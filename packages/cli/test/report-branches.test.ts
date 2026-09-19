import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportCommand } from '../src/commands/report.js';
import { ConfigManager, DatabaseManager, ReportGenerator } from '@wta/core';

let tempDir = '';
let originalCwd = '';

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-report-branches-'));
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function runReport(...args: string[]) {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
    logs.push(values.map(value => String(value)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
    errors.push(values.map(value => String(value)).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });

  try {
    await reportCommand.parseAsync(args, { from: 'user' });
    return { logs, errors, exited: false };
  } catch (error) {
    if (error instanceof Error && error.message === 'process.exit') {
      return { logs, errors, exited: true };
    }
    throw error;
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

function createSession() {
  const config = new ConfigManager(tempDir).load();
  const db = new DatabaseManager(config.dbPath);
  db.prepare(`
    INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
    VALUES ('demo', 'demo', 'https://example.com', '{}', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO sessions (id, target_id, status, started_at, ended_at)
    VALUES ('session-1', 'demo', 'completed', 1000, 2000)
  `).run();
  db.close();
}

describe('报告命令目录与异常分支', () => {
  it('列出报告目录缺失、包含报告和仅非报告文件的状态', async () => {
    await runReport('list');
    createSession();

    const missing = await runReport('list');
    expect(missing.logs.join('\n')).not.toContain('报告文件：');

    const reportsDir = path.join(tempDir, '.wta', 'reports');
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(path.join(reportsDir, 'a.md'), '# 报告', 'utf-8');
    writeFileSync(path.join(reportsDir, 'b.json'), '{}', 'utf-8');
    writeFileSync(path.join(reportsDir, 'c.txt'), '文本', 'utf-8');

    const files = await runReport('list');
    expect(files.logs.join('\n')).toContain('a.md');
    expect(files.logs.join('\n')).toContain('b.json');
    expect(files.logs.join('\n')).not.toContain('c.txt');

    rmSync(reportsDir, { recursive: true, force: true });
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(path.join(reportsDir, 'c.txt'), '文本', 'utf-8');
    const noReports = await runReport('list');
    expect(noReports.logs.join('\n')).not.toContain('报告文件：');
  });

  it('生成和导出报告支持非 Error 异常', async () => {
    createSession();
    const generateSpy = vi.spyOn(ReportGenerator.prototype, 'generate')
      .mockImplementationOnce(() => {
        throw '生成失败';
      });

    const show = await runReport('show', 'session-1');
    expect(show.errors.join('\n')).toContain('报告生成失败：生成失败');
    expect(show.exited).toBe(true);
    generateSpy.mockRestore();

    const saveSpy = vi.spyOn(ReportGenerator.prototype, 'save')
      .mockImplementationOnce(() => {
        throw '导出失败';
      });

    const exported = await runReport('export', 'session-1', '--format', 'md');
    expect(exported.errors.join('\n')).toContain('报告导出失败：导出失败');
    expect(exported.exited).toBe(true);
    saveSpy.mockRestore();
  });
});
