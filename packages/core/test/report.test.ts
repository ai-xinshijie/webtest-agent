import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseManager } from '../src/db/Database.js';
import { AgentLogger } from '../src/logger/AgentLogger.js';
import { ReportGenerator } from '../src/reporter/ReportGenerator.js';

let db: DatabaseManager;
let tempDir: string;

function setup(): { database: DatabaseManager; sessionId: string } {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-report-'));
  db = new DatabaseManager(path.join(tempDir, 'test.db'));
  db.prepare(`
    INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('target-1', '测试目标', 'https://example.com', '{}', Date.now(), Date.now());
  db.prepare(`
    INSERT INTO sessions (id, target_id, status, started_at, ended_at, phase)
    VALUES (?, ?, 'completed', ?, ?, 'report')
  `).run('session-1', 'target-1', 1000, 3000);

  db.prepare(`
    INSERT INTO pages (id, target_id, url_pattern, title, role, first_seen_at, last_visited_at, visit_count, test_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('page-1', 'target-1', 'https://example.com/page', '业务页面', 'form', 1000, 2000, 1, 'partial');
  db.prepare(`
    INSERT INTO components (id, target_id, page_id, type, selector, label, state_json, constraints_json, confidence, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('component-1', 'target-1', 'page-1', 'button', '#submit', '提交按钮', '{}', '[]', 0.95, 'rule', 1000, 2000);
  db.prepare(`
    INSERT INTO state_nodes (id, target_id, page_id, fingerprint, summary_json, first_seen_at, last_seen_at)
    VALUES ('state-1', 'target-1', 'page-1', 'fingerprint', '{}', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO state_transitions (id, session_id, target_id, from_state_id, to_state_id, action_type, status, evidence_json, created_at)
    VALUES ('transition-1', 'session-1', 'target-1', 'state-1', 'state-1', 'click', 'passed', '{}', 1)
  `).run();
  db.prepare(`
    INSERT INTO bugs (id, session_id, target_id, severity, title, description, page_url, rule_id, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('bug-1', 'session-1', 'target-1', 'major', '提交后无反馈', '点击提交后页面无变化', 'https://example.com/page', 'QR001', 2500);
  db.prepare(`
    INSERT INTO test_results (id, session_id, component_id, test_type, status, input_json, output_json, started_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('result-1', 'session-1', 'component-1', 'form-submit', 'passed', '{}', '{}', 2000, 500);
  db.prepare(`
    INSERT INTO navigation_macros (id, target_id, component_id, steps_json, url, selector, cached_at)
    VALUES ('macro-1', 'target-1', 'component-1', '[{}]', 'https://example.com/page', '#submit', 1)
  `).run();
  db.prepare(`
    INSERT INTO compiled_test_cases
      (id, target_id, component_id, test_type, navigation_macro_id, actions_json, assertions_json, timeout, execute_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'case-1', 'target-1', 'component-1', 'form-submit', 'macro-1',
    JSON.stringify([
      { order: 1, type: 'navigate', description: '进入页面：业务页面', expected: '页面地址为 https://example.com/page' },
      { order: 2, type: 'action', description: '对“提交按钮”执行提交', selector: '#submit', action: 'form-submit' },
      { order: 3, type: 'assertion', description: '验证提交结果', expected: '页面稳定' },
    ]),
    JSON.stringify(['提交按钮可定位', '页面稳定']), 30000, 1, 1000, 2000,
  );

  const logger = new AgentLogger(db, 'session-1', { consoleOutput: false });
  logger.logScript(
    { description: '执行表单测试', module: '测试', method: 'test' },
    { type: 'form-test' },
    { status: 'success', duration: 25 },
    { phase: 'test' },
  );
  logger.logSystem(
    { description: '测试会话完成', module: '测试', method: 'complete' },
    { type: 'complete' },
    { status: 'success', duration: 2000 },
    { phase: 'report' },
  );
  db.prepare(`UPDATE sessions SET progress_json = ? WHERE id = 'session-1'`).run(JSON.stringify({
    coverage: {
      actions: { visited: 3, blocked: 1, pending: 0, percentage: 75 },
      combinations: { covered: 4, total: 5, percentage: 80 },
      paths: { covered: 2, total: 2, percentage: 100 },
    },
  }));
  db.prepare(`
    INSERT INTO hot_patch_reports (id, session_id, strategy_name, status, report_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('patch-1', 'session-1', 'orchestrator-recovery', 'proposed', JSON.stringify({
    strategyName: 'orchestrator-recovery',
    status: 'proposed',
    rootCause: '登录异常',
    explanation: '等待人工审核补丁',
  }), 2600);

  return { database: db, sessionId: 'session-1' };
}

afterEach(() => {
  db?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('ReportGenerator', () => {
  it('生成中文 Markdown 报告并包含执行时间线', () => {
    const { database, sessionId } = setup();
    const report = new ReportGenerator(database, { outputDir: tempDir, format: 'md' }).generate(sessionId);

    expect(report).toContain('# WebTestAgent 测试报告');
    expect(report).toContain('## 概要');
    expect(report).toContain('测试目标');
    expect(report).toContain('问题 1：提交后无反馈');
    expect(report).toContain('## 执行时间线');
    expect(report).toContain('脚本');
    expect(report).toContain('执行表单测试');
    expect(report).toContain('按钮：1 个');
    expect(report).toContain('### 深度覆盖');
    expect(report).toContain('### 组件范围');
    expect(report).toContain('### 状态图');
    expect(report).toContain('| 1 | 1 | 1 | 0 |');
    expect(report).toContain('| 动作 | 3 | 0 | 1 | 0 | 4 | 75.00% |');
    expect(report).toContain('实际覆盖率只计入本会话真正执行的项目');
    expect(report).toContain('## 测试用例与步骤（1 条）');
    expect(report).toContain('用例 1：业务页面：提交按钮 - form-submit');
    expect(report).toContain('对“提交按钮”执行提交');
    expect(report).toContain('提交按钮可定位');
    expect(report).toContain('## 代码自愈');
    expect(report).toContain('登录异常');
  });

  it('生成机器可读 JSON 报告并保留完整日志详情', () => {
    const { database, sessionId } = setup();
    const content = new ReportGenerator(database, { outputDir: tempDir, format: 'json' }).generate(sessionId);
    const parsed = JSON.parse(content);

    expect(parsed.会话.标识).toBe(sessionId);
    expect(parsed.覆盖.已访问页面数).toBe(1);
    expect(parsed.问题列表[0].严重级别).toBe('重要');
    expect(parsed.执行时间线).toHaveLength(2);
    expect(parsed.执行时间线[0].操作.type).toBe('form-test');
    expect(parsed.执行时间线[1].结果.duration).toBe(2000);
    expect(parsed.深度覆盖.actions.blocked).toBe(1);
    expect(parsed.覆盖.组件范围).toEqual({ business: 0, navigation: 0, shell: 0, thirdParty: 0, unknown: 1 });
    expect(parsed.状态图).toEqual({ 状态节点数: 1, 状态迁移数: 1, 通过迁移数: 1, 失败迁移数: 0 });
    expect(parsed.代码自愈[0].rootCause).toBe('登录异常');
    expect(parsed.执行异常).toEqual([]);
    expect(parsed.测试结果[0].输出).toEqual({});
    expect(parsed.测试用例[0]).toMatchObject({
      标识: 'case-1', 标题: '业务页面：提交按钮 - form-submit', 执行次数: 1,
      步骤: expect.arrayContaining([expect.objectContaining({ description: '进入页面：业务页面' })]),
      断言: ['提交按钮可定位', '页面稳定'],
    });
  });

  it('用例尚未执行时在 Markdown 与 JSON 中保留未执行状态', () => {
    const { database, sessionId } = setup();
    database.prepare(`
      INSERT INTO components (id, target_id, page_id, type, selector, label, created_at, updated_at)
      VALUES ('component-2', 'target-1', 'page-1', 'link', '#help', '帮助', 1, 1)
    `).run();
    database.prepare(`
      INSERT INTO navigation_macros (id, target_id, component_id, steps_json, cached_at)
      VALUES ('macro-2', 'target-1', 'component-2', '[]', 1)
    `).run();
    database.prepare(`
      INSERT INTO compiled_test_cases (id, target_id, component_id, test_type, navigation_macro_id, actions_json, assertions_json, created_at, updated_at)
      VALUES ('case-2', 'target-1', 'component-2', 'click', 'macro-2', '[]', '[]', 1, 1)
    `).run();
    const markdown = new ReportGenerator(database, { outputDir: tempDir, format: 'md' }).generate(sessionId);
    expect(markdown).toContain('最近状态**：未执行');
    expect(markdown).toContain('最近执行时间**：无');
    const json = JSON.parse(new ReportGenerator(database, { outputDir: tempDir, format: 'json' }).generate(sessionId));
    expect(json.测试用例.find((item: { 标识: string }) => item.标识 === 'case-2').最近状态).toBeNull();
  });

  it('将失败测试作为执行异常呈现，而不混入产品问题列表', () => {
    const { database, sessionId } = setup();
    database.prepare(
      "UPDATE test_results SET status = 'failed', input_json = ?, output_json = ?, duration_ms = ? WHERE id = ?",
    ).run(JSON.stringify({ selector: '#submit' }), JSON.stringify({ error: '点击超时' }), 5000, 'result-1');

    const markdown = new ReportGenerator(database, { outputDir: tempDir, format: 'md' }).generate(sessionId);
    expect(markdown).toContain('## 执行异常（1 条）');
    expect(markdown).toContain('执行异常 1：form-submit');
    expect(markdown).toContain('点击超时');

    const json = JSON.parse(new ReportGenerator(database, { outputDir: tempDir, format: 'json' }).generate(sessionId));
    expect(json.问题列表).toHaveLength(1);
    expect(json.执行异常).toEqual([{
      测试类型: 'form-submit',
      耗时毫秒: 5000,
      输入: { selector: '#submit' },
      错误证据: { error: '点击超时' },
    }]);
  });

  it('保存报告到指定目录', () => {
    const { database, sessionId } = setup();
    const outputDir = path.join(tempDir, 'reports');
    const report = new ReportGenerator(database, { outputDir, format: 'md' });
    const filePath = report.save(sessionId);

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('WebTestAgent 测试报告');
  });

  it('会话不存在时返回中文错误', () => {
    const { database } = setup();
    expect(() => new ReportGenerator(database, { outputDir: tempDir, format: 'md' }).generate('missing'))
      .toThrow('未找到测试会话：missing');
  });

  it('翻译状态、组件、严重级别与自愈状态的全部受支持值', () => {
    const { database } = setup();
    const report = new ReportGenerator(database, { outputDir: tempDir, format: 'md' }) as any;

    expect(['running', 'completed', 'failed', 'paused', 'passed', 'failed_test', 'skipped', 'warning']
      .map(value => report.translateStatus(value))).toEqual(['运行中', '已完成', '失败', '已暂停', '通过', '未通过', '已跳过', '警告']);
    expect(report.translateStatus('custom')).toBe('custom');
    expect(['untested', 'partial', 'tested', 'other'].map(value => report.translateTestStatus(value)))
      .toEqual(['未测试', '部分测试', '已测试', 'other']);
    expect(['critical', 'major', 'minor', 'info', 'other'].map(value => report.translateSeverity(value)))
      .toEqual(['严重', '重要', '一般', '提示', 'other']);
    expect(['script', 'model', 'system', 'user', 'other'].map(value => report.translateSource(value)))
      .toEqual(['脚本', '模型', '系统', '用户', 'other']);
    expect([
      'button', 'input', 'textarea', 'select', 'form', 'table', 'modal', 'accordion', 'tab', 'toast',
      'checkbox', 'radio', 'navigation', 'breadcrumb', 'pagination', 'link', 'dropdown', 'datepicker',
      'fileupload', 'unknown', 'other',
    ].map(value => report.translateComponentType(value))).toEqual([
      '按钮', '输入框', '文本域', '下拉选择', '表单', '表格', '弹框', '手风琴', '标签页', '通知',
      '复选框', '单选框', '导航', '面包屑', '分页', '链接', '下拉菜单', '日期选择', '文件上传', '未知组件', 'other',
    ]);
    expect(['fallback-applied', 'proposed', 'applied', 'rejected', 'rolled-back', 'other']
      .map(value => report.translateHotPatchStatus(value)))
      .toEqual(['已切换降级策略', '待人工审核', '已应用', '已拒绝', '已回滚', 'other']);
  });

  it('空数据、未知值与覆盖快照边界仍可生成报告', () => {
    const { database, sessionId } = setup();
    database.prepare('DELETE FROM components').run();
    database.prepare('DELETE FROM state_transitions').run();
    database.prepare('DELETE FROM state_nodes').run();
    database.prepare('DELETE FROM pages').run();
    database.prepare('DELETE FROM bugs').run();
    database.prepare('DELETE FROM test_results').run();
    database.prepare('DELETE FROM compiled_test_cases').run();
    database.prepare('DELETE FROM navigation_macros').run();
    database.prepare('DELETE FROM agent_logs').run();
    database.prepare('DELETE FROM hot_patch_reports').run();
    database.prepare('UPDATE sessions SET ended_at = NULL, progress_json = NULL, status = ? WHERE id = ?').run('custom', sessionId);
    const markdown = new ReportGenerator(database, { outputDir: tempDir, format: 'md' }).generate(sessionId);
    expect(markdown).toContain('N/A 秒');
    expect(markdown).toContain('本次会话尚未生成深度覆盖快照。');
    expect(markdown).toContain('本次测试未发现问题。');
    expect(markdown).toContain('本次会话未触发代码级自愈。');
    expect(markdown).toContain('本次会话尚未编译可重放测试用例。');
    expect(markdown).toContain('暂无审计日志');

    const generator = new ReportGenerator(database, { outputDir: tempDir, format: 'md' }) as any;
    expect(generator.coverageMarkdown({ coverage: {
      actions: { visited: 0, blocked: 0, pending: 1, percentage: 0 },
      combinations: { covered: 3, total: 1, percentage: 300 },
      paths: { covered: 0, total: 0, percentage: 0 },
    } })).toContain('| 组合 | 3 | 0 | 0 | 0 | 1 | 300.00% |');
  });

  it('保存报告支持指定文件名', () => {
    const { database, sessionId } = setup();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const filename = path.join(tempDir, 'custom', 'result.md');
    expect(new ReportGenerator(database, { outputDir: tempDir, format: 'md' }).save(sessionId, filename)).toBe(filename);
    expect(existsSync(filename)).toBe(true);
    logSpy.mockRestore();
  });

  it('不完整证据字段在 Markdown 和 JSON 中有稳定回退值', () => {
    const { database, sessionId } = setup();
    database.prepare('UPDATE pages SET title = NULL WHERE id = ?').run('page-1');
    database.prepare('UPDATE bugs SET rule_id = NULL, page_url = NULL, description = NULL WHERE id = ?').run('bug-1');
    database.prepare("UPDATE test_results SET status = 'failed', input_json = NULL, output_json = NULL, duration_ms = NULL WHERE id = ?").run('result-1');
    database.prepare('UPDATE sessions SET ended_at = NULL WHERE id = ?').run(sessionId);

    const markdown = new ReportGenerator(database, { outputDir: tempDir, format: 'md' }).generate(sessionId);
    expect(markdown).toContain('未命名页面');
    expect(markdown).toContain('质量规则**：无');
    expect(markdown).toContain('页面**：未知');
    expect(markdown).toContain('描述**：无');
    expect(markdown).toContain('0 毫秒');
    expect(markdown).toContain('执行异常 1：form-submit');

    const json = JSON.parse(new ReportGenerator(database, { outputDir: tempDir, format: 'json' }).generate(sessionId));
    expect(json.会话.持续毫秒).toBeNull();
    expect(json.测试结果[0].输入).toBeNull();
    expect(json.测试结果[0].输出).toBeNull();
  });

  it('不完整审计日志在 Markdown 中保留错误与默认展示值', () => {
    const { database } = setup();
    const report = new ReportGenerator(database, { outputDir: tempDir, format: 'md' }) as any;
    const markdown = report.generateMarkdown(
      { id: 's', target_name: '目标', target_url: 'https://example.com', status: 'completed', started_at: 1, ended_at: 2, phase: 'report' },
      [], [], [], [],
      [{ sequence: 1, timestamp: 1, source: 'script', trigger: {}, result: { error: '动作失败' } }],
      null, [],
    );
    expect(markdown).toContain('未命名操作（动作失败）');
    expect(markdown).toContain('| 1 |');
    expect(markdown).toContain('| 成功 | 0 毫秒 |');
  });

  it('深度覆盖表对缺省百分比使用零值回退', () => {
    const { database } = setup();
    const generator = new ReportGenerator(database, { outputDir: tempDir, format: 'md' }) as any;
    const markdown = generator.coverageMarkdown({ coverage: {
      actions: { visited: 0, blocked: 0, pending: 0 },
      combinations: { covered: 0, total: 0 },
      paths: { covered: 0, total: 0 },
    } });
    expect(markdown).toContain('| 动作 | 0 | 0 | 0 | 0 | 0 | 0.00% |');
    expect(markdown).toContain('| 路径 | 0 | 0 | 0 | 0 | 0 | 0.00% |');
  });

  it('组件范围统计兼容全部范围和损坏的历史状态', () => {
    const { database } = setup();
    const generator = new ReportGenerator(database, { outputDir: tempDir, format: 'md' }) as any;

    expect(generator.componentScopeCounts([
      { state_json: JSON.stringify({ scope: 'business' }) },
      { state_json: JSON.stringify({ scope: 'navigation' }) },
      { state_json: JSON.stringify({ scope: 'shell' }) },
      { state_json: JSON.stringify({ scope: 'third-party' }) },
      { state_json: JSON.stringify({ scope: 'future-scope' }) },
      { state_json: null },
      { state_json: '{损坏的历史状态' },
    ])).toEqual({ business: 1, navigation: 1, shell: 1, thirdParty: 1, unknown: 3 });
  });
});
