import type { Page } from 'playwright';
import type { ExtractedComponent } from '../perception/types.js';
import type { AgentLogger, AgentLogContext } from '../logger/AgentLogger.js';

export interface ReachabilityResult {
  reachable: boolean;
  status: 'ready' | 'temporarily-blocked' | 'permanently-blocked';
  reason?: string;
  attempts: string[];
}

/**
 * 用无副作用检查确认控件是否可由真实用户访问。静态提取只是一时快照，
 * 因此先尝试滚动与 Playwright 可操作性检查，再将控件归类为受阻。
 */
export class ReachabilityResolver {
  constructor(private logger?: AgentLogger) {}

  async resolve(
    page: Page,
    component: ExtractedComponent,
    action: string,
    context: AgentLogContext,
  ): Promise<ReachabilityResult> {
    if (!component.state.enabled) {
      return {
        reachable: false,
        status: 'permanently-blocked',
        reason: '组件当前已禁用，需要满足业务前置条件后重测',
        attempts: ['读取静态禁用状态'],
      };
    }

    const selector = component.selector;
    if (!selector || typeof page.locator !== 'function') return this.fromStaticState(component);

    const attempts: string[] = [];
    try {
      const locator = page.locator(selector);
      if (typeof locator.scrollIntoViewIfNeeded !== 'function'
        || typeof locator.isVisible !== 'function'
        || typeof locator.isEnabled !== 'function') {
        return this.fromStaticState(component);
      }
      await this.run('滚动组件到可视区域', selector, () => locator.scrollIntoViewIfNeeded({ timeout: 2000 }), context);
      attempts.push('已尝试滚动到可视区域');

      const [visible, enabled] = await Promise.all([locator.isVisible({ timeout: 2000 }), locator.isEnabled({ timeout: 2000 })]);
      attempts.push(`Playwright 可见性=${visible}`);
      attempts.push(`Playwright 启用态=${enabled}`);
      if (!enabled) {
        return {
          reachable: false, status: 'permanently-blocked',
          reason: '组件当前已禁用，需要满足业务前置条件后重测', attempts,
        };
      }
      if (!visible) {
        return {
          reachable: false, status: 'temporarily-blocked',
          reason: '组件经滚动后仍不可见，可能需要展开容器、切换标签或人工配置前置条件', attempts,
        };
      }

      if (this.requiresClickTrial(action) && typeof locator.click === 'function') {
        await this.run('验证组件可点击性', selector, () => locator.click({ trial: true, timeout: 2000 }), context);
        attempts.push('Playwright trial click 通过');
      }
      return { reachable: true, status: 'ready', attempts };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push(`可达性检查失败：${reason}`);
      return {
        reachable: false,
        status: 'temporarily-blocked',
        reason: `组件可达性探测失败：${reason}`,
        attempts,
      };
    }
  }

  private fromStaticState(component: ExtractedComponent): ReachabilityResult {
    if (component.state.visible) return { reachable: true, status: 'ready', attempts: ['缺少 Locator 接口，使用结构化快照'] };
    return {
      reachable: false,
      status: 'temporarily-blocked',
      reason: '组件当前不可见，尚未获得可达性探测能力',
      attempts: ['缺少 Locator 接口，使用结构化快照'],
    };
  }

  private requiresClickTrial(action: string): boolean {
    return !['fill', 'fill-max', 'clear', 'select-first', 'select-last', 'check', 'uncheck'].includes(action);
  }

  private async run(
    description: string,
    selector: string,
    execution: () => Promise<unknown>,
    context: AgentLogContext,
  ): Promise<void> {
    if (this.logger) {
      await this.logger.runScript(
        { description, module: 'ReachabilityResolver', method: 'resolve' },
        { type: 'reachability-check', target: selector },
        execution,
        context,
      );
      return;
    }
    await execution();
  }
}
