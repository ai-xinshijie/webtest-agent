import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { BrowserManager } from '../browser/BrowserManager.js';
import { StructuredPerceiver } from '../perception/StructuredPerceiver.js';
import { DatabaseManager } from '../db/Database.js';
import { classifyComponent, type ComponentModel, type Component } from '../cognition/ComponentModel.js';
import { InteractionExecutor } from '../tester/InteractionExecutor.js';
import { TestEngine, type TestEngineResult } from '../tester/TestEngine.js';
import { BFSExplorer } from '../exploration/BFSExplorer.js';
import { ComponentRevealer } from '../exploration/ComponentRevealer.js';
import { AuthSessionManager } from '../auth/AuthSessionManager.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { LLMRouter } from '../llm/LLMRouter.js';
import { ScreenshotManager } from '../reporter/ScreenshotManager.js';
import { ReportGenerator } from '../reporter/ReportGenerator.js';
import { BUILTIN_RULES, type QualityRule, type RuleContext, type RuleResult } from '../cognition/QualityRule.js';
import type { AgentConfig, TargetConfig } from '../config/types.js';
import type { StructuredObservation } from '../perception/types.js';
import { AgentLogger } from '../logger/AgentLogger.js';
import type { CoverageSnapshot } from '../coverage/CoverageGuarantee.js';
import { CodeSelfHealer, type HotPatchReport } from '../healing/CodeSelfHealer.js';

export interface Session {
  id: string;
  targetId: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  phase: 'login' | 'explore' | 'test' | 'combo' | 'chaos' | 'report';
  startedAt: number;
  endedAt?: number;
  currentPage?: Page;
  componentModel?: ComponentModel;
  restartCount: number;
  logger?: AgentLogger;
  targetConfig?: TargetConfig;
  progress?: TestEngineResult;
  reportPaths?: string[];
  hotPatchReports?: HotPatchReport[];
}

export interface RunOptions {
  runMode?: TargetConfig['strategy']['runMode'];
  phase?: 'explore' | 'test' | 'combo' | 'chaos';
  headless?: boolean;
  parallel?: number;
  resumeSessionId?: string;
  sessionId?: string;
}

interface PageRow {
  id: string;
  url_pattern: string;
  title: string | null;
}

export class Orchestrator {
  private sessions = new Map<string, Session>();
  private currentTargetId = '';
  private browserManager: BrowserManager;
  private perceiver = new StructuredPerceiver();
  private executor = new InteractionExecutor();
  private db: DatabaseManager;
  private config: AgentConfig;
  private memory: MemoryManager;
  private router: LLMRouter;
  private codeHealer: CodeSelfHealer;

  constructor(config: AgentConfig) {
    this.config = config;
    this.browserManager = new BrowserManager(config.browserDir, config.defaultBrowser);
    this.db = new DatabaseManager(config.dbPath);
    this.memory = new MemoryManager(this.db);
    this.router = new LLMRouter(config.models);
    this.codeHealer = new CodeSelfHealer({ rootDir: process.cwd(), router: this.router });
  }

