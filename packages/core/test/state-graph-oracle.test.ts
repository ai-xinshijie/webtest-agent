import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/db/Database.js';
import { StateGraph } from '../src/testing/StateGraph.js';
import { SemanticOracle } from '../src/testing/SemanticOracle.js';
import type { StructuredObservation } from '../src/perception/types.js';

let directory = '';

function observation(overrides: Partial<StructuredObservation> = {}): StructuredObservation {
  return {
    type: 'structured', timestamp: 1, url: 'https://example.com/form', title: '表单',
    components: [{
      tag: 'input', role: 'textbox', classes: [], ariaLabel: '名称', placeholder: null, selector: '#name',
      state: { visible: true, enabled: true, inViewport: true, cursorPointer: false, userSelectNone: false },
      clickability: {
        score: 0.3, isInteractive: true, isHighConfidence: false,
        signals: { isSemanticTag: true, hasAriaRole: false, cursorPointer: false, hasOnclick: false, hasTabIndex: false },
      },
      rect: { x: 0, y: 0, w: 100, h: 20 },
    }],
    forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [],
    ...overrides,
  };
}

beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'wta-state-')); });
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = ''; });

describe('StateGraph', () => {
  it('复用相同观察的状态节点并持久化状态迁移', () => {
    const db = new DatabaseManager(path.join(directory, 'state.db'));
    db.prepare('INSERT INTO targets (id, name, url, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('target', '目标', 'https://example.com', '{}', 1, 1);
    db.prepare('INSERT INTO sessions (id, target_id, status, started_at) VALUES (?, ?, ?, ?)')
      .run('session', 'target', 'running', 1);
    db.prepare('INSERT INTO pages (id, target_id, url_pattern) VALUES (?, ?, ?)')
      .run('page', 'target', 'https://example.com/form');
    const graph = new StateGraph(db);
    const before = graph.observe('target', 'page', observation());
    const again = graph.observe('target', 'page', observation());
    const after = graph.observe('target', 'page', observation({ dialogCount: 1 }));
    const fallback = graph.observe('target', 'page', observation({ components: [{ ...observation().components[0]!, selector: null }] }));
    const transition = graph.recordTransition({
      sessionId: 'session', targetId: 'target', from: before, to: after, componentId: 'component', action: 'click',
      status: 'passed', evidence: { oracle: [] },
    });

    expect(again.id).toBe(before.id);
    expect(after.id).not.toBe(before.id);
    expect(fallback.id).not.toBe(before.id);
    expect(transition).toMatchObject({ fromStateId: before.id, toStateId: after.id, action: 'click', status: 'passed' });
    expect(db.prepare('SELECT visit_count FROM state_nodes WHERE id = ?').get(before.id)).toEqual({ visit_count: 2 });
    expect(db.prepare('SELECT action_type, status FROM state_transitions').get()).toEqual({ action_type: 'click', status: 'passed' });
    db.close();
  });
});

describe('SemanticOracle', () => {
  it('验证正常页面、非法提交与有效提交的语义结果', () => {
    const oracle = new SemanticOracle();
    const stable = oracle.evaluate({ action: 'click', before: observation(), after: observation() });
    expect(stable).toEqual([{ name: '页面稳定性', passed: true, detail: '未发现崩溃、服务端错误、白屏或持续加载' }]);

    const invalid = oracle.evaluate({ action: 'submit-empty', before: observation(), after: observation({
      networkEvents: [{ url: 'https://example.com/api/save', method: 'POST', status: 200, resourceType: 'xhr' }],
    }) });
    expect(invalid).toContainEqual({ name: '非法提交校验', passed: false, detail: '非法提交未显示校验且发出了写请求' });

    const validation = oracle.evaluate({ action: 'submit-partial', before: observation(), after: observation({
      components: [{ ...observation().components[0]!, classes: ['field-error'] }],
      networkEvents: [{ url: 'https://example.com/api/save', method: 'POST', status: 200, resourceType: 'xhr' }],
    }) });
    expect(validation).toContainEqual({ name: '非法提交校验', passed: true, detail: '非法提交未绕过校验' });

    const valid = oracle.evaluate({ action: 'submit-valid', before: observation(), after: observation({
      networkEvents: [{ url: 'https://example.com/api/save', method: 'POST', status: 201, resourceType: 'xhr' }],
    }) });
    expect(valid).toContainEqual({ name: '有效提交反馈', passed: true, detail: '有效提交产生了可验证反馈' });
  });

  it('报告崩溃、服务端失败、白屏和持续加载', () => {
    const oracle = new SemanticOracle();
    const crashed = oracle.evaluate({ action: 'click', before: observation(), after: observation({
      components: [], loadingOverlayCount: 1, consoleEvents: ['error: TypeError'],
      networkEvents: [{ url: 'https://example.com/api', method: 'GET', status: 500, resourceType: 'xhr' }],
    }) });
    expect(crashed[0]).toEqual({ name: '页面稳定性', passed: false, detail: '检测到页面稳定性异常' });

    const undefinedStatus = oracle.evaluate({ action: 'submit-valid', before: observation(), after: observation({
      networkEvents: [{ url: 'https://example.com/api/save', method: 'POST', resourceType: 'xhr' }],
    }) });
    expect(undefinedStatus).toContainEqual({ name: '有效提交反馈', passed: true, detail: '有效提交产生了可验证反馈' });

    const rejected = oracle.evaluate({ action: 'submit-valid', before: observation(), after: observation({
      networkEvents: [{ url: 'https://example.com/api/save', method: 'POST', status: 500, resourceType: 'xhr' }],
    }) });
    expect(rejected).toContainEqual({ name: '有效提交反馈', passed: false, detail: '有效提交未观察到可验证反馈' });
  });
});
