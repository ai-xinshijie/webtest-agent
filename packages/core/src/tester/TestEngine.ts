import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import type { DatabaseManager } from '../db/Database.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { AgentLogger } from '../logger/AgentLogger.js';
import type { TargetConfig } from '../config/types.js';
import type { ExtractedComponent } from '../perception/types.js';
import { StructuredPerceiver } from '../perception/StructuredPerceiver.js';
import { ComponentRevealer } from '../exploration/ComponentRevealer.js';
import { ReachabilityResolver } from '../exploration/ReachabilityResolver.js';
import { InteractionExecutor } from './InteractionExecutor.js';
import {
  CoveringArrayGenerator,
  CoverageTracker,
  PathCoverageGenerator,
  type CoverageSnapshot,
} from '../coverage/CoverageGuarantee.js';
import { NetworkFaultInjector } from '../testing/NetworkFaultInjector.js';
import { StateGraph } from '../testing/StateGraph.js';
import { SemanticOracle } from '../testing/SemanticOracle.js';
import { TestCaseManager } from './TestCaseManager.js';
import { BUILTIN_RULES, type RuleContext } from '../cognition/QualityRule.js';
import type { StructuredObservation } from '../perception/types.js';

interface PageRow {
  id: string;
  url_pattern: string;
  title: string | null;
}

interface ComponentRow {
  id: string;
  page_id: string;
  type: string;
  selector: string;
  label: string | null;
  state_json: string | null;
  constraints_json: string | null;
}

export interface TestEngineOptions {
  targetId: string;
  sessionId: string;
  runMode: TargetConfig['strategy']['runMode'];
  depth: TargetConfig['strategy']['depth'];
  phase?: 'explore' | 'test' | 'combo' | 'chaos';
  enablePaths?: boolean;
  enableChaos?: boolean;
  deadlineAt?: number;
  caseIds?: string[];
}

export interface TestEngineResult {
  executedActions: number;
  skippedActions: number;
  executedCombinations: number;
  skippedCombinations: number;
  executedPaths: number;
  skippedPaths: number;
  chaosTests: number;
  coverage: CoverageSnapshot;
}

const ACTIONS_BY_TYPE: Record<string, string[]> = {
  button: ['click', 'double-click', 'right-click'],
  link: ['click'],
  input: ['fill', 'clear', 'fill-max'],
  textarea: ['fill', 'clear', 'fill-max'],
  select: ['select-first', 'select-last'],
  form: ['submit-empty', 'submit-partial', 'submit-valid'],
  modal: ['open', 'close-esc', 'close-overlay'],
  accordion: ['expand', 'collapse'],
  tab: ['switch'],
  checkbox: ['check', 'uncheck'],
  radio: ['select'],
  pagination: ['next', 'prev'],
  dropdown: ['open', 'select-first'],
  table: ['row-click', 'sort'],
};

const FEEDBACK_ACTIONS = new Set([
  'click', 'double-click', 'right-click', 'submit-empty', 'submit-partial', 'submit-valid',
  'open', 'close-esc', 'close-overlay', 'expand', 'collapse', 'switch', 'check', 'uncheck',
  'select', 'next', 'prev', 'select-first', 'select-last', 'row-click', 'sort',
]);

/**
 * 深度测试引擎：动作覆盖、组合覆盖、路径覆盖和混沌测试统一调度。
 */
export class TestEngine {
  private perceiver = new StructuredPerceiver();
  private revealer: ComponentRevealer;
  private reachability: ReachabilityResolver;
  private injector = new NetworkFaultInjector();
  private stateGraph: StateGraph;
  private oracle = new SemanticOracle();
  private covering = new CoveringArrayGenerator();
  private pathGenerator = new PathCoverageGenerator();
  private tracker = new CoverageTracker();
  private executedActions = 0;
  private skippedActions = 0;
  private executedCombinations = 0;
  private executedPaths = 0;
  private skippedCombinations = 0;
  private skippedPaths = 0;
  private chaosTests = 0;
  private pageFingerprints = new Map<string, string>();
  private cases: TestCaseManager;
  private selectedActionKeys = new Set<string>();

