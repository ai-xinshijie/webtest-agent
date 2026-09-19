import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  createContext: vi.fn(),
  newPage: vi.fn(),
  pageGoto: vi.fn(),
  storageState: vi.fn(),
  browserClose: vi.fn(),
  question: vi.fn(),
  readlineClose: vi.fn(),
}));

vi.mock('@wta/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@wta/core')>();
  class MockBrowserManager {
    async createContext(...args: unknown[]) { return mocks.createContext(...args); }
    async close() { return mocks.browserClose(); }
  }
  return { ...actual, BrowserManager: MockBrowserManager };
});

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: mocks.question,
    close: mocks.readlineClose,
  }),
}));

let tempDir = '';
let originalCwd = '';
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-auth-cli-'));
  process.chdir(tempDir);
  mkdirSync(path.join(tempDir, '.wta', 'targets'), { recursive: true });
  writeFileSync(path.join(tempDir, '.wta', 'targets', 'demo.json'), JSON.stringify({
    name: 'demo',
    url: 'https://example.com/login',
    credentials: { username: 'user', password: 'pass' },
    strategy: {
      runMode: 'continue', depth: 'quick', maxDuration: 60, maxPages: 1, parallel: 1,
      screenshot: 'always', video: false, headless: true,
    },
    scope: { includePaths: [], excludePaths: [] },
  }), 'utf-8');
  mocks.createContext.mockReset();
  mocks.newPage.mockReset();
  mocks.pageGoto.mockReset();
  mocks.storageState.mockReset();
  mocks.browserClose.mockReset();
  mocks.question.mockReset();
  mocks.readlineClose.mockReset();
});

afterEach(() => {
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function command(): Promise<Command> {
  vi.resetModules();
  return (await import('../src/commands/auth.js')).authCommand;
}

async function run(...args: string[]) {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
    logs.push(values.map(value => String(value)).join(' '));
  });
  try {
    await (await command()).parseAsync(args, { from: 'user' });
    return logs;
  } finally {
    logSpy.mockRestore();
  }
}

function stateFile(file: string, value: unknown = { cookies: [], origins: [] }) {
  writeFileSync(file, JSON.stringify(value), 'utf-8');
}

describe('认证状态命令', () => {
  it('导入和导出合法认证状态', async () => {
    const source = path.join(tempDir, 'source.json');
    stateFile(source);

    const imported = await run('import', 'demo', source);
    const destination = path.join(tempDir, '.wta', 'auth', 'demo.json');
    expect(imported.join('\n')).toContain('认证状态已导入');
    expect(JSON.parse(readFileSync(destination, 'utf-8'))).toEqual({ cookies: [], origins: [] });

    const exportedPath = path.join(tempDir, 'exported.json');
    const exported = await run('export', 'demo', '--output', exportedPath);
    expect(exported.join('\n')).toContain('认证状态已导出');
    expect(JSON.parse(readFileSync(exportedPath, 'utf-8'))).toEqual({ cookies: [], origins: [] });
  });

  it('导出未指定输出路径时使用目标名称作为默认文件名', async () => {
    const source = path.join(tempDir, 'source.json');
    stateFile(source);
    await run('import', 'demo', source);
    await run('export', 'demo');
    expect(existsSync(path.join(tempDir, 'demo-auth-state.json'))).toBe(true);
  });

  it('校验目标、认证状态文件和认证状态结构', async () => {
    await expect(run('import', '不存在', 'missing.json')).rejects.toThrow('未找到测试目标：不存在');
    await expect(run('import', 'demo', 'missing.json')).rejects.toThrow('认证状态文件不存在');

    const invalidJson = path.join(tempDir, 'invalid.json');
    writeFileSync(invalidJson, '{', 'utf-8');
    await expect(run('import', 'demo', invalidJson)).rejects.toThrow('认证状态文件格式不正确');

    const invalidShape = path.join(tempDir, 'invalid-shape.json');
    stateFile(invalidShape, { cookies: {} });
    await expect(run('import', 'demo', invalidShape)).rejects.toThrow('认证状态缺少 cookies 或 origins 数组');
    await expect(run('export', 'demo')).rejects.toThrow('认证状态文件不存在');
  });

  it('交互式 capture 使用项目浏览器并保存认证状态', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const page = { goto: mocks.pageGoto };
    const context = {
      newPage: mocks.newPage.mockResolvedValue(page),
      storageState: mocks.storageState.mockResolvedValue(undefined),
    };
    mocks.createContext.mockResolvedValue(context);
    mocks.question.mockResolvedValue('');

    const logs = await run('capture', 'demo', '--timeout', '1');
    const destination = path.join(tempDir, '.wta', 'auth', 'demo.json');
    expect(logs.join('\n')).toContain('认证状态已保存');
    expect(mocks.createContext).toHaveBeenCalledWith(expect.stringMatching(/^auth-capture-/), expect.objectContaining({ headless: false }));
    expect(mocks.pageGoto).toHaveBeenCalledWith('https://example.com/login', expect.anything());
    expect(mocks.storageState).toHaveBeenCalledWith({ path: destination });
    expect(mocks.browserClose).toHaveBeenCalled();
    expect(mocks.readlineClose).toHaveBeenCalled();
  });

  it('capture 校验超时、非交互终端并在浏览器失败时关闭资源', async () => {
    await expect(run('capture', 'demo', '--timeout', '0')).rejects.toThrow('无效认证等待时间：0');

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    mocks.createContext.mockResolvedValue({ newPage: mocks.newPage, storageState: mocks.storageState });
    mocks.newPage.mockResolvedValue({ goto: mocks.pageGoto });
    await expect(run('capture', 'demo', '--timeout', '1')).rejects.toThrow('当前终端不支持交互认证');
    expect(mocks.browserClose).toHaveBeenCalled();

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mocks.createContext.mockRejectedValueOnce(new Error('浏览器启动失败'));
    await expect(run('capture', 'demo', '--timeout', '1')).rejects.toThrow('浏览器启动失败');
    expect(existsSync(path.join(tempDir, '.wta', 'auth', 'demo.json'))).toBe(false);
  });

  it('capture 在人工认证超时时关闭交互和浏览器资源', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mocks.createContext.mockResolvedValue({
      newPage: mocks.newPage.mockResolvedValue({ goto: mocks.pageGoto }),
      storageState: mocks.storageState,
    });
    mocks.pageGoto.mockResolvedValue(undefined);
    mocks.question.mockImplementation(() => new Promise(() => {}));

    const pending = run('capture', 'demo', '--timeout', '1');
    const rejection = expect(pending).rejects.toThrow('人工认证等待超时');
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(mocks.readlineClose).toHaveBeenCalled();
    expect(mocks.browserClose).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('capture 不提供超时参数时使用默认等待时间', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mocks.createContext.mockResolvedValue({
      newPage: mocks.newPage.mockResolvedValue({ goto: mocks.pageGoto }),
      storageState: mocks.storageState,
    });
    mocks.pageGoto.mockResolvedValue(undefined);
    mocks.question.mockResolvedValue('');
    await run('capture', 'demo');
    expect(mocks.storageState).toHaveBeenCalled();
  });
});
