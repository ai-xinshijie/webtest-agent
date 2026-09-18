import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { ExplorationFrontier } from '../src/exploration/ExplorationFrontier.js';
import { AgentSelfHealer } from '../src/healing/AgentSelfHealer.js';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { ScreenshotManager } from '../src/reporter/ScreenshotManager.js';
import { createDefaultConfig } from '../src/config/types.js';

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('ExplorationFrontier', () => {
  it('按组件类型生成待测动作并计算覆盖率', () => {
    const frontier = new ExplorationFrontier();
    frontier.initialize('page-1', [
      { id: 'button-1', type: 'button' },
      { id: 'unknown-1', type: 'unknown' },
    ]);

    const first = frontier.dequeue()!;
    expect(first.action).toBe('click');
    frontier.markVisited(first.pageId, first.componentId, first.action);

    while (frontier.dequeue()) {
      // 清空剩余队列，用于验证穷尽状态。
    }
    frontier.markBlocked('page-1', 'button-1', 'double-click');
    frontier.enqueue('page-1', 'button-1', 'double-click', 10);

    const coverage = frontier.getCoverage();
    expect(frontier.isExhausted()).toBe(true);
    expect(coverage.visited).toBe(1);
    expect(coverage.blocked).toBe(1);
    expect(coverage.percentage).toBe(50);
  });

  it('不重复加入已访问或已阻断的队列项', () => {
    const frontier = new ExplorationFrontier();
    frontier.enqueue('page', 'button', 'click');
    const item = frontier.dequeue()!;
    frontier.markVisited(item.pageId, item.componentId, item.action);
    frontier.enqueue(item.pageId, item.componentId, item.action);
    frontier.markBlocked('page', 'input', 'fill');
    frontier.enqueue('page', 'input', 'fill');

    expect(frontier.isExhausted()).toBe(true);
  });
});

describe('AgentSelfHealer', () => {
  it('致命错误返回跳过结果', async () => {
    const healer = new AgentSelfHealer();
    const result = await healer.executeSafely(async () => {
      throw new Error('配置文件不存在');
    }, { operationName: '读取配置', sessionId: 'session-1' });

    expect(result).toEqual({ skipped: true, reason: '配置文件不存在' });
  });

  it('浏览器崩溃返回跳过结果', async () => {
    const healer = new AgentSelfHealer();
    const result = await healer.executeSafely(async () => {
      throw new Error('Target closed');
    }, { operationName: '点击按钮', sessionId: 'session-1' });

    expect(result).toEqual({ skipped: true, reason: '浏览器崩溃：Target closed' });
  });

  it('LLM 输出格式错误返回跳过结果', async () => {
    const healer = new AgentSelfHealer();
    const result = await healer.executeSafely(async () => {
      throw new Error('validation failed');
    }, { operationName: '解析模型输出', sessionId: 'session-1' });

    expect(result).toEqual({ skipped: true, reason: '模型输出格式错误：validation failed' });
  });

  it('检测重复动作循环并改变策略', async () => {
    const healer = new AgentSelfHealer();
    let skipped = false;

    for (let i = 0; i < 6; i++) {
      const result = await healer.executeSafely(async () => i, {
        operationName: '点击同一按钮',
        sessionId: 'session-1',
      });
      if (result && typeof result === 'object' && 'skipped' in result) skipped = true;
    }

    expect(skipped).toBe(true);
  });
});

describe('BrowserManager', () => {
  it('检测浏览器目录、状态并支持无浏览器关闭', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'wta-browser-'));
    const manager = new BrowserManager(tempDir, 'chromium');

    expect(manager.isBrowserAvailable()).toBe(false);
    expect(manager.isAlive()).toBe(false);
    expect(manager.isBrowserAvailable('firefox')).toBe(false);
    expect(manager.isBrowserAvailable('webkit')).toBe(false);
    await expect(manager.createPage('session-1')).rejects.toThrow('未找到会话的浏览器上下文：session-1');
    await expect(manager.close()).resolves.toBe(undefined);
  });
});

describe('ScreenshotManager', () => {
  it('保存截图并按阶段查询', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'wta-screenshot-'));
    const manager = new ScreenshotManager(tempDir, 'session-1');
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/page'),
      screenshot: vi.fn(async (options: { path?: string }) => {
        expect(options.path).toContain('initial');
        writeFileSync(options.path!, '');
      }),
    } as unknown as Page;

    const info = await manager.capture(page, 'initial', '初始页面');
    expect(info).not.toBeNull();
    expect(existsSync(info!.filePath)).toBe(true);
    expect(manager.getAll()).toHaveLength(1);
    expect(manager.getByPhase('initial')).toHaveLength(1);
    expect(manager.getByPhase('after-test')).toHaveLength(0);
  });

  it('截图失败时返回空值', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'wta-screenshot-fail-'));
    const manager = new ScreenshotManager(tempDir, 'session-2');
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/page'),
      screenshot: vi.fn().mockRejectedValue(new Error('页面正在跳转')),
    } as unknown as Page;

    expect(await manager.capture(page, 'initial')).toBeNull();
    expect(await manager.captureFullPage(page, 'initial')).toBeNull();
  });
});

describe('createDefaultConfig', () => {
  it('创建包含模型路由和日志级别的默认配置', () => {
    const config = createDefaultConfig('F:/tmp-project');
    expect(config.dbPath).toContain('F:/tmp-project/.wta/wta.db');
    expect(config.defaultBrowser).toBe('chromium');
    expect(config.models['component-identify'].provider).toBe('anthropic');
    expect(config.logLevel).toBe('info');
  });
});