  constructor(
    private db: DatabaseManager,
    private memory: MemoryManager,
    private logger: AgentLogger,
    private executor: InteractionExecutor,
    private options: TestEngineOptions,
  ) {
    this.revealer = new ComponentRevealer(logger);
    this.reachability = new ReachabilityResolver(logger);
    this.injector.setLogger(logger);
    this.stateGraph = new StateGraph(db);
    this.cases = new TestCaseManager(db);
    this.selectedActionKeys = this.cases.getActionKeys(options.caseIds ?? []);
  }

  async run(page: Page, pages: PageRow[]): Promise<TestEngineResult> {
    const allComponents = pages.flatMap(item => this.getTestableComponents(item.id));
    const plannedActions = [];
    for (const component of allComponents) {
      for (const action of this.actionsForComponent(component)) {
        plannedActions.push({ pageId: component.page_id, componentId: component.id, action });
      }
    }
    this.tracker.initializeActions(plannedActions);

    const phase = this.options.phase;
    if (!phase || phase === 'test' || phase === 'combo') {
      for (const pageRow of pages) {
        this.assertWithinDeadline();
        await this.testPageActions(page, pageRow);
      }
    }

    if (!phase || phase === 'combo') {
      for (const pageRow of pages) {
        this.assertWithinDeadline();
        await this.testPageCombinations(page, pageRow);
      }
    }

    if ((!phase || phase === 'combo') && this.options.enablePaths !== false) {
      await this.testPaths(page);
    }
    if ((!phase || phase === 'chaos') && this.options.enableChaos !== false) {
      await this.testChaos(page, pages);
    }

    return {
      executedActions: this.executedActions,
      skippedActions: this.skippedActions,
      executedCombinations: this.executedCombinations,
      executedPaths: this.executedPaths,
      skippedCombinations: this.skippedCombinations,
      skippedPaths: this.skippedPaths,
      chaosTests: this.chaosTests,
      coverage: this.tracker.snapshot(),
    };
  }

