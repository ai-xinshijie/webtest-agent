import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@wta/core', async () => {
  const actual = await vi.importActual<typeof import('@wta/core')>('@wta/core');

  class MockOrchestrator {
    static instances: MockOrchestrator[] = [];
    static session = {
      id: 'session-1',
      status: 'completed',
      reportPaths: ['.wta/reports/a.md', '.wta/reports/b.md'],
    };
    run = vi.fn(async () => MockOrchestrator.session);

    constructor() {
      MockOrchestrator.instances.push(this);
    }
  }

  return { ...actual, Orchestrator: MockOrchestrator, MockOrchestrator };
});

let tempDir = '';
let originalCwd = '';

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-run-foreground-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) console.warn(`清理测试目录失败：${tempDir}`);
      else await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  tempDir = '';
});

async function loadRunCommand() {
  vi.resetModules();
  return (await import('../src/commands/run.js')).runCommand;
}

async function runForeground() {
  const command = await loadRunCommand();
  const logs: string[] = [];
  const exitCodes: number[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
    logs.push(values.map(value => String(value)).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    exitCodes.push(code ?? 0);
  });

  try {
    await command.parseAsync(['demo', '--foreground', '--mode', 'expand', '--phase', 'test', '--parallel', '3', '--headed', '--max-time', '1.5h'], {
      from: 'user',
    });
    return { logs, exitCodes };
  } finally {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe('前台运行命令', () => {
  it('前台执行测试并输出全部报告路径', async () => {
    mkdirSync(path.join(tempDir, '.wta', 'targets'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'targets', 'demo.json'), JSON.stringify({
      name: 'demo',
      url: 'https://example.com',
      credentials: { username: 'user', password: 'pass' },
      strategy: {
        runMode: 'continue',
        depth: 'deep',
        maxDuration: 600,
        maxPages: 20,
        parallel: 1,
        screenshot: 'always',
        video: false,
        headless: true,
      },
      scope: { includePaths: [], excludePaths: [] },
    }), 'utf-8');

    const result = await runForeground();
    const core = await import('@wta/core') as any;
    const instance = core.MockOrchestrator.instances.at(-1)!;

    expect(instance.run).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'demo' }),
      expect.objectContaining({
        runMode: 'expand',
        phase: 'test',
        parallel: 3,
        headless: false,
        resumeSessionId: undefined,
        maxDuration: 5400,
      }),
    );
    expect(result.logs.join('\n')).toContain('会话完成：session-1');
    expect(result.logs.join('\n')).toContain('.wta/reports/a.md、.wta/reports/b.md');
    expect(result.exitCodes).toEqual([0]);
  });

  it('前台执行失败时退出并提示未生成报告', async () => {
    mkdirSync(path.join(tempDir, '.wta', 'targets'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'targets', 'demo.json'), JSON.stringify({
      name: 'demo',
      url: 'https://example.com',
      credentials: { username: 'user', password: 'pass' },
      strategy: {
        runMode: 'continue',
        depth: 'deep',
        maxDuration: 600,
        maxPages: 20,
        parallel: 1,
        screenshot: 'always',
        video: false,
        headless: true,
      },
      scope: { includePaths: [], excludePaths: [] },
    }), 'utf-8');
    const core = await import('@wta/core') as any;
    core.MockOrchestrator.session = { id: 'session-1', status: 'failed' };

    const result = await runForeground();
    expect(result.logs.join('\n')).toContain('状态：failed');
    expect(result.logs.join('\n')).toContain('报告：未生成');
    expect(result.exitCodes).toEqual([1]);
  });

  it('拒绝非法或非正数的最大运行时长', async () => {
    mkdirSync(path.join(tempDir, '.wta', 'targets'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'targets', 'demo.json'), JSON.stringify({
      name: 'demo', url: 'https://example.com', credentials: { username: 'u', password: 'p' },
      strategy: { runMode: 'continue', depth: 'quick', maxDuration: 60, maxPages: 1, parallel: 1, screenshot: 'never', video: false, headless: true },
      scope: { includePaths: [], excludePaths: [] },
    }), 'utf-8');
    const command = await loadRunCommand();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await command.parseAsync(['demo', '--foreground', '--max-time', 'bad'], { from: 'user' });
    await command.parseAsync(['demo', '--foreground', '--max-time', '0s'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('无效最大运行时长'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('必须大于 0'));
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('接受分钟和默认秒单位的最大运行时长', async () => {
    mkdirSync(path.join(tempDir, '.wta', 'targets'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'targets', 'demo.json'), JSON.stringify({
      name: 'demo', url: 'https://example.com', credentials: { username: 'u', password: 'p' },
      strategy: { runMode: 'continue', depth: 'quick', maxDuration: 60, maxPages: 1, parallel: 1, screenshot: 'never', video: false, headless: true },
      scope: { includePaths: [], excludePaths: [] },
    }), 'utf-8');
    const core = await import('@wta/core') as any;
    const command = await loadRunCommand();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await command.parseAsync(['demo', '--foreground', '--max-time', '2m'], { from: 'user' });
    expect(core.MockOrchestrator.instances.at(-1).run).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ maxDuration: 120 }));
    const secondsCommand = await loadRunCommand();
    await secondsCommand.parseAsync(['demo', '--foreground', '--max-time', '42'], { from: 'user' });
    expect(core.MockOrchestrator.instances.at(-1).run).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ maxDuration: 42 }));
    exitSpy.mockRestore();
  });
});
