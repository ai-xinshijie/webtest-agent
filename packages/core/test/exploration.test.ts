import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { DatabaseManager } from '../src/db/Database.js';
import { BFSExplorer } from '../src/exploration/BFSExplorer.js';
import { StructuredPerceiver } from '../src/perception/StructuredPerceiver.js';
import type { StructuredObservation } from '../src/perception/types.js';

let db: DatabaseManager | null;
let tempDir: string;

function createDatabase(): DatabaseManager {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-exploration-'));
  db = new DatabaseManager(path.join(tempDir, 'test.db'));
  db.prepare(`
    INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('target-1', '测试目标', 'https://example.com', '{}', Date.now(), Date.now());
  db.prepare(`
    INSERT INTO sessions (id, target_id, status, started_at, phase)
    VALUES (?, ?, 'running', ?, 'explore')
  `).run('session-1', 'target-1', Date.now());
  return db;
}

function createObservation(): StructuredObservation {
  return {
    type: 'structured',
    timestamp: Date.now(),
    url: 'https://example.com/page',
    title: '业务页面',
    components: [{
      tag: 'button',
      role: 'button',
      text: '提交',
      classes: [],
      ariaLabel: null,
      placeholder: null,
      state: {
        visible: true,
        enabled: true,
        inViewport: true,
        cursorPointer: true,
        userSelectNone: false,
      },
      clickability: {
        score: 0.5,
        isInteractive: true,
        isHighConfidence: true,
        signals: {
          isSemanticTag: true,
          hasAriaRole: true,
          cursorPointer: true,
          hasOnclick: false,
          hasTabIndex: false,
        },
      },
      selector: '#submit',
      rect: { x: 0, y: 0, w: 100, h: 30 },
    }],
    forms: [],
    dialogCount: 0,
    loadingOverlayCount: 0,
    networkEvents: [],
  };
}

afterEach(() => {
  db?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  db = null;
  tempDir = '';
});

describe('BFSExplorer', () => {
  it('访问同源链接并持久化页面和组件', async () => {
    const database = createDatabase();
    const observation = createObservation();
    const perceiver = { capture: vi.fn().mockResolvedValue(observation) };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn().mockResolvedValue([
        { href: 'https://example.com/other', text: '其他页面' },
        { href: 'https://external.com/page', text: '外部页面' },
        { href: '#anchor', text: '锚点' },
        { href: 'javascript:void(0)', text: '脚本' },
      ]),
    } as unknown as Page;

    const explorer = new BFSExplorer(perceiver, database, 'target-1', {
      maxPages: 1,
      maxDepth: 1,
      excludePaths: [],
    });
    const result = await explorer.explore(page, 'https://example.com/page');

    expect(result.pagesVisited).toBe(1);
    expect(result.totalComponents).toBe(1);
    expect(result.navigationGraph).toEqual([{
      from: 'https://example.com/page',
      to: 'https://example.com/other',
      trigger: '其他页面',
    }]);

    const pageRow = database.prepare('SELECT * FROM pages').get() as any;
    const componentRow = database.prepare('SELECT * FROM components').get() as any;
    expect(pageRow.title).toBe('业务页面');
    expect(componentRow.type).toBe('button');
  });

  it('导航失败时跳过页面', async () => {
    const database = createDatabase();
    const perceiver = { capture: vi.fn() };
    const page = {
      goto: vi.fn().mockRejectedValue(new Error('导航超时')),
      waitForTimeout: vi.fn(),
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn(),
    } as unknown as Page;

    const explorer = new BFSExplorer(perceiver, database, 'target-1', {
      maxPages: 1,
      maxDepth: 1,
      excludePaths: [],
    });
    const result = await explorer.explore(page, 'https://example.com/page');

    expect(result.pagesVisited).toBe(0);
    expect(perceiver.capture).not.toHaveBeenCalled();
    expect(database.prepare('SELECT COUNT(*) AS count FROM pages').get()).toEqual({ count: 0 });
  });
});

describe('StructuredPerceiver', () => {
  it('执行结构化提取并返回页面观察', async () => {
    const observation = createObservation();
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn().mockResolvedValue({
        components: observation.components,
        url: 'https://example.com/page',
        title: '业务页面',
        forms: [{ id: 'form', fieldCount: 1, hasFileInput: false }],
        dialogs: 1,
        loadingOverlays: 0,
      }),
    } as unknown as Page;

    const result = await new StructuredPerceiver().capture(page);
    expect(result.url).toBe('https://example.com/page');
    expect(result.title).toBe('业务页面');
    expect(result.components).toHaveLength(1);
    expect(result.forms).toHaveLength(1);
    expect(result.dialogCount).toBe(1);
    expect(result.networkEvents).toEqual([]);
  });

  it('按需捕获视觉截图', async () => {
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn(),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('image', 'utf-8')),
    } as unknown as Page;

    const visual = await new StructuredPerceiver().captureVisual(page, true);
    expect(visual).toBe(Buffer.from('image', 'utf-8').toString('base64'));
    expect(page.screenshot).toHaveBeenCalledWith({ type: 'png', fullPage: true, timeout: 5000 });
  });
});