  private async testPageActions(page: Page, pageRow: PageRow): Promise<void> {
    const components = this.getTestableComponents(pageRow.id);
    try {
      await this.navigate(page, pageRow);
    } catch (error) {
      this.recordNavigationBlocked(pageRow, components, error);
      return;
    }
    const fingerprint = await this.capturePageFingerprint(page, pageRow);

    for (const row of components) {
      const component = this.toExtracted(row);
      for (const action of this.actionsForComponent(row)) {
        this.assertWithinDeadline();
        const itemKey = `${this.options.targetId}:${row.id}:${action}`;
        const availability = await this.reachability.resolve(page, component, action, {
          pageUrl: pageRow.url_pattern, phase: 'test', componentId: row.id,
        });
        if (!availability.reachable) {
          this.skippedActions++;
          this.persistResult({
            componentId: row.id,
            testType: action,
            status: 'skipped',
            input: { action, selector: row.selector },
            output: { reason: availability.reason, status: availability.status, attempts: availability.attempts },
            startedAt: Date.now(),
          });
          this.tracker.markBlocked(row.page_id, row.id, action);
          continue;
        }
        if (this.shouldReuse(itemKey, row.page_id, fingerprint)) {
          this.skippedActions++;
          this.persistResult({
            componentId: row.id,
            testType: action,
            status: 'skipped',
            input: { action, selector: row.selector },
            output: { reason: '页面未变更，复用历史通过测试结果', fingerprint },
            startedAt: Date.now(),
          });
          this.tracker.markReused(row.page_id, row.id, action);
          continue;
        }

        const startedAt = Date.now();
        try {
          const before = await this.perceiver.capture(page);
          await this.executor.executeAction(page, component, action, {
            context: { pageUrl: pageRow.url_pattern, phase: 'test' },
          });
          const after = await this.perceiver.capture(page);
          const changed = JSON.stringify(before.components.length) !== JSON.stringify(after.components.length)
            || page.url() !== pageRow.url_pattern;
          const fromState = this.stateGraph.observe(this.options.targetId, pageRow.id, before);
          const toState = this.stateGraph.observe(this.options.targetId, pageRow.id, after);
          const oracle = this.oracle.evaluate({ action, before, after });
          this.stateGraph.recordTransition({
            sessionId: this.options.sessionId, targetId: this.options.targetId, from: fromState, to: toState,
            componentId: row.id, action, status: 'passed', evidence: { changed, oracle },
          });

          this.persistResult({
            componentId: row.id,
            testType: action,
            status: 'passed',
            input: { action, selector: row.selector },
            output: {
              changed, url: page.url(), componentCount: after.components.length,
              stateTransition: { from: fromState.id, to: toState.id }, oracle,
            },
            startedAt,
          });
          this.memory.markTested(this.options.targetId, {
            itemKey,
            componentId: row.id,
            testType: action,
            status: 'passed',
          });
          this.tracker.markVisited(row.page_id, row.id, action);
          this.executedActions++;
          await this.evaluateActionEvidence({
            before,
            after,
            action,
            selector: row.selector,
            pageUrl: pageRow.url_pattern,
          });
          this.persistOracleViolations(oracle, pageRow.url_pattern, row.id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.persistResult({
            componentId: row.id,
            testType: action,
            status: 'failed',
            input: { action, selector: row.selector },
            output: { error: reason },
            startedAt,
          });
          this.memory.markTested(this.options.targetId, {
            itemKey,
            componentId: row.id,
            testType: action,
            status: 'failed',
          });
          this.tracker.markVisited(row.page_id, row.id, action);
          this.executedActions++;
        }

        try {
          await this.navigate(page, pageRow);
        } catch (error) {
          this.logger.logSystem(
            { description: '动作后页面复位失败，停止当前页面后续动作', module: 'TestEngine', method: 'testPageActions' },
            { type: 'navigation-blocked', target: pageRow.url_pattern, params: { action } },
            {
              status: 'warning', duration: 0,
              error: String(error).replace(/^Error: /, ''),
            },
            { pageUrl: pageRow.url_pattern, phase: 'test' },
          );
          this.recordNavigationBlocked(pageRow, components, error);
          return;
        }
      }
    }

    this.db.prepare(`
      UPDATE pages SET test_status = 'tested', last_visited_at = ? WHERE id = ?
    `).run(Date.now(), pageRow.id);
    this.memory.savePageFingerprint(this.options.targetId, pageRow.id, fingerprint);
  }

  private async testPageCombinations(page: Page, pageRow: PageRow): Promise<void> {
    const components = this.getTestableComponents(pageRow.id)
      .filter(row => this.getActions(row.type).length > 1)
      .slice(0, 10);

    if (components.length < 2) return;

    const factors = components.map(row => this.getActions(row.type).slice(0, 3));
    const strengthByDepth = { deep: 3, standard: 2, quick: 1 } as const;
    const strength = strengthByDepth[this.options.depth];
    const result = this.covering.generate(factors, strength);
    this.tracker.setExpectedCombinations(result.rows.length);

    for (const rowValues of result.rows) {
      this.assertWithinDeadline();
      const itemKey = [
        'combination',
        pageRow.id,
        components.map(component => component.id).join('|'),
        rowValues.join('|'),
        `strength:${strength}`,
      ].join(':');
      try {
        await this.navigate(page, pageRow);
      } catch (error) {
        this.recordCombinationNavigationBlocked(pageRow, components, result.rows.slice(result.rows.indexOf(rowValues)), strength, error);
        return;
      }
      const fingerprint = await this.capturePageFingerprint(page, pageRow);
      if (this.shouldReuse(itemKey, pageRow.id, fingerprint)) {
        this.tracker.markCombinationReused(rowValues);
        this.persistResult({
          componentId: components[0]!.id,
          testType: `combination-${strength}way`,
          status: 'skipped',
          input: { combination: rowValues },
          output: { reason: '页面未变更，复用历史组合测试结果', fingerprint },
          startedAt: Date.now(),
        });
        this.skippedCombinations++;
        continue;
      }
      const startedAt = Date.now();
      const input: Record<string, unknown> = {};
      let failed = false;

      for (let index = 0; index < components.length; index++) {
        const component = this.toExtracted(components[index]!);
        const action = rowValues[index]!;
        input[components[index]!.id] = action;
        try {
          await this.executor.executeAction(page, component, action, {
            context: { pageUrl: pageRow.url_pattern, phase: 'combo' },
          });
        } catch {
          failed = true;
        }
      }

      this.tracker.recordCombination(rowValues);
      this.persistResult({
        componentId: components[0]!.id,
        testType: `combination-${strength}way`,
        status: failed ? 'failed' : 'passed',
        input,
        output: { combination: rowValues, exhaustive: result.exhaustive },
        startedAt,
      });
      this.memory.markTested(this.options.targetId, {
        itemKey,
        componentId: components[0]!.id,
        testType: `combination-${strength}way`,
        status: failed ? 'failed' : 'passed',
      });
      this.executedCombinations++;
    }
    const fingerprint = this.pageFingerprints.get(pageRow.id);
    if (fingerprint) this.memory.savePageFingerprint(this.options.targetId, pageRow.id, fingerprint);
  }

  private async testPaths(page: Page): Promise<void> {
    const nodes = (this.db.prepare('SELECT id FROM pages WHERE target_id = ?')
      .all(this.options.targetId) as Array<{ id: string }>).map(row => row.id);
    const edges = (this.db.prepare(`
      SELECT from_page_id, to_page_id FROM navigation_edges WHERE target_id = ?
    `).all(this.options.targetId) as Array<{ from_page_id: string; to_page_id: string }>).map(row => ({
      from: row.from_page_id,
      to: row.to_page_id,
    }));

    const paths = this.pathGenerator.generate({ nodes, edges }, 6, 1000);
    this.tracker.setExpectedPaths(paths.length);

    for (const path of paths) {
      this.assertWithinDeadline();
      const itemKey = `path:${path.join('>')}`;
      const startedAt = Date.now();
      let failed = false;
      try {
        for (const pageId of path) {
          const pageRow = this.db.prepare(`
            SELECT id, url_pattern, title FROM pages WHERE id = ?
          `).get(pageId) as PageRow | undefined;
          await this.navigate(page, pageRow!);
        }
        this.persistResult({
          componentId: null,
          testType: 'path-coverage',
          status: 'passed',
          input: { path },
          output: { visited: path.length },
          startedAt,
        });
      } catch (error) {
        failed = true;
        this.persistResult({
          componentId: null,
          testType: 'path-coverage',
          status: 'failed',
          input: { path },
          output: { error: String(error).replace(/^Error: /, '') },
          startedAt,
        });
      }
      this.executedPaths++;
      this.tracker.recordPath(path);
      this.memory.markTested(this.options.targetId, {
        itemKey,
        componentId: 'path',
        testType: 'path-coverage',
        status: failed ? 'failed' : 'passed',
      });
    }
  }

  private async testChaos(page: Page, pages: PageRow[]): Promise<void> {
    if (this.options.depth !== 'deep' || pages.length === 0) return;
    const faults = [
      { type: 'http-500' as const, urlPattern: '**/*' },
      { type: 'slow' as const, urlPattern: '**/*', delayMs: 1500 },
      { type: 'offline' as const, urlPattern: '**/*' },
    ];

    for (const fault of faults) {
      this.assertWithinDeadline();
      const startedAt = Date.now();
      await this.injector.apply(page, fault);
      try {
        await this.navigate(page, pages[0]!);
        const observation = await this.perceiver.capture(page);
        this.persistResult({
          componentId: null,
          testType: `chaos-${fault.type}`,
          status: observation.components.length === 0 ? 'failed' : 'passed',
          input: { fault },
          output: { componentCount: observation.components.length },
          startedAt,
        });
      } finally {
        await this.injector.restore(page, fault);
      }
      this.chaosTests++;
    }
  }

  private async navigate(page: Page, pageRow: PageRow): Promise<void> {
    const attempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.assertWithinDeadline();
      try {
        await this.logger.runScript(
          {
            description: `进入页面执行测试：${pageRow.title ?? pageRow.url_pattern}（第 ${attempt} 次）`,
            module: 'TestEngine',
            method: 'navigate',
          },
          { type: 'navigate', target: pageRow.url_pattern, params: { attempt, attempts } },
          () => page.goto(pageRow.url_pattern, { waitUntil: 'domcontentloaded', timeout: 20000 }),
          { pageUrl: pageRow.url_pattern, phase: 'test' },
        );
        await this.revealer.reveal(page, { pageUrl: pageRow.url_pattern, phase: 'test' });
        return;
      } catch (error) {
        lastError = error;
        if (attempt === attempts) break;
        await page.waitForTimeout(attempt * 500);
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`页面导航连续 ${attempts} 次失败：${pageRow.url_pattern}。${reason}`);
  }

  private getComponents(pageId: string): ComponentRow[] {
    return this.db.prepare(`
      SELECT id, page_id, type, selector, label, state_json, constraints_json
      FROM components WHERE page_id = ?
    `).all(pageId) as unknown as ComponentRow[];
  }

  private getTestableComponents(pageId: string): ComponentRow[] {
    return this.getComponents(pageId).filter(row => {
      const state = row.state_json ? JSON.parse(row.state_json) as { scope?: string } : {};
      return state.scope === undefined || state.scope === 'business' || state.scope === 'unknown';
    });
  }

  private assertWithinDeadline(): void {
    if (this.options.deadlineAt !== undefined && Date.now() >= this.options.deadlineAt) {
      throw new Error('测试会话已达到最大运行时长，未执行项目保留为待覆盖');
    }
  }

  private async evaluateActionEvidence(input: {
    before: import('../perception/types.js').StructuredObservation;
    after: import('../perception/types.js').StructuredObservation;
    action: string;
    selector: string;
    pageUrl: string;
  }): Promise<void> {
    const context: RuleContext = {
      before: input.before,
      after: input.after,
      action: { type: input.action, target: input.selector },
      networkLog: input.after.networkEvents ?? [],
      consoleLog: input.after.consoleEvents ?? [],
      componentModel: null,
      memory: this.memory.getTargetMemory(this.options.targetId),
    };

    for (const rule of BUILTIN_RULES) {
      if (rule.id === 'QR001' && !FEEDBACK_ACTIONS.has(input.action)) continue;
      if (rule.id === 'QR002' && !input.action.startsWith('submit')) continue;
      const result = await this.logger.runScript(
        { description: `执行动作质量规则：${rule.name}`, module: 'TestEngine', method: 'evaluateActionEvidence' },
        { type: 'quality-rule', target: rule.id, params: { action: input.action, selector: input.selector } },
        () => rule.check(context),
        { pageUrl: input.pageUrl, phase: 'test' },
      );
      if (!result.violation) continue;
      this.db.prepare(`
        INSERT INTO bugs
          (id, session_id, target_id, severity, title, description, page_url, rule_id, component_id, evidence_json, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        this.options.sessionId,
        this.options.targetId,
        result.violation.severity,
        result.violation.description.slice(0, 100),
        result.violation.description,
        input.pageUrl,
        result.violation.ruleId,
        null,
        JSON.stringify(result.violation.evidence),
        Date.now(),
      );
    }
  }

  private persistOracleViolations(
    verdicts: Array<{ name: string; passed: boolean; detail: string }>,
    pageUrl: string,
    componentId: string,
  ): void {
    for (const verdict of verdicts.filter(item => !item.passed)) {
      this.db.prepare(`
        INSERT INTO bugs
          (id, session_id, target_id, severity, title, description, page_url, rule_id, component_id, evidence_json, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), this.options.sessionId, this.options.targetId, 'major',
        `语义断言失败：${verdict.name}`, verdict.detail, pageUrl, `ORACLE:${verdict.name}`, componentId,
        JSON.stringify(verdict), Date.now(),
      );
    }
  }

  private getActions(type: string): string[] {
    return ACTIONS_BY_TYPE[type] ?? ['click'];
  }

  private actionsForComponent(component: ComponentRow): string[] {
    const actions = this.getActions(component.type);
    if (!this.options.caseIds) return actions;
    return actions.filter(action => this.selectedActionKeys.has(`${component.id}:${action}`));
  }

  private recordNavigationBlocked(
    pageRow: PageRow,
    components: ComponentRow[],
    error: unknown,
  ): void {
    const reason = `页面不可访问，已阻断组件动作：${error instanceof Error ? error.message : String(error)}`;
    for (const row of components) {
      for (const action of this.actionsForComponent(row)) {
        if (!this.tracker.isPendingAction(row.page_id, row.id, action)) continue;
        this.tracker.markBlocked(row.page_id, row.id, action);
        this.persistResult({
          componentId: row.id,
          testType: action,
          status: 'skipped',
          input: { action, selector: row.selector },
          output: { reason },
          startedAt: Date.now(),
        });
        this.skippedActions++;
      }
    }
    this.db.prepare(`
      UPDATE pages SET test_status = 'partial', last_visited_at = ? WHERE id = ?
    `).run(Date.now(), pageRow.id);
    this.logger.logSystem(
      { description: '页面测试已标记为受阻', module: 'TestEngine', method: 'recordNavigationBlocked' },
      { type: 'navigation-blocked', target: pageRow.url_pattern, params: { scope: 'action', componentCount: components.length } },
      { status: 'warning', duration: 0, error: reason },
      { pageUrl: pageRow.url_pattern, phase: 'test' },
    );
  }

  private recordCombinationNavigationBlocked(
    pageRow: PageRow,
    components: ComponentRow[],
    rows: string[][],
    strength: number,
    error: unknown,
  ): void {
    const reason = `页面不可访问，已阻断组合测试：${error instanceof Error ? error.message : String(error)}`;
    for (const rowValues of rows) {
      this.tracker.markCombinationBlocked(rowValues);
      this.persistResult({
        componentId: components[0]!.id,
        testType: `combination-${strength}way`,
        status: 'skipped',
        input: { combination: rowValues },
        output: { reason },
        startedAt: Date.now(),
      });
      this.skippedCombinations++;
    }
    this.logger.logSystem(
      { description: '组合测试已标记为受阻', module: 'TestEngine', method: 'recordCombinationNavigationBlocked' },
      { type: 'navigation-blocked', target: pageRow.url_pattern, params: { scope: 'combo', rowCount: rows.length } },
      { status: 'warning', duration: 0, error: reason },
      { pageUrl: pageRow.url_pattern, phase: 'combo' },
    );
  }

  private shouldReuse(itemKey: string, pageId: string, fingerprint: string): boolean {
    if (this.options.runMode === 'retest' || this.options.runMode === 'fresh') return false;

    const status = this.memory.getTestedStatus(this.options.targetId, itemKey);
    if (this.options.runMode === 'regression') return status !== null && status !== 'failed';
    if (status !== 'passed') return false;
    const known = this.memory.getPageFingerprint(this.options.targetId, pageId);
    return known?.fingerprint === fingerprint;
  }

  private async capturePageFingerprint(page: Page, pageRow: PageRow): Promise<string> {
    const cached = this.pageFingerprints.get(pageRow.id);
    if (cached) return cached;
    const observation = await this.perceiver.capture(page);
    const fingerprint = this.fingerprint(observation);
    this.pageFingerprints.set(pageRow.id, fingerprint);
    return fingerprint;
  }

  private fingerprint(observation: StructuredObservation): string {
    const components = observation.components
      .map(component => `${component.selector ?? component.tag}:${component.role ?? ''}:${component.text ?? ''}`)
      .sort();
    return JSON.stringify({ url: observation.url, title: observation.title, components });
  }

  private getUnavailableReason(component: ExtractedComponent): string | null {
    if (!component.state.visible) return '组件当前不可见，已阻断动作执行';
    if (!component.state.enabled) return '组件当前已禁用，已阻断动作执行';
    return null;
  }

  private toExtracted(row: ComponentRow): ExtractedComponent {
    const state = row.state_json ? JSON.parse(row.state_json) : {};
    return {
      tag: row.type,
      role: this.getRole(row.type),
      text: row.label ?? undefined,
      classes: [],
      ariaLabel: row.label ?? null,
      placeholder: null,
      state: {
        visible: state.visible ?? true,
        enabled: state.enabled ?? true,
        inViewport: true,
        cursorPointer: true,
        userSelectNone: false,
      },
      clickability: {
        score: 0.6,
        isInteractive: true,
        isHighConfidence: true,
        signals: {
          isSemanticTag: true,
          hasAriaRole: Boolean(this.getRole(row.type)),
          cursorPointer: true,
          hasOnclick: false,
          hasTabIndex: false,
        },
      },
      selector: row.selector,
      rect: { x: 0, y: 0, w: 0, h: 0 },
    };
  }

  private getRole(type: string): string | null {
    const map: Record<string, string> = {
      button: 'button',
      link: 'link',
      input: 'textbox',
      textarea: 'textbox',
      select: 'combobox',
      tab: 'tab',
      checkbox: 'checkbox',
      radio: 'radio',
      modal: 'dialog',
    };
    return map[type] ?? null;
  }

  private persistResult(input: {
    componentId: string | null;
    testType: string;
    status: 'passed' | 'failed' | 'skipped';
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    startedAt: number;
  }): void {
    this.db.prepare(`
      INSERT INTO test_results
        (id, session_id, component_id, test_type, status, input_json, output_json, started_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      this.options.sessionId,
      input.componentId,
      input.testType,
      input.status,
      JSON.stringify(input.input),
      JSON.stringify(input.output),
      input.startedAt,
      Date.now() - input.startedAt,
    );
    this.cases.recordExecution(
      input.componentId,
      input.testType,
      input.status,
      input.startedAt,
    );
  }
}
