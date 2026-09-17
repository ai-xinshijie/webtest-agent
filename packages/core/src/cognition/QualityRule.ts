import type { StructuredObservation } from '../perception/types.js';

export type RuleLayer = 'builtin' | 'learned';
export type RuleVerdict = 'pass' | 'suspect' | 'fail';

export interface QualityRule {
  id: string;
  layer: RuleLayer;
  name: string;
  statement: string;
  check: (ctx: RuleContext) => Promise<RuleResult>;
  severity: 'critical' | 'major' | 'minor' | 'info';
  appliesTo?: string[];
}

export interface RuleContext {
  before: StructuredObservation;
  action: { type: string; target: string; value?: string };
  after: StructuredObservation;
  networkLog: Array<{ url: string; method: string; status?: number }>;
  consoleLog: string[];
  componentModel: any;
  memory: any;
}

export interface RuleResult {
  score: number;
  verdict: RuleVerdict;
  confidence: number;
  violation?: RuleViolation;
}

export interface RuleViolation {
  ruleId: string;
  description: string;
  evidence: {
    screenshots?: string[];
    networkLog?: Array<{ url: string; status?: number }>;
    consoleLog?: string[];
    beforeState?: any;
    afterState?: any;
  };
  severity: 'critical' | 'major' | 'minor' | 'info';
  reproduction?: string[];
}

/**
 * QR001: Feedback Rule
 * Any user action must produce perceivable feedback within 2 seconds.
 */
export const QR001: QualityRule = {
  id: 'QR001',
  layer: 'builtin',
  name: '反馈性',
  statement: '任何用户操作必须在 2 秒内产生可感知反馈',
  severity: 'major',
  async check(ctx) {
    const beforeComponents = ctx.before.components;
    const afterComponents = ctx.after.components;

    // Check if DOM changed
    const domChanged =
      JSON.stringify(beforeComponents?.map(c => c.selector)) !==
      JSON.stringify(afterComponents?.map(c => c.selector));

    // Check if URL changed
    const urlChanged = ctx.before.url !== ctx.after.url;

    // Check if network requests were made
    const networkActivity = ctx.networkLog.length > 0;

    // Check if console output changed
    const consoleActivity = ctx.consoleLog.length > 0;

    if (domChanged || urlChanged || networkActivity || consoleActivity) {
      return { score: 1.0, verdict: 'pass', confidence: 0.9 };
    }

    return {
      score: 0.2,
      verdict: 'fail',
      confidence: 0.8,
      violation: {
        ruleId: 'QR001',
        description: '操作后 2 秒内无任何可感知反馈（DOM 未变化、URL 未变化、无网络请求、无控制台输出）',
        evidence: {
          beforeState: beforeComponents?.slice(0, 5),
          afterState: afterComponents?.slice(0, 5),
        },
        severity: 'major',
      },
    };
  },
};

/**
 * QR002: Form Validation Rule
 * Submitting a form with invalid input should not send network requests.
 */
export const QR002: QualityRule = {
  id: 'QR002',
  layer: 'builtin',
  name: '表单验证',
  statement: '提交包含非法输入的表单时，不应发出网络请求，应显示验证信息',
  severity: 'critical',
  appliesTo: ['form', 'input', 'select', 'textarea'],
  async check(ctx) {
    // If action was a form submission with invalid input
    const isFormSubmit = ctx.action.type === 'click' &&
      (ctx.action.target.includes('submit') || ctx.action.target.includes('button'));

    if (!isFormSubmit) return { score: 1.0, verdict: 'pass', confidence: 1.0 };

    // Check if validation error is displayed
    const hasValidationError = ctx.after.components?.some(c =>
      c.validationMessage || c.classes.some(cls =>
        cls.includes('error') || cls.includes('invalid')));

    // Check if network request was sent
    const apiCalls = ctx.networkLog.filter(n => n.url.includes('/api/'));

    if (!hasValidationError && apiCalls.length > 0) {
      return {
        score: 0.1,
        verdict: 'fail',
        confidence: 0.9,
        violation: {
          ruleId: 'QR002',
          description: '表单包含非法输入但提交时发出了网络请求且未显示验证信息',
          evidence: {
            networkLog: apiCalls.map(n => ({ url: n.url, status: n.status })),
          },
          severity: 'critical',
        },
      };
    }

    return { score: 0.9, verdict: 'pass', confidence: 0.8 };
  },
};

/**
 * QR006: No Crash Rule
 * Any action should not cause page crash, uncaught JS error, or infinite loading.
 */
export const QR006: QualityRule = {
  id: 'QR006',
  layer: 'builtin',
  name: '无崩溃',
  statement: '任何操作不应导致页面白屏、JS 未捕获异常或无限 loading',
  severity: 'critical',
  async check(ctx) {
    // Check for console errors
    const hasConsoleErrors = ctx.consoleLog.some(log =>
      log.includes('Uncaught') || log.includes('TypeError') || log.includes('ReferenceError'));

    // Check for 5xx network responses
    const serverErrors = ctx.networkLog.filter(n => n.status && n.status >= 500);

    // Check for empty page (white screen)
    const isBlank = ctx.after.components?.length === 0;

    // Check for infinite loading
    const isLoading = ctx.after.loadingOverlayCount > 0;

    if (hasConsoleErrors || serverErrors.length > 0 || isBlank) {
      return {
        score: 0.0,
        verdict: 'fail',
        confidence: 0.95,
        violation: {
          ruleId: 'QR006',
          description: `检测到异常: ${hasConsoleErrors ? 'JS错误' : serverErrors.length ? '服务器错误' : '页面空白'}`,
          evidence: {
            consoleLog: ctx.consoleLog.slice(0, 10),
            networkLog: serverErrors.map(n => ({ url: n.url, status: n.status })),
          },
          severity: 'critical',
        },
      };
    }

    return { score: 1.0, verdict: 'pass', confidence: 0.9 };
  },
};

export const BUILTIN_RULES: QualityRule[] = [QR001, QR002, QR006];
