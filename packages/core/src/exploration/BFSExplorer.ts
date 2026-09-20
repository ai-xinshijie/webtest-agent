import type { Page } from 'playwright';
import type { StructuredObservation } from '../perception/types.js';
import { classifyComponent, classifyComponentScope } from '../cognition/ComponentModel.js';
import type { DatabaseManager } from '../db/Database.js';
import { randomUUID } from 'node:crypto';
import type { AgentLogger } from '../logger/AgentLogger.js';
import type { ComponentRevealer } from './ComponentRevealer.js';

export interface ExplorerOptions {
  maxPages: number;
  maxDepth: number;
  includePaths?: string[];
  excludePaths: string[];
  deadlineAt?: number;
}

export interface ExplorationResult {
  pagesVisited: number;
  newPagesDiscovered: number;
  totalComponents: number;
  navigationGraph: Array<{ from: string; to: string; trigger: string }>;
}

/**
 * 广度优先页面探索器，负责发现可达页面并持久化组件模型。
 */
export class BFSExplorer {
  private visitedUrls = new Set<string>();
  private queue: Array<{ url: string; depth: number; trigger: string }> = [];
  private pendingEdges: Array<{ fromPageId: string; toUrlPattern: string; trigger: string }> = [];

  constructor(
    private perceiver: { capture(page: Page): Promise<StructuredObservation> },
    private db: DatabaseManager,
    private targetId: string,
    private options: ExplorerOptions = { maxPages: 50, maxDepth: 3, includePaths: [], excludePaths: [] },
    private logger?: AgentLogger,
    private revealer?: ComponentRevealer,
  ) {}

  async explore(page: Page, startUrl: string): Promise<ExplorationResult> {
    const result: ExplorationResult = {
      pagesVisited: 0,
      newPagesDiscovered: 0,
      totalComponents: 0,
      navigationGraph: [],
    };

    this.queue.push({ url: startUrl, depth: 0, trigger: 'start' });

    while (this.queue.length > 0 && result.pagesVisited < this.options.maxPages) {
      this.assertWithinDeadline();
      const { url, depth, trigger } = this.queue.shift()!;
      const normalizedUrl = this.normalizeUrl(url);

      if (this.visitedUrls.has(normalizedUrl)) continue;
      this.visitedUrls.add(normalizedUrl);
      if (!this.isInScope(normalizedUrl)) continue;

      try {
        const navigate = () => page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
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
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`  探索器：页面导航失败 ${url}：${reason}`);
        this.logger?.logScript(
          { description: `页面导航失败：${normalizedUrl}`, module: 'BFSExplorer', method: 'page.goto' },
          { type: 'navigate', target: url, params: { depth, trigger } },
          { status: 'warning', duration: 0, error: reason },
          { pageUrl: url, phase: 'explore' },
        );
        continue;
      }

      if (this.revealer) {
        const revealResult = await this.revealer.reveal(page, {
          pageUrl: url,
          phase: 'explore',
        });
        this.logger?.logScript(
          { description: '组件揭示完成', module: 'ComponentRevealer', method: 'reveal' },
          { type: 'reveal', target: url, params: { interactions: revealResult.interactions } },
          { status: 'success', duration: 0, output: revealResult },
          { pageUrl: url, phase: 'explore' },
        );
      }

      const observation = this.logger
        ? await this.logger.runScript(
            { description: '结构化提取页面组件', module: 'StructuredPerceiver', method: 'capture' },
            { type: 'perceive', target: url, params: { componentCountExpected: true } },
            () => this.perceiver.capture(page),
            { pageUrl: url, phase: 'explore' },
          )
        : await this.perceiver.capture(page);

      const pageId = this.persistPage(observation, normalizedUrl);
      this.logger?.logScript(
        { description: '持久化页面组件模型', module: 'BFSExplorer', method: 'persistPage' },
        { type: 'persist-model', target: normalizedUrl, params: { componentCount: observation.components.length } },
        { status: 'success', duration: 0, output: { pageId } },
        { pageUrl: normalizedUrl, phase: 'explore' },
      );
      result.pagesVisited++;

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
        const currentOrigin = new URL(observation.url).origin;
        const targetOrigin = new URL(absoluteUrl).origin;
        if (currentOrigin !== targetOrigin) continue;
        if (!this.isInScope(normalizedTarget)) continue;

        const edge = { from: normalizedUrl, to: normalizedTarget, trigger: link.text || 'link' };
        result.navigationGraph.push(edge);
        if (!this.persistNavigationEdge(pageId, normalizedTarget, edge.trigger)) {
          this.pendingEdges.push({ fromPageId: pageId, toUrlPattern: normalizedTarget, trigger: edge.trigger });
        }

        if (!this.visitedUrls.has(normalizedTarget) && depth < this.options.maxDepth) {
          this.queue.push({
            url: absoluteUrl,
            depth: depth + 1,
            trigger: link.text || 'link',
          });
        }
      }

