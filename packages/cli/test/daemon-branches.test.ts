import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { ensureDaemon } from '../src/commands/daemon.js';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
}));

const childMocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  exec: vi.fn(),
}));

vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: fsMocks.existsSync,
}));

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: childMocks.spawn,
  exec: childMocks.exec,
}));

let tempDir = '';
let originalCwd = '';
let fetchState: {
  healthCalls: number;
  health: () => boolean;
  stopOk: boolean;
};
let fetchMock: ReturnType<typeof vi.fn>;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-daemon-branches-'));
  process.chdir(tempDir);
  fsMocks.existsSync.mockReset();
  fsMocks.existsSync.mockReturnValue(true);
  childMocks.spawn.mockClear();
  childMocks.exec.mockClear();
  fetchState = {
    healthCalls: 0,
    health: () => false,
    stopOk: true,
  };
  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    if (text.endsWith('/api/health')) {
      fetchState.healthCalls += 1;
      return { ok: fetchState.health() } as Response;
    }
    if (text.endsWith('/api/daemon/stop')) {
      expect(init).toEqual({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return { ok: fetchState.stopOk, status: fetchState.stopOk ? 200 : 500 } as Response;
    }
    return { ok: false, status: 404 } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function loadDaemonCommand(): Promise<Command> {
  vi.resetModules();
  const module = await import('../src/commands/daemon.js');
  return module.daemonCommand;
}

async function loadGuiCommand(): Promise<Command> {
  vi.resetModules();
  const module = await import('../src/commands/daemon.js');
  return module.guiCommand;
}

async function runCommand(command: Command, ...args: string[]) {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
    logs.push(values.map(value => String(value)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
    errors.push(values.map(value => String(value)).join(' '));
  });

  try {
    await command.parseAsync(args, { from: 'user' });
    return { logs, errors };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

function writeState(state: Record<string, unknown>) {
  mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
  writeFileSync(path.join(tempDir, '.wta', 'daemon.json'), JSON.stringify(state), 'utf-8');
}

describe('常驻代理分支', () => {
  it('服务已运行时直接返回地址', async () => {
    fetchState.health = () => true;
    await expect(ensureDaemon(1234)).resolves.toBe('http://127.0.0.1:1234');
    expect(childMocks.spawn).not.toHaveBeenCalled();
  });

  it('GUI 服务不存在时输出构建提示', async () => {
    fsMocks.existsSync.mockReturnValue(false);
    await expect(ensureDaemon(1234)).rejects.toThrow('GUI 服务不存在');
    expect(childMocks.spawn).not.toHaveBeenCalled();
  });

  it('启动子进程并在健康检查通过后返回', async () => {
    vi.useFakeTimers();
    fetchState.health = () => fetchState.healthCalls >= 2;

    const promise = ensureDaemon(1234);
    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).resolves.toBe('http://127.0.0.1:1234');

    expect(childMocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining('gui')],
      expect.objectContaining({
        cwd: tempDir,
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({ WTA_PORT: '1234' }),
      }),
    );
  });

  it('健康检查持续失败时抛出启动超时', async () => {
    vi.useFakeTimers();
    fetchState.health = () => false;

    const expectation = expect(ensureDaemon(1234)).rejects.toThrow('GUI 服务启动超时');
    await vi.advanceTimersByTimeAsync(10000);
    await expectation;
  });

  it('代理未运行、停止失败和停止成功', async () => {
    const stopped = await runCommand(await loadDaemonCommand(), 'stop');
    expect(stopped.logs.join('\n')).toContain('常驻代理未运行');

    writeState({ port: 1234 });
    fetchState.health = () => true;
    fetchState.stopOk = false;
    await expect(runCommand(await loadDaemonCommand(), 'stop')).rejects.toThrow('停止常驻代理失败：500');

    fetchState.stopOk = true;
    fetchState.healthCalls = 0;
    fetchState.health = () => fetchState.healthCalls <= 1;
    const success = await runCommand(await loadDaemonCommand(), 'stop');
    expect(success.logs.join('\n')).toContain('常驻代理已停止');
  });

  it('停止健康检查持续通过时抛出停止超时', async () => {
    vi.useFakeTimers();
    writeState({ port: 1234 });
    fetchState.health = () => true;
    fetchState.stopOk = true;

    const command = await loadDaemonCommand();
    const action = command.parseAsync(['stop'], { from: 'user' });
    const expectation = expect(action).rejects.toThrow('常驻代理停止超时');
    await vi.advanceTimersByTimeAsync(2000);
    await expectation;
  });

  it('start 和 GUI 未指定端口时使用默认端口', async () => {
    fetchState.health = () => true;

    const start = await runCommand(await loadDaemonCommand(), 'start');
    expect(start.logs.join('\n')).toContain('http://127.0.0.1:7878');

    const gui = await runCommand(await loadGuiCommand(), '--no-open');
    expect(gui.logs.join('\n')).toContain('http://127.0.0.1:7878');
  });

  it('状态输出运行信息和 PID', async () => {
    writeState({ pid: 12345, port: 1234 });
    fetchState.health = () => true;

    const status = await runCommand(await loadDaemonCommand(), 'status');
    expect(status.logs.join('\n')).toContain('状态：运行中');
    expect(status.logs.join('\n')).toContain('PID：12345');
    expect(status.logs.join('\n')).toContain('地址：http://127.0.0.1:1234');
  });

  it('GUI 按平台打开浏览器且支持不自动打开', async () => {
    fetchState.health = () => true;

    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      const result = await runCommand(await loadGuiCommand(), '--port', '1234');
      expect(result.logs.join('\n')).toContain('GUI 已启动：http://127.0.0.1:1234');
    }
    expect(childMocks.exec.mock.calls.map(call => String(call[0]))).toEqual([
      expect.stringContaining('start'),
      expect.stringContaining('open'),
      expect.stringContaining('xdg-open'),
    ]);

    childMocks.exec.mockClear();
    const noOpen = await runCommand(await loadGuiCommand(), '--port', '1234', '--no-open');
    expect(noOpen.logs.join('\n')).toContain('GUI 已启动');
    expect(childMocks.exec).not.toHaveBeenCalled();
  });
});
