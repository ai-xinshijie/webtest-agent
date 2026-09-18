import type { Page } from 'playwright';
import type { Component } from '../cognition/ComponentModel.js';
import type { ExtractedComponent } from '../perception/types.js';
import type { AgentLogger, AgentLogContext } from '../logger/AgentLogger.js';

interface ExecutionOptions {
  context: AgentLogContext;
}

/**
 * Execute interactions on page components (fill, click, select, etc.)
 */
export class InteractionExecutor {
  private logger?: AgentLogger;

  /** 注入会话日志器。 */
  setLogger(logger: AgentLogger): void {
    this.logger = logger;
  }
  /**
   * Fill a form field with a test value.
   */
  async fill(
    page: Page,
    component: ExtractedComponent,
    value: string,
    options?: ExecutionOptions,
  ): Promise<void> {
    const selector = this.getSelector(component);
    if (!selector) throw new Error(`组件没有可用选择器：${component.tag}`);

    const execute = () => page.fill(selector, value, { timeout: 5000 });
    if (!this.logger || !options) {
      await execute();
      return;
    }

    await this.logger.runScript(
      { description: `填充字段：${this.getFieldName(component)}`, module: 'InteractionExecutor', method: 'fill' },
      { type: 'fill', target: selector, params: { value } },
      execute,
      options.context,
    );
  }

  /**
   * Click a component.
   */
  async click(page: Page, component: ExtractedComponent, options?: ExecutionOptions): Promise<void> {
    const selector = this.getSelector(component);
    if (!selector) throw new Error(`组件没有可用选择器：${component.tag}`);

    const execute = () => page.click(selector, { timeout: 5000 });
    if (!this.logger || !options) {
      await execute();
      return;
    }

    await this.logger.runScript(
      { description: `点击组件：${this.getFieldName(component)}`, module: 'InteractionExecutor', method: 'click' },
      { type: 'click', target: selector, params: { tag: component.tag } },
      execute,
      options.context,
    );
  }

  /**
   * Select an option from a dropdown.
   */
  async selectOption(page: Page, component: ExtractedComponent, value: string): Promise<void> {
    const selector = this.getSelector(component);
    if (!selector) throw new Error(`No selector for component: ${component.tag}`);

    await page.selectOption(selector, value, { timeout: 5000 });
  }

  /**
   * Fill a form with test data based on field type.
   */
  async fillForm(
    page: Page,
    fields: ExtractedComponent[],
    mode: 'valid' | 'empty' | 'invalid' | 'boundary' = 'valid',
    options?: ExecutionOptions,
  ): Promise<Record<string, string>> {
    const filledValues: Record<string, string> = {};

    for (const field of fields) {
      if (!this.isFormField(field)) continue;

      const testValue = this.generateTestValue(field, mode);
      if (testValue !== undefined) {
        await this.fill(page, field, testValue, options);
        filledValues[field.text || field.ariaLabel || field.placeholder || field.tag] = testValue;
      }
    }

    return filledValues;
  }

  /**
   * Submit a form by clicking the submit button.
   */
  async submitForm(
    page: Page,
    submitButton: ExtractedComponent,
    options?: ExecutionOptions,
  ): Promise<void> {
    await this.click(page, submitButton, options);
    // 等待表单提交后的页面反馈。
    if (this.logger && options) {
      await this.logger.runScript(
        { description: '等待表单提交后的页面反馈', module: 'InteractionExecutor', method: 'waitForTimeout' },
        { type: 'wait', params: { timeout: 1000, reason: 'form-feedback' } },
        () => page.waitForTimeout(1000),
        options.context,
      );
    } else {
      await page.waitForTimeout(1000);
    }
  }

  /**
   * Generate test values based on field type and test mode.
   */
  private generateTestValue(
    field: ExtractedComponent,
    mode: 'valid' | 'empty' | 'invalid' | 'boundary',
  ): string | undefined {
    if (mode === 'empty') return '';
    if (mode === 'invalid') return this.getInvalidValue(field);
    if (mode === 'boundary') return this.getBoundaryValue(field);
    return this.getValidValue(field);
  }

  private getValidValue(field: ExtractedComponent): string {
    const type = field.type || '';
    const placeholder = field.placeholder || '';
    const label = field.text || field.ariaLabel || field.placeholder || '';

    if (
      type === 'email' ||
      label.toLowerCase().includes('email') ||
      label.includes('邮箱') ||
      placeholder.toLowerCase().includes('email') ||
      placeholder.includes('邮箱')
    ) {
      return 'test@example.com';
    }
    if (type === 'tel' || label.toLowerCase().includes('phone')) {
      return '13800138000';
    }
    if (type === 'number') return '42';
    if (type === 'url' || label.toLowerCase().includes('website')) {
      return 'https://example.com';
    }
    if (type === 'password') return 'TestPass123!';
    if (type === 'date') return '2024-01-15';
    if (field.tag === 'textarea') {
      return 'This is a test address for automated testing.';
    }
    if (label.toLowerCase().includes('name') || label.toLowerCase().includes('user')) {
      return 'Test User';
    }
    return 'Test Value';
  }

  private getInvalidValue(field: ExtractedComponent): string {
    const type = field.type || '';
    if (type === 'email') return 'not-an-email';
    if (type === 'number') return 'not-a-number';
    if (type === 'url') return 'not-a-url';
    if (field.maxLength && field.maxLength > 0) {
      return 'a'.repeat(field.maxLength + 100);
    }
    return '<script>alert(1)</script>';
  }

  private getBoundaryValue(field: ExtractedComponent): string {
    if (field.maxLength && field.maxLength > 0) {
      return 'a'.repeat(field.maxLength);
    }
    return 'a'.repeat(1000);
  }

  private getFieldName(component: ExtractedComponent): string {
    return component.text || component.ariaLabel || component.placeholder || component.testId || component.tag;
  }

  private isFormField(field: ExtractedComponent): boolean {
    return ['input', 'textarea', 'select'].includes(field.tag) ||
      field.role === 'textbox' || field.role === 'combobox';
  }

  private getSelector(component: ExtractedComponent): string | null {
    if (component.selector) return component.selector;
    if (component.id) return `#${component.id}`;
    if (component.testId) return `[data-testid="${component.testId}"]`;
    if (component.ariaLabel) return `${component.tag}[aria-label="${component.ariaLabel}"]`;
    if (component.placeholder) return `${component.tag}[placeholder="${component.placeholder}"]`;
    return null;
  }
}
