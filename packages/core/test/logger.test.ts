import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('输出控制台日志、复用序号并将不可序列化内容降级为字符串', () => {
    const database = createDatabase('session-console');
    const silent = new AgentLogger(database, 'session-console', { consoleOutput: false });
    silent.logUser(
      { description: '已有事件', module: '测试', method: 'user' }, { type: 'user' }, { status: 'warning' }, { phase: 'test' },
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = new AgentLogger(database, 'session-console', { consoleOutput: true });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const entry = logger.logSystem(
      { description: '控制台事件', module: '测试', method: 'console' },
      { type: 'cycle', params: cyclic },
      { status: 'failed', error: '详情错误', output: cyclic },
      { phase: 'test' },
    );
    expect(entry.sequence).toBe(2);
    expect((entry.action.params as Record<string, unknown>).self).toBe('[循环引用]');
    expect((entry.result.output as Record<string, unknown>).self).toBe('[循环引用]');
    expect(logger.getTimeline(0)).toHaveLength(2);
    expect(logger.getTimeline(1)).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[0002] system failed 控制台事件'));
    expect(warnSpy).toHaveBeenCalledWith('    详情错误');
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('不可 JSON 序列化值和非 Error 异常保留可读文本', async () => {
    const database = createDatabase('session-non-json');
    const logger = new AgentLogger(database, 'session-non-json', { consoleOutput: false });
    await expect(logger.runScript(
      { description: '抛出文本', module: '测试', method: 'throw-text' },
      { type: 'throw-text' },
      async () => { throw '文本异常'; },
      { phase: 'test' },
    )).rejects.toBe('文本异常');
    logger.logSystem(
      { description: '大整数', module: '测试', method: 'bigint' },
      { type: 'bigint', params: { value: BigInt(1) } },
      { status: 'success', output: BigInt(2) },
      { phase: 'test' },
    );
    const timeline = logger.getTimeline();
    expect(timeline[0]?.result.error).toBe('文本异常');
    expect((timeline[1]?.action.params as Record<string, unknown>).value).toBe('1');
    expect(timeline[1]?.result.output).toBe('2');
  });

  it('无法 JSON 编码的 Symbol 会降级为可读审计文本', () => {
    const database = createDatabase('session-symbol');
    const logger = new AgentLogger(database, 'session-symbol', { consoleOutput: false });
    const value = Symbol('审计值');
    const entry = logger.logSystem(
      { description: '符号值', module: '测试', method: 'symbol' },
      { type: 'symbol', params: value as never },
      { status: 'success', output: value },
      { phase: 'test' },
    );
    expect(entry.action.params).toBe('Symbol(审计值)');
    expect(entry.result.output).toBe('Symbol(审计值)');
  });

  it('审计文本覆盖空 token、模型前缀和 toJSON 异常降级', () => {
    const database = createDatabase('session-format');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new AgentLogger(database, 'session-format', { consoleOutput: true });
    const problematic = { toJSON: () => { throw new Error('无法编码'); } };
    const entry = logger.logSystem(
      { description: '降级对象', module: '测试', method: 'format' },
      { type: 'format', params: problematic as never },
      { status: 'success', output: problematic },
      { phase: 'test' },
    );
    expect(entry.action.params).toBe('[object Object]');
    expect(entry.result.output).toBe('[object Object]');
    expect(estimateTokens('')).toBe(0);
    (logger as any).print({ ...entry, model: { provider: 'openai', model: 'test', taskType: 'x' }, result: { status: 'success', duration: 1 } });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[openai/test]'));
    logSpy.mockRestore();
  });

  it('结构化降级保留数组、循环引用、特殊值和不可读字段', () => {
    const database = createDatabase('session-fallback');
    const logger = new AgentLogger(database, 'session-fallback', { consoleOutput: false }) as any;
    const cyclic: Record<string, unknown> = { value: BigInt(2), symbol: Symbol('x') };
    cyclic.self = cyclic;
    const unreadable: Record<string, unknown> = {};
    Object.defineProperty(unreadable, 'broken', { enumerable: true, get: () => { throw new Error('不可读'); } });
    expect(logger.cloneFallback([cyclic])).toEqual([{ value: '2', symbol: 'Symbol(x)', self: '[循环引用]' }]);
    expect(logger.cloneFallback(unreadable)).toEqual({ broken: '[无法读取]' });
    expect(logger.cloneFallback(null)).toBeNull();
    expect(logger.cloneFallback('文本')).toBe('文本');
  });

  it('没有历史序号时从零开始，并允许模型响应缺少文本', async () => {
    const inserts: unknown[][] = [];
    const fakeDb = {
      prepare: vi.fn((sql: string) => ({
        get: () => sql.includes('MAX(sequence)') ? undefined : undefined,
        all: () => [],
        run: (...args: unknown[]) => inserts.push(args),
      })),
    };
    const logger = new AgentLogger(fakeDb as never, 'empty', { consoleOutput: false });
    await logger.runModel(
      { description: '空模型文本', module: '测试', method: 'model' }, { type: 'model' },
      { provider: 'custom', model: 'empty', taskType: 'x', request: { messages: [] } },
      async () => ({ content: undefined as never }), { phase: 'test' },
    );
    expect(logger.getTimeline()[0]).toMatchObject({ sequence: 1, result: { output: '' } });
    expect(inserts).toHaveLength(1);
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
