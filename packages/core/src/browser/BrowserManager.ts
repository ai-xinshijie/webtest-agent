import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type BrowserType = 'chromium' | 'firefox' | 'webkit';

export interface BrowserLaunchOptions {
  headless?: boolean;
  browserType?: BrowserType;
  viewport?: { width: number; height: number };
  recordVideo?: boolean;
  videoDir?: string;
  storageStatePath?: string;
}

/**
 * 管理项目内置浏览器。浏览器保存在 vendor/browsers 中，不依赖用户系统浏览器。
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private activeBrowserType: BrowserType | null = null;
  private contexts = new Map<string, BrowserContext>();

  constructor(
    private browserDir: string,
    private defaultBrowser: BrowserType = 'chromium',
  ) {}

  getSessionIds(): string[] {
    return [...this.contexts.keys()];
  }

  isBrowserAvailable(browserType?: string): boolean {
    const type = (browserType ?? this.defaultBrowser) as BrowserType;
    return this.getExecutablePath(type, false) !== null;
  }

  async launch(options: BrowserLaunchOptions = {}): Promise<Browser> {
    const browserType = options.browserType ?? this.defaultBrowser;
    if (this.browser && this.activeBrowserType === browserType) return this.browser;
    if (this.browser) await this.close();

    const executablePath = this.getExecutablePath(
      browserType,
      options.headless ?? true,
    );
    if (!executablePath) {
      throw new Error(`未找到项目内置浏览器：${browserType}，请执行 wta install browsers`);
    }

    const launcher = browserType === 'chromium' ? chromium : browserType === 'firefox' ? firefox : webkit;
    this.browser = await launcher.launch({
      headless: options.headless ?? true,
      executablePath,
    });
    this.activeBrowserType = browserType;
    return this.browser;
  }

  async createContext(
    sessionId: string,
    options: BrowserLaunchOptions = {},
  ): Promise<BrowserContext> {
    const browser = await this.launch(options);
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1920, height: 1080 },
      storageState: options.storageStatePath && existsSync(options.storageStatePath)
        ? options.storageStatePath
        : undefined,
      recordVideo: options.recordVideo
        ? { dir: options.videoDir ?? path.join(process.cwd(), '.wta', 'videos') }
        : undefined,
    });

    this.contexts.set(sessionId, context);
    return context;
  }

  async createPage(sessionId: string): Promise<Page> {
    const context = this.contexts.get(sessionId);
    if (!context) throw new Error(`未找到会话的浏览器上下文：${sessionId}`);
    return context.newPage();
  }

  async closeSession(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) return;
    await context.close().catch(() => {});
    this.contexts.delete(sessionId);
  }

  async restart(): Promise<Browser> {
    await this.close();
    return this.launch();
  }

  async close(): Promise<void> {
    for (const [, context] of this.contexts) {
      await context.close().catch(() => {});
    }
    this.contexts.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.activeBrowserType = null;
  }

  isAlive(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  private getExecutablePath(browserType: BrowserType, preferHeadless: boolean): string | null {
    if (!existsSync(this.browserDir)) return null;
    const executableNames = this.getExecutableNames(browserType, preferHeadless);

    const direct = this.findExecutable(this.browserDir, executableNames, 5);
    if (direct) return direct;

    const entries = readdirSync(this.browserDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(browserType)) continue;
      const found = this.findExecutable(path.join(this.browserDir, entry.name), executableNames, 5);
      if (found) return found;
    }
    return null;
  }

  private findExecutable(
    directory: string,
    executableNames: string[],
    maxDepth: number,
  ): string | null {
    if (!existsSync(directory) || maxDepth < 0) return null;
    for (const name of executableNames) {
      const file = path.join(directory, name);
      if (existsSync(file) && statSync(file).isFile()) return file;
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const found = this.findExecutable(path.join(directory, entry.name), executableNames, maxDepth - 1);
      if (found) return found;
    }
    return null;
  }

  private getExecutableNames(browserType: BrowserType, preferHeadless: boolean): string[] {
    if (browserType === 'chromium') {
      return process.platform === 'win32'
        ? preferHeadless
          ? ['chrome-headless-shell.exe', 'chrome.exe']
          : ['chrome.exe', 'chrome-headless-shell.exe']
        : process.platform === 'darwin'
          ? preferHeadless
            ? ['chrome-headless-shell', 'Chromium', 'chrome']
            : ['Chromium', 'chrome', 'chrome-headless-shell']
          : preferHeadless
            ? ['chrome-headless-shell', 'chrome']
            : ['chrome', 'chrome-headless-shell'];
    }
    if (browserType === 'firefox') {
      return process.platform === 'win32' ? ['firefox.exe'] : ['firefox'];
    }
    return process.platform === 'win32'
      ? ['webkitbrowser.exe', 'Playwright.exe', 'webkit2png.exe']
      : ['webkitbrowser', 'Playwright', 'webkit2png'];
  }
}