  async run(target: TargetConfig, options: RunOptions = {}): Promise<Session> {
    const runMode = options.runMode ?? target.strategy.runMode;
    if (runMode === 'fresh') this.memory.clear(target.name);
    if (runMode === 'retest') this.memory.clearTestedItems(target.name);

    const existingSession = options.resumeSessionId
      ? this.loadSessionRow(options.resumeSessionId)
      : undefined;
    if (existingSession && existingSession.target_id !== target.name) {
      throw new Error('恢复会话与测试目标不一致');
    }

    const sessionId = existingSession?.id ?? options.sessionId ?? randomUUID();
    this.currentTargetId = target.name;
    this.persistTarget(target);

    const session: Session = {
      id: sessionId,
      targetId: target.name,
      status: 'running',
      phase: options.phase === 'explore' ? 'explore' : 'login',
      startedAt: existingSession?.started_at ?? Date.now(),
      restartCount: 0,
      targetConfig: target,
    };
    this.sessions.set(sessionId, session);

    if (existingSession) {
      this.db.prepare(`
        UPDATE sessions
        SET status = 'running', phase = ?, ended_at = NULL
        WHERE id = ?
      `).run(session.phase, sessionId);
    } else {
      this.db.prepare(`
        INSERT INTO sessions (id, target_id, status, started_at, phase)
        VALUES (?, ?, 'running', ?, ?)
      `).run(sessionId, target.name, session.startedAt, session.phase);
    }

    const logger = new AgentLogger(this.db, sessionId);
    session.logger = logger;
    logger.logUser(
      { description: `启动测试会话：${target.name}`, module: 'Orchestrator', method: 'run' },
      {
        type: 'start-session',
        target: target.name,
        params: {
          runMode,
          phase: options.phase ?? 'all',
          headless: options.headless ?? 'auto',
          parallel: options.parallel ?? target.strategy.parallel,
          resume: Boolean(options.resumeSessionId),
        },
      },
      { status: 'success', duration: 0, output: { sessionId } },
      { phase: session.phase },
    );

    try {
      await this.executeWithRecovery(session, target, options, runMode);
    } catch (error) {
      if (session.status === 'stopped') return session;
      const reason = error instanceof Error ? error.message : String(error);
      const repair = await this.codeHealer.recover(error, {
        sessionId,
        strategyName: 'orchestrator-recovery',
        recentActions: logger.getTimeline(10).map(item => item.trigger.description),
      });
      session.hotPatchReports = this.codeHealer.getReports(sessionId);
      this.db.prepare(`
        INSERT INTO hot_patch_reports (id, session_id, strategy_name, status, report_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        repair.id,
        sessionId,
        repair.strategyName,
        repair.status,
        JSON.stringify(repair),
        repair.createdAt,
      );
      logger.logSystem(
        { description: '代码级自愈诊断完成', module: 'CodeSelfHealer', method: 'recover' },
        { type: 'code-self-healing', target: repair.strategyName, params: { status: repair.status } },
        { status: repair.status === 'rejected' || repair.status === 'rolled-back' ? 'warning' : 'success', duration: 0, output: repair, error: repair.error },
        { phase: session.phase },
      );
      logger.logSystem(
        { description: '测试会话执行失败', module: 'Orchestrator', method: 'run' },
        { type: 'session-error', target: sessionId },
        { status: 'failed', duration: Date.now() - session.startedAt, error: reason },
        { phase: session.phase },
      );
      session.status = 'failed';
      session.endedAt = Date.now();
      this.db.prepare(`
        UPDATE sessions SET status = 'failed', ended_at = ?, phase = ?
        WHERE id = ?
      `).run(session.endedAt, session.phase, sessionId);
      session.reportPaths = this.saveReports(session, logger);
      throw error;
    }

    return session;
  }

  private async executeWithRecovery(
    session: Session,
    target: TargetConfig,
    options: RunOptions,
    runMode: TargetConfig['strategy']['runMode'],
  ): Promise<void> {
    try {
      await this.agentLoop(session, target, options, runMode);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const browserCrash = /Target closed|Browser closed|Connection closed/i.test(reason);
      if (browserCrash && session.restartCount < 2) {
        session.restartCount++;
        session.logger?.logSystem(
          { description: `浏览器崩溃，第 ${session.restartCount} 次自愈重启`, module: 'Orchestrator', method: 'executeWithRecovery' },
          { type: 'self-healing', target: session.id },
          { status: 'warning', duration: 0, output: { reason, restartCount: session.restartCount } },
          { phase: session.phase },
        );
        await this.browserManager.restart();
        await this.agentLoop(session, target, options, runMode);
        return;
      }
      throw error;
    }
  }

  private async agentLoop(
    session: Session,
    target: TargetConfig,
    options: RunOptions,
    runMode: TargetConfig['strategy']['runMode'],
  ): Promise<void> {
    const logger = session.logger;
    if (!logger) throw new Error('会话日志器尚未初始化');
    this.executor.setLogger(logger);

    const headless = options.headless ?? this.shouldHeadless();
    const sessionDir = path.join(process.cwd(), '.wta', 'sessions');
    mkdirSync(sessionDir, { recursive: true });
   const storageStatePath = path.join(sessionDir, `${session.id}.json`);
    const authDir = path.join(process.cwd(), '.wta', 'auth');
    mkdirSync(authDir, { recursive: true });
    const targetAuthStatePath = path.join(authDir, `${target.name}.json`);
    const initialStorageStatePath = existsSync(storageStatePath)
      ? storageStatePath
      : existsSync(targetAuthStatePath)
        ? targetAuthStatePath
        : undefined;

    const context = await logger.runScript(
      { description: '创建浏览器上下文', module: 'BrowserManager', method: 'createContext' },
      { type: 'create-context', params: { headless, viewport: this.config.viewport } },
      () => this.browserManager.createContext(session.id, {
        headless,
        viewport: this.config.viewport,
        storageStatePath: initialStorageStatePath,
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

    await logger.runScript(
      { description: '导航到目标页面', module: 'Orchestrator', method: 'page.goto' },
      { type: 'navigate', target: target.url, params: { waitUntil: 'networkidle' } },
      () => page.goto(target.url, {
        waitUntil: 'networkidle',
        timeout: this.config.timeout.navigation,
      }),
      { pageUrl: target.url, phase: 'login' },
    );

    const auth = new AuthSessionManager(logger);
    const loginResult = await auth.login(page, target, { pageUrl: page.url(), phase: 'login' });
    logger.logSystem(
      { description: '登录流程检查完成', module: 'AuthSessionManager', method: 'login' },
      { type: 'login-result', target: target.url },
      { status: loginResult.success ? 'success' : 'failed', duration: 0, output: loginResult },
      { pageUrl: page.url(), phase: 'login' },
    );
    if (!loginResult.success && loginResult.requiresManual) {
      throw new Error(loginResult.reason + '。请执行：wta auth capture ' + target.name
        + '，或 wta auth import ' + target.name + ' <state.json>');
    }
    if (loginResult.performed && !loginResult.success) {
      throw new Error(`自动登录失败：${loginResult.reason ?? '未知原因'}`);
    }
    if (loginResult.performed) {
      await auth.saveState(page, storageStatePath, { phase: 'login' });
      await auth.saveState(page, targetAuthStatePath, { phase: 'login' });
    }

    const screenshots = new ScreenshotManager(process.cwd(), session.id);
    const initialScreenshot = await screenshots.capture(page, 'initial', '初始页面加载完成');
    this.logScreenshot(logger, initialScreenshot?.filePath ?? null, 'initial', target.url, 'login');

    const requestedPhase = options.phase;
    if (requestedPhase !== 'test' && requestedPhase !== 'combo' && requestedPhase !== 'chaos') {
      session.phase = 'explore';
      this.updateSessionPhase(session);
      const revealer = new ComponentRevealer(logger);
      const explorer = new BFSExplorer(
        this.perceiver,
        this.db,
        target.name,
        {
          maxPages: target.strategy.maxPages,
          maxDepth: target.strategy.depth === 'deep' ? 6 : target.strategy.depth === 'standard' ? 4 : 2,
          excludePaths: target.scope.excludePaths,
        },
        logger,
        revealer,
      );

      const explorationResult = await logger.runScript(
        { description: '广度优先探索目标系统', module: 'BFSExplorer', method: 'explore' },
        { type: 'explore', target: target.url },
        () => explorer.explore(page, target.url),
        { pageUrl: page.url(), phase: 'explore' },
      );
      logger.logScript(
        { description: '广度优先探索完成', module: 'BFSExplorer', method: 'explore' },
        {
          type: 'explore-complete',
          target: target.url,
          params: { explorationResult },
        },
        { status: 'success', duration: 0, output: explorationResult },
        { pageUrl: page.url(), phase: 'explore' },
      );
    }

    if (requestedPhase === 'explore') {
      await this.finalizeSession(session, page, screenshots);
      return;
    }

    const pages = this.loadPages(target.name);
    if (pages.length === 0) throw new Error('探索完成后没有可测试页面');

    session.phase = requestedPhase ?? 'test';
    this.updateSessionPhase(session);

    const parallel = Math.max(1, Math.min(
      options.parallel ?? target.strategy.parallel ?? this.config.parallel,
      pages.length,
      8,
    ));

    const workerPages: Page[] = [page];
    for (let index = 1; index < parallel; index++) {
      const workerContext = await this.browserManager.createContext(
        `${session.id}:worker-${index}`,
        {
          headless,
          viewport: this.config.viewport,
          storageStatePath,
        },
      );
      workerPages.push(await workerContext.newPage());
    }
    session.currentPage = workerPages[0];

    const workers = workerPages.map((workerPage, index) => {
      const assignedPages = pages.filter((_, pageIndex) => pageIndex % parallel === index);
      const engine = new TestEngine(this.db, this.memory, logger, this.executor, {
        targetId: target.name,
        sessionId: session.id,
        runMode,
        depth: target.strategy.depth,
        phase: requestedPhase,
        enablePaths: index === 0,
        enableChaos: index === 0,
      });
      return engine.run(workerPage, assignedPages);
    });

    const results = await Promise.all(workers);
    const progress = this.mergeResults(results);
    session.progress = progress;
    this.db.prepare(`
      UPDATE sessions SET progress_json = ?, checkpoint_json = ?
      WHERE id = ?
    `).run(
      JSON.stringify(progress),
      JSON.stringify({ phase: 'report', completedAt: Date.now() }),
      session.id,
    );

    const afterTestScreenshot = await screenshots.capture(page, 'after-test', '深度测试完成后的页面');
    this.logScreenshot(logger, afterTestScreenshot?.filePath ?? null, 'after-test', page.url(), session.phase);

    try {
      const observation = await logger.runScript(
        { description: '结构化提取测试后的页面状态', module: 'StructuredPerceiver', method: 'capture' },
        { type: 'perceive', target: page.url(), params: { reason: 'quality-rules' } },
        () => this.captureWithTimeout(page, this.config.timeout.navigation),
        { pageUrl: page.url(), phase: 'test' },
      );
      session.componentModel = this.buildComponentModel(observation);
      await this.runQualityRules(session, observation);
    } catch (error) {
      logger.logSystem(
        { description: '测试后页面状态提取受阻，跳过质量规则', module: 'Orchestrator', method: 'agentLoop' },
        { type: 'quality-rule-skip', target: page.url() },
        {
          status: 'warning',
          duration: 0,
          error: error instanceof Error ? error.message : String(error),
        },
        { pageUrl: page.url(), phase: 'test' },
      );
    }


    await this.finalizeSession(session, page, screenshots);

    for (let index = 0; index < workerPages.length; index++) {
      await this.browserManager.closeSession(index === 0 ? session.id : `${session.id}:worker-${index}`);
    }
  }

  private async finalizeSession(
    session: Session,
    page: Page,
    screenshots: ScreenshotManager,
  ): Promise<void> {
    const logger = session.logger;
    if (!logger) throw new Error('会话日志器尚未初始化');

    const finalScreenshot = await screenshots.capture(page, 'final', '会话结束前的页面');
    this.logScreenshot(logger, finalScreenshot?.filePath ?? null, 'final', page.url(), 'report');

    session.phase = 'report';
    this.updateSessionPhase(session);
    session.status = 'completed';
    session.endedAt = Date.now();
    this.db.prepare(`
      UPDATE sessions
      SET status = 'completed', ended_at = ?, phase = 'report'
      WHERE id = ?
    `).run(session.endedAt, session.id);

    const reportPaths = this.saveReports(session, logger);
    session.reportPaths = reportPaths;

    const summary = await this.memory.compressSession(session.id, { llm: this.router });
    logger.logSystem(
      { description: '测试会话完成并沉淀记忆', module: 'Orchestrator', method: 'finalizeSession' },
      { type: 'complete-session', target: session.id },
      {
        status: 'success',
        duration: session.endedAt! - session.startedAt,
        output: { sessionId: session.id, reportPaths, memorySummary: summary },
      },
      { phase: 'report' },
    );
  }

  private mergeResults(results: TestEngineResult[]): TestEngineResult {
    const coverage: CoverageSnapshot = results.reduce((acc, item) => ({
      actions: {
        visited: acc.actions.visited + item.coverage.actions.visited,
        blocked: acc.actions.blocked + item.coverage.actions.blocked,
        pending: acc.actions.pending + item.coverage.actions.pending,
        percentage: 0,
      },
      combinations: {
        covered: acc.combinations.covered + item.coverage.combinations.covered,
        total: acc.combinations.total + item.coverage.combinations.total,
        percentage: 0,
      },
      paths: {
        covered: acc.paths.covered + item.coverage.paths.covered,
        total: acc.paths.total + item.coverage.paths.total,
        percentage: 0,
      },
    }), {
      actions: { visited: 0, blocked: 0, pending: 0, percentage: 0 },
      combinations: { covered: 0, total: 0, percentage: 0 },
      paths: { covered: 0, total: 0, percentage: 0 },
    });

    const actionTotal = coverage.actions.visited + coverage.actions.blocked
      + coverage.actions.pending;
    coverage.actions.percentage = actionTotal === 0
      ? 100
      : ((coverage.actions.visited + coverage.actions.blocked) / actionTotal) * 100;
    coverage.combinations.percentage = coverage.combinations.total === 0
      ? 100
      : (coverage.combinations.covered / coverage.combinations.total) * 100;
    coverage.paths.percentage = coverage.paths.total === 0
      ? 100
      : (coverage.paths.covered / coverage.paths.total) * 100;

    return {
      executedActions: results.reduce((sum, item) => sum + item.executedActions, 0),
      skippedActions: results.reduce((sum, item) => sum + item.skippedActions, 0),
      executedCombinations: results.reduce((sum, item) => sum + item.executedCombinations, 0),
      skippedCombinations: results.reduce((sum, item) => sum + item.skippedCombinations, 0),
      executedPaths: results.reduce((sum, item) => sum + item.executedPaths, 0),
      skippedPaths: results.reduce((sum, item) => sum + item.skippedPaths, 0),
      chaosTests: results.reduce((sum, item) => sum + item.chaosTests, 0),
      coverage,
    };
  }

  private saveReports(session: Session, logger: AgentLogger): string[] {
    const reportDir = path.join(process.cwd(), '.wta', 'reports');
    const reportPaths: string[] = [];
    for (const format of ['md', 'json'] as const) {
      const reporter = new ReportGenerator(this.db, { outputDir: reportDir, format });
      const description = `生成${format === 'md' ? '中文 Markdown' : '机器可读 JSON'}测试报告`;
      try {
        const reportPath = reporter.save(session.id);
        reportPaths.push(reportPath);
        logger.logScript(
          { description, module: 'ReportGenerator', method: 'save' },
          { type: 'generate-report', target: session.id, params: { format } },
          { status: 'success', duration: 0, output: reportPath },
          { phase: 'report' },
        );
      } catch (error) {
        logger.logSystem(
          { description: `${description}失败`, module: 'ReportGenerator', method: 'save' },
          { type: 'generate-report', target: session.id, params: { format } },
          {
            status: 'warning',
            duration: 0,
            error: String(error).replace(/^Error: /, ''),
          },
          { phase: 'report' },
        );
      }
    }
    return reportPaths;
  }

  private persistTarget(target: TargetConfig): void {
    this.db.prepare(`
      INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        url = excluded.url,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(
      target.name,
      target.name,
      target.url,
      JSON.stringify(target),
      Date.now(),
      Date.now(),
    );
  }

  private loadSessionRow(sessionId: string): {
    id: string;
    target_id: string;
    started_at: number;
  } | undefined {
    return this.db.prepare(`
      SELECT id, target_id, started_at FROM sessions WHERE id = ?
    `).get(sessionId) as { id: string; target_id: string; started_at: number } | undefined;
  }

  private loadPages(targetId: string): PageRow[] {
    return this.db.prepare(`
      SELECT id, url_pattern, title
      FROM pages
      WHERE target_id = ?
      ORDER BY first_seen_at ASC
    `).all(targetId) as unknown as PageRow[];
  }

  private buildComponentModel(observation: StructuredObservation): ComponentModel {
    const urlPattern = this.normalizeUrl(observation.url);
    const existingPage = this.db.prepare(`
      SELECT id FROM pages WHERE target_id = ? AND url_pattern = ?
    `).get(this.currentTargetId, urlPattern) as { id: string } | undefined;
    const pageId = existingPage?.id ?? randomUUID();
    const components: Component[] = observation.components.map(extracted => {
      const classified = classifyComponent(extracted);
      return {
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
    });

    this.db.prepare(`
      INSERT OR IGNORE INTO pages
        (id, target_id, url_pattern, title, role, first_seen_at, last_visited_at, visit_count, test_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'partial')
    `).run(
      pageId,
      this.currentTargetId,
      urlPattern,
      observation.title,
      'unknown',
      Date.now(),
      Date.now(),
    );

    const insertComponent = this.db.prepare(`
      INSERT OR IGNORE INTO components
        (id, target_id, page_id, type, selector, label, state_json, confidence, source, created_at, updated_at)
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
        urlPattern,
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

  private async runQualityRules(
    session: Session,
    observation: StructuredObservation,
  ): Promise<RuleResult[]> {
    const results: RuleResult[] = [];
    const logger = session.logger;
    if (!logger) throw new Error('会话日志器尚未初始化');

    for (const rule of BUILTIN_RULES as QualityRule[]) {
      if (rule.id === 'QR001' || rule.id === 'QR002') {
        logger.logScript(
          { description: `跳过需要操作前后的质量规则：${rule.id}`, module: 'Orchestrator', method: 'runQualityRules' },
          { type: 'quality-rule', target: rule.id, params: { ruleName: rule.name } },
          { status: 'skipped', duration: 0, output: { reason: '规则需要操作前后状态对比' } },
          { pageUrl: observation.url, phase: 'test' },
        );
        continue;
      }

      const ctx: RuleContext = {
        before: observation,
        action: { type: 'deep-test', target: observation.url },
        after: observation,
        networkLog: observation.networkEvents ?? [],
        consoleLog: [],
        componentModel: session.componentModel,
        memory: this.memory.getTargetMemory(session.targetId),
      };

      try {
        const result = await logger.runScript(
          { description: `执行质量规则：${rule.name}`, module: 'QualityRule', method: 'check' },
          { type: 'quality-rule', target: rule.id, params: { ruleName: rule.name, severity: rule.severity } },
          () => rule.check(ctx),
          { pageUrl: observation.url, phase: 'test' },
        );
        results.push(result);

        if (result.violation) {
          this.db.prepare(`
            INSERT INTO bugs
              (id, session_id, target_id, severity, title, description, page_url, rule_id, detected_at)
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
        logger.logScript(
          { description: `质量规则执行失败：${rule.id}`, module: 'QualityRule', method: 'check' },
          { type: 'quality-rule', target: rule.id, params: { ruleName: rule.name } },
          { status: 'failed', duration: 0, error: error instanceof Error ? error.message : String(error) },
          { pageUrl: observation.url, phase: 'test' },
        );
      }
    }

    return results;
  }

  private extractConstraints(extracted: StructuredObservation['components'][number]): any[] {
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

  private async captureWithTimeout(page: Page, timeout: number): Promise<StructuredObservation> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.perceiver.capture(page),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`结构化页面提取超时：${timeout}ms`)), timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private shouldHeadless(): boolean {
    if (this.config.headless === 'auto') return process.platform === 'linux';
    return this.config.headless === true;
  }

  private updateSessionPhase(session: Session): void {
    this.db.prepare(`
      UPDATE sessions SET phase = ? WHERE id = ?
    `).run(session.phase, session.id);
  }

  private logScreenshot(
    logger: AgentLogger,
    filePath: string | null,
    phase: string,
    pageUrl: string,
    sessionPhase: Session['phase'],
  ): void {
    logger.logScript(
      { description: `截取${phase}阶段截图`, module: 'ScreenshotManager', method: 'capture' },
      { type: 'screenshot', target: pageUrl, params: { phase } },
      {
        status: filePath ? 'success' : 'warning',
        duration: 0,
        output: filePath ?? undefined,
        error: filePath ? undefined : '截图失败',
      },
      { pageUrl, phase: sessionPhase },
    );
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`未找到测试会话：${sessionId}`);

    session.status = 'stopped';
    session.endedAt = Date.now();
    this.db.prepare(`
      UPDATE sessions SET status = 'stopped', ended_at = ? WHERE id = ?
    `).run(session.endedAt, sessionId);

    await this.browserManager.closeSession(sessionId);
    for (const contextId of this.browserManager.getSessionIds()) {
      if (contextId.startsWith(`${sessionId}:worker-`)) {
        await this.browserManager.closeSession(contextId);
      }
    }
  }

