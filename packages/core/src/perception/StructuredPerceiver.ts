import type { Page } from 'playwright';
import type { StructuredObservation, ExtractedComponent } from './types.js';

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
          return el.tagName.toLowerCase() + '[aria-label="' + el.getAttribute('aria-label') + '"]';
        }
        if (el.getAttribute('role')) {
          return '[role="' + el.getAttribute('role') + '"]';
        }
        return null;
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
  /**
   * Capture structured observation from page using custom extraction script.
   * This is the primary perception channel (DOM + CSS states + clickability).
   */
  async capture(page: Page): Promise<StructuredObservation> {
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

    const networkEvents = await this.captureNetworkEvents(page);

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

  /**
   * Capture network events from page.
   */
  private async captureNetworkEvents(page: Page): Promise<Array<{
    url: string;
    method: string;
    status?: number;
    resourceType: string;
  }>> {
    // Note: Network events are captured via page.on('request'/'response') listeners
    // set up by NetworkMonitor. This is a simplified version for observation.
    return [];
  }
}
