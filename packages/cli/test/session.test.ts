import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { ConfigManager, DatabaseManager } from '@wta/core';

let tempDir = '';
let originalCwd = '';
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-session-command-'));
  process.chdir(tempDir);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function command(name: 'status' | 'stop'): Promise<Command> {
  vi.resetModules();
  const module = await import('../src/commands/session.js');
  return name === 'status' ? module.statusCommand : module.stopCommand;
}

async function run(commandName: 'status' | 'stop', ...args: string[]) {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
    logs.push(values.map(value => String(value)).join(' '));
  });

  try {
    await (await command(commandName)).parseAsync(args, { from: 'user' });
    return logs;
  } finally {
    logSpy.mockRestore();
  }
}

function createSessions(): void {
  const config = new ConfigManager(tempDir).load();
  const db = new DatabaseManager(config.dbPath);
  db.prepare(`
    INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
    VALUES ('demo', '演示系统', 'https://example.com', '{}', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO sessions (id, target_id, status, started_at, ended_at, phase)
    VALUES ('active-12345678', 'demo', 'running', 1000, NULL, 'test'),
           ('done-12345678', 'demo', 'completed', 1000, 2000, 'report')
  `).run();
  db.close();
}

function health(online: boolean): void {
  fetchMock.mockImplementation(async (url: string | URL, options?: RequestInit) => {
    const value = String(url);
    if (value.endsWith('/api/health')) return { ok: online, text: async () => '' } as Response;
    if (value.includes('/api/sessions/') && options?.method === 'POST') {
      return { ok: true, status: 200, text: async () => '' } as Response;
    }
    return { ok: false, status: 404, text: async () => '未找到' } as Response;
  });
}

describe('顶层会话命令', () => {
  it('显示活动会话、历史会话和不存在的指定会话', async () => {
    createSessions();
    health(true);
    mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'daemon.json'), JSON.stringify({ port: 9123 }), 'utf-8');

    const active = await run('status');
    expect(active.join('\n')).toContain('常驻代理：运行中（http://127.0.0.1:9123）');
    expect(active.join('\n')).toContain('active-1');
    expect(active.join('\n')).not.toContain('done-123');

    const all = await run('status', '--all');
    expect(all.join('\n')).toContain('done-123');

    const missing = await run('status', 'missing');
    expect(missing.join('\n')).toContain('未找到测试会话：missing');
  });

  it('在没有数据库或活动会话时给出明确提示，并容错错误守护状态文件', async () => {
    health(false);
    const noDatabase = await run('status');
    expect(noDatabase.join('\n')).toContain('常驻代理：未运行');
    expect(noDatabase.join('\n')).toContain('当前没有运行中的测试会话');

    mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'daemon.json'), '{', 'utf-8');
    createSessions();
    const none = await run('status');
    expect(none.join('\n')).toContain('active-1');
  });

  it('停止单个会话和全部活动会话，并保留常驻代理', async () => {
    createSessions();
    health(true);

    const one = await run('stop', 'active-12345678', '--port', '9123');
    expect(one.join('\n')).toContain('测试会话已停止：active-12345678');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9123/api/sessions/active-12345678/stop',
      { method: 'POST' },
    );

    fetchMock.mockClear();
    health(true);
    const all = await run('stop', '--all');
    expect(all.join('\n')).toContain('测试会话已停止：active-12345678');
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('done-12345678'))).toBe(false);
  });

  it('校验停止命令的必要参数、端口、代理状态和 HTTP 失败', async () => {
    await expect(run('stop')).rejects.toThrow('必须指定测试会话 ID 或 --all');
    await expect(run('stop', 'session', '--port', 'bad')).rejects.toThrow('无效端口：bad');

    health(false);
    await expect(run('stop', 'session')).rejects.toThrow('常驻代理未运行');

    health(true);
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith('/api/health')) return { ok: true } as Response;
      return { ok: false, status: 500, text: async () => '停止失败' } as Response;
    });
    await expect(run('stop', 'session')).rejects.toThrow('停止测试会话失败：session 500 停止失败');

    health(true);
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith('/api/health')) return { ok: true } as Response;
      return { ok: false, status: 503, text: async () => { throw new Error('响应断开'); } } as Response;
    });
    await expect(run('stop', 'session')).rejects.toThrow('停止测试会话失败：session 503');
  });

  it('没有活动会话时批量停止不会请求会话接口', async () => {
    const config = new ConfigManager(tempDir).load();
    new DatabaseManager(config.dbPath).close();
    health(true);

    const result = await run('stop', '--all');
    expect(result.join('\n')).toContain('当前没有可停止的测试会话');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('守护服务网络异常和非数字端口使用稳定回退值', async () => {
    mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'daemon.json'), JSON.stringify({ port: '9123' }), 'utf-8');
    fetchMock.mockRejectedValue(new Error('网络不可达'));
    const result = await run('status', '--all');
    expect(result.join('\n')).toContain('常驻代理：未运行（http://127.0.0.1:7878）');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:7878/api/health');
  });

  it('会话阶段为空时以短横线展示', async () => {
    const config = new ConfigManager(tempDir).load();
    const db = new DatabaseManager(config.dbPath);
    db.prepare("INSERT INTO targets (id, name, url, config_json, created_at, updated_at) VALUES ('demo', '演示系统', 'https://example.com', '{}', 1, 1)").run();
    db.prepare("INSERT INTO sessions (id, target_id, status, started_at, phase) VALUES ('null-phase', 'demo', 'running', 1, NULL)").run();
    db.close();
    health(true);
    const output = await run('status');
    expect(output.join('\n')).toContain('running    -');
  });
});
