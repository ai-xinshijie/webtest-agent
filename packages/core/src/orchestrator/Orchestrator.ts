import { randomUUID } from 'node:crypto';
import { BrowserManager } from '../browser/BrowserManager.js';
import { StructuredPerceiver } from '../perception/StructuredPerceiver.js';
import { DatabaseManager } from '../db/Database.js';
import { classifyComponent, type ComponentModel, type Component } from '../cognition/ComponentModel.js';
import { InteractionExecutor } from '../tester/InteractionExecutor.js';
import { BFSExplorer } from '../exploration/BFSExplorer.js';
import { ScreenshotManager } from '../reporter/ScreenshotManager.js';
import { ReportGenerator } from '../reporter/ReportGenerator.js';
import { BUILTIN_RULES, type QualityRule, type RuleContext, type RuleResult } from '../cognition/QualityRule.js';
import type { AgentConfig, TargetConfig } from '../config/types.js';
import type { StructuredObservation } from '../perception/types.js';
import { AgentLogger } from '../logger/AgentLogger.js';
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
  logger?: AgentLogger;
}

export class Orchestrator {
  private sessions: Map<string, Session> = new Map();
  private currentTargetId: string = '';
  private browserManager: BrowserManager;
  private perceiver: StructuredPerceiver;
  private executor: InteractionExecutor;
  private db: DatabaseManager;
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.browserManager = new BrowserManager(config.browserDir, config.defaultBrowser);
    this.perceiver = new StructuredPerceiver();
    this.executor = new InteractionExecutor();
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
    this.currentTargetId = target.name;

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

    // Ensure target exists in database
    this.db.prepare(`
      INSERT OR IGNORE INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(target.name, target.name, target.url, JSON.stringify(target), Date.now(), Date.now());

    // Persist session
    this.db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at, phase)
      VALUES (?, ?, 'running', ?, 'login')
    `).run(sessionId, target.name, session.startedAt);

    const logger = new AgentLogger(this.db, sessionId);
    session.logger = logger;
    logger.logUser(
      { description: `启动测试会话：${target.name}`, module: 'Orchestrator', method: 'run' },
      {
        type: 'start-session',
        target: target.name,
        params: { runMode: options.runMode ?? 'continue', headless: options.headless ?? 'auto' },
      },
      { status: 'success', duration: 0, output: { sessionId } },
      { phase: 'login' },
    );

