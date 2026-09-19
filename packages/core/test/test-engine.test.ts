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
    expect(first.executedCombinations).toBe(9);
    expect(first.executedPaths).toBe(1);
    expect(first.coverage.combinations).toEqual({ covered: 9, total: 9, percentage: 100 });
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
    expect(second.skippedCombinations).toBe(9);
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
});
