import { randomUUID } from 'node:crypto';
import { BrowserManager } from '../browser/BrowserManager.js';
import { StructuredPerceiver } from '../perception/StructuredPerceiver.js';
import { DatabaseManager } from '../db/Database.js';
import { classifyComponent, type ComponentModel, type Component } from '../cognition/ComponentModel.js';
import { BUILTIN_RULES, type QualityRule, type RuleContext, type RuleResult } from '../cognition/QualityRule.js';
import type { AgentConfig, TargetConfig } from '../config/types.js';
import type { StructuredObservation } from '../perception/types.js';
import type { Page } from 'playwright';

export interface Session {
  id: string;
  targetId: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  phase: 'login' | 'explore' | 'test' | 'combo' | 'chaos' | 'report';
  startedAt: number;
  endedAt?: number;
  currentPage?: Page;
  componentModel?: ComponentModel;
  restartCount: number;
}

export class Orchestrator {
  private sessions: Map<string, Session> = new Map();
  private browserManager: BrowserManager;
  private perceiver: StructuredPerceiver;
  private db: DatabaseManager;
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.browserManager = new BrowserManager(config.browserDir, config.defaultBrowser);
    this.perceiver = new StructuredPerceiver();
    this.db = new DatabaseManager(config.dbPath);
  }

  /**
   * Start a new test session for a target.
   */
  async run(target: TargetConfig, options: {
    runMode?: string;
    phase?: string;
    headless?: boolean;
    parallel?: number;
  } = {}): Promise<Session> {
    const sessionId = randomUUID();

    // Create session record
    const session: Session = {
      id: sessionId,
      targetId: target.name,
      status: 'running',
      phase: 'login',
      startedAt: Date.now(),
      restartCount: 0,
    };

    this.sessions.set(sessionId, session);

    // Persist session
    this.db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at, phase)
      VALUES (?, ?, 'running', ?, 'login')
    `).run(sessionId, target.name, session.startedAt);

    // Run agent loop
    try {
      await this.agentLoop(session, target, options);
    } catch (error) {
      session.status = 'failed';
      this.db.prepare(`
        UPDATE sessions SET status = 'failed', ended_at = ?
        WHERE id = ?
      `).run(Date.now(), sessionId);
      throw error;
    }

    return session;
  }

  /**
   * Main agent loop: perceive → reason → act → check.
   */
  private async agentLoop(
    session: Session,
    target: TargetConfig,
    options: { runMode?: string; phase?: string; headless?: boolean }
  ): Promise<void> {
    const headless = options.headless ?? this.shouldHeadless();

    // Phase 1: Launch browser and navigate
    const context = await this.browserManager.createContext(session.id, {
      headless,
      viewport: this.config.viewport,
    });
    const page = await context.newPage();
    session.currentPage = page;

    // Navigate to target
    await page.goto(target.url, {
      waitUntil: 'networkidle',
      timeout: this.config.timeout.navigation,
    });

    // Phase 2: Explore (perceive + build component model)
    session.phase = 'explore';
    this.updateSessionPhase(session);

    const observation = await this.perceiver.capture(page);
    session.componentModel = this.buildComponentModel(observation);

    // Phase 3: Test (execute quality rules)
    session.phase = 'test';
    this.updateSessionPhase(session);

    const testResults = await this.runQualityRules(session, observation);

    // Phase 4: Report
    session.phase = 'report';
    this.updateSessionPhase(session);
    session.status = 'completed';
    session.endedAt = Date.now();

    this.db.prepare(`
      UPDATE sessions SET status = 'completed', ended_at = ?, phase = 'report'
      WHERE id = ?
    `).run(session.endedAt, session.id);

    // Close context
    await this.browserManager.close();
  }

  /**
   * Build component model from structured observation.
   */
  private buildComponentModel(observation: StructuredObservation): ComponentModel {
    const pageId = randomUUID();
    const components: Component[] = [];

    for (const extracted of observation.components) {
      const classified = classifyComponent(extracted);
      const component: Component = {
        id: randomUUID(),
        pageId,
        type: classified.type,
        selector: extracted.selector ?? extracted.tag,
        label: extracted.text ?? extracted.ariaLabel ?? extracted.testId ?? 'unknown',
        state: {
          visible: extracted.state.visible,
          enabled: extracted.state.enabled,
          value: extracted.value,
        },
        constraints: this.extractConstraints(extracted),
        children: [],
        meta: {
          confidence: classified.confidence,
          source: classified.source,
        },
      };
      components.push(component);
    }

    return {
      pages: [{
        id: pageId,
        url: observation.url,
        title: observation.title,
        urlPattern: this.normalizeUrl(observation.url),
        role: 'unknown',
        components,
        navigationTargets: [],
        meta: {
          firstSeenAt: Date.now(),
          lastVisitedAt: Date.now(),
          visitCount: 1,
          testStatus: 'partial',
        },
      }],
      components,
      interactions: [],
      navigationGraph: [],
      lastUpdatedAt: Date.now(),
    };
  }

  /**
   * Run quality rules against observation.
   */
  private async runQualityRules(
    session: Session,
    observation: StructuredObservation
  ): Promise<RuleResult[]> {
    const results: RuleResult[] = [];
    const rules: QualityRule[] = BUILTIN_RULES;

    for (const rule of rules) {
      const ctx: RuleContext = {
        before: observation,
        action: { type: 'page-load', target: observation.url },
        after: observation,
        networkLog: observation.networkEvents ?? [],
        consoleLog: [],
        componentModel: session.componentModel,
        memory: null,
      };

      try {
        const result = await rule.check(ctx);
        results.push(result);

        // Persist violations as bugs
        if (result.violation) {
          this.db.prepare(`
            INSERT INTO bugs (id, session_id, target_id, severity, title, description, page_url, rule_id, detected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            session.id,
            session.targetId,
            result.violation.severity,
            result.violation.description.slice(0, 100),
            result.violation.description,
            observation.url,
            result.violation.ruleId,
            Date.now(),
          );
        }
      } catch (error) {
        // Rule check itself failed, log but don't stop
        console.error(`Rule ${rule.id} check failed:`, error);
      }
    }

    return results;
  }

  private extractConstraints(extracted: any): any[] {
    const constraints: any[] = [];
    if (extracted.required) constraints.push({ type: 'required', value: true });
    if (extracted.maxLength) constraints.push({ type: 'maxLength', value: extracted.maxLength });
    if (extracted.pattern) constraints.push({ type: 'pattern', value: extracted.pattern });
    return constraints;
  }

  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url;
    }
  }

  private shouldHeadless(): boolean {
    if (this.config.headless === 'auto') {
      return process.platform === 'linux';
    }
    return this.config.headless === true;
  }

  private updateSessionPhase(session: Session): void {
    this.db.prepare(`
      UPDATE sessions SET phase = ? WHERE id = ?
    `).run(session.phase, session.id);
  }

  /**
   * Stop a specific session.
   */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.status = 'completed';
    session.endedAt = Date.now();

    this.db.prepare(`
      UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?
    `).run(session.endedAt, sessionId);

    await this.browserManager.close();
    this.sessions.delete(sessionId);
  }

  /**
   * Get session status.
   */
  getStatus(sessionId?: string): Session | Map<string, Session> | null {
    if (sessionId) return this.sessions.get(sessionId) ?? null;
    return this.sessions;
  }
}
