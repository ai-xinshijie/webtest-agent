import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGuiServer, type GuiServerHandle } from '../src/server.js';
import { AgentLogger, DatabaseManager, MemoryManager } from '@wta/core';
import type { TargetConfig } from '@wta/core';

let tempDir = '';
let handle: GuiServerHandle | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-gui-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close().catch(() => undefined);
    handle = null;
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function createTarget(): TargetConfig {
  return {
    name: 'demo',
    url: 'https://example.com',
    credentials: { username: 'user', password: 'pass' },
    strategy: {
      runMode: 'continue',
      depth: 'deep',
      maxDuration: 600,
      maxPages: 20,
      parallel: 2,
      screenshot: 'always',
      video: false,
      headless: true,
    },
    scope: { includePaths: [], excludePaths: [] },
  };
}

describe('GUI API', () => {
  it('提供配置、目标、会话、时间线、报告、记忆和插件接口', async () => {
    mkdirSync(path.join(tempDir, '.wta', 'targets'), { recursive: true });
    mkdirSync(path.join(tempDir, '.wta', 'reports'), { recursive: true });
    mkdirSync(path.join(tempDir, '.wta', 'plugins'), { recursive: true });
    const target = createTarget();
    writeFileSync(path.join(tempDir, '.wta', 'targets', 'demo.json'), JSON.stringify(target), 'utf-8');
    writeFileSync(path.join(tempDir, '.wta', 'reports', 'demo.md'), '# 中文报告', 'utf-8');
    writeFileSync(path.join(tempDir, '.wta', 'reports', 'demo.json'), '{"ok":true}', 'utf-8');

    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    const app = handle.fastify;

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: '运行中', port: handle.port });

    const configResponse = await app.inject({ method: 'GET', url: '/api/config' });
    expect(configResponse.statusCode).toBe(200);
    const config = configResponse.json();
    expect(config.browserDir).toContain('vendor/browsers');

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { ...config, logLevel: 'debug', parallel: 3 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ logLevel: 'debug', parallel: 3 });

    const targets = await app.inject({ method: 'GET', url: '/api/targets' });
    expect(targets.statusCode).toBe(200);
    expect(targets.json()).toEqual([target]);

    const db = new DatabaseManager(path.join(tempDir, '.wta', 'wta.db'));
    db.prepare(`
      INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES ('demo', 'demo', ?, '{}', 1, 1)
    `).run(target.url);
    db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at, ended_at, phase)
      VALUES ('session-1', 'demo', 'completed', 1, 2, 'report')
    `).run();
    const memory = new MemoryManager(db);
    memory.markTested('demo', {
      itemKey: 'demo:button-1:click',
      componentId: 'button-1',
      testType: 'click',
      status: 'passed',
    });
    new AgentLogger(db, 'session-1', { consoleOutput: false }).logSystem(
      { description: 'GUI 测试日志', module: '测试', method: 'test' },
      { type: 'test', target: 'demo' },
      { status: 'success', duration: 1, output: { ok: true } },
      { phase: 'test' },
    );

    const sessions = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(sessions.json()).toEqual([expect.objectContaining({
      id: 'session-1',
      targetId: 'demo',
      targetName: 'demo',
      status: 'completed',
    })]);

    const session = await app.inject({ method: 'GET', url: '/api/sessions/session-1' });
    expect(session.json()).toMatchObject({ id: 'session-1' });

    const timeline = await app.inject({ method: 'GET', url: '/api/sessions/session-1/timeline' });
    expect(timeline.json()).toEqual([expect.objectContaining({
      sessionId: 'session-1',
      source: 'system',
      trigger: expect.objectContaining({ description: 'GUI 测试日志' }),
    })]);

    const reports = await app.inject({ method: 'GET', url: '/api/reports' });
    expect(reports.json()).toEqual([
      expect.objectContaining({ name: 'demo.md', format: 'md', size: Buffer.byteLength('# 中文报告') }),
      expect.objectContaining({ name: 'demo.json', format: 'json', size: 11 }),
    ]);

    const memoryResponse = await app.inject({ method: 'GET', url: '/api/memory' });
    expect(memoryResponse.json()).toMatchObject({
      overview: expect.objectContaining({ testedItemCount: 1, targetCount: 1 }),
      targets: [expect.objectContaining({ name: 'demo' })],
    });

    const plugins = await app.inject({ method: 'GET', url: '/api/plugins' });
    expect(plugins.json()).toEqual([]);
    db.close();
  });

  it('缺少会话、未运行代理和缺少目标时返回错误', async () => {
    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    const app = handle.fastify;

    const missingSession = await app.inject({ method: 'GET', url: '/api/sessions/不存在' });
    expect(missingSession.statusCode).toBe(500);

    const stop = await app.inject({ method: 'POST', url: '/api/sessions/不存在/stop' });
    expect(stop.statusCode).toBe(500);

    const resume = await app.inject({ method: 'POST', url: '/api/sessions/不存在/resume' });
    expect(resume.statusCode).toBe(500);
  });

  it('停机接口返回中文状态并移除守护进程文件', async () => {
    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    const statePath = path.join(tempDir, '.wta', 'daemon.json');

    const response = await handle.fastify.inject({ method: 'POST', url: '/api/daemon/stop' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: '正在停止' });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await import('node:fs').then(fs => fs.existsSync(statePath))).toBe(false);
    handle = null;
  });
});
