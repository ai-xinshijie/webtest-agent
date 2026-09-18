import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/db/Database.js';
import { AgentLogger, estimateTokens } from '../src/logger/AgentLogger.js';
import { LLMRouter } from '../src/llm/LLMRouter.js';

let db: DatabaseManager;
let tempDir: string;

function createDatabase(sessionId = 'session-1'): DatabaseManager {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-logger-'));
  db = new DatabaseManager(path.join(tempDir, 'test.db'));
  db.prepare(`
    INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('target-1', '测试目标', 'https://example.com', '{}', Date.now(), Date.now());
  db.prepare(`
    INSERT INTO sessions (id, target_id, status, started_at, phase)
    VALUES (?, ?, 'running', ?, 'login')
  `).run(sessionId, 'target-1', Date.now());
  return db;
}

afterEach(() => {
  db?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('DatabaseManager', () => {
  it('创建全部数据表并支持事务回滚', () => {
    const database = createDatabase('db-session');
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all() as Array<{ name: string }>;
    const names = tables.map(table => table.name);

    expect(names).toContain('agent_logs');
    expect(names).toContain('memory_tested_items');
    expect(names).toContain('compiled_test_cases');

    expect(() => database.transaction(() => {
      database.prepare(`
        INSERT INTO pages (id, target_id, url_pattern, title, role, first_seen_at, last_visited_at, visit_count, test_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('page-1', 'target-1', '/a', '页面', 'unknown', Date.now(), Date.now(), 1, 'partial');
      throw new Error('主动失败');
    })).toThrow('主动失败');

    expect(database.prepare('SELECT COUNT(*) AS count FROM pages').get()).toEqual({ count: 0 });
  });
});

describe('AgentLogger', () => {
  it('记录脚本执行、模型调用并持久化完整时间线', async () => {
    const database = createDatabase();
    const logger = new AgentLogger(database, 'session-1', { consoleOutput: false });

    logger.logSystem(
      { description: '系统初始化', module: '测试', method: 'init' },
      { type: 'init' },
      { status: 'success', duration: 1 },
      { phase: 'login' },
    );

    const output = await logger.runScript(
      { description: '导航页面', module: '测试', method: 'goto' },
      { type: 'navigate', target: 'https://example.com' },
      async () => ({ url: 'https://example.com' }),
      { pageUrl: 'https://example.com', phase: 'explore' },
    );
    expect(output).toEqual({ url: 'https://example.com' });

    const response = await logger.runModel(
      { description: '识别组件', module: '测试', method: 'identify' },
      { type: 'identify', params: { componentCount: 1 } },
      {
        provider: 'openai',
        model: 'gpt-test',
        taskType: 'component-identify',
        request: { messages: [{ role: 'user', content: '识别这些组件' }] },
      },
      async () => ({ content: '识别完成', parsed: { type: 'button' } }),
      { phase: 'test' },
    );
    expect(response.parsed).toEqual({ type: 'button' });

    const timeline = logger.getTimeline();
    expect(timeline.map(log => log.source)).toEqual(['system', 'script', 'model']);
    expect(logger.getModelCalls()).toHaveLength(1);
    expect(timeline[2].model?.request.messages[0].content).toBe('识别这些组件');
    expect(timeline[2].result.output).toEqual({ type: 'button' });

    const rows = database.prepare(`
      SELECT source, log_json FROM agent_logs WHERE session_id = ? ORDER BY sequence
    `).all('session-1') as Array<{ source: string; log_json: string }>;
    expect(rows).toHaveLength(3);
    expect(JSON.parse(rows[2].log_json).model.model).toBe('gpt-test');
  });

  it('失败日志保留原始异常，模型日志记录失败结果', async () => {
    const database = createDatabase('session-2');
    const logger = new AgentLogger(database, 'session-2', { consoleOutput: false });

    await expect(logger.runScript(
      { description: '执行失败', module: '测试', method: 'fail' },
      { type: 'fail' },
      async () => { throw new Error('脚本失败'); },
      { phase: 'test' },
    )).rejects.toThrow('脚本失败');

    await expect(logger.runModel(
      { description: '模型失败', module: '测试', method: 'fail' },
      { type: 'model-fail' },
      {
        provider: 'anthropic',
        model: 'claude-test',
        taskType: 'quality-reasoning',
        request: { messages: [{ role: 'user', content: '判断质量' }] },
      },
      async () => { throw new Error('模型失败'); },
      { phase: 'test' },
    )).rejects.toThrow('模型失败');

    expect(logger.getTimeline().every(log => log.result.status === 'failed')).toBe(true);
    expect(logger.getModelCalls()[0].result.error).toBe('模型失败');
    expect(estimateTokens('abcabcabc')).toBe(3);
  });
});

describe('LLMRouter', () => {
  it('没有路由时返回中文错误', async () => {
    const database = createDatabase();
    const logger = new AgentLogger(database, 'session-1', { consoleOutput: false });
    const router = new LLMRouter({});

    await expect(router.call('component-identify', [
      { role: 'user', content: '识别组件' },
    ])).rejects.toThrow('未配置任务类型 component-identify 的模型路由');
    await expect(router.callWithLog('component-identify', [
      { role: 'user', content: '识别组件' },
    ], logger, { phase: 'test' })).rejects.toThrow('未配置任务类型 component-identify 的模型路由');
  });

  it('模型调用失败时写入中文错误和完整模型审计日志', async () => {
    const database = createDatabase();
    const logger = new AgentLogger(database, 'session-1', { consoleOutput: false });
    const router = new LLMRouter({
      'quality-reasoning': {
        provider: 'custom',
        model: 'custom-model',
        temperature: 0,
        maxTokens: 100,
      },
    });

    await expect(router.callWithLog('quality-reasoning', [
      { role: 'user', content: '判断质量' },
    ], logger, { phase: 'test' })).rejects.toThrow('自定义模型必须配置 baseUrl');

    const modelCall = logger.getModelCalls()[0];
    expect(modelCall.model?.provider).toBe('custom');
    expect(modelCall.model?.request.messages[0].content).toBe('判断质量');
    expect(modelCall.result.status).toBe('failed');
  });
});
