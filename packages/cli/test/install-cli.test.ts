import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCommand } from '../src/commands/install.js';

const childMocks = vi.hoisted(() => ({
  execSync: vi.fn(),
}));

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: childMocks.execSync,
}));

let tempDir = '';
let originalCwd = '';
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  // 默认验证 Windows 无需安装 Linux 依赖的分支；Linux 场景在专用用例中覆盖。
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-install-cli-'));
  process.chdir(tempDir);
  childMocks.execSync.mockReset();
});

afterEach(() => {
  process.chdir(originalCwd);
  Object.defineProperty(process, 'platform', platformDescriptor);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function runInstall(...args: string[]) {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
    logs.push(values.map(value => String(value)).join(' '));
  });

  try {
    await installCommand.parseAsync(args, { from: 'user' });
    return { logs, calls: childMocks.execSync.mock.calls };
  } finally {
    logSpy.mockRestore();
  }
}

describe('浏览器安装命令', () => {
  it('默认安装 Chromium 到项目内置目录', async () => {
    const result = await runInstall('browsers');

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]![0]).toBe('pnpm exec playwright install chromium');
    expect(result.calls[0]![1]).toMatchObject({
      cwd: tempDir,
      env: expect.objectContaining({
        PLAYWRIGHT_BROWSERS_PATH: path.join(tempDir, 'vendor', 'browsers'),
      }),
    });
    expect(result.logs.join('\n')).toContain('浏览器目录：');
  });

  it('支持指定浏览器和全量安装', async () => {
    await runInstall('browsers', '--browser', 'firefox');
    expect(childMocks.execSync).toHaveBeenLastCalledWith(
      'pnpm exec playwright install firefox',
      expect.anything(),
    );

    childMocks.execSync.mockClear();
    await runInstall('browsers', '--all');
    expect(childMocks.execSync.mock.calls.map(call => call[0])).toEqual([
      'pnpm exec playwright install chromium',
      'pnpm exec playwright install firefox',
      'pnpm exec playwright install webkit',
    ]);
  });

  it('Windows 上跳过 Linux 依赖安装', async () => {
    const result = await runInstall('deps');
    expect(childMocks.execSync).not.toHaveBeenCalled();
    expect(result.logs.join('\n')).toContain('当前系统不需要安装 Linux 浏览器依赖');
  });

  it('Linux 上安装无头浏览器系统依赖', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const result = await runInstall('deps');

    expect(childMocks.execSync).toHaveBeenCalledWith(
      'pnpm exec playwright install-deps',
      expect.objectContaining({
        env: expect.objectContaining({
          PLAYWRIGHT_BROWSERS_PATH: path.join(tempDir, 'vendor', 'browsers'),
        }),
      }),
    );
    expect(result.logs.join('\n')).toContain('系统依赖安装完成');
  });

  it('查看浏览器目录不存在和全部已安装状态', async () => {
    const missing = await runInstall('status');
    expect(missing.logs.join('\n')).toContain('浏览器目录不存在');

    const browserRoot = path.join(tempDir, 'vendor', 'browsers');
    mkdirSync(browserRoot, { recursive: true });
    for (const name of ['chrome.exe', 'firefox.exe', 'webkitbrowser.exe']) {
      writeFileSync(path.join(browserRoot, name), '');
    }

    const installed = await runInstall('status');
    expect(installed.logs.join('\n')).toContain('chromium：已安装');
    expect(installed.logs.join('\n')).toContain('firefox：已安装');
    expect(installed.logs.join('\n')).toContain('webkit：已安装');
  });

  it('浏览器目录存在但不可用时输出未安装', async () => {
    mkdirSync(path.join(tempDir, 'vendor', 'browsers'), { recursive: true });

    const result = await runInstall('status');
    expect(result.logs.join('\n')).toContain('chromium：未安装');
    expect(result.logs.join('\n')).toContain('firefox：未安装');
    expect(result.logs.join('\n')).toContain('webkit：未安装');
  });
});
