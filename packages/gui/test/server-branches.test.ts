import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startGuiServer, type GuiServerHandle } from '../src/server.js';
import { ConfigManager, DatabaseManager } from '@wta/core';

vi.mock('@wta/core', async () => {
  const actual = await vi.importActual<typeof import('@wta/core')>('@wta/core');

  class MockOrchestrator {
    static instances: MockOrchestrator[] = [];
    run = vi.fn(async () => {
      throw '测试执行异常';
    });
    close = vi.fn(async () => undefined);

    constructor() {
      MockOrchestrator.instances.push(this);
    }
  }

  return { ...actual, Orchestrator: MockOrchestrator, MockOrchestrator };
});

let tempDir = '';
let originalCwd = '';
let handle: GuiServerHandle | null = null;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-gui-branches-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close().catch(() => undefined);
    handle = null;
  }
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function createTargetRow(db: DatabaseManager, name: string) {
  db.prepare(`
    INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
    VALUES (?, ?, 'https://example.com', '{}', 1, 1)
  `).run(name, name);
}

describe('GUI 服务分支', () => {
  it('无参数启动时使用当前目录、系统空闲端口和本机地址', async () => {
    process.chdir(tempDir);
    handle = await startGuiServer();

    expect(handle.port).toBeGreaterThan(0);
    expect(path.resolve(process.cwd())).toBe(path.resolve(tempDir));
    await handle.close();
    handle = null;
  });

  it('会话摘要兼容有进度和无进度数据', async () => {
    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    const config = new ConfigManager(tempDir).load();
    const db = new DatabaseManager(config.dbPath);
    createTargetRow(db, 'demo');
    const insert = db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at, progress_json)
      VALUES (?, 'demo', 'running', 1, ?)
    `);
    insert.run('with-progress', JSON.stringify({ coverage: 1 }));
    insert.run('without-progress', null);
    db.close();

    const response = await handle.fastify.inject({ method: 'GET', url: '/api/sessions' });
    const sessions = response.json() as Array<{ id: string; progress: unknown }>;
    expect(sessions.find(item => item.id === 'with-progress')?.progress).toEqual({ coverage: 1 });
    expect(sessions.find(item => item.id === 'without-progress')?.progress).toBeNull();
  });

  it('异步测试执行失败支持非 Error 异常', async () => {
    mkdirSync(path.join(tempDir, '.wta', 'targets'), { recursive: true });
    const target = {
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
    };
    writeFileSync(
      path.join(tempDir, '.wta', 'targets', 'demo.json'),
      JSON.stringify(target),
      'utf-8',
    );

    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
      errors.push(values.map(value => String(value)).join(' '));
    });

    const response = await handle.fastify.inject({
      method: 'POST',
      url: '/api/run',
      payload: { target: 'demo' },
    });
    expect(response.statusCode).toBe(202);
    await new Promise(resolve => setImmediate(resolve));
    expect(errors.join('\n')).toContain('测试执行异常');
    errorSpy.mockRestore();
  });

  it('重复关闭数据库时直接返回', async () => {
    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    await handle.close();
    await handle.close();
    handle = null;
  });

  it('停机时守护文件不存在也能正常关闭', async () => {
    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    const statePath = path.join(tempDir, '.wta', 'daemon.json');
    await import('node:fs').then(fs => fs.rmSync(statePath, { force: true }));

    const response = await handle.fastify.inject({ method: 'POST', url: '/api/daemon/stop' });
    expect(response.statusCode).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    handle = null;
  });

  it('关闭时守护文件不存在也能完成清理', async () => {
    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    const statePath = path.join(tempDir, '.wta', 'daemon.json');
    await import('node:fs').then(fs => fs.rmSync(statePath, { force: true }));
    await handle.close();
    handle = null;
  });

  it('监听地址不是对象时保留请求端口', async () => {
    const addressSpy = vi.spyOn(Server.prototype, 'address')
      .mockReturnValue('\\\\.\\pipe\\wta-test' as never);
    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    expect(handle.port).toBe(0);
    addressSpy.mockRestore();
  });
});
