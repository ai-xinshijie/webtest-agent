import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { AgentLogger } from '../src/logger/AgentLogger.js';
import { DatabaseManager } from '../src/db/Database.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { TestEngine } from '../src/tester/TestEngine.js';
import type { InteractionExecutor } from '../src/tester/InteractionExecutor.js';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-engine-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function createDatabase() {
  const db = new DatabaseManager(path.join(tempDir, 'engine.db'));
  db.prepare(`
    INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
    VALUES ('demo', '演示系统', 'https://example.com', '{}', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO sessions (id, target_id, status, started_at, phase)
    VALUES ('session-1', 'demo', 'running', 1, 'test')
  `).run();
  return db;
}

function addPage(db: DatabaseManager, id: string, url: string) {
  db.prepare(`
    INSERT INTO pages (id, target_id, url_pattern, title, first_seen_at, last_visited_at)
    VALUES (?, 'demo', ?, '页面', 1, 1)
  `).run(id, url);
}

function addComponent(
  db: DatabaseManager,
  id: string,
  pageId: string,
  type: string,
  selector: string,
  state: Record<string, unknown> = { visible: true, enabled: true },
) {
  db.prepare(`
    INSERT INTO components
      (id, target_id, page_id, type, selector, label, state_json, created_at, updated_at)
    VALUES (?, 'demo', ?, ?, ?, ?, ?, 1, 1)
  `).run(id, pageId, type, selector, `${type}组件`, JSON.stringify(state));
}

function addEdge(db: DatabaseManager, from: string, to: string) {
  db.prepare(`
    INSERT INTO navigation_edges (id, target_id, from_page_id, to_page_id, method)
    VALUES (?, 'demo', ?, ?, 'click')
  `).run(`${from}-${to}`, from, to);
}

