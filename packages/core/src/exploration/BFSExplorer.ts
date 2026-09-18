import type { Page } from 'playwright';
import type { StructuredObservation } from '../perception/types.js';
import { classifyComponent, type ComponentModel, type PageNode, type Component } from '../cognition/ComponentModel.js';
import type { DatabaseManager } from '../db/Database.js';
import { randomUUID } from 'node:crypto';
import type { AgentLogger } from '../logger/AgentLogger.js';

export interface ExplorerOptions {
  maxPages: number;
  maxDepth: number;
  excludePaths: string[];
}

export interface ExplorationResult {
  pagesVisited: number;
  newPagesDiscovered: number;
  totalComponents: number;
  navigationGraph: Array<{ from: string; to: string; trigger: string }>;
}

/**
 * BFS page explorer: discovers all reachable pages via navigation links.
 */
export class BFSExplorer {
  private visitedUrls = new Set<string>();
  private queue: Array<{ url: string; depth: number; trigger: string }> = [];

  constructor(
    private perceiver: { capture(page: Page): Promise<StructuredObservation> },
    private db: DatabaseManager,
    private targetId: string,
    private options: ExplorerOptions = { maxPages: 50, maxDepth: 3, excludePaths: [] },
    private logger?: AgentLogger,
  ) {}

  /**
   * Explore pages starting from the current URL.
   */
  async explore(page: Page, startUrl: string): Promise<ExplorationResult> {
    const result: ExplorationResult = {
      pagesVisited: 0,
      newPagesDiscovered: 0,
      totalComponents: 0,
      navigationGraph: [],
    };

    this.queue.push({ url: startUrl, depth: 0, trigger: 'start' });

    while (this.queue.length > 0 && result.pagesVisited < this.options.maxPages) {
      const { url, depth, trigger } = this.queue.shift()!;
      const normalizedUrl = this.normalizeUrl(url);

      // Skip if already visited
      if (this.visitedUrls.has(normalizedUrl)) continue;
      this.visitedUrls.add(normalizedUrl);

      // Skip excluded paths
      if (this.options.excludePaths.some(path => normalizedUrl.includes(path))) continue;

      // Navigate to page
      try {
        const navigate = () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (this.logger) {
          await this.logger.runScript(
          { description: `探索页面：${normalizedUrl}`, module: 'BFSExplorer', method: 'page.goto' },
          { type: 'navigate', target: url, params: { depth, trigger } },
            navigate,
            { pageUrl: url, phase: 'explore' },
          );
        } else {
          await navigate();
        }
        const waitForContent = () => page.waitForTimeout(1000);
        if (this.logger) {
          await this.logger.runScript(
          { description: '等待动态内容加载', module: 'BFSExplorer', method: 'waitForTimeout' },
          { type: 'wait', target: url, params: { timeout: 1000 } },
            waitForContent,
            { pageUrl: url, phase: 'explore' },
          );
        } else {
          await waitForContent();
        }
      } catch (error) {
        console.warn(`  [explorer] Failed to navigate to ${url}: ${error instanceof Error ? error.message : error}`);
        this.logger?.logScript(
          { description: `页面导航失败：${normalizedUrl}`, module: 'BFSExplorer', method: 'page.goto' },
          { type: 'navigate', target: url, params: { depth, trigger } },
          { status: 'warning', duration: 0, error: error instanceof Error ? error.message : String(error) },
          { pageUrl: url, phase: 'explore' },
        );
        continue;
      }

      // Capture and classify
      const observation = await (
        this.logger
          ? this.logger.runScript(
              { description: '结构化提取页面组件', module: 'StructuredPerceiver', method: 'capture' },
              { type: 'perceive', target: url, params: { componentCountExpected: true } },
              () => this.perceiver.capture(page),
              { pageUrl: url, phase: 'explore' },
            )
          : this.perceiver.capture(page)
      );
      const pageId = this.persistPage(observation, normalizedUrl);
      this.logger?.logScript(
        { description: '持久化页面组件模型', module: 'BFSExplorer', method: 'persistPage' },
        { type: 'persist-model', target: normalizedUrl, params: { componentCount: observation.components.length } },
        { status: 'success', duration: 0, output: { pageId } },
        { pageUrl: normalizedUrl, phase: 'explore' },
      );
      result.pagesVisited++;

      // Extract all links directly from the page (more reliable than component selectors)
      const pageLinks = await page.evaluate(`
        Array.from(document.querySelectorAll('a[href]')).map(el => ({
          href: el.getAttribute('href') || '',
          text: el.textContent?.trim() || ''
        })).filter(l => l.href && !l.href.startsWith('#') &&
          !l.href.startsWith('javascript:') && !l.href.startsWith('mailto:') &&
          !l.href.startsWith('tel:'))
      `) as Array<{ href: string; text: string }>;

      for (const link of pageLinks) {
        const absoluteUrl = this.resolveUrl(link.href, observation.url);
        if (!absoluteUrl) continue;

        const normalizedTarget = this.normalizeUrl(absoluteUrl);

        // Only follow same-origin links
        const currentOrigin = new URL(observation.url).origin;
        const targetOrigin = new URL(absoluteUrl).origin;
        if (currentOrigin !== targetOrigin) continue;

        // Skip excluded paths
        if (this.options.excludePaths.some(path => normalizedTarget.includes(path))) continue;

        if (!this.visitedUrls.has(normalizedTarget)) {
          if (depth < this.options.maxDepth) {
            this.queue.push({ url: absoluteUrl, depth: depth + 1, trigger: link.text || 'link' });
            result.navigationGraph.push({ from: normalizedUrl, to: normalizedTarget, trigger: link.text || 'link' });
          }
        }
      }

      result.totalComponents += observation.components.length;
      console.log(`  [explorer] Visited ${result.pagesVisited}: ${normalizedUrl} (${pageLinks.length} links, ${observation.components.length} components, queue: ${this.queue.length})`);
    }

    result.newPagesDiscovered = result.pagesVisited;
    return result;
  }

  /**
   * Persist a page and its components to the database.
   */
  private persistPage(observation: StructuredObservation, urlPattern: string): string {
    const pageId = randomUUID();

    this.db.prepare(`
      INSERT OR REPLACE INTO pages (id, target_id, url_pattern, title, role, first_seen_at, last_visited_at, visit_count, test_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'partial')
    `).run(pageId, this.targetId, urlPattern, observation.title, 'unknown', Date.now(), Date.now());

    const insertComponent = this.db.prepare(`
      INSERT INTO components (id, target_id, page_id, type, selector, label, state_json, confidence, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const extracted of observation.components) {
      const classified = classifyComponent(extracted);
      insertComponent.run(
        randomUUID(),
        this.targetId,
        pageId,
        classified.type,
        extracted.selector ?? extracted.tag,
        extracted.text ?? extracted.ariaLabel ?? 'unknown',
        JSON.stringify(extracted.state),
        classified.confidence,
        classified.source,
        Date.now(),
        Date.now(),
      );
    }

    return pageId;
  }



  /**
   * Resolve relative URL to absolute.
   */
  private resolveUrl(href: string, baseUrl: string): string | null {
    try {
      if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
        return null;
      }
      return new URL(href, baseUrl).href;
    } catch {
      return null;
    }
  }

  /**
   * Normalize URL for dedup (remove hash, trailing slash).
   */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
    } catch {
      return url;
    }
  }
}
