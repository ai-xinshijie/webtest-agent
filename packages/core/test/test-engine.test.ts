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
  it('动作测试记录通过、失败和记忆跳过，失败仍计入覆盖', async () => {
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

    expect(result.executedActions).toBe(4);
    expect(result.skippedActions).toBe(1);
    expect(result.coverage.actions).toEqual({ visited: 5, blocked: 0, pending: 0, percentage: 100 });

    const statuses = (db.prepare('SELECT status, COUNT(*) AS count FROM test_results GROUP BY status').all() as any[])
      .reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {});
    expect(statuses).toEqual({ passed: 3, failed: 1, skipped: 1 });
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
    expect(result.coverage.actions).toEqual({ visited: 0, blocked: 4, pending: 0, percentage: 100 });
    const reasons = (db.prepare('SELECT output_json FROM test_results').all() as Array<{ output_json: string }>)
      .map(row => JSON.parse(row.output_json).reason)
      .sort();
    expect(reasons).toEqual([
      '组件当前不可见，已阻断动作执行',
      '组件当前不可见，已阻断动作执行',
      '组件当前不可见，已阻断动作执行',
      '组件当前已禁用，已阻断动作执行',
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
    expect(first.coverage.combinations).toEqual({ covered: 5, total: 5, percentage: 100 });
    expect(first.coverage.paths).toEqual({ covered: 1, total: 1, percentage: 100 });

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
    expect(second.executedPaths).toBe(0);
    expect(second.skippedPaths).toBe(1);
    expect(second.coverage.actions.percentage).toBe(100);
    expect(second.coverage.combinations.percentage).toBe(100);
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
    expect(result.coverage.actions).toEqual({ visited: 0, blocked: 3, pending: 0, percentage: 100 });
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
    expect(result.coverage.actions).toEqual({ visited: 1, blocked: 2, pending: 0, percentage: 100 });
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
    expect(result.coverage.combinations).toEqual({ covered: 5, total: 5, percentage: 100 });
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
});