function createPage() {
  return {
    url: vi.fn().mockReturnValue('https://example.com/page'),
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => ({
      components: [{ selector: '#visible', tag: 'button' }],
      title: '演示页面',
      forms: [],
      dialogs: 0,
      loadingOverlays: 0,
    })),
    locator: vi.fn(() => ({ all: async () => [] })),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    mouse: { click: vi.fn().mockResolvedValue(undefined) },
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
    unroute: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function createExecutor(failActions: string[] = []) {
  return {
    executeAction: vi.fn(async (_page: Page, _component: unknown, action: string) => {
      if (failActions.includes(action)) throw new Error('动作执行失败');
    }),
  } as unknown as InteractionExecutor;
}

function createEngine(
  db: DatabaseManager,
  memory: MemoryManager,
  executor: InteractionExecutor,
  options: Partial<ConstructorParameters<typeof TestEngine>[4]> = {},
) {
  return new TestEngine(
    db,
    memory,
    new AgentLogger(db, 'session-1', { consoleOutput: false }),
    executor,
    {
      targetId: 'demo',
      sessionId: 'session-1',
      runMode: 'continue',
      depth: 'quick',
      ...options,
    },
  );
}

describe('TestEngine', () => {
  it('指定用例时仅执行目标动作并回写用例执行次数', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    db.prepare(`
      INSERT INTO navigation_macros (id, target_id, component_id, steps_json, cached_at)
      VALUES ('macro-1', 'demo', 'button-1', '[]', 1)
    `).run();
    db.prepare(`
      INSERT INTO compiled_test_cases
        (id, target_id, component_id, test_type, navigation_macro_id, actions_json, assertions_json, created_at, updated_at)
      VALUES ('case-click', 'demo', 'button-1', 'click', 'macro-1', '[]', '[]', 1, 1)
    `).run();
    const executor = createExecutor();

    const selected = await createEngine(db, new MemoryManager(db), executor, {
      runMode: 'fresh', phase: 'test', enableChaos: false, caseIds: ['case-click'],
    }).run(createPage(), [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);
    expect(selected.executedActions).toBe(1);
    expect(executor.executeAction).toHaveBeenCalledTimes(1);
    expect(executor.executeAction).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'click', expect.anything());
    expect(db.prepare(`SELECT execute_count, last_passed_at FROM compiled_test_cases WHERE id = 'case-click'`).get()).toEqual({ execute_count: 1, last_passed_at: expect.any(Number) });

    const missing = await createEngine(db, new MemoryManager(db), createExecutor(), {
      runMode: 'fresh', phase: 'test', enableChaos: false, caseIds: ['missing'],
    }).run(createPage(), [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);
    expect(missing.executedActions).toBe(0);
    expect(missing.coverage.actions).toEqual({ visited: 0, reused: 0, blocked: 0, pending: 0, percentage: 0, resolvedPercentage: 0 });
    db.close();
  });

  it('历史记录缺少页面指纹时强制重测，失败仍计入覆盖', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    addComponent(db, 'link-1', 'page-1', 'link', '#link-1');
    addComponent(db, 'unknown-1', 'page-1', 'custom', '#custom-1');
    const memory = new MemoryManager(db);
    memory.markTested('demo', {
      itemKey: 'demo:button-1:click',
      componentId: 'button-1',
      testType: 'click',
      status: 'passed',
    });

    const engine = createEngine(db, memory, createExecutor(['right-click']), {
      runMode: 'continue',
      phase: 'test',
      enableChaos: false,
    });
    const result = await engine.run(createPage(), [
      { id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' },
    ]);

    expect(result.executedActions).toBe(5);
    expect(result.skippedActions).toBe(0);
    expect(result.coverage.actions).toEqual({ visited: 5, reused: 0, blocked: 0, pending: 0, percentage: 100, resolvedPercentage: 100 });

    const statuses = (db.prepare('SELECT status, COUNT(*) AS count FROM test_results GROUP BY status').all() as any[])
      .reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {});
    expect(statuses).toEqual({ passed: 4, failed: 1 });
    expect(memory.getTestedItems('demo')).toHaveLength(5);
    db.close();
  });

  it('不可见或禁用组件记录为受阻覆盖，不尝试执行 Playwright 动作', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'hidden-button', 'page-1', 'button', '#hidden', { visible: false, enabled: true });
    addComponent(db, 'disabled-link', 'page-1', 'link', '#disabled', { visible: true, enabled: false });
    const executor = createExecutor();

    const result = await createEngine(db, new MemoryManager(db), executor, {
      runMode: 'fresh',
      phase: 'test',
      enableChaos: false,
    }).run(createPage(), [
      { id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' },
    ]);

    expect(executor.executeAction).not.toHaveBeenCalled();
    expect(result.executedActions).toBe(0);
    expect(result.skippedActions).toBe(4);
    expect(result.coverage.actions).toEqual({ visited: 0, reused: 0, blocked: 4, pending: 0, percentage: 0, resolvedPercentage: 100 });
    const reasons = (db.prepare('SELECT output_json FROM test_results').all() as Array<{ output_json: string }>)
      .map(row => JSON.parse(row.output_json).reason)
      .sort();
    expect(reasons).toEqual([
      '组件当前不可见，尚未获得可达性探测能力',
      '组件当前不可见，尚未获得可达性探测能力',
      '组件当前不可见，尚未获得可达性探测能力',
      '组件当前已禁用，需要满足业务前置条件后重测',
    ].sort());
    db.close();
  });

  it('组合和路径首次执行后可被记忆完整跳过', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page-1');
    addPage(db, 'page-2', 'https://example.com/page-2');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    addComponent(db, 'button-2', 'page-1', 'button', '#button-2');
    addEdge(db, 'page-1', 'page-2');
    const pages = [
      { id: 'page-1', url_pattern: 'https://example.com/page-1', title: '页面一' },
      { id: 'page-2', url_pattern: 'https://example.com/page-2', title: '页面二' },
    ];
    const memory = new MemoryManager(db);

    const first = await createEngine(db, memory, createExecutor(), {
      runMode: 'fresh',
      phase: 'combo',
      enablePaths: true,
      enableChaos: false,
    }).run(createPage(), pages);

    expect(first.executedActions).toBe(6);
    expect(first.executedCombinations).toBe(5);
    expect(first.executedPaths).toBe(1);
    expect(first.coverage.combinations).toEqual({ covered: 5, reused: 0, blocked: 0, total: 5, percentage: 100, resolvedPercentage: 100 });
    expect(first.coverage.paths).toEqual({ covered: 1, reused: 0, blocked: 0, total: 1, percentage: 100, resolvedPercentage: 100 });

    const second = await createEngine(db, memory, createExecutor(), {
      runMode: 'continue',
      phase: 'combo',
      enablePaths: true,
      enableChaos: false,
    }).run(createPage(), pages);

    expect(second.executedActions).toBe(0);
    expect(second.skippedActions).toBe(6);
    expect(second.executedCombinations).toBe(0);
    expect(second.skippedCombinations).toBe(5);
    expect(second.executedPaths).toBe(1);
    expect(second.skippedPaths).toBe(0);
    expect(second.coverage.actions).toMatchObject({ visited: 0, reused: 6, percentage: 0, resolvedPercentage: 100 });
    expect(second.coverage.combinations).toMatchObject({ covered: 0, reused: 5, percentage: 0, resolvedPercentage: 100 });
    expect(second.coverage.paths.percentage).toBe(100);
    db.close();
  });

  it('回归、发散和继续模式使用不同记忆跳过策略', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    const pages = [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }];
    const memory = new MemoryManager(db);
    memory.markTested('demo', {
      itemKey: 'demo:button-1:click',
      componentId: 'button-1',
      testType: 'click',
      status: 'passed',
    });
    memory.markTested('demo', {
      itemKey: 'demo:button-1:right-click',
      componentId: 'button-1',
      testType: 'right-click',
      status: 'failed',
    });

    const regression = await createEngine(db, memory, createExecutor(['right-click']), {
      runMode: 'regression',
      phase: 'test',
      enableChaos: false,
    }).run(createPage(), pages);
    expect(regression.executedActions).toBe(2);
    expect(regression.skippedActions).toBe(1);

    const expand = await createEngine(db, memory, createExecutor(), {
      runMode: 'expand',
      phase: 'test',
      enableChaos: false,
    }).run(createPage(), pages);
    expect(expand.executedActions).toBe(1);
    expect(expand.skippedActions).toBe(2);

    const continueRun = await createEngine(db, memory, createExecutor(), {
      runMode: 'continue',
      phase: 'test',
      enableChaos: false,
    }).run(createPage(), pages);
    expect(continueRun.executedActions).toBe(0);
    expect(continueRun.skippedActions).toBe(3);
    db.close();
  });

  it('仅在页面指纹一致时复用通过动作，页面变更后强制重测', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    const memory = new MemoryManager(db);
    const page = createPage();
    const first = await createEngine(db, memory, createExecutor(), {
      runMode: 'fresh', phase: 'test', enableChaos: false,
    }).run(page, [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);
    expect(first.executedActions).toBe(3);

    const samePage = createPage();
    const reused = await createEngine(db, memory, createExecutor(), {
      runMode: 'continue', phase: 'test', enableChaos: false,
    }).run(samePage, [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);
    expect(reused.executedActions).toBe(0);
    expect(reused.coverage.actions).toMatchObject({ reused: 3, percentage: 0, resolvedPercentage: 100 });

    const changedPage = createPage();
    (changedPage.evaluate as any).mockResolvedValue({
      components: [{ selector: '#visible', tag: 'button' }, { selector: '#new', tag: 'input' }],
      title: '演示页面', forms: [], dialogs: 0, loadingOverlays: 0,
    });
    const retested = await createEngine(db, memory, createExecutor(), {
      runMode: 'continue', phase: 'test', enableChaos: false,
    }).run(changedPage, [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);
    expect(retested.executedActions).toBe(3);
    expect(retested.coverage.actions).toMatchObject({ visited: 3, reused: 0, percentage: 100 });
    db.close();
  });

  it('深度混沌阶段注入并恢复三类网络故障', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    const page = createPage();
    const result = await createEngine(db, new MemoryManager(db), createExecutor(), {
      runMode: 'continue',
      depth: 'deep',
      phase: 'chaos',
    }).run(page, [
      { id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' },
    ]);

    expect(result.chaosTests).toBe(3);
    expect(result.executedActions).toBe(0);
    expect(page.route).toHaveBeenCalledTimes(3);
    expect(page.unroute).toHaveBeenCalledTimes(3);
    const chaosResults = db.prepare(`
      SELECT test_type, status FROM test_results WHERE test_type LIKE 'chaos-%' ORDER BY test_type
    `).all();
    expect(chaosResults).toEqual([
      { test_type: 'chaos-http-500', status: 'passed' },
      { test_type: 'chaos-offline', status: 'passed' },
      { test_type: 'chaos-slow', status: 'passed' },
    ]);
    db.close();
  });

  it('非深度模式和空页面不执行混沌测试', async () => {
    const db = createDatabase();
    const quick = await createEngine(db, new MemoryManager(db), createExecutor(), {
      phase: 'chaos',
      depth: 'quick',
    }).run(createPage(), []);
    const empty = await createEngine(db, new MemoryManager(db), createExecutor(), {
      phase: 'chaos',
      depth: 'deep',
    }).run(createPage(), []);

    expect(quick.chaosTests).toBe(0);
    expect(empty.chaosTests).toBe(0);
    db.close();
  });

  it('页面导航短暂失败时重试后继续完成动作测试', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    const page = createPage();
    (page.goto as any).mockRejectedValueOnce(new Error('临时网络超时')).mockResolvedValue(undefined);

    const result = await createEngine(db, new MemoryManager(db), createExecutor(), {
      runMode: 'fresh',
      phase: 'test',
      enableChaos: false,
    }).run(page, [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);

    expect(page.goto).toHaveBeenCalledTimes(5);
    expect(result.executedActions).toBe(3);
    expect(result.coverage.actions.percentage).toBe(100);
    db.close();
  });

  it('页面连续不可访问时把动作记录为受阻并继续结束会话', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    const page = createPage();
    (page.goto as any).mockRejectedValue(new Error('目标暂时不可访问'));
    const executor = createExecutor();

    const result = await createEngine(db, new MemoryManager(db), executor, {
      runMode: 'fresh', phase: 'test', enableChaos: false,
    }).run(page, [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);

    expect(executor.executeAction).not.toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledTimes(3);
    expect(result.coverage.actions).toEqual({ visited: 0, reused: 0, blocked: 3, pending: 0, percentage: 0, resolvedPercentage: 100 });
    const blocked = db.prepare('SELECT status, output_json FROM test_results').all() as Array<{ status: string; output_json: string }>;
    expect(blocked).toHaveLength(3);
    expect(blocked.every(item => item.status === 'skipped' && JSON.parse(item.output_json).reason.includes('页面不可访问'))).toBe(true);
    db.close();
  });

  it('动作后页面复位连续失败时保留已执行动作并阻断剩余动作', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    const page = createPage();
    (page.goto as any).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('页面复位失败'));
    const result = await createEngine(db, new MemoryManager(db), createExecutor(), {
      runMode: 'fresh', phase: 'test', enableChaos: false,
    }).run(page, [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);

    expect(result.executedActions).toBe(1);
    expect(result.coverage.actions).toMatchObject({ visited: 1, blocked: 2, pending: 0, resolvedPercentage: 100 });
    expect(result.coverage.actions.percentage).toBeCloseTo(100 / 3);
    const statuses = db.prepare('SELECT status FROM test_results ORDER BY started_at').all() as Array<{ status: string }>;
    expect(statuses.filter(item => item.status === 'skipped')).toHaveLength(2);
    db.close();
  });

  it('组合阶段页面连续不可访问时将剩余组合标记为受阻', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    addComponent(db, 'button-2', 'page-1', 'button', '#button-2');
    const page = createPage();
    let navigation = 0;
    (page.goto as any).mockImplementation(async () => {
      navigation++;
      if (navigation > 7) throw new Error('组合页不可访问');
    });
    const result = await createEngine(db, new MemoryManager(db), createExecutor(), {
      runMode: 'fresh', phase: 'combo', enablePaths: false, enableChaos: false,
    }).run(page, [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);

    expect(result.executedActions).toBe(6);
    expect(result.executedCombinations).toBe(0);
    expect(result.skippedCombinations).toBe(5);
    expect(result.coverage.combinations).toEqual({ covered: 0, reused: 0, blocked: 5, total: 5, percentage: 0, resolvedPercentage: 100 });
    const combinations = db.prepare("SELECT status FROM test_results WHERE test_type = 'combination-1way'").all() as Array<{ status: string }>;
    expect(combinations).toHaveLength(5);
    expect(combinations.every(item => item.status === 'skipped')).toBe(true);
    db.close();
  });

  it('组合中任一动作失败时保留失败组合结果并继续覆盖其余组合', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    addComponent(db, 'button-2', 'page-1', 'button', '#button-2');
    const result = await createEngine(db, new MemoryManager(db), createExecutor(['double-click']), {
      runMode: 'fresh', phase: 'combo', enablePaths: false, enableChaos: false,
    }).run(createPage(), [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);

    expect(result.executedCombinations).toBe(5);
    const combinations = db.prepare("SELECT status FROM test_results WHERE test_type = 'combination-1way'").all() as Array<{ status: string }>;
    expect(combinations.some(item => item.status === 'failed')).toBe(true);
    expect(combinations.some(item => item.status === 'passed')).toBe(true);
    db.close();
  });

  it('路径导航失败与缺省组件字段均可记录为可读测试结果', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page-1');
    addPage(db, 'page-2', 'https://example.com/page-2');
    addEdge(db, 'page-1', 'page-2');
    const engine = createEngine(db, new MemoryManager(db), createExecutor(), {
      runMode: 'fresh', phase: 'explore', enablePaths: true, enableChaos: false,
    }) as any;
    const page = createPage();
    (page.goto as any).mockRejectedValue(new Error('路径页面不可访问'));
    await engine.testPaths(page);
    const result = db.prepare("SELECT status, output_json FROM test_results WHERE test_type = 'path-coverage'").get() as any;
    expect(result.status).toBe('failed');
    expect(JSON.parse(result.output_json).error).toContain('页面导航连续 3 次失败');

    expect(engine.getActions('unknown')).toEqual(['click']);
    expect(engine.getUnavailableReason({ state: { visible: true, enabled: true } })).toBeNull();
    expect(engine.toExtracted({ id: 'raw', page_id: 'page-1', type: 'custom', selector: '#raw', label: null, state_json: null, constraints_json: null }))
      .toMatchObject({ role: null, text: undefined, ariaLabel: null, state: { visible: true, enabled: true } });
    db.close();
  });

  it('文本异常、标准组合强度和空组件混沌结果均会持久化', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    addComponent(db, 'button-2', 'page-1', 'button', '#button-2');
    const page = createPage();
    const executor = { executeAction: vi.fn(async () => { throw '文本动作失败'; }) } as unknown as InteractionExecutor;
    const standard = await createEngine(db, new MemoryManager(db), executor, {
      runMode: 'fresh', depth: 'standard', phase: 'combo', enablePaths: false, enableChaos: false,
    }).run(page, [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);
    expect(standard.executedCombinations).toBeGreaterThan(0);
    expect((db.prepare("SELECT output_json FROM test_results WHERE test_type = 'click'").get() as any).output_json)
      .toContain('文本动作失败');

    const chaosPage = createPage();
    (chaosPage.evaluate as any).mockResolvedValue({ components: [], title: '空页面', forms: [], dialogs: 0, loadingOverlays: 0 });
    await createEngine(db, new MemoryManager(db), createExecutor(), {
      runMode: 'fresh', depth: 'deep', phase: 'chaos',
    }).run(chaosPage, [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);
    expect(db.prepare("SELECT status FROM test_results WHERE test_type = 'chaos-http-500' ORDER BY started_at DESC").get()).toEqual({ status: 'failed' });
    db.close();
  });

  it('文本导航异常和缺省页面标题仍可生成失败证据', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page-1');
    addPage(db, 'page-2', 'https://example.com/page-2');
    addEdge(db, 'page-1', 'page-2');
    const engine = createEngine(db, new MemoryManager(db), createExecutor(), {
      runMode: 'fresh', phase: 'explore', enablePaths: true, enableChaos: false,
    }) as any;
    const page = createPage();
    (page.goto as any).mockRejectedValue('文本导航失败');
    await expect(engine.navigate(page, { id: 'page-1', url_pattern: 'https://example.com/page-1', title: null }))
      .rejects.toThrow('文本导航失败');
    db.close();
  });

  it('测试引擎将文本复位和组合导航异常记录为受阻项', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    addComponent(db, 'button-2', 'page-1', 'button', '#button-2');
    const engine = createEngine(db, new MemoryManager(db), createExecutor(), { runMode: 'fresh', phase: 'test', enableChaos: false }) as any;
    engine.tracker.initializeActions([
      { pageId: 'page-1', componentId: 'button-1', action: 'click' },
      { pageId: 'page-1', componentId: 'button-2', action: 'click' },
    ]);
    engine.recordNavigationBlocked({ id: 'page-1', url_pattern: 'https://example.com/page', title: null }, engine.getComponents('page-1'), '文本不可访问');
    expect(db.prepare("SELECT output_json FROM test_results WHERE test_type = 'click' LIMIT 1").get()).toMatchObject({ output_json: expect.stringContaining('文本不可访问') });
    engine.recordCombinationNavigationBlocked({ id: 'page-1', url_pattern: 'https://example.com/page', title: null }, engine.getComponents('page-1'), [['click', 'click']], 1, '组合文本不可访问');
    expect(db.prepare("SELECT output_json FROM test_results WHERE test_type = 'combination-1way'").get()).toMatchObject({ output_json: expect.stringContaining('组合文本不可访问') });
    db.close();
  });

  it('动作执行抛出文本时保留失败原因并继续覆盖', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    const executor = { executeAction: vi.fn(async () => { throw '文本动作异常'; }) } as unknown as InteractionExecutor;
    const result = await createEngine(db, new MemoryManager(db), executor, {
      runMode: 'fresh', phase: 'test', enableChaos: false,
    }).run(createPage(), [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);
    expect(result.executedActions).toBe(3);
    expect((db.prepare("SELECT output_json FROM test_results WHERE test_type = 'click'").get() as any).output_json)
      .toContain('文本动作异常');
    db.close();
  });

  it('达到运行期限时中止后续测试并保留待覆盖项目', () => {
    const db = createDatabase();
    const engine = createEngine(db, new MemoryManager(db), createExecutor(), {
      deadlineAt: Date.now() - 1,
    }) as any;
    expect(() => engine.assertWithinDeadline()).toThrow('最大运行时长');
    db.close();
  });

  it('质量证据缺省时按空数组执行规则', async () => {
    const db = createDatabase();
    const engine = createEngine(db, new MemoryManager(db), createExecutor()) as any;
    const observation = { ...createPage() } as any;
    await engine.evaluateActionEvidence({
      before: { components: [], url: 'https://example.com', loadingOverlayCount: 0 },
      after: { components: [], url: 'https://example.com', loadingOverlayCount: 0 },
      action: 'click', selector: '#button', pageUrl: 'https://example.com',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM bugs').get()).toEqual({ count: 2 });
    expect(observation).toBeTruthy();
    db.close();
  });

  it('输入类动作不套用页面级反馈规则，避免把字段编辑误报为缺陷', async () => {
    const db = createDatabase();
    const engine = createEngine(db, new MemoryManager(db), createExecutor()) as any;
    await engine.evaluateActionEvidence({
      before: { components: [], url: 'https://example.com', loadingOverlayCount: 0 },
      after: { components: [], url: 'https://example.com', loadingOverlayCount: 0 },
      action: 'fill', selector: '#field', pageUrl: 'https://example.com',
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM bugs WHERE rule_id = 'QR001'").get()).toEqual({ count: 0 });
    db.close();
  });

  it('语义断言失败时单独持久化为可追溯问题', () => {
    const db = createDatabase();
    const engine = createEngine(db, new MemoryManager(db), createExecutor()) as any;
    engine.persistOracleViolations([
      { name: '非法提交校验', passed: false, detail: '写请求未被校验阻断' },
      { name: '页面稳定性', passed: true, detail: '正常' },
    ], 'https://example.com/page', 'component-1');
    expect(db.prepare('SELECT title, rule_id, component_id FROM bugs').get()).toEqual({
      title: '语义断言失败：非法提交校验', rule_id: 'ORACLE:非法提交校验', component_id: 'component-1',
    });
    db.close();
  });

  it('业务范围、组合指纹与状态快照辅助分支均可安全处理', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'shell', 'page-1', 'button', '#shell', { visible: true, enabled: true, scope: 'shell' });
    addComponent(db, 'unknown', 'page-1', 'button', '#unknown', { visible: true, enabled: true, scope: 'unknown' });
    const engine = createEngine(db, new MemoryManager(db), createExecutor(), {
      runMode: 'fresh', phase: 'combo', enablePaths: false, enableChaos: false,
    }) as any;
    expect(engine.getTestableComponents('page-1').map((row: any) => row.id)).toEqual(['unknown']);
    expect(engine.getTestableComponents('none')).toEqual([]);
    expect(engine.fingerprint({ url: 'u', title: 't', components: [{ tag: 'button', role: null } as any] })).toContain('button');
    expect(engine.getUnavailableReason({ state: { visible: false, enabled: true } })).toContain('不可见');
    expect(engine.getUnavailableReason({ state: { visible: true, enabled: false } })).toContain('禁用');
    const combo = await engine.run(createPage(), [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);
    expect(combo.executedCombinations).toBe(0);
    db.close();
  });

  it('兼容缺少组件状态的历史数据，并在组合指纹未缓存时继续完成测试', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    db.prepare('INSERT INTO components (id, target_id, page_id, type, selector, label, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy', 'demo', 'page-1', 'button', '#legacy', '历史按钮', null, 1, 1);
    addComponent(db, 'button-2', 'page-1', 'button', '#button-2');
    const engine = createEngine(db, new MemoryManager(db), createExecutor(), {
      runMode: 'fresh', phase: 'combo', enablePaths: false, enableChaos: false,
    }) as any;
    expect(engine.getTestableComponents('page-1')).toHaveLength(2);
    engine.capturePageFingerprint = vi.fn().mockResolvedValue('未缓存指纹');
    await engine.testPageCombinations(createPage(), {
      id: 'page-1', url_pattern: 'https://example.com/page', title: '页面',
    });
    expect(engine.pageFingerprints.has('page-1')).toBe(false);
    db.close();
  });

  it('模型决策门返回合法候选时，测试引擎提升该候选动作', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    addComponent(db, 'button-2', 'page-1', 'link', '#button-2');
    const order: string[] = [];
    const executor = { executeAction: vi.fn(async (_page: Page, component: any, action: string) => { order.push(component.selector + ':' + action); }) } as unknown as InteractionExecutor;
    const engine = createEngine(db, new MemoryManager(db), executor, { runMode: 'fresh', phase: 'test', enableChaos: false }) as any;
    engine.navigate = vi.fn().mockResolvedValue(undefined);
    engine.capturePageFingerprint = vi.fn().mockResolvedValue('fingerprint');
    engine.perceiver.capture = vi.fn().mockResolvedValue({ components: [], url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [] });
    engine.decisionGate.selectNext = vi.fn().mockResolvedValue({ candidateId: 'button-2:click', reason: '先验证链接动作', expectedState: '进入目标页面' });
    await engine.run(createPage(), [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);
    expect(order.slice(0, 2)).toEqual(['#button-1:click', '#button-2:click']);
    expect(engine.decisionGate.selectNext).toHaveBeenCalled();
    db.close();
  });

  it('页面变化后将新出现的受控控件交给模型选择，并在当前状态执行', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#button-1');
    const order: string[] = [];
    const executor = {
      executeAction: vi.fn(async (_page: Page, component: any, action: string) => {
        order.push(component.selector + ':' + action);
      }),
    } as unknown as InteractionExecutor;
    const engine = createEngine(db, new MemoryManager(db), executor, {
      runMode: 'fresh', phase: 'test', enableChaos: false,
    }) as any;
    const component = (selector: string, text: string) => ({
      tag: 'button', role: 'button', text, classes: [], ariaLabel: null, placeholder: null, selector,
      rect: { x: 0, y: 0, w: 20, h: 10 },
      state: { visible: true, enabled: true, inViewport: true, cursorPointer: true, userSelectNone: false },
      clickability: { score: 1, isInteractive: true, isHighConfidence: true, signals: { isSemanticTag: true, hasAriaRole: true, cursorPointer: true, hasOnclick: false, hasTabIndex: false } },
    });
    const baseline = { type: 'structured' as const, timestamp: 1, url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [], components: [component('#button-1', '打开弹窗')] };
    const dialog = { ...baseline, dialogCount: 1, components: [...baseline.components, component('#confirm', '确认')] };
    engine.navigate = vi.fn().mockResolvedValue(undefined);
    engine.capturePageFingerprint = vi.fn().mockResolvedValue('fingerprint');
    engine.perceiver.capture = vi.fn()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(dialog)
      .mockResolvedValue(dialog);
    engine.decisionGate.selectNext = vi.fn().mockImplementation(async (input: any) =>
      input.candidates.find((candidate: any) => candidate.id.startsWith('dynamic-'))
        ? { candidateId: input.candidates.find((candidate: any) => candidate.id.startsWith('dynamic-')).id, reason: '确认弹窗状态', expectedState: '完成弹窗确认' }
        : null);

    await engine.run(createPage(), [{ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }]);

    expect(order.slice(0, 2)).toEqual(['#button-1:click', '#confirm:click']);
    expect(db.prepare("SELECT input_json FROM test_results WHERE component_id LIKE 'dynamic-%'").get()).toMatchObject({
      input_json: expect.stringContaining('模型选择当前状态候选'),
    });
    db.close();
  });

  it('动态候选忽略字段不完整、页面外壳和既有基础控件', () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'button-1', 'page-1', 'button', '#existing');
    const engine = createEngine(db, new MemoryManager(db), createExecutor()) as any;
    const complete = {
      tag: 'button', role: 'button', text: '新增', classes: [], ariaLabel: null, placeholder: null, selector: '#new',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      state: { visible: true, enabled: true, inViewport: true, cursorPointer: true, userSelectNone: false },
      clickability: { score: 1, isInteractive: true, isHighConfidence: true, signals: { isSemanticTag: true, hasAriaRole: true, cursorPointer: true, hasOnclick: false, hasTabIndex: false } },
    };
    const before = { components: [], url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [] };
    const after = { ...before, components: [
      { ...complete, selector: '#existing' },
      { ...complete, selector: '#shell', classes: ['sidebar'] },
      { selector: '#incomplete', tag: 'button' },
      { ...complete, selector: '#new' },
    ] };
    const result = engine.dynamicActionsFromObservation({ id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }, before, after, []);
    expect(result.map((item: any) => item.row.selector)).toEqual(['#new', '#new', '#new']);
    db.close();
  });

  it('动态候选按动作去重，并在达到受控上限后停止扩展', () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    const engine = createEngine(db, new MemoryManager(db), createExecutor()) as any;
    const component = (selector: string) => ({
      tag: 'button', role: 'button', text: selector, classes: [], ariaLabel: null, placeholder: null, selector,
      rect: { x: 0, y: 0, w: 10, h: 10 },
      state: { visible: true, enabled: true, inViewport: true, cursorPointer: true, userSelectNone: false },
      clickability: { score: 1, isInteractive: true, isHighConfidence: true, signals: { isSemanticTag: true, hasAriaRole: true, cursorPointer: true, hasOnclick: false, hasTabIndex: false } },
    });
    const before = { components: [], url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [] };
    const page = { id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' };
    const repeated = engine.dynamicActionsFromObservation(page, before, { ...before, components: [component('#new'), component('#new')] }, []);
    const pending = [repeated[0]];
    const withoutPendingDuplicate = engine.dynamicActionsFromObservation(page, before, { ...before, components: [component('#new')] }, pending);
    const capped = engine.dynamicActionsFromObservation(page, before, { ...before, components: Array.from({ length: 5 }, (_, index) => component(`#new-${index}`)) }, []);

    expect(repeated).toHaveLength(3);
    expect(withoutPendingDuplicate.map((item: any) => item.action)).not.toContain(repeated[0].action);
    expect(capped).toHaveLength(12);
    db.close();
  });

  it('动态候选按 aria、占位文本和选择器回退生成标签', () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    const engine = createEngine(db, new MemoryManager(db), createExecutor()) as any;
    const component = (selector: string, ariaLabel: string | null, placeholder: string | null) => ({
      tag: 'button', role: 'button', text: null, classes: [], ariaLabel, placeholder, selector,
      rect: { x: 0, y: 0, w: 10, h: 10 },
      state: { visible: true, enabled: true, inViewport: true, cursorPointer: true, userSelectNone: false },
      clickability: { score: 1, isInteractive: true, isHighConfidence: true, signals: { isSemanticTag: true, hasAriaRole: true, cursorPointer: true, hasOnclick: false, hasTabIndex: false } },
    });
    const before = { components: [], url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [] };
    const result = engine.dynamicActionsFromObservation(
      { id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' },
      before,
      { ...before, components: [component('#aria', '辅助标签', null), component('#placeholder', null, '占位标签'), component('#selector', null, null)] },
      [],
    );

    expect(result.map((item: any) => item.row.label)).toEqual(expect.arrayContaining(['辅助标签', '占位标签', '#selector']));
    db.close();
  });

  it('模型选择的动态候选不可达或执行失败时分别记录跳过和失败', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    const engine = createEngine(db, new MemoryManager(db), createExecutor()) as any;
    const page = createPage();
    const item = {
      row: { id: 'dynamic-x', page_id: 'page-1', type: 'button', selector: '#dynamic', label: '动态按钮', state_json: JSON.stringify({ visible: true, enabled: true }), constraints_json: null },
      action: 'click', source: 'model', modelReason: '处理弹窗', expectedState: '弹窗关闭', currentState: true,
    };
    engine.reachability.resolve = vi.fn().mockResolvedValueOnce({ reachable: false, status: 'temporarily-blocked', reason: '被遮挡', attempts: ['探测'] })
      .mockResolvedValueOnce({ reachable: true, status: 'ready', attempts: ['通过'] });
    await engine.executeDynamicAction(page, { id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }, item, {
      ...({ components: [], url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 1, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [] }),
    });
    engine.executor.executeAction = vi.fn().mockRejectedValue('动态动作异常');
    await engine.executeDynamicAction(page, { id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }, item, {
      ...({ components: [], url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 1, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [] }),
    });
    expect(db.prepare("SELECT status FROM test_results WHERE component_id = 'dynamic-x' ORDER BY started_at").all()).toEqual([{ status: 'skipped' }, { status: 'failed' }]);
    db.close();
  });

  it('动态动作和页面复位接受非 Error 异常并记录失败', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    const engine = createEngine(db, new MemoryManager(db), createExecutor()) as any;
    const page = createPage();
    const item = {
      row: { id: 'dynamic-text', page_id: 'page-1', type: 'button', selector: '#dynamic-text', label: '动态按钮', state_json: JSON.stringify({ visible: true, enabled: true }), constraints_json: null },
      action: 'click', source: 'model', modelReason: '验证异常路径', expectedState: '保留测试记录', currentState: true,
    };
    engine.reachability.resolve = vi.fn().mockResolvedValue({ reachable: true, status: 'ready', attempts: ['通过'] });
    engine.executor.executeAction = vi.fn().mockRejectedValue({ reason: '浏览器上下文已关闭' });
    await engine.executeDynamicAction(page, { id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }, item, {
      components: [], url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [],
    });
    engine.navigate = vi.fn().mockRejectedValue({ reason: '页面复位失败' });
    await expect(engine.resetAfterModelAction(page, { id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }, [])).resolves.toBe(false);

    expect(db.prepare("SELECT output_json FROM test_results WHERE component_id = 'dynamic-text'").get()).toMatchObject({
      output_json: expect.stringContaining('[object Object]'),
    });
    db.close();
  });

  it('动态动作异常为 Error 时记录错误消息', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    const engine = createEngine(db, new MemoryManager(db), createExecutor()) as any;
    const item = {
      row: { id: 'dynamic-error', page_id: 'page-1', type: 'button', selector: '#dynamic-error', label: '动态按钮', state_json: JSON.stringify({ visible: true, enabled: true }), constraints_json: null },
      action: 'click', source: 'model', modelReason: '验证错误分支', expectedState: '记录错误', currentState: true,
    };
    engine.reachability.resolve = vi.fn().mockResolvedValue({ reachable: true, status: 'ready', attempts: ['通过'] });
    engine.executor.executeAction = vi.fn().mockRejectedValue(new Error('动态动作 Error 异常'));

    await engine.executeDynamicAction(createPage(), { id: 'page-1', url_pattern: 'https://example.com/page', title: '页面' }, item, {
      components: [], url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [],
    });

    expect(db.prepare("SELECT output_json FROM test_results WHERE component_id = 'dynamic-error'").get()).toMatchObject({
      output_json: expect.stringContaining('动态动作 Error 异常'),
    });
    db.close();
  });

  it('模型优先级动作可跳过、失败，并在页面复位失败时停止页面队列', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'first', 'page-1', 'button', '#first');
    addComponent(db, 'second', 'page-1', 'button', '#second');
    const engine = createEngine(db, new MemoryManager(db), createExecutor(), { runMode: 'fresh', phase: 'test', enableChaos: false }) as any;
    engine.capturePageFingerprint = vi.fn().mockResolvedValue('fingerprint');
    engine.perceiver.capture = vi.fn().mockResolvedValue({ components: [], url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [] });
    engine.decisionGate.selectNext = vi.fn().mockResolvedValue({ candidateId: 'second:click', reason: '先处理第二项', expectedState: '第二项已验证' });
    engine.reachability.resolve = vi.fn()
      .mockResolvedValueOnce({ reachable: true, status: 'ready', attempts: ['通过'] })
      .mockResolvedValueOnce({ reachable: false, status: 'blocked', reason: '被遮挡', attempts: ['探测'] });
    engine.navigate = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('基线页不可达'));

    await engine.run(createPage(), [{ id: 'page-1', url_pattern: 'https://example.com/page', title: null }]);

    expect(db.prepare("SELECT status, input_json FROM test_results WHERE component_id = 'second'").get()).toMatchObject({
      status: 'skipped', input_json: expect.stringContaining('模型优先级'),
    });
    expect(engine.navigate).toHaveBeenCalledTimes(3);
    db.close();
  });

  it('模型优先级动作失败时以 Error 消息持久化结果', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'first', 'page-1', 'button', '#first');
    addComponent(db, 'second', 'page-1', 'button', '#second');
    const executor = createExecutor();
    const engine = createEngine(db, new MemoryManager(db), executor, { runMode: 'fresh', phase: 'test', enableChaos: false }) as any;
    engine.navigate = vi.fn().mockResolvedValue(undefined);
    engine.capturePageFingerprint = vi.fn().mockResolvedValue('fingerprint');
    engine.perceiver.capture = vi.fn().mockResolvedValue({ components: [], url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [] });
    engine.decisionGate.selectNext = vi.fn().mockResolvedValue({ candidateId: 'second:click', reason: '模型排序', expectedState: '失败被记录' });
    engine.executor.executeAction = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('模型优先级动作失败'));

    await engine.run(createPage(), [{ id: 'page-1', url_pattern: 'https://example.com/page', title: null }]);

    expect(db.prepare("SELECT output_json, input_json FROM test_results WHERE component_id = 'second'").get()).toMatchObject({
      output_json: expect.stringContaining('模型优先级动作失败'), input_json: expect.stringContaining('模型优先级'),
    });
    expect((engine.toDecisionCandidates([{ row: { id: 'empty-label', selector: '#fallback', label: null }, action: 'click' }])[0] as any).label).toContain('#fallback');
    db.close();
  });

  it('模型决策上下文中缺少标签时回退到选择器', async () => {
    const db = createDatabase();
    addPage(db, 'page-1', 'https://example.com/page');
    addComponent(db, 'untitled', 'page-1', 'button', '#untitled');
    db.prepare("UPDATE components SET label = NULL WHERE id = 'untitled'").run();
    const engine = createEngine(db, new MemoryManager(db), createExecutor(), { runMode: 'fresh', phase: 'test', enableChaos: false }) as any;
    engine.navigate = vi.fn().mockResolvedValue(undefined);
    engine.capturePageFingerprint = vi.fn().mockResolvedValue('fingerprint');
    engine.perceiver.capture = vi.fn().mockResolvedValue({ components: [], url: 'https://example.com/page', title: '页面', forms: [], dialogCount: 0, loadingOverlayCount: 0, networkEvents: [], consoleEvents: [] });
    const selectNext = vi.spyOn(engine.decisionGate, 'selectNext');

    await engine.run(createPage(), [{ id: 'page-1', url_pattern: 'https://example.com/page', title: null }]);

    expect(selectNext).toHaveBeenCalledWith(expect.objectContaining({
      executedAction: expect.objectContaining({ label: '#untitled' }),
    }));
    db.close();
  });

  it('按测试深度配置视觉模型单页决策上限', () => {
    const db = createDatabase();
    expect((createEngine(db, new MemoryManager(db), createExecutor(), { depth: 'quick' }) as any).decisionGate.maxDecisions).toBe(1);
    expect((createEngine(db, new MemoryManager(db), createExecutor(), { depth: 'standard' }) as any).decisionGate.maxDecisions).toBe(3);
    expect((createEngine(db, new MemoryManager(db), createExecutor(), { depth: 'deep' }) as any).decisionGate.maxDecisions).toBe(6);
    db.close();
  });

});
