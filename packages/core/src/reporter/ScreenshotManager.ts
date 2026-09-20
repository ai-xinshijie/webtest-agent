import type { Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface ScreenshotInfo {
  id: string;
  filePath: string;
  url: string;
  timestamp: number;
  phase: string;
  description?: string;
}

/**
 * Capture and store screenshots as evidence during testing.
 */
export class ScreenshotManager {
  private screenshotsDir: string;
  private captured: ScreenshotInfo[] = [];

  constructor(baseDir: string, private sessionId: string) {
    this.screenshotsDir = path.join(baseDir, '.wta', 'screenshots', sessionId);
    mkdirSync(this.screenshotsDir, { recursive: true });
  }

  /**
   * Take a screenshot of the current viewport.
   */
  async capture(page: Page, phase: string, description?: string): Promise<ScreenshotInfo | null> {
    try {
      const timestamp = Date.now();
      const filename = `${phase}-${timestamp}.png`;
      const filePath = path.join(this.screenshotsDir, filename);

      await page.screenshot({
        path: filePath,
        type: 'png',
        fullPage: false,
        timeout: 5000,
      });

      const info: ScreenshotInfo = {
        id: `${this.sessionId}-${timestamp}`,
        filePath,
        url: page.url(),
        timestamp,
        phase,
        description,
      };

      this.captured.push(info);
      return info;
    } catch (error) {
      console.warn(`  [screenshot] Failed: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * Take a full-page screenshot.
   */
  async captureFullPage(page: Page, phase: string, description?: string): Promise<ScreenshotInfo | null> {
    try {
      const timestamp = Date.now();
      const filename = `${phase}-full-${timestamp}.png`;
      const filePath = path.join(this.screenshotsDir, filename);

      await page.screenshot({
        path: filePath,
        type: 'png',
        fullPage: true,
        timeout: 10000,
      });

      const info: ScreenshotInfo = {
        id: `${this.sessionId}-${timestamp}-full`,
        filePath,
        url: page.url(),
        timestamp,
        phase,
        description,
      };

      this.captured.push(info);
      return info;
    } catch (error) {
      console.warn(`  [screenshot] Full page failed: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * Get all captured screenshots.
   */
  getAll(): ScreenshotInfo[] {
    return this.captured;
  }

  /**
   * Get screenshots for a specific phase.
   */
  getByPhase(phase: string): ScreenshotInfo[] {
    return this.captured.filter(s => s.phase === phase);
  }
}
