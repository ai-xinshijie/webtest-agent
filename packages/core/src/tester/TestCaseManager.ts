import { randomUUID } from 'node:crypto';
import type { DatabaseManager } from '../db/Database.js';

interface PageRow {
  id: string;
  url_pattern: string;
  title: string | null;
}

interface ComponentRow {
  id: string;
  page_id: string;
  type: string;
  selector: string;
  label: string | null;
}

export interface TestCaseStep {
  order: number;
  type: 'navigate' | 'action' | 'assertion';
  description: string;
  selector?: string;
  action?: string;
  expected?: string;
}

export interface CompiledTestCase {
  id: string;
  targetId: string;
  componentId: string;
  pageUrl: string;
  pageTitle: string;
  componentLabel: string;
  componentType: string;
  testType: string;
  title: string;
  steps: TestCaseStep[];
  assertions: string[];
  timeout: number;
  executeCount: number;
  lastPassedAt: number | null;
  lastStatus: string | null;
  lastExecutedAt: number | null;
}

const ACTIONS_BY_TYPE: Record<string, string[]> = {
  button: ['click', 'double-click', 'right-click'],
  link: ['click'],
  input: ['fill', 'clear', 'fill-max'],
  textarea: ['fill', 'clear', 'fill-max'],
  select: ['select-first', 'select-last'],
  form: ['submit-empty', 'submit-partial', 'submit-valid'],
  modal: ['open', 'close-esc', 'close-overlay'],
  accordion: ['expand', 'collapse'],
  tab: ['switch'],
  checkbox: ['check', 'uncheck'],
  radio: ['select'],
  pagination: ['next', 'prev'],
  dropdown: ['open', 'select-first'],
  table: ['row-click', 'sort'],
};

const ACTION_NAMES: Record<string, string> = {
  click: '点击', 'double-click': '双击', 'right-click': '右键点击', fill: '填写有效数据',
  clear: '清空内容', 'fill-max': '填写边界长度数据', 'select-first': '选择第一项',
  'select-last': '选择最后一项', 'submit-empty': '空数据提交', 'submit-partial': '部分数据提交',
  'submit-valid': '有效数据提交', open: '打开', 'close-esc': '按 Escape 关闭',
  'close-overlay': '点击遮罩关闭', expand: '展开', collapse: '收起', switch: '切换',
  check: '勾选', uncheck: '取消勾选', select: '选择', next: '下一页', prev: '上一页',
  'row-click': '点击表格行', sort: '排序',
};

/** 将探索到的页面和组件编译为可审阅、可重放的中文测试用例。 */
export class TestCaseManager {
  constructor(private db: DatabaseManager) {}

  compileTarget(targetId: string): CompiledTestCase[] {
    const pages = this.db.prepare(`
      SELECT id, url_pattern, title FROM pages WHERE target_id = ? ORDER BY url_pattern
    `).all(targetId) as unknown as PageRow[];
    const cases: CompiledTestCase[] = [];

    for (const page of pages) {
      const components = this.db.prepare(`
        SELECT id, page_id, type, selector, label FROM components
        WHERE target_id = ? AND page_id = ?
        ORDER BY selector
      `).all(targetId, page.id) as unknown as ComponentRow[];
      for (const component of components) {
        for (const action of this.actionsFor(component.type)) {
          cases.push(this.upsertCase(targetId, page, component, action));
        }
      }
    }
    return cases;
  }

  list(targetId?: string): CompiledTestCase[] {
    const filter = targetId ? 'WHERE c.target_id = ?' : '';
    const rows = this.db.prepare(`
      SELECT c.*, p.url_pattern, p.title AS page_title, component.type AS component_type, component.label AS component_label, component.selector AS selector,
        latest.status AS last_status, latest.started_at AS last_executed_at
      FROM compiled_test_cases c
      JOIN components component ON component.id = c.component_id
      JOIN pages p ON p.id = component.page_id
      LEFT JOIN test_results latest ON latest.id = (
        SELECT id FROM test_results
        WHERE component_id = c.component_id AND test_type = c.test_type
        ORDER BY started_at DESC, id DESC LIMIT 1
      )
      ${filter}
      ORDER BY p.url_pattern, component.label, c.test_type
    `).all(...(targetId ? [targetId] : [])) as any[];
    return rows.map(row => this.toCase(row));
  }

