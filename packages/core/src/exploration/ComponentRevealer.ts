import type { Page } from 'playwright';
import type { AgentLogger, AgentLogContext } from '../logger/AgentLogger.js';
import { StructuredPerceiver } from '../perception/StructuredPerceiver.js';

export interface RevealResult {
  interactions: number;
  revealedComponents: number;
  revealedSelectors: string[];
}

interface RevealStep {
  description: string;
  selector: string;
  action: 'click' | 'hover';
}

/**
 * 在结构化提取前系统性展开隐藏组件。
 * 覆盖手风琴、Tab、下拉、悬停菜单和可安全打开的弹框入口。
 */
export class ComponentRevealer {
  private perceiver = new StructuredPerceiver();

  constructor(private logger?: AgentLogger) {}

  setLogger(logger: AgentLogger): void {
    this.logger = logger;
  }

  async reveal(page: Page, context: AgentLogContext = { phase: 'explore' }): Promise<RevealResult> {
    const before = await this.capture(page, context);
    const beforeSelectors = new Set(before.components.map(component => component.selector ?? component.tag));
    let interactions = 0;

    const steps: RevealStep[] = [
      { description: '展开手风琴', selector: 'details:not([open]) > summary', action: 'click' },
      {
        description: '展开折叠面板',
        selector: '[role="button"][aria-expanded="false"], button[aria-expanded="false"]',
        action: 'click',
      },
      { description: '切换标签页', selector: '[role="tab"]', action: 'click' },
      {
        description: '展开下拉菜单',
        selector: '[aria-haspopup="true"], [aria-haspopup="menu"], .dropdown-toggle',
        action: 'click',
      },
      {
        description: '悬停菜单入口',
        selector: '[aria-haspopup="menu"], [aria-haspopup="true"]',
        action: 'hover',
      },
    ];

    for (const step of steps) {
      interactions += await this.executeStep(page, step, context);
    }

    await this.closeTransient(page, context);
    const after = await this.capture(page, context);
    const revealedSelectors = after.components
      .filter(component => !beforeSelectors.has(component.selector ?? component.tag))
      .map(component => component.selector ?? component.tag);

    return {
      interactions,
      revealedComponents: revealedSelectors.length,
      revealedSelectors: revealedSelectors.slice(0, 100),
    };
  }

  private async executeStep(
    page: Page,
    step: RevealStep,
    context: AgentLogContext,
  ): Promise<number> {
    let count = 0;
    const elements = await page.locator(step.selector).all();

    for (const element of elements) {
      const execute = async () => {
        if (step.action === 'hover') await element.hover({ timeout: 2000 });
        else await element.click({ timeout: 2000 });
        await page.waitForTimeout(250);
      };

      if (this.logger) {
        await this.logger.runScript(
          { description: step.description, module: 'ComponentRevealer', method: step.action },
          { type: 'reveal', target: step.selector },
          execute,
          context,
        );
      } else {
        await execute();
      }
      count++;
    }

    return count;
  }

  private async closeTransient(page: Page, context: AgentLogContext): Promise<void> {
    const execute = async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await page.mouse.click(4, 4).catch(() => {});
    };

    if (this.logger) {
      await this.logger.runScript(
        { description: '关闭临时下拉和弹层', module: 'ComponentRevealer', method: 'closeTransient' },
        { type: 'close-transient' },
        execute,
        context,
      );
    } else {
      await execute();
    }
  }

  private async capture(page: Page, context: AgentLogContext) {
    if (!this.logger) return this.perceiver.capture(page);

    return this.logger.runScript(
      { description: '提取组件揭示后的页面结构', module: 'StructuredPerceiver', method: 'capture' },
      { type: 'perceive', target: page.url(), params: { reason: 'component-reveal' } },
      () => this.perceiver.capture(page),
      context,
    );
  }
}