    // Run agent loop
    try {
      await this.agentLoop(session, target, options);
    } catch (error) {
      logger.logSystem(
        { description: '测试会话执行失败', module: 'Orchestrator', method: 'run' },
        { type: 'session-error', target: sessionId },
        {
          status: 'failed',
          duration: Date.now() - session.startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
        { phase: session.phase },
      );
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
    const logger = session.logger;
    if (!logger) throw new Error('会话日志器尚未初始化');
    this.executor.setLogger(logger);

    // Phase 1: Launch browser and navigate
    const context = await logger.runScript(
      { description: '创建浏览器上下文', module: 'BrowserManager', method: 'createContext' },
      { type: 'create-context', params: { headless, viewport: this.config.viewport } },
      () => this.browserManager.createContext(session.id, {
        headless,
        viewport: this.config.viewport,
      }),
      { phase: 'login' },
    );
    const page = await logger.runScript(
      { description: '创建浏览器页面', module: 'BrowserManager', method: 'newPage' },
      { type: 'new-page' },
      () => context.newPage(),
      { phase: 'login' },
    );
    session.currentPage = page;

    // Navigate to target
    await logger.runScript(
      { description: '导航到目标页面', module: 'Orchestrator', method: 'page.goto' },
      { type: 'navigate', target: target.url, params: { waitUntil: 'networkidle' } },
      () => page.goto(target.url, {
        waitUntil: 'networkidle',
        timeout: this.config.timeout.navigation,
      }),
      { pageUrl: target.url, phase: 'login' },
    );

    // Initialize screenshot manager
    const screenshots = new ScreenshotManager(process.cwd(), session.id);
    const initialScreenshot = await screenshots.capture(page, 'initial', '初始页面加载完成');
    logger.logScript(
      { description: '截取初始页面截图', module: 'ScreenshotManager', method: 'capture' },
      { type: 'screenshot', target: target.url, params: { phase: 'initial' } },
      {
        status: initialScreenshot ? 'success' : 'warning',
        duration: 0,
        output: initialScreenshot?.filePath,
        screenshotId: initialScreenshot?.id,
        error: initialScreenshot ? undefined : '截图失败',
      },
      { pageUrl: target.url, phase: 'login' },
    );

    // Phase 2: Explore (BFS navigation)
    session.phase = 'explore';
    this.updateSessionPhase(session);

    console.log('  Starting BFS exploration...');
    const explorer = new BFSExplorer(this.perceiver, this.db, target.name, {
      maxPages: Math.min(target.strategy.maxPages, 20), // Limit for v0.1
      maxDepth: 3,
      excludePaths: target.scope.excludePaths,
    }, logger);

    const explorationResult = await explorer.explore(page, target.url);
    console.log(`  Exploration complete: ${explorationResult.pagesVisited} pages, ${explorationResult.totalComponents} components`);
    logger.logScript(
      { description: '广度优先探索完成', module: 'BFSExplorer', method: 'explore' },
      {
        type: 'explore-complete',
        target: target.url,
        params: { pagesVisited: explorationResult.pagesVisited, totalComponents: explorationResult.totalComponents },
      },
      { status: 'success', duration: 0, output: explorationResult },
      { pageUrl: target.url, phase: 'explore' },
    );

    // Navigate back to start page for form testing
    await logger.runScript(
      { description: '返回起始页面执行功能测试', module: 'Orchestrator', method: 'page.goto' },
      { type: 'navigate', target: target.url, params: { reason: 'form-test' } },
      () => page.goto(target.url, {
        waitUntil: 'networkidle',
        timeout: this.config.timeout.navigation,
      }),
      { pageUrl: target.url, phase: 'test' },
    );

    const observation = await logger.runScript(
      { description: '结构化提取当前页面组件', module: 'StructuredPerceiver', method: 'capture' },
      { type: 'perceive', target: page.url(), params: { mode: 'form-test' } },
      () => this.perceiver.capture(page),
      { pageUrl: page.url(), phase: 'test' },
    );
    session.componentModel = this.buildComponentModel(observation);

    const afterExploreScreenshot = await screenshots.capture(page, 'after-explore', '探索完成后的页面');
    logger.logScript(
      { description: '截取探索完成后的页面截图', module: 'ScreenshotManager', method: 'capture' },
      { type: 'screenshot', target: page.url(), params: { phase: 'after-explore' } },
      {
        status: afterExploreScreenshot ? 'success' : 'warning',
        duration: 0,
        output: afterExploreScreenshot?.filePath,
        screenshotId: afterExploreScreenshot?.id,
        error: afterExploreScreenshot ? undefined : '截图失败',
      },
      { pageUrl: page.url(), phase: 'test' },
    );

    // Phase 3: Test (form interactions + quality rules)
    session.phase = 'test';
    this.updateSessionPhase(session);

    // Test form interactions
    await this.testForms(page, observation, session);

    const afterTestScreenshot = await screenshots.capture(page, 'after-test', '功能测试完成后的页面');
    logger.logScript(
      { description: '截取功能测试完成后的页面截图', module: 'ScreenshotManager', method: 'capture' },
      { type: 'screenshot', target: page.url(), params: { phase: 'after-test' } },
      {
        status: afterTestScreenshot ? 'success' : 'warning',
        duration: 0,
        output: afterTestScreenshot?.filePath,
        screenshotId: afterTestScreenshot?.id,
        error: afterTestScreenshot ? undefined : '截图失败',
      },
      { pageUrl: page.url(), phase: 'test' },
    );

    const testResults = await this.runQualityRules(session, observation);

    // Phase 4: Report
    session.phase = 'report';
    this.updateSessionPhase(session);
    session.status = 'completed';
    session.endedAt = Date.now();

    // Update session status first, then generate report
    this.db.prepare(`
      UPDATE sessions SET status = 'completed', ended_at = ?, phase = 'report'
      WHERE id = ?
    `).run(session.endedAt, session.id);

    // Generate report (after status is updated)
    try {
      const reportDir = `${process.cwd()}/.wta/reports`;
      const reporter = new ReportGenerator(this.db, { outputDir: reportDir, format: 'md' });
      const reportPath = await logger.runScript(
        { description: '生成中文测试报告', module: 'ReportGenerator', method: 'save' },
        { type: 'generate-report', target: session.id, params: { format: 'md' } },
        () => Promise.resolve(reporter.save(session.id)),
        { phase: 'report' },
      );
      console.log(`  Report generated: ${reportPath}`);
    } catch (error) {
      logger.logScript(
        { description: '生成测试报告失败', module: 'ReportGenerator', method: 'save' },
        { type: 'generate-report', target: session.id, params: { format: 'md' } },
        { status: 'failed', duration: 0, error: error instanceof Error ? error.message : String(error) },
        { phase: 'report' },
      );
      console.warn(`  Report generation failed: ${error instanceof Error ? error.message : error}`);
    }

    // Close context
    await logger.runScript(
      { description: '关闭浏览器', module: 'BrowserManager', method: 'close' },
      { type: 'close-browser', target: session.id },
      () => this.browserManager.close(),
      { phase: 'report' },
    );
    logger.logSystem(
      { description: '测试会话完成', module: 'Orchestrator', method: 'agentLoop' },
      { type: 'complete-session', target: session.id },
      { status: 'success', duration: session.endedAt! - session.startedAt, output: { sessionId: session.id } },
      { phase: 'report' },
    );
  }

  /**
   * Build component model from structured observation.
   */
  private buildComponentModel(observation: StructuredObservation): ComponentModel {
    // Check if page already exists (BFS explorer may have already persisted it)
    const urlPattern = this.normalizeUrl(observation.url);
    const existingPage = this.db.prepare(`
      SELECT id FROM pages WHERE target_id = ? AND url_pattern = ?
    `).get(this.currentTargetId, urlPattern) as { id: string } | undefined;

    const pageId = existingPage?.id ?? randomUUID();
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

    // Persist page to database
    this.db.prepare(`
      INSERT OR IGNORE INTO pages (id, target_id, url_pattern, title, role, first_seen_at, last_visited_at, visit_count, test_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'partial')
    `).run(pageId, this.currentTargetId, this.normalizeUrl(observation.url), observation.title, 'unknown', Date.now(), Date.now());

    // Persist components to database
    const insertComponent = this.db.prepare(`
      INSERT OR IGNORE INTO components (id, target_id, page_id, type, selector, label, state_json, confidence, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const component of components) {
      insertComponent.run(
        component.id,
        this.currentTargetId,
        pageId,
        component.type,
        component.selector,
        component.label,
        JSON.stringify(component.state),
        component.meta.confidence,
        component.meta.source,
        Date.now(),
        Date.now(),
      );
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
   * Test form: fill with valid data, submit, check result.
   */
  private async testForms(page: any, observation: any, session: Session): Promise<void> {
    const formFields = observation.components.filter((c: any) =>
      ['input', 'textarea', 'select'].includes(c.tag) ||
      c.role === 'textbox' || c.role === 'combobox');

    const submitButtons = observation.components.filter((c: any) =>
      c.tag === 'button' && c.clickability?.isInteractive &&
      (c.text?.toLowerCase().includes('submit') || c.text?.toLowerCase().includes('提交')));

    if (formFields.length === 0) {
      console.log('  No form fields found, skipping form test');
      session.logger?.logScript(
        { description: '当前页面未发现表单字段，跳过表单测试', module: 'Orchestrator', method: 'testForms' },
        { type: 'form-test', target: observation.url, params: { skipped: true } },
        { status: 'skipped', duration: 0 },
        { pageUrl: observation.url, phase: 'test' },
      );
      return;
    }

    console.log(`  Testing form: ${formFields.length} fields, ${submitButtons.length} submit buttons`);

    // Test 1: Fill with valid data
    try {
      const startedAt = Date.now();
      const formContext = { pageUrl: observation.url, phase: 'test' };
      const filledValues = await this.executor.fillForm(page, formFields, 'valid', { context: formContext });
      console.log(`  Filled ${Object.keys(filledValues).length} fields with valid data`);

      // Test 2: Submit if there's a submit button
      if (submitButtons.length > 0) {
        await this.executor.submitForm(page, submitButtons[0], { context: formContext });
        console.log('  Submitted form');

        // Check for validation or success feedback
        const afterSubmit = await (
          session.logger
            ? session.logger.runScript(
                { description: '结构化提取表单提交后的页面状态', module: 'StructuredPerceiver', method: 'capture' },
                { type: 'perceive', target: observation.url, params: { reason: 'form-after-submit' } },
                () => this.perceiver.capture(page),
                { pageUrl: page.url(), phase: 'test' },
              )
            : this.perceiver.capture(page)
        );
        const hasValidation = afterSubmit.components.some(c =>
          c.validationMessage ||
          c.classes.some(cls => cls.includes('error') || cls.includes('invalid')));

        if (hasValidation) {
          console.log('  Form validation detected');
        } else {
          console.log('  Form submitted (no validation errors)');
        }

        // Persist test result
        this.db.prepare(`
          INSERT INTO test_results (id, session_id, component_id, test_type, status, input_json, output_json, started_at, duration_ms)
          VALUES (?, ?, ?, 'form-submit', ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          session.id,
          'form',
          hasValidation ? 'passed' : 'passed',
          JSON.stringify(filledValues),
          JSON.stringify({ validation: hasValidation }),
          Date.now(),
          Date.now() - startedAt,
        );
      }
    } catch (error) {
      console.error('  Form test error:', error instanceof Error ? error.message : error);
      session.logger?.logScript(
        { description: '表单测试失败', module: 'Orchestrator', method: 'testForms' },
        { type: 'form-test', target: observation.url, params: { fieldCount: formFields.length } },
        { status: 'failed', duration: 0, error: error instanceof Error ? error.message : String(error) },
        { pageUrl: observation.url, phase: 'test' },
      );
    }
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
      // Skip action-dependent rules on initial page load (not a user action)
      if (rule.id === 'QR001' || rule.id === 'QR002') {
        session.logger?.logScript(
          { description: `跳过需要操作前后的质量规则：${rule.id}`, module: 'Orchestrator', method: 'runQualityRules' },
          { type: 'quality-rule', target: rule.id, params: { ruleName: rule.name } },
          { status: 'skipped', duration: 0, output: { reason: '规则需要操作前后状态对比' } },
          { pageUrl: observation.url, phase: 'test' },
        );
        continue; // These rules require a user action (before vs after), not page load
      }

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
        const result = await (
          session.logger
            ? session.logger.runScript(
                { description: `执行质量规则：${rule.name}`, module: 'QualityRule', method: 'check' },
                { type: 'quality-rule', target: rule.id, params: { ruleName: rule.name, severity: rule.severity } },
                () => rule.check(ctx),
                { pageUrl: observation.url, phase: 'test' },
              )
            : rule.check(ctx)
        );
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
        session.logger?.logScript(
          { description: `质量规则执行失败：${rule.id}`, module: 'QualityRule', method: 'check' },
          { type: 'quality-rule', target: rule.id, params: { ruleName: rule.name } },
          { status: 'failed', duration: 0, error: error instanceof Error ? error.message : String(error) },
          { pageUrl: observation.url, phase: 'test' },
        );
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
    if (!session) throw new Error(`未找到测试会话：${sessionId}`);

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
