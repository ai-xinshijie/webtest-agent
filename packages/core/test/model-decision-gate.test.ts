import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { DatabaseManager } from '../src/db/Database.js';
import { AgentLogger } from '../src/logger/AgentLogger.js';
import { ModelDecisionGate } from '../src/decision/ModelDecisionGate.js';
import type { LLMRouter } from '../src/llm/LLMRouter.js';
import type { StructuredObservation } from '../src/perception/types.js';

let directory = '';
let database: DatabaseManager | null = null;

beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'wta-decision-')); });
afterEach(() => { database?.close(); database = null; if (directory) rmSync(directory, { recursive: true, force: true }); directory = ''; });

function createLogger(): AgentLogger {
  const db = new DatabaseManager(path.join(directory, 'decision.db'));
  database = db;
  db.prepare("INSERT INTO targets (id, name, url, config_json, created_at, updated_at) VALUES ('target', '目标', 'https://example.com', '{}', 1, 1)").run();
  db.prepare("INSERT INTO sessions (id, target_id, status, started_at, phase) VALUES ('session', 'target', 'running', 1, 'test')").run();
  return new AgentLogger(db, 'session', { consoleOutput: false });
}

function observation(extra: Partial<StructuredObservation> = {}): StructuredObservation {
  return {
    type: 'structured', timestamp: 1, url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [],
    components: [{ tag: 'button', role: 'button', text: '保存', classes: [], ariaLabel: null, placeholder: null, selector: '#save', rect: { x: 0, y: 0, w: 10, h: 10 }, state: { visible: true, enabled: true, inViewport: true, cursorPointer: true, userSelectNone: false }, clickability: { score: 1, isInteractive: true, isHighConfidence: true, signals: { isSemanticTag: true, hasAriaRole: true, cursorPointer: true, hasOnclick: false, hasTabIndex: false } } }],
    ...extra,
  };
}

function input(page: Page, before = observation(), after = observation({ dialogCount: 1 })): any {
  return { page, pageUrl: 'https://example.com/page', before, after, executedAction: { componentId: 'save', action: 'click', label: '保存' }, candidates: [{ id: 'dialog:close', componentId: 'dialog', action: 'close-esc', label: '关闭弹窗 / close-esc' }] };
}