  getActionKeys(caseIds: string[]): Set<string> {
    if (caseIds.length === 0) return new Set();
    const placeholders = caseIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT component_id, test_type FROM compiled_test_cases WHERE id IN (${placeholders})
    `).all(...caseIds) as Array<{ component_id: string; test_type: string }> ;
    return new Set(rows.map(row => `${row.component_id}:${row.test_type}`));
  }

  recordExecution(componentId: string | null, testType: string, status: string, executedAt: number): void {
    if (!componentId) return;
    this.db.prepare(`
      UPDATE compiled_test_cases
      SET execute_count = execute_count + 1,
          last_passed_at = CASE WHEN ? = 'passed' THEN ? ELSE last_passed_at END,
          updated_at = ?
      WHERE component_id = ? AND test_type = ?
    `).run(status, executedAt, executedAt, componentId, testType);
  }

  private upsertCase(targetId: string, page: PageRow, component: ComponentRow, action: string): CompiledTestCase {
    const existing = this.db.prepare(`
      SELECT id, navigation_macro_id FROM compiled_test_cases
      WHERE target_id = ? AND component_id = ? AND test_type = ?
    `).get(targetId, component.id, action) as { id: string; navigation_macro_id: string | null } | undefined;
    const existingMacro = this.db.prepare(`
      SELECT id FROM navigation_macros
      WHERE target_id = ? AND component_id = ?
      ORDER BY cached_at DESC LIMIT 1
    `).get(targetId, component.id) as { id: string } | undefined;
    const now = Date.now();
    const macroId = existing?.navigation_macro_id ?? existingMacro?.id ?? randomUUID();
    const caseId = existing?.id ?? randomUUID();
    const label = component.label?.trim() || component.selector;
    const actionName = ACTION_NAMES[action] ?? action;
    const steps: TestCaseStep[] = [
      { order: 1, type: 'navigate', description: `进入页面：${page.title ?? page.url_pattern}`, expected: `页面地址为 ${page.url_pattern}` },
      { order: 2, type: 'action', description: `对“${label}”执行${actionName}`, selector: component.selector, action },
      { order: 3, type: 'assertion', description: '验证操作结果与页面稳定性', expected: '操作可执行，页面无阻塞性错误、无 5xx 请求且无持续加载遮罩' },
    ];
    const assertions = [
      '目标组件可定位且可交互',
      '页面无阻塞性错误、无 5xx 请求且无持续加载遮罩',
    ];

    this.db.prepare(`
      INSERT INTO navigation_macros (id, target_id, component_id, steps_json, url, selector, cached_at, valid)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET steps_json = excluded.steps_json, url = excluded.url, selector = excluded.selector, cached_at = excluded.cached_at, valid = 1
    `).run(macroId, targetId, component.id, JSON.stringify([steps[0]]), page.url_pattern, component.selector, now);
    this.db.prepare(`
      INSERT INTO compiled_test_cases
        (id, target_id, component_id, test_type, navigation_macro_id, actions_json, assertions_json, timeout, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 30000, ?, ?)
      ON CONFLICT(id) DO UPDATE SET navigation_macro_id = excluded.navigation_macro_id, actions_json = excluded.actions_json, assertions_json = excluded.assertions_json, updated_at = excluded.updated_at
    `).run(caseId, targetId, component.id, action, macroId, JSON.stringify(steps), JSON.stringify(assertions), now, now);

    return { id: caseId, targetId, componentId: component.id, pageUrl: page.url_pattern, pageTitle: page.title ?? page.url_pattern, componentLabel: label, componentType: component.type, testType: action, title: `${page.title ?? '页面'}：${label} - ${actionName}`, steps, assertions, timeout: 30000, executeCount: 0, lastPassedAt: null, lastStatus: null, lastExecutedAt: null };
  }

  private actionsFor(type: string): string[] {
    // 必须与 TestEngine 的通用回退动作一致，避免探索到的新组件无法生成可审阅步骤。
    return ACTIONS_BY_TYPE[type] ?? ['click'];
  }

  private toCase(row: any): CompiledTestCase {
    const steps = JSON.parse(row.actions_json) as TestCaseStep[];
    const label = row.component_label?.trim() || row.selector;
    return {
      id: row.id, targetId: row.target_id, componentId: row.component_id, pageUrl: row.url_pattern,
      pageTitle: row.page_title ?? row.url_pattern, componentLabel: label, componentType: row.component_type,
      testType: row.test_type, title: `${row.page_title ?? '页面'}：${label} - ${ACTION_NAMES[row.test_type] ?? row.test_type}`,
      steps, assertions: JSON.parse(row.assertions_json), timeout: row.timeout, executeCount: row.execute_count,
      lastPassedAt: row.last_passed_at, lastStatus: row.last_status, lastExecutedAt: row.last_executed_at,
    };
  }
}
