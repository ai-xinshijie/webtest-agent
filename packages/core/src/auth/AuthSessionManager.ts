import type { Page } from 'playwright';
import { readFileSync } from 'node:fs';
import type { TargetConfig } from '../config/types.js';
import type { AgentLogger, AgentLogContext } from '../logger/AgentLogger.js';

export interface LoginResult {
  performed: boolean;
  success: boolean;
  reason?: string;
  requiresManual?: boolean;
}

/**
 * 自动登录并保存浏览器状态，用于会话保持和过期重登。
 */
export class AuthSessionManager {
  constructor(private logger?: AgentLogger) {}

  setLogger(logger: AgentLogger): void {
    this.logger = logger;
  }

  async login(
    page: Page,
    target: TargetConfig,
    context: AgentLogContext = { phase: 'login' },
  ): Promise<LoginResult> {
    if (!target.credentials.username && !target.credentials.password) {
      return { performed: false, success: true, reason: '目标未配置凭证，跳过登录' };
    }

    const challenge = await this.detectChallenge(page);
    if (challenge) {
      return {
        performed: false,
        success: false,
        requiresManual: true,
        reason: '检测到' + challenge + '，需要人工认证后导入登录状态',
      };
    }

    const password = page.locator('input[type="password"]').first();
    if (!(await password.count())) {
      return { performed: false, success: true, reason: '当前页面没有登录表单' };
    }

    const usernameSelector = await this.findUsernameSelector(page);
    if (!usernameSelector) {
      return { performed: false, success: false, reason: '未识别用户名输入框' };
    }

    const execute = async () => {
      await page.fill(usernameSelector, target.credentials.username, { timeout: 10000 });
      await password.fill(target.credentials.password, { timeout: 10000 });
      const submit = await this.findSubmitSelector(page);
      if (submit) await page.click(submit, { timeout: 10000 });
      else await password.press('Enter');
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    };

    try {
      if (this.logger) {
        await this.logger.runScript(
          { description: '自动填写登录表单并提交', module: 'AuthSessionManager', method: 'login' },
          { type: 'login', target: target.url, params: { usernameHint: target.credentials.usernameHint ?? '自动识别' } },
          execute,
          context,
        );
      } else {
        await execute();
      }
    } catch (error) {
      return {
        performed: true,
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const failed = await this.hasLoginFailure(page);
    return {
      performed: true,
      success: !failed,
      reason: failed ? '登录后页面仍显示登录错误' : undefined,
    };
  }

  async saveState(page: Page, filePath: string, context: AgentLogContext = { phase: 'login' }): Promise<void> {
    const execute = () => page.context().storageState({ path: filePath });
    if (this.logger) {
      await this.logger.runScript(
        { description: '保存登录后的浏览器状态', module: 'AuthSessionManager', method: 'saveState' },
        { type: 'save-auth-state', target: filePath },
        execute,
        context,
      );
    } else {
      await execute();
    }
  }

  async restoreState(page: Page, filePath: string, context: AgentLogContext = { phase: 'login' }): Promise<void> {
    const execute = async () => {
      const state = JSON.parse(readFileSync(filePath, 'utf-8')) as {
        cookies: Array<Record<string, unknown>>;
        origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
      };
      await page.context().addCookies(state.cookies as any);
      await page.context().addInitScript((origins: typeof state.origins) => {
        for (const site of origins) {
          const browserLocation = (globalThis as { location?: { origin: string } }).location;
          if (browserLocation?.origin !== site.origin) continue;
          for (const item of site.localStorage) {
            (globalThis as { localStorage?: Storage }).localStorage?.setItem(item.name, item.value);
          }
        }
      }, state.origins);
    };
    if (this.logger) {
      await this.logger.runScript(
        { description: '恢复登录状态占位检查', module: 'AuthSessionManager', method: 'restoreState' },
        { type: 'restore-auth-state', target: filePath },
        execute,
        context,
      );
    } else {
      await execute();
    }
  }

  private async findUsernameSelector(page: Page): Promise<string | null> {
    const preferred = [
      'input[name="username"]',
      'input[name="email"]',
      'input[name="account"]',
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[placeholder*="用户"]',
      'input[placeholder*="账号"]',
      'input[placeholder*="邮箱"]',
    ];

    for (const selector of preferred) {
      if (await page.locator(selector).count()) return selector;
    }

    const generic = page.locator('form input:not([type="password"]):not([type="hidden"])').first();
    if (await generic.count()) return 'form input:not([type="password"]):not([type="hidden"])';
    return null;
  }

  private async findSubmitSelector(page: Page): Promise<string | null> {
    const candidates = [
      'form button[type="submit"]',
      'form button:has-text("登录")',
      'form button:has-text("Sign in")',
      'form button:has-text("Login")',
    ];
    for (const selector of candidates) {
      if (await page.locator(selector).count()) return selector;
    }
    return null;
  }

  private async hasLoginFailure(page: Page): Promise<boolean> {
    return page.getByText(/用户名或密码错误|登录失败|invalid username|incorrect password/i)
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);
  }

  private async detectChallenge(page: Page): Promise<'验证码' | '二次验证' | null> {
    const captchaSelectors = [
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      '[class*="captcha" i]',
      '[data-sitekey]',
    ];
    for (const selector of captchaSelectors) {
      if (await page.locator(selector).count().catch(() => 0)) return '验证码';
    }

    const twoFactorSelectors = [
      'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]',
      'input[name*="2fa" i]',
      'input[name*="verification" i]',
    ];
    for (const selector of twoFactorSelectors) {
      if (await page.locator(selector).count().catch(() => 0)) return '二次验证';
    }
    return null;
  }
}
