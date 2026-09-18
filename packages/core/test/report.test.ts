import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
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
    INSERT INTO bugs (id, session_id, target_id, severity, title, description, page_url, rule_id, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('bug-1', 'session-1', 'target-1', 'major', '提交后无反馈', '点击提交后页面无变化', 'https://example.com/page', 'QR001', 2500);
  db.prepare(`
    INSERT INTO test_results (id, session_id, component_id, test_type, status, input_json, output_json, started_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('result-1', 'session-1', 'component-1', 'form-submit', 'passed', '{}', '{}', 2000, 500);

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
});
