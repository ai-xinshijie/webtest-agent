import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { startGuiServer, type GuiServerHandle } from '../../gui/src/server.js';
import { daemonCommand, guiCommand } from '../src/commands/daemon.js';
import { attachCommand } from '../src/commands/attach.js';
import { runCommand } from '../src/commands/run.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { initCommand } from '../src/commands/init.js';
import { AgentLogger, DatabaseManager } from '@wta/core';

let tempDir = '';
let originalCwd = '';
let handle: GuiServerHandle | null = null;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-agent-cli-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  if (handle) {
    await handle.close().catch(() => undefined);
    handle = null;
  }
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function runCliCommand(command: Command, ...args: string[]) {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
    logs.push(values.map(value => String(value)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
    errors.push(values.map(value => String(value)).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });

  try {
    await command.parseAsync(args, { from: 'user' });
    return { logs, errors };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

function createTargetFile() {
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
}

function createSession() {
  const db = new DatabaseManager(path.join(tempDir, '.wta', 'wta.db'));
  db.prepare(`
    INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
    VALUES ('demo', 'demo', 'https://example.com', '{}', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO sessions (id, target_id, status, started_at, phase)
    VALUES ('session-1', 'demo', 'running', 1, 'test')
  `).run();
  new AgentLogger(db, 'session-1', { consoleOutput: false }).logScript(
    { description: '执行深度测试', module: '测试', method: 'test' },
    { type: 'test', target: 'demo' },
    { status: 'success', duration: 1, output: { ok: true } },
    { phase: 'test' },
  );
  db.close();
}

describe('常驻代理与运行命令', () => {
  it('启动、查看和停止常驻 GUI 代理', async () => {
    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    const port = handle.port;

    const start = await runCliCommand(daemonCommand, 'start', '--port', String(port));
    expect(start.logs.join('\n')).toContain(`常驻测试代理已启动：http://127.0.0.1:${port}`);

    const status = await runCliCommand(daemonCommand, 'status');
    expect(status.logs.join('\n')).toContain('状态：运行中');
    expect(status.logs.join('\n')).toContain(`地址：http://127.0.0.1:${port}`);

    const gui = await runCliCommand(guiCommand, '--port', String(port), '--no-open');
    expect(gui.logs.join('\n')).toContain(`GUI 已启动：http://127.0.0.1:${port}`);

    const stop = await runCliCommand(daemonCommand, 'stop');
    expect(stop.logs.join('\n')).toContain('常驻代理已停止');
    handle = null;
  });

  it('代理未运行时停止和状态输出中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false } as Response)));
    const stop = await runCliCommand(daemonCommand, 'stop');
    expect(stop.logs.join('\n')).toContain('常驻代理未运行');

    mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'daemon.json'), '不是 JSON', 'utf-8');
    const status = await runCliCommand(daemonCommand, 'status');
    expect(status.logs.join('\n')).toContain('状态：未运行');
    expect(status.logs.join('\n')).toContain('地址：http://127.0.0.1:7878');
  });

  it('提交测试会话到常驻代理', async () => {
    createTargetFile();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const text = String(url);
      requests.push({ url: text, init });
      if (text.endsWith('/api/health')) {
        return { ok: true } as Response;
      }
      if (text.endsWith('/api/run')) {
        return {
          ok: true,
          json: async () => ({ sessionId: 'session-1' }),
        } as Response;
      }
      return { ok: false } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCliCommand(
      runCommand,
      'demo',
      '--mode', 'regression',
      '--phase', 'combo',
      '--parallel', '4',
      '--resume',
    );
    expect(result.logs.join('\n')).toContain('测试已提交：session-1');
    const runRequest = requests.find(item => item.url.endsWith('/api/run'));
    expect(runRequest).toBeDefined();
    expect(JSON.parse(String(runRequest!.init!.body))).toEqual({
      target: 'demo',
      mode: 'regression',
      phase: 'combo',
      parallel: 4,
      headless: true,
      resume: true,
    });
  });

  it('目标、运行模式和测试阶段无效时输出中文错误', async () => {
    await expect(runCliCommand(runCommand, '不存在')).rejects.toThrow('process.exit');

    createTargetFile();
    await expect(runCliCommand(runCommand, 'demo', '--mode', 'invalid')).rejects.toThrow('process.exit');
    await expect(runCliCommand(runCommand, 'demo', '--phase', 'invalid')).rejects.toThrow('process.exit');
  });

  it('附加到会话并输出时间线', async () => {
    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    createSession();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as any);

    const result = await runCliCommand(attachCommand, 'session-1', '--port', String(handle.port));
    expect(result.logs.join('\n')).toContain('已附加会话：session-1');
    expect(result.logs.join('\n')).toContain('脚本');
    expect(result.logs.join('\n')).toContain('执行深度测试');
    intervalSpy.mockRestore();
  });

  it('环境检查在浏览器可用时全部通过', async () => {
    await runCliCommand(initCommand);
    mkdirSync(path.join(tempDir, 'vendor', 'browsers'), { recursive: true });
    writeFileSync(path.join(tempDir, 'vendor', 'browsers', 'chrome.exe'), '');

    const result = await runCliCommand(doctorCommand);
    expect(result.logs.join('\n')).toContain('内置浏览器 chromium：已安装');
    expect(result.logs.join('\n')).toContain('必需检查全部通过');
  });

  it('环境检查缺少必需浏览器时失败', async () => {
    await runCliCommand(initCommand);
    await expect(runCliCommand(doctorCommand)).rejects.toThrow('process.exit');
  });
});
