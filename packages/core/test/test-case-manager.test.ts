import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/db/Database.js';
import { TestCaseManager } from '../src/tester/TestCaseManager.js';

let tempDir = '';
let database: DatabaseManager | undefined;

function setup(): { db: DatabaseManager; manager: TestCaseManager } {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-cases-'));
  const db = new DatabaseManager(path.join(tempDir, 'cases.db'));
  db.prepare(`INSERT INTO targets (id, name, url, config_json, created_at, updated_at) VALUES ('target', '目标', 'https://example.com', '{}', 1, 1)`).run();
  db.prepare(`INSERT INTO pages (id, target_id, url_pattern, title, first_seen_at, last_visited_at) VALUES ('page', 'target', 'https://example.com/form', '表单页', 1, 1)`).run();
  database = db;
  return { db, manager: new TestCaseManager(db) };
}

function addComponent(db: DatabaseManager, id: string, type: string, label = `${type}控件`): void {
  db.prepare(`
    INSERT INTO components (id, target_id, page_id, type, selector, label, created_at, updated_at)
    VALUES (?, 'target', 'page', ?, ?, ?, 1, 1)
  `).run(id, type, `#${id}`, label);
}

afterEach(() => {
  database?.close();
  database = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('TestCaseManager', () => {
  it('将探索组件编译为中文步骤、断言和可复用导航宏', () => {
    const { db, manager } = setup();
    addComponent(db, 'button', 'button');
    addComponent(db, 'custom', 'unknown', '');

    const cases = manager.compileTarget('target');
    expect(cases).toHaveLength(4);
    expect(cases[0]!.steps).toEqual([
      expect.objectContaining({ order: 1, type: 'navigate', description: '进入页面：表单页' }),
      expect.objectContaining({ order: 2, type: 'action', selector: '#button' }),
      expect.objectContaining({ order: 3, type: 'assertion' }),
    ]);
    expect(cases.find(item => item.componentId === 'custom')!.componentLabel).toBe('#custom');
    expect(cases.find(item => item.componentId === 'custom')!.testType).toBe('click');
    expect(db.prepare('SELECT COUNT(*) AS count FROM navigation_macros').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM compiled_test_cases').get()).toEqual({ count: 4 });
  });

  it('重复编译保持用例和导航宏标识稳定，并覆盖所有内置组件动作', () => {
    const { db, manager } = setup();
    const expectedActions: Record<string, number> = {
      button: 3, link: 1, input: 3, textarea: 3, select: 2, form: 3, modal: 3, accordion: 2,
      tab: 1, checkbox: 2, radio: 1, pagination: 2, dropdown: 2, table: 2, unknown: 1, unsupported: 1,
    };
    for (const type of Object.keys(expectedActions)) addComponent(db, `item-${type}`, type);
    const first = manager.compileTarget('target');
    const second = manager.compileTarget('target');

    expect(first).toHaveLength(Object.values(expectedActions).reduce((sum, count) => sum + count, 0));
    expect(second.map(item => item.id)).toEqual(first.map(item => item.id));
    expect(db.prepare('SELECT COUNT(*) AS count FROM navigation_macros').get()).toEqual({ count: 16 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM compiled_test_cases').get()).toEqual({ count: first.length });
  });

  it('支持按目标列出用例、查询动作键并回写不同执行状态', () => {
    const { db, manager } = setup();
    addComponent(db, 'button', 'button');
    const compiled = manager.compileTarget('target');
    const [clickCase] = compiled.filter(item => item.testType === 'click');
    expect(manager.getActionKeys([])).toEqual(new Set());
    expect(manager.getActionKeys([clickCase!.id, 'missing'])).toEqual(new Set(['button:click']));
    expect(manager.list()).toHaveLength(3);
    expect(manager.list('missing')).toEqual([]);

    db.prepare(`INSERT INTO sessions (id, target_id, status, started_at) VALUES ('session', 'target', 'completed', 1)`).run();
    db.prepare(`
      INSERT INTO test_results (id, session_id, component_id, test_type, status, started_at)
      VALUES ('old', 'session', 'button', 'click', 'failed', 5)
    `).run();
    manager.recordExecution(null, 'click', 'passed', 10);
    manager.recordExecution('button', 'click', 'failed', 10);
    manager.recordExecution('button', 'click', 'passed', 20);
    db.prepare(`
      INSERT INTO test_results (id, session_id, component_id, test_type, status, started_at)
      VALUES ('new', 'session', 'button', 'click', 'passed', 30)
    `).run();

    const listed = manager.list('target');
    const click = listed.find(item => item.testType === 'click')!;
    expect(click.executeCount).toBe(2);
    expect(click.lastPassedAt).toBe(20);
    expect(click.lastStatus).toBe('passed');
    expect(click.lastExecutedAt).toBe(30);
  });

  it('兼容历史空导航关联、空页面标题和未知动作名称', () => {
    const { db, manager } = setup();
    db.prepare(`UPDATE pages SET title = NULL WHERE id = 'page'`).run();
    addComponent(db, 'button', 'button', '');
    const compiled = manager.compileTarget('target');
    const click = compiled.find(item => item.testType === 'click')!;
    db.prepare(`UPDATE compiled_test_cases SET navigation_macro_id = NULL WHERE id = ?`).run(click.id);
    const refreshed = manager.compileTarget('target').find(item => item.id === click.id)!;
    expect(refreshed.title).toContain('页面：#button - 点击');
    expect(db.prepare(`SELECT navigation_macro_id FROM compiled_test_cases WHERE id = ?`).get(click.id)).toEqual({ navigation_macro_id: db.prepare(`SELECT id FROM navigation_macros WHERE component_id = 'button'`).get().id });

    const custom = (manager as any).upsertCase(
      'target',
      { id: 'page', url_pattern: 'https://example.com/form', title: null },
      { id: 'button', page_id: 'page', type: 'button', selector: '#button', label: null },
      'custom-action',
    );
    expect(custom.title).toBe('页面：#button - custom-action');
    expect(manager.list('target').find(item => item.id === custom.id)!.title).toBe('页面：#button - custom-action');
  });
});