      result.totalComponents += observation.components.length;
      console.log(
        `  探索页面 ${result.pagesVisited}：${normalizedUrl}，` +
        `链接 ${pageLinks.length} 个，组件 ${observation.components.length} 个，队列 ${this.queue.length} 个`,
      );
    }

    result.newPagesDiscovered = result.pagesVisited;
    this.persistPendingNavigationEdges();
    return result;
  }

  private persistPage(observation: StructuredObservation, urlPattern: string): string {
    const existingPage = this.db.prepare(`
      SELECT id, visit_count FROM pages WHERE target_id = ? AND url_pattern = ?
    `).get(this.targetId, urlPattern) as { id: string; visit_count: number } | undefined;

    let pageId: string;
    if (existingPage) {
      pageId = existingPage.id;
      this.db.prepare(`
        UPDATE pages
        SET title = ?, last_visited_at = ?, visit_count = ?
        WHERE id = ?
      `).run(observation.title, Date.now(), existingPage.visit_count + 1, pageId);
    } else {
      pageId = randomUUID();
      this.db.prepare(`
        INSERT INTO pages
          (id, target_id, url_pattern, title, role, first_seen_at, last_visited_at, visit_count, test_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'partial')
      `).run(
        pageId,
        this.targetId,
        urlPattern,
        observation.title,
        'unknown',
        Date.now(),
        Date.now(),
      );
    }

    for (const extracted of observation.components) {
      const classified = classifyComponent(extracted);
      const scope = classifyComponentScope(extracted, classified.type);
      const selector = extracted.selector ?? extracted.tag;
      const label = extracted.text ?? extracted.ariaLabel ?? 'unknown';

      this.db.prepare(`
        INSERT INTO components
          (id, target_id, page_id, type, selector, label, state_json, confidence, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_id, page_id, selector) DO UPDATE SET
          type = excluded.type,
          label = excluded.label,
          state_json = excluded.state_json,
          confidence = excluded.confidence,
          source = excluded.source,
          updated_at = excluded.updated_at
      `).run(
        randomUUID(),
        this.targetId,
        pageId,
        classified.type,
        selector,
        label,
        JSON.stringify({ ...extracted.state, scope }),
        classified.confidence,
        classified.source,
        Date.now(),
        Date.now(),
      );
    }

    return pageId;
  }

  private persistNavigationEdge(fromPageId: string, toUrlPattern: string, trigger: string): boolean {
    const toPage = this.db.prepare(`
      SELECT id FROM pages WHERE target_id = ? AND url_pattern = ?
    `).get(this.targetId, toUrlPattern) as { id: string } | undefined;
    if (!toPage) return false;

    this.db.prepare(`
      INSERT INTO navigation_edges (id, target_id, from_page_id, to_page_id, trigger_component_id, method)
      VALUES (?, ?, ?, ?, NULL, ?)
      ON CONFLICT(target_id, from_page_id, to_page_id, method) DO NOTHING
    `).run(randomUUID(), this.targetId, fromPageId, toPage.id, trigger);
    return true;
  }

  private persistPendingNavigationEdges(): void {
    for (const edge of this.pendingEdges) {
      this.persistNavigationEdge(edge.fromPageId, edge.toUrlPattern, edge.trigger);
    }
    this.pendingEdges = [];
  }

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

  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
    } catch {
      return url;
    }
  }

  private isInScope(normalizedUrl: string): boolean {
    const includes = this.options.includePaths ?? [];
    if (includes.length > 0 && !includes.some(path => normalizedUrl.includes(path))) return false;
    return !this.options.excludePaths.some(path => normalizedUrl.includes(path));
  }

  private assertWithinDeadline(): void {
    if (this.options.deadlineAt !== undefined && Date.now() >= this.options.deadlineAt) {
      throw new Error('测试会话已达到最大运行时长，未探索页面保留为待发现');
    }
  }
}
