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

  /** Check if bundled browser exists */
  isBrowserAvailable(browserType?: string): boolean {
    const type = browserType ?? this.defaultBrowser;
    const browserPath = path.join(this.browserDir, type);
    return existsSync(browserPath);
  }

  /** Launch browser pointing to vendor/browsers */
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
        throw new Error(`Unsupported browser: ${browserType}`);
    }

    return this.browser;
  }

  /** Create an isolated browser context */
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

  /** Create a new page in a context */
  async createPage(sessionId: string): Promise<Page> {
    const context = this.contexts.get(sessionId);
    if (!context) throw new Error(`No context found for session: ${sessionId}`);
    return context.newPage();
  }

  /** Restart browser (self-healing) */
  async restart(): Promise<Browser> {
    await this.close();
    return this.launch();
  }

  /** Close all contexts and browser */
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

  /** Check if browser is alive */
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