  async pause(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`未找到测试会话：${sessionId}`);
    session.status = 'paused';
    this.db.prepare(`UPDATE sessions SET status = 'paused' WHERE id = ?`).run(sessionId);
  }

  async resume(sessionId: string): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (session?.targetConfig) {
      return this.run(session.targetConfig, {
        resumeSessionId: sessionId,
        runMode: 'continue',
      });
    }

    const row = this.db.prepare(`
      SELECT t.config_json
      FROM sessions s
      JOIN targets t ON t.id = s.target_id
      WHERE s.id = ?
    `).get(sessionId) as { config_json: string } | undefined;
    if (!row) throw new Error(`未找到测试会话：${sessionId}`);
    const target = JSON.parse(row.config_json) as TargetConfig;
    return this.run(target, {
      resumeSessionId: sessionId,
      runMode: 'continue',
    });
  }

  getStatus(sessionId?: string): Session | Map<string, Session> | null {
    if (sessionId) return this.sessions.get(sessionId) ?? null;
    return this.sessions;
  }

  getTimeline(sessionId: string) {
    const logger = this.sessions.get(sessionId)?.logger;
    if (logger) return logger.getTimeline();
    return new AgentLogger(this.db, sessionId).getTimeline();
  }

  async close(): Promise<void> {
    await this.browserManager.close();
    this.sessions.clear();
    this.db.close();
  }
}
