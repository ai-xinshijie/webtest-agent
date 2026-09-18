import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface BrowserLaunchOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  recordVideo?: boolean;
  videoDir?: string;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private contexts: Map<string, BrowserContext> = new Map();

  constructor(
    private browserDir: string,
    private defaultBrowser: 'chromium' | 'firefox' | 'webkit' = 'chromium',
  ) {}

  /** 检查内置浏览器是否存在。 */
  isBrowserAvailable(browserType?: string): boolean {
    const type = browserType ?? this.defaultBrowser;
    const browserPath = path.join(this.browserDir, type);
    return existsSync(browserPath);
  }

  /** 启动内置目录中的浏览器。 */
  async launch(options: BrowserLaunchOptions = {}): Promise<Browser> {
    if (this.browser) return this.browser;

    const browserType = this.defaultBrowser;
    const executablePath = this.getExecutablePath(browserType);

    const launchOptions = {
      headless: options.headless ?? true,
      executablePath: existsSync(executablePath) ? executablePath : undefined,
    };

    switch (browserType) {
      case 'chromium':
        this.browser = await chromium.launch(launchOptions);
        break;
      case 'firefox':
        this.browser = await firefox.launch(launchOptions);
        break;
      case 'webkit':
        this.browser = await webkit.launch(launchOptions);
        break;
      default:
        throw new Error(`不支持的浏览器类型：${browserType}`);
    }

    return this.browser;
  }

  /** 创建隔离的浏览器上下文。 */
  async createContext(sessionId: string, options: BrowserLaunchOptions = {}): Promise<BrowserContext> {
    const browser = await this.launch(options);

    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1920, height: 1080 },
      recordVideo: options.recordVideo
        ? { dir: options.videoDir ?? path.join(process.cwd(), '.wta', 'videos') }
        : undefined,
    });

    this.contexts.set(sessionId, context);
    return context;
  }

  /** 在指定上下文中创建页面。 */
  async createPage(sessionId: string): Promise<Page> {
    const context = this.contexts.get(sessionId);
    if (!context) throw new Error(`未找到会话的浏览器上下文：${sessionId}`);
    return context.newPage();
  }

  /** 重启浏览器，用于测试级自愈。 */
  async restart(): Promise<Browser> {
    await this.close();
    return this.launch();
  }

  /** 关闭全部上下文和浏览器。 */
  async close(): Promise<void> {
    for (const [, context] of this.contexts) {
      await context.close().catch(() => {});
    }
    this.contexts.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  /** 检查浏览器是否存活。 */
  isAlive(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  private getExecutablePath(browserType: string): string {
    const platform = process.platform;
    const arch = process.arch;

    let binaryName: string;
    if (browserType === 'chromium') {
      binaryName = platform === 'win32' ? 'chrome.exe' : platform === 'darwin' ? 'Chromium' : 'chrome';
    } else if (browserType === 'firefox') {
      binaryName = platform === 'win32' ? 'firefox.exe' : 'firefox';
    } else {
      binaryName = platform === 'win32' ? 'webkit2png.exe' : 'webkit2png';
    }

    return path.join(this.browserDir, browserType, binaryName);
  }
}
