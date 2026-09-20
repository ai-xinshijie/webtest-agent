import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { DatabaseManager } from '@wta/core';

let tempDir = '';
let originalCwd = '';

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-case-cli-'));
  process.chdir(tempDir);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function createCase(): void {
  const db = new DatabaseManager(path.join(tempDir, '.wta', 'wta.db'));
  db.prepare(`INSERT INTO targets (id, name, url, config_json, created_at, updated_at) VALUES ('demo', 'demo', 'https://example.com', '{}', 1, 1)`).run();
  db.prepare(`INSERT INTO pages (id, target_id, url_pattern, title, first_seen_at, last_visited_at) VALUES ('page', 'demo', 'https://example.com/form', '表单页', 1, 1)`).run();
  db.prepare(`INSERT INTO components (id, target_id, page_id, type, selector, label, created_at, updated_at) VALUES ('button', 'demo', 'page', 'button', '#submit', '提交', 1, 1)`).run();
  db.prepare(`INSERT INTO navigation_macros (id, target_id, component_id, steps_json, cached_at) VALUES ('macro', 'demo', 'button', '[]', 1)`).run();
  db.prepare(`
    INSERT INTO compiled_test_cases (id, target_id, component_id, test_type, navigation_macro_id, actions_json, assertions_json, created_at, updated_at)
    VALUES ('case-1', 'demo', 'button', 'click', 'macro', ?, ?, 1, 1)
  `).run(JSON.stringify([{ order: 1, type: 'navigate', description: '进入表单页' }]), JSON.stringify(['提交控件可交互']));
  db.close();
}

async function load(): Promise<Command> {
  vi.resetModules();
  return (await import('../src/commands/case.js')).caseCommand;
}

async function run(...args: string[]): Promise<string[]> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...values) => logs.push(values.join(' ')));
  try {
    await (await load()).parseAsync(args, { from: 'user' });
    return logs;
  } finally {
    spy.mockRestore();
  }
}

describe('测试用例 CLI', () => {
  it('列出、筛选和查看编译后的中文测试步骤', async () => {
    createCase();
    expect((await run('list')).join('\n')).toContain('表单页：提交 - 点击');
    expect((await run('list', '--target', 'missing')).join('\n')).toContain('暂无测试用例');
    const shown = await run('show', 'case-1');
    expect(shown.join('\n')).toContain('进入表单页');
    expect(shown.join('\n')).toContain('提交控件可交互');
    await expect(run('show', 'missing')).rejects.toThrow('未找到测试用例：missing');
  });

  it('数据库不存在时提示先探索，并通过常驻代理提交有头重跑', async () => {
    await expect(run('list')).rejects.toThrow('未找到测试数据库');
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/api/health')) return { ok: true } as Response;
      return { ok: true, json: async () => ({ sessionId: 'case-session' }) } as Response;
    }));
    expect((await run('run', 'case-1', '--headed')).join('\n')).toContain('用例重跑已提交：case-session');
    expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({
      url: 'http://127.0.0.1:7878/api/test-cases/case-1/run',
      init: expect.objectContaining({ method: 'POST', body: JSON.stringify({ headless: false }) }),
    })]));
  });

  it('默认无头重跑并透传服务端失败响应', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/health')) return { ok: true } as Response;
      return { ok: false, status: 500, text: async () => '执行器不可用' } as Response;
    }));
    await expect(run('run', 'case-1')).rejects.toThrow('提交用例重跑失败：500 执行器不可用');
  });
});