describe('ModelDecisionGate', () => {
  it('未配置视觉模型或没有候选动作时直接回退，不截图', async () => {
    const page = { screenshot: vi.fn() } as unknown as Page;
    const logger = createLogger();
    const inputValue = input(page);

    await expect(new ModelDecisionGate(undefined, logger).selectNext(inputValue)).resolves.toBeNull();
    await expect(new ModelDecisionGate({ callVisionWithLog: vi.fn() } as unknown as LLMRouter, logger).selectNext({ ...inputValue, candidates: [] })).resolves.toBeNull();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(logger.getTimeline().filter(item => item.trigger.description === '跳过视觉模型决策')).toHaveLength(2);
  });

  it('页面无语义变化时不调用模型或截图', async () => {
    const callVisionWithLog = vi.fn();
    const page = { screenshot: vi.fn() } as unknown as Page;
    const gate = new ModelDecisionGate({ callVisionWithLog } as unknown as LLMRouter, createLogger());
    await expect(gate.selectNext(input(page, observation(), observation()))).resolves.toBeNull();
    expect(callVisionWithLog).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(gate['logger'].getTimeline().at(-1)?.result.output).toEqual({ reason: '页面未发生语义变化，跳过视觉模型决策' });
  });

  it('状态变化后携带截图调用模型，并且只接受候选列表内的动作', async () => {
    const callVisionWithLog = vi.fn().mockResolvedValue('{"candidateId":"dialog:close","reason":"弹窗已出现","expectedState":"弹窗关闭"}');
    const page = { screenshot: vi.fn().mockResolvedValue(Buffer.from('image')) } as unknown as Page;
    const logger = createLogger();
    const gate = new ModelDecisionGate({ callVisionWithLog } as unknown as LLMRouter, logger);
    await expect(gate.selectNext(input(page))).resolves.toEqual({ candidateId: 'dialog:close', reason: '弹窗已出现', expectedState: '弹窗关闭' });
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png', fullPage: false }));
    expect(callVisionWithLog).toHaveBeenCalledWith('visual-analysis', expect.any(Array), 'aW1hZ2U=', logger, expect.objectContaining({ phase: 'test' }));
    expect(logger.getTimeline().some(item => item.trigger.description === '模型决定下一测试动作优先级')).toBe(true);
  });

  it('非法 JSON、未知候选和超过单页决策上限时回退到脚本计划', async () => {
    const callVisionWithLog = vi.fn()
      .mockResolvedValueOnce('不是 JSON')
      .mockResolvedValueOnce('{"candidateId":"未知动作","reason":"x","expectedState":"y"}')
      .mockResolvedValue('{"candidateId":"dialog:close","reason":"x","expectedState":"y"}');
    const page = { screenshot: vi.fn().mockResolvedValue(Buffer.from('image')) } as unknown as Page;
    const logger = createLogger();
    const gate = new ModelDecisionGate({ callVisionWithLog } as unknown as LLMRouter, logger, 3);
    await expect(gate.selectNext(input(page))).resolves.toBeNull();
    await expect(gate.selectNext(input(page, observation(), observation({ dialogCount: 2 })))).resolves.toBeNull();
    await expect(gate.selectNext(input(page, observation(), observation({ dialogCount: 3 })))).resolves.not.toBeNull();
    await expect(gate.selectNext(input(page, observation(), observation({ dialogCount: 4 })))).resolves.toBeNull();
    expect(callVisionWithLog).toHaveBeenCalledTimes(3);
    expect(logger.getTimeline().filter(item => item.result.status === 'warning')).toHaveLength(2);
    expect(logger.getTimeline().some(item => item.result.output?.reason === '已达到当前页面视觉模型决策上限，继续执行脚本计划')).toBe(true);
  });

  it('相同语义状态不会重复调用视觉模型', async () => {
    const callVisionWithLog = vi.fn().mockResolvedValue('{"candidateId":"dialog:close","reason":"处理弹窗","expectedState":"弹窗关闭"}');
    const page = { screenshot: vi.fn().mockResolvedValue(Buffer.from('image')) } as unknown as Page;
    const logger = createLogger();
    const gate = new ModelDecisionGate({ callVisionWithLog } as unknown as LLMRouter, logger, 3);
    await expect(gate.selectNext(input(page))).resolves.not.toBeNull();
    await expect(gate.selectNext(input(page))).resolves.toBeNull();
    expect(callVisionWithLog).toHaveBeenCalledTimes(1);
    expect(logger.getTimeline().some(item => item.result.output?.reason === '当前语义状态已经咨询过视觉模型，避免重复决策')).toBe(true);
  });

  it('按页面隔离状态去重和视觉决策配额', async () => {
    const callVisionWithLog = vi.fn().mockResolvedValue('{"candidateId":"dialog:close","reason":"继续测试弹窗关闭","expectedState":"弹窗关闭"}');
    const page = { screenshot: vi.fn().mockResolvedValue(Buffer.from('image')) } as unknown as Page;
    const gate = new ModelDecisionGate({ callVisionWithLog } as unknown as LLMRouter, createLogger(), 1);

    await expect(gate.selectNext(input(page))).resolves.not.toBeNull();
    await expect(gate.selectNext(input(page, observation(), observation({ dialogCount: 2 })))).resolves.toBeNull();
    await expect(gate.selectNext({ ...input(page), pageUrl: 'https://example.com/other', after: observation({ url: 'https://example.com/other', dialogCount: 1 }) })).resolves.not.toBeNull();

    expect(callVisionWithLog).toHaveBeenCalledTimes(2);
  });

  it('视觉模型异常时记录中文回退日志，并兼容非 Error 异常', async () => {
    const callVisionWithLog = vi.fn().mockRejectedValue('服务暂时不可用');
    const page = { screenshot: vi.fn().mockResolvedValue(Buffer.from('image')) } as unknown as Page;
    const logger = createLogger();
    const gate = new ModelDecisionGate({ callVisionWithLog } as unknown as LLMRouter, logger);

    await expect(gate.selectNext(input(page))).resolves.toBeNull();
    const warning = logger.getTimeline().find(item => item.result.status === 'warning');
    expect(warning?.result.error).toContain('服务暂时不可用');
  });

  it('支持 JSON 代码块响应并截断过长解释', async () => {
    const longText = '说明'.repeat(400);
    const callVisionWithLog = vi.fn().mockResolvedValue('```json\n{\"candidateId\":\"dialog:close\",\"reason\":\"' + longText + '\",\"expectedState\":\"' + longText + '\"}\n```');
    const page = { screenshot: vi.fn().mockResolvedValue(Buffer.from('image')) } as unknown as Page;
    const gate = new ModelDecisionGate({ callVisionWithLog } as unknown as LLMRouter, createLogger());
    const result = await gate.selectNext(input(page));

    expect(result?.reason).toHaveLength(500);
    expect(result?.expectedState).toHaveLength(500);
  });

  it('候选协议字段不完整时拒绝响应，并兼容空页面地址和缺省组件字段', () => {
    const gate = new ModelDecisionGate(undefined, createLogger()) as any;
    const candidates = [{ id: 'dialog:close', componentId: 'dialog', action: 'close-esc', label: '关闭' }];
    expect(gate.parseDecision('{"candidateId":"dialog:close","reason":"缺少预期状态"}', candidates)).toBeNull();
    expect(gate.pageKey({ pageUrl: '', after: observation({ url: 'https://example.com/fallback' }) })).toBe('https://example.com/fallback');
    const sparse = observation({
      components: [{ ...observation().components[0]!, selector: null, role: null, text: undefined, parentDialog: undefined }],
    });
    expect(gate.fingerprint(sparse)).toContain('button');
    expect(gate.describeChange(observation({ url: 'https://before.example', title: '前标题' }), observation({ url: 'https://after.example', title: '后标题' }))).toMatchObject({
      地址变化: { 前: 'https://before.example', 后: 'https://after.example' },
      标题变化: { 前: '前标题', 后: '后标题' },
    });
    expect(gate.errorMessage(new Error('视觉错误'))).toBe('视觉错误');
  });
});
