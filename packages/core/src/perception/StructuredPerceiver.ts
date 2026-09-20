import type { Page } from 'playwright';
import type { StructuredObservation, ExtractedComponent, NetworkEvent } from './types.js';

/**
 * Custom extraction script executed in browser context.
 * Extracts only testing-relevant data with CSS states, clickability scoring,
 * form constraints, and precise selectors for subsequent Playwright operations.
 */
const EXTRACTION_SCRIPT = `(() => {
  const components = [];
  const seen = new Set();

  const INTERACTIVE_SELECTOR = [
    'button', 'a', 'input', 'select', 'textarea',
    '[role="button"]', '[role="combobox"]', '[role="tab"]',
    '[role="dialog"]', '[role="checkbox"]', '[role="switch"]',
    '[role="menuitem"]', '[role="option"]', '[role="textbox"]',
    '[onclick]', '[tabindex]',
    '.ant-select', '.el-select', '.ant-collapse',
    '[class*="dropdown"]', '[class*="accordion"]', '[class*="modal"]',
    '[class*="clickable"]', '[class*="cursor-pointer"]',
  ].join(', ');

  document.querySelectorAll(INTERACTIVE_SELECTOR).forEach(el => {
    if (seen.has(el)) return;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);

    // Multi-signal clickability scoring
    const isSemanticTag = ['button', 'a', 'input', 'select', 'textarea']
      .includes(el.tagName.toLowerCase());
    const hasAriaRole = ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'switch']
      .includes(el.getAttribute('role'));
    const cursorPointer = style.cursor === 'pointer';
    const hasOnclick = el.hasAttribute('onclick');
    const hasTabIndex = el.hasAttribute('tabindex');

    const clickabilityScore =
      (isSemanticTag ? 0.3 : 0) +
      (hasAriaRole ? 0.25 : 0) +
      (cursorPointer ? 0.2 : 0) +
      (hasOnclick ? 0.15 : 0) +
      (hasTabIndex ? 0.1 : 0);

    const isDisabled = el.disabled
      || el.hasAttribute('disabled')
      || el.getAttribute('aria-disabled') === 'true'
      || style.pointerEvents === 'none'
      || Array.from(el.classList).some(c =>
        c.includes('disabled') || c.includes('readonly'));

    components.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      text: el.textContent?.trim().slice(0, 80) || undefined,
      id: el.id || undefined,
      classes: Array.from(el.classList).slice(0, 8),
      testId: el.dataset?.testid || el.getAttribute('data-testid') || undefined,
      ariaLabel: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('placeholder'),

      state: {
        visible: rect.width > 0 && rect.height > 0,
        enabled: !isDisabled,
        inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
        cursorPointer,
        userSelectNone: style.userSelect === 'none',
      },

      clickability: {
        score: clickabilityScore,
        isInteractive: clickabilityScore >= 0.3 && !isDisabled,
        isHighConfidence: clickabilityScore >= 0.5,
        signals: { isSemanticTag, hasAriaRole, cursorPointer, hasOnclick, hasTabIndex },
      },

      // Form field details
      value: el.value !== undefined ? String(el.value).slice(0, 100) : undefined,
      type: el.type,
      required: el.required || el.hasAttribute('required'),
      maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      pattern: el.pattern || undefined,
      validationMessage: el.validationMessage || undefined,

      // Hierarchy
      parentDialog: el.closest('[role="dialog"], .ant-modal')?.id || undefined,
      parentForm: el.closest('form')?.id || undefined,
      parentAccordion: el.closest('.ant-collapse-item, details')?.id || undefined,

      // Position (for overlap detection)
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height),
      },

      // Precise selector for subsequent Playwright operations
      selector: (() => {
        if (el.dataset?.testid) return '[data-testid="' + el.dataset.testid + '"]';
        if (el.id) return '#' + CSS.escape(el.id);
        if (el.getAttribute('aria-label')) {
          const selector = el.tagName.toLowerCase() + '[aria-label="' + el.getAttribute('aria-label') + '"]';
          if (document.querySelectorAll(selector).length === 1) return selector;
        }
        if (el.getAttribute('role')) {
          const selector = '[role="' + el.getAttribute('role') + '"]';
          if (document.querySelectorAll(selector).length === 1) return selector;
        }
        // Text-based selector for links and buttons
        const text = el.textContent?.trim().slice(0, 50);
        if (text && ['a', 'button'].includes(el.tagName.toLowerCase())) {
          const escaped = text.replace(/"/g, '\\\\\\"');
          return el.tagName.toLowerCase() + ':has-text("' + escaped + '")';
        }
        // Class-based selector (first unique class)
        const uniqueClass = Array.from(el.classList).find(c =>
          document.querySelectorAll('.' + CSS.escape(c)).length === 1);
        if (uniqueClass) return '.' + CSS.escape(uniqueClass);
        // 相同 role、文本或 class 在业务列表中通常会重复。使用从 body 开始的
        // nth-of-type 路径保留元素实例身份，避免后续测试只命中首个控件。
        const path = [];
        let current = el;
        while (current && current !== document.body && path.length < 8) {
          let index = 1;
          let sibling = current.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === current.tagName) index++;
            sibling = sibling.previousElementSibling;
          }
          path.unshift(current.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
          current = current.parentElement;
        }
        return 'body > ' + path.join(' > ');
      })(),
    });
  });

  return {
    components,
    url: location.href,
    title: document.title,
    forms: Array.from(document.querySelectorAll('form')).map(f => ({
      id: f.id,
      fieldCount: f.querySelectorAll('input, select, textarea').length,
      hasFileInput: f.querySelector('input[type="file"]') !== null,
    })),
    dialogs: Array.from(document.querySelectorAll('[role="dialog"], .ant-modal')).length,
    loadingOverlays: Array.from(document.querySelectorAll(
      '.ant-spin, .loading, [class*="loading"]'
    )).filter(el => el.getBoundingClientRect().height > 0).length,
  };
})()`;

