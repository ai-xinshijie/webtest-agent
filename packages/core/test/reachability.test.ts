import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { ReachabilityResolver } from '../src/exploration/ReachabilityResolver.js';
import type { ExtractedComponent } from '../src/perception/types.js';

function component(overrides: Partial<ExtractedComponent> = {}): ExtractedComponent {
  return {
    tag: 'button', role: 'button', classes: [], ariaLabel: null, placeholder: null, selector: '#submit',
    state: { visible: true, enabled: true, inViewport: false, cursorPointer: true, userSelectNone: false },
    clickability: {
      score: 1, isInteractive: true, isHighConfidence: true,
      signals: { isSemanticTag: true, hasAriaRole: true, cursorPointer: true, hasOnclick: false, hasTabIndex: false },
    },
    rect: { x: 0, y: 0, w: 100, h: 40 },
    ...overrides,
  };
}

function page(locator: Record<string, unknown>): Page {
  return { locator: vi.fn(() => locator) } as unknown as Page;
}

describe('ReachabilityResolver', () => {
  it('滚动并用 trial click 验证可点击控件', async () => {
    const locator = {
      scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
    };
    const result = await new ReachabilityResolver().resolve(page(locator), component(), 'click', { phase: 'test' });
    expect(result).toEqual({
      reachable: true, status: 'ready',
      attempts: ['已尝试滚动到可视区域', 'Playwright 可见性=true', 'Playwright 启用态=true', 'Playwright trial click 通过'],
    });
    expect(locator.click).toHaveBeenCalledWith({ trial: true, timeout: 2000 });
  });

  it('把禁用态和不可见态区分为永久和临时阻断', async () => {
    const disabled = await new ReachabilityResolver().resolve(page({}), component({ state: { ...component().state, enabled: false } }), 'click', { phase: 'test' });
    expect(disabled).toMatchObject({ reachable: false, status: 'permanently-blocked', reason: '组件当前已禁用，需要满足业务前置条件后重测' });

    const hiddenLocator = {
      scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      isVisible: vi.fn().mockResolvedValue(false),
      isEnabled: vi.fn().mockResolvedValue(true),
    };
    const hidden = await new ReachabilityResolver().resolve(page(hiddenLocator), component(), 'click', { phase: 'test' });
    expect(hidden).toMatchObject({ reachable: false, status: 'temporarily-blocked', reason: expect.stringContaining('经滚动后仍不可见') });

    const runtimeDisabled = await new ReachabilityResolver().resolve(page({
      scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(false),
    }), component(), 'click', { phase: 'test' });
    expect(runtimeDisabled).toMatchObject({ reachable: false, status: 'permanently-blocked' });
  });

  it('通过日志器记录可达性探测步骤', async () => {
    const logger = { runScript: vi.fn(async (_trigger, _action, execution) => execution()) };
    const locator = {
      scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
    };
    const result = await new ReachabilityResolver(logger as any).resolve(page(locator), component(), 'fill', { phase: 'test' });
    expect(result.reachable).toBe(true);
    expect(logger.runScript).toHaveBeenCalledTimes(1);
  });

  it('Locator 缺失或探测异常时安全回退并保留原因', async () => {
    const noSelector = await new ReachabilityResolver().resolve(page({}), component({ selector: null }), 'click', { phase: 'test' });
    expect(noSelector).toMatchObject({ reachable: true, status: 'ready' });
    const fallback = await new ReachabilityResolver().resolve(page({}), component({ state: { ...component().state, visible: false } }), 'fill', { phase: 'test' });
    expect(fallback).toMatchObject({ reachable: false, status: 'temporarily-blocked', reason: '组件当前不可见，尚未获得可达性探测能力' });

    const broken = {
      scrollIntoViewIfNeeded: vi.fn().mockRejectedValue(new Error('被遮挡')),
      isVisible: vi.fn(), isEnabled: vi.fn(),
    };
    const result = await new ReachabilityResolver().resolve(page(broken), component(), 'click', { phase: 'test' });
    expect(result).toMatchObject({ reachable: false, status: 'temporarily-blocked', reason: '组件可达性探测失败：被遮挡' });
    expect(result.attempts).toEqual(['可达性检查失败：被遮挡']);

    const textFailure = await new ReachabilityResolver().resolve(page({
      scrollIntoViewIfNeeded: vi.fn().mockRejectedValue('原始错误'), isVisible: vi.fn(), isEnabled: vi.fn(),
    }), component(), 'click', { phase: 'test' });
    expect(textFailure).toMatchObject({ reason: '组件可达性探测失败：原始错误' });
  });
});
