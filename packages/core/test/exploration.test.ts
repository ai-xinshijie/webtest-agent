import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { DatabaseManager } from '../src/db/Database.js';
import { BFSExplorer } from '../src/exploration/BFSExplorer.js';
import { StructuredPerceiver } from '../src/perception/StructuredPerceiver.js';
import type { StructuredObservation } from '../src/perception/types.js';
import { AgentLogger } from '../src/logger/AgentLogger.js';

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

  it('URL 标准化与排除规则在重复和非法地址下保持稳定', async () => {
    const database = createDatabase();
    const explorer = new BFSExplorer({ capture: vi.fn() }, database, 'target-1', {
      maxPages: 1, maxDepth: 1, excludePaths: ['/skip'],
    }) as any;
    expect(explorer.normalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
    expect(explorer.normalizeUrl('非法地址')).toBe('非法地址');
    expect(explorer.resolveUrl('mailto:test@example.com', 'https://example.com')).toBeNull();
    expect(explorer.resolveUrl('bad:url', 'https://example.com')).toBe('bad:url');
  });

  it('跳过已访问和排除页面，并以可读文本记录非 Error 导航失败', async () => {
    const database = createDatabase();
    const page = {
      goto: vi.fn().mockRejectedValue('网关不可用'),
      waitForTimeout: vi.fn(),
      url: vi.fn(),
      evaluate: vi.fn(),
    } as unknown as Page;
    const logger = new AgentLogger(database, 'session-1', { consoleOutput: false });

    const excluded = new BFSExplorer({ capture: vi.fn() }, database, 'target-1', {
      maxPages: 2, maxDepth: 1, excludePaths: ['/skip'],
    }, logger) as any;
    await excluded.explore(page, 'https://example.com/skip');
    expect((page.goto as any)).not.toHaveBeenCalled();

    const duplicate = new BFSExplorer({ capture: vi.fn() }, database, 'target-1', {
      maxPages: 2, maxDepth: 1, excludePaths: [],
    }, logger) as any;
    duplicate.visitedUrls.add('https://example.com/seen');
    await duplicate.explore(page, 'https://example.com/seen');
    expect((page.goto as any)).not.toHaveBeenCalled();

    const failing = new BFSExplorer({ capture: vi.fn() }, database, 'target-1', {
      maxPages: 2, maxDepth: 1, excludePaths: [],
    }, logger);
    await failing.explore(page, 'https://example.com/fail');
    expect(logger.getTimeline().some(log => log.result.error === '网关不可用')).toBe(true);
  });

  it('使用组件标签和 unknown 标签回退持久化缺省字段', async () => {
    const database = createDatabase();
    const observation = {
      ...createObservation(),
      components: [{ ...createObservation().components[0]!, selector: null, text: null, ariaLabel: null }],
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn().mockResolvedValue([]),
    } as unknown as Page;
    const result = await new BFSExplorer({ capture: vi.fn().mockResolvedValue(observation) }, database, 'target-1', {
      maxPages: 1, maxDepth: 0, excludePaths: [],
    }).explore(page, 'https://example.com/page');
    expect(result.totalComponents).toBe(1);
    expect(database.prepare('SELECT selector, label FROM components').get()).toMatchObject({ selector: 'button', label: 'unknown' });
  });

  it('记录揭示、日志、待补导航边并更新已存在页面', async () => {
    const database = createDatabase();
    const first = createObservation();
    const second = { ...createObservation(), url: 'https://example.com/other', title: '其他页面' };
    const perceiver = { capture: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
    const revealer = { reveal: vi.fn().mockResolvedValue({ interactions: 1, revealedComponents: 1, revealedSelectors: ['#revealed'] }) };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn()
        .mockResolvedValueOnce([
          { href: '/other', text: '' }, { href: 'mailto:test@example.com', text: '邮件' },
          { href: 'tel:10086', text: '电话' }, { href: 'http://[bad', text: '错误链接' },
        ])
        .mockResolvedValueOnce([{ href: '/page/', text: '返回' }, { href: '/skip', text: '跳过' }]),
    } as unknown as Page;
    const logger = new AgentLogger(database, 'session-1', { consoleOutput: false });
    const explorer = new BFSExplorer(perceiver, database, 'target-1', {
      maxPages: 5, maxDepth: 2, excludePaths: ['/skip'],
    }, logger, revealer as any);

    const result = await explorer.explore(page, 'https://example.com/page/');

    expect(result).toMatchObject({ pagesVisited: 2, newPagesDiscovered: 2, totalComponents: 2 });
    expect(result.navigationGraph).toContainEqual({
      from: 'https://example.com/page', to: 'https://example.com/other', trigger: 'link',
    });
    expect(revealer.reveal).toHaveBeenCalledTimes(2);
    expect(database.prepare('SELECT COUNT(*) AS count FROM navigation_edges').get()).toEqual({ count: 2 });
    expect(logger.getTimeline().some(log => log.action.type === 'reveal')).toBe(true);

    const update = new BFSExplorer({ capture: vi.fn().mockResolvedValue(first) }, database, 'target-1', {
      maxPages: 1, maxDepth: 0, excludePaths: [],
    });
    await update.explore({
      goto: vi.fn().mockResolvedValue(undefined), waitForTimeout: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue([]),
    } as unknown as Page, 'https://example.com/page');
    expect(database.prepare("SELECT visit_count FROM pages WHERE url_pattern = 'https://example.com/page'").get()).toEqual({ visit_count: 2 });
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
