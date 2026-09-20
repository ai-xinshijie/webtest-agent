import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startGuiServer, type GuiServerHandle } from '../src/server.js';
import { ConfigManager, DatabaseManager, type TargetConfig } from '@wta/core';

vi.mock('@wta/core', async () => {
  const actual = await vi.importActual<typeof import('@wta/core')>('@wta/core');

  class MockOrchestrator {
    static instances: MockOrchestrator[] = [];
    run = vi.fn(async (_target: TargetConfig, options: { sessionId: string }) => ({
      sessionId: options.sessionId,
    }));
    stop = vi.fn(async () => undefined);
    resume = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);

    constructor() {
      MockOrchestrator.instances.push(this);
    }
  }

  return { ...actual, Orchestrator: MockOrchestrator, MockOrchestrator };
});

let tempDir = '';
let handle: GuiServerHandle | null = null;

beforeEach(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-gui-run-'));
  const core = await import('@wta/core') as unknown as {
    MockOrchestrator: { instances: unknown[] };
  };
  core.MockOrchestrator.instances = [];
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

describe('GUI 运行控制接口', () => {
  it('提交测试、恢复、停止并处理异步执行失败', async () => {
    mkdirSync(path.join(tempDir, '.wta', 'targets'), { recursive: true });
    mkdirSync(path.join(tempDir, 'packages', 'web', 'dist'), { recursive: true });
    writeFileSync(
      path.join(tempDir, '.wta', 'targets', 'demo.json'),
      JSON.stringify(createTarget()),
      'utf-8',
    );
    writeFileSync(path.join(tempDir, 'packages', 'web', 'dist', 'index.html'), 'GUI 页面', 'utf-8');

    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
      errors.push(values.map(value => String(value)).join(' '));
    });

    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    const app = handle.fastify;

    const home = await app.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toBe('GUI 页面');

    const invalidConfig = await app.inject({ method: 'PUT', url: '/api/config', payload: null });
    expect(invalidConfig.statusCode).toBe(500);
    expect(invalidConfig.json().message).toBe('配置格式不正确');

    const missingTarget = await app.inject({ method: 'POST', url: '/api/run', payload: {} });
    expect(missingTarget.statusCode).toBe(500);
    expect(missingTarget.json().message).toBe('必须提供测试目标名称');

    const unknownTarget = await app.inject({ method: 'POST', url: '/api/run', payload: { target: '不存在' } });
    expect(unknownTarget.statusCode).toBe(500);
    expect(unknownTarget.json().message).toBe('未找到测试目标：不存在');

    const config = new ConfigManager(tempDir).load();
    const db = new DatabaseManager(config.dbPath);
    db.prepare(`
      INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES ('demo', 'demo', 'https://example.com', '{}', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at, phase)
      VALUES ('session-1', 'demo', 'paused', 1, 'test')
    `).run();
    db.prepare(`
      INSERT INTO pages (id, target_id, url_pattern, title, first_seen_at, last_visited_at)
      VALUES ('page-1', 'demo', 'https://example.com/page', '页面', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO components (id, target_id, page_id, type, selector, label, created_at, updated_at)
      VALUES ('component-1', 'demo', 'page-1', 'button', '#button', '按钮', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO navigation_macros (id, target_id, component_id, steps_json, cached_at)
      VALUES ('macro-1', 'demo', 'component-1', '[]', 1)
    `).run();
    db.prepare(`
      INSERT INTO compiled_test_cases (id, target_id, component_id, test_type, navigation_macro_id, actions_json, assertions_json, created_at, updated_at)
      VALUES ('case-1', 'demo', 'component-1', 'click', 'macro-1', '[]', '["按钮可点击"]', 1, 1)
    `).run();
    db.close();

    const testCases = await app.inject({ method: 'GET', url: '/api/test-cases?target=demo' });
    expect(testCases.json()).toEqual([expect.objectContaining({ id: 'case-1', componentLabel: '按钮' })]);
    const missingCase = await app.inject({ method: 'POST', url: '/api/test-cases/missing/run', payload: {} });
    expect(missingCase.statusCode).toBe(500);
    expect(missingCase.json().message).toBe('未找到测试用例：missing');
    const caseRun = await app.inject({ method: 'POST', url: '/api/test-cases/case-1/run', payload: { headless: false } });
    expect(caseRun.statusCode).toBe(202);
    expect(caseRun.json()).toMatchObject({ status: 'running', testCaseId: 'case-1' });

    const run = await app.inject({
      method: 'POST',
      url: '/api/run',
      payload: {
        target: 'demo',
        mode: 'expand',
        phase: 'combo',
        parallel: 3,
        headless: false,
        resume: true,
      },
    });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toEqual({ sessionId: 'session-1', status: 'running', target: 'demo' });

    const core = await import('@wta/core') as unknown as {
      MockOrchestrator: {
        instances: Array<{
          run: ReturnType<typeof vi.fn>;
          stop: ReturnType<typeof vi.fn>;
          resume: ReturnType<typeof vi.fn>;
        }>;
      };
    };
    const instance = core.MockOrchestrator.instances.at(-1)!;
    await new Promise(resolve => setImmediate(resolve));
    expect(instance.run).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'demo' }),
      expect.objectContaining({
        sessionId: 'session-1',
        resumeSessionId: 'session-1',
        runMode: 'expand',
        phase: 'combo',
        parallel: 3,
        headless: false,
      }),
    );
    expect(instance.run).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'demo' }),
      expect.objectContaining({ runMode: 'retest', phase: 'test', parallel: 1, headless: false, caseIds: ['case-1'] }),
    );

    const resume = await app.inject({ method: 'POST', url: '/api/sessions/session-1/resume' });
    expect(resume.statusCode).toBe(200);
    expect(instance.resume).toHaveBeenCalledWith('session-1');

    const stop = await app.inject({ method: 'POST', url: '/api/sessions/session-1/stop' });
    expect(stop.statusCode).toBe(200);
    expect(instance.stop).toHaveBeenCalledWith('session-1');

    instance.run.mockRejectedValueOnce(new Error('浏览器启动失败'));
    const failedRun = await app.inject({ method: 'POST', url: '/api/run', payload: { target: 'demo' } });
    expect(failedRun.statusCode).toBe(202);
    await new Promise(resolve => setImmediate(resolve));
    expect(errors.join('\n')).toContain('测试会话执行失败');
    expect(errors.join('\n')).toContain('浏览器启动失败');

    instance.run.mockRejectedValueOnce(new Error('用例执行失败'));
    const failedCaseRun = await app.inject({ method: 'POST', url: '/api/test-cases/case-1/run' });
    expect(failedCaseRun.statusCode).toBe(202);
    await new Promise(resolve => setImmediate(resolve));
    expect(errors.join('\n')).toContain('测试用例执行失败');
    expect(errors.join('\n')).toContain('用例执行失败');

    instance.run.mockRejectedValueOnce('字符串错误');
    const stringFailedCaseRun = await app.inject({ method: 'POST', url: '/api/test-cases/case-1/run' });
    expect(stringFailedCaseRun.statusCode).toBe(202);
    await new Promise(resolve => setImmediate(resolve));
    expect(errors.join('\n')).toContain('字符串错误');

    const reports = await app.inject({ method: 'GET', url: '/api/reports' });
    expect(reports.json()).toEqual([]);
    errorSpy.mockRestore();
  });

  it('通过 WebSocket 推送会话状态', async () => {
    handle = await startGuiServer({ rootDir: tempDir, port: 0, host: '127.0.0.1' });
    const WebSocketConstructor = globalThis.WebSocket;
    const socket = new WebSocketConstructor(`ws://127.0.0.1:${handle.port}/ws`);
    const firstMessage = new Promise<string>(resolve => {
      socket.addEventListener('message', event => resolve(String((event as MessageEvent).data)));
    });
    socket.addEventListener('open', () => {
      socket.send('刷新');
    });
    const raw = await firstMessage;
    const message = JSON.parse(raw) as { type: string; sessions: unknown[] };
    expect(message).toMatchObject({ type: 'status', sessions: [] });
    socket.close();
    await new Promise(resolve => setImmediate(resolve));
  });
});