export class StructuredPerceiver {
  private events = new WeakMap<Page, { network: NetworkEvent[]; console: string[] }>();

  /** 注册一次 Playwright 事件监听；读取观察时会返回并清空上一动作的证据。 */
  observe(page: Page): void {
    if (this.events.has(page)) return;
    const state = { network: [] as NetworkEvent[], console: [] as string[] };
    this.events.set(page, state);
    if (typeof page.on !== 'function') return;
    page.on('request', request => {
      state.network.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
      });
    });
    page.on('response', response => {
      const request = response.request();
      state.network.push({
        url: response.url(),
        method: request.method(),
        status: response.status(),
        resourceType: request.resourceType(),
      });
    });
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') {
        state.console.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', error => state.console.push(`pageerror: ${error.message}`));
  }

  drainEvidence(page: Page): { networkEvents: NetworkEvent[]; consoleEvents: string[] } {
    this.observe(page);
    const state = this.events.get(page)!;
    const evidence = { networkEvents: state.network, consoleEvents: state.console };
    state.network = [];
    state.console = [];
    return evidence;
  }

  /**
   * Capture structured observation from page using custom extraction script.
   * This is the primary perception channel (DOM + CSS states + clickability).
   */
  async capture(page: Page): Promise<StructuredObservation> {
    this.observe(page);
    const [extracted, url] = await Promise.all([
      page.evaluate(EXTRACTION_SCRIPT) as Promise<{
        components: ExtractedComponent[];
        url: string;
        title: string;
        forms: Array<{ id: string; fieldCount: number; hasFileInput: boolean }>;
        dialogs: number;
        loadingOverlays: number;
      }>,
      Promise.resolve(page.url()),
    ]);

    const { networkEvents, consoleEvents } = this.drainEvidence(page);

    return {
      type: 'structured',
      timestamp: Date.now(),
      url: url,
      title: extracted.title,
      components: extracted.components,
      forms: extracted.forms,
      dialogCount: extracted.dialogs,
      loadingOverlayCount: extracted.loadingOverlays,
      networkEvents,
      consoleEvents,
    };
  }

  /**
   * Capture a screenshot (visual perception channel, triggered on demand).
   */
  async captureVisual(page: Page, fullPage = false): Promise<string> {
    const buffer = await page.screenshot({
      type: 'png',
      fullPage,
      timeout: 5000,
    });
    return buffer.toString('base64');
  }

}
