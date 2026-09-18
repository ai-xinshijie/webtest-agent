import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import type { DatabaseManager } from '../db/Database.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { AgentLogger } from '../logger/AgentLogger.js';
import type { TargetConfig } from '../config/types.js';
import type { ExtractedComponent } from '../perception/types.js';
import { StructuredPerceiver } from '../perception/StructuredPerceiver.js';
import { ComponentRevealer } from '../exploration/ComponentRevealer.js';
import { InteractionExecutor } from './InteractionExecutor.js';
import {
  CoveringArrayGenerator,
  CoverageTracker,
  PathCoverageGenerator,
  type CoverageSnapshot,
} from '../coverage/CoverageGuarantee.js';
import { NetworkFaultInjector } from '../testing/NetworkFaultInjector.js';

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

/**
 * 深度测试引擎：动作覆盖、组合覆盖、路径覆盖和混沌测试统一调度。
 */
export class TestEngine {
  private perceiver = new StructuredPerceiver();
  private revealer: ComponentRevealer;
  private injector = new NetworkFaultInjector();
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

  constructor(
    private db: DatabaseManager,
    private memory: MemoryManager,
    private logger: AgentLogger,
    private executor: InteractionExecutor,
    private options: TestEngineOptions,
  ) {
    this.revealer = new ComponentRevealer(logger);
    this.injector.setLogger(logger);
  }

  async run(page: Page, pages: PageRow[]): Promise<TestEngineResult> {
    const allComponents = pages.flatMap(item => this.getComponents(item.id));
    const plannedActions = [];
    for (const component of allComponents) {
      for (const action of this.getActions(component.type)) {
        plannedActions.push({ pageId: component.page_id, componentId: component.id, action });
      }
    }
    this.tracker.initializeActions(plannedActions);

    const phase = this.options.phase;
    if (!phase || phase === 'test' || phase === 'combo') {
      for (const pageRow of pages) await this.testPageActions(page, pageRow);
    }

    if (!phase || phase === 'combo') {
      for (const pageRow of pages) await this.testPageCombinations(page, pageRow);
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
    await this.navigate(page, pageRow);
    const components = this.getComponents(pageRow.id);

    for (const row of components) {
      const component = this.toExtracted(row);
      for (const action of this.getActions(row.type)) {
        const itemKey = `${this.options.targetId}:${row.id}:${action}`;
        if (this.shouldSkip(itemKey)) {
          this.skippedActions++;
          this.persistResult({
            componentId: row.id,
            testType: action,
            status: 'skipped',
            input: { action, selector: row.selector },
            output: { reason: '记忆中已有测试结果，本次跳过执行' },
            startedAt: Date.now(),
          });
          this.tracker.markVisited(row.page_id, row.id, action);
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

          this.persistResult({
            componentId: row.id,
            testType: action,
            status: 'passed',
            input: { action, selector: row.selector },
            output: { changed, url: page.url(), componentCount: after.components.length },
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

        await this.navigate(page, pageRow);
      }
    }
  }

  private async testPageCombinations(page: Page, pageRow: PageRow): Promise<void> {
    const components = this.getComponents(pageRow.id)
      .filter(row => this.getActions(row.type).length > 1)
      .slice(0, 10);

    if (components.length < 2) return;

    const factors = components.map(row => this.getActions(row.type).slice(0, 3));
    const strength = this.options.depth === 'deep' ? 3 : this.options.depth === 'standard' ? 2 : 1;
    const result = this.covering.generate(factors, strength);
    this.tracker.setExpectedCombinations(result.totalCombinations);

    for (const rowValues of result.rows) {
      const itemKey = [
        'combination',
        pageRow.id,
        components.map(component => component.id).join('|'),
        rowValues.join('|'),
        `strength:${strength}`,
      ].join(':');
      if (this.shouldSkip(itemKey)) {
        this.tracker.recordCombination(rowValues);
        this.persistResult({
          componentId: components[0]!.id,
          testType: `combination-${strength}way`,
          status: 'skipped',
          input: { combination: rowValues },
          output: { reason: '记忆中已有组合测试结果，本次跳过执行' },
          startedAt: Date.now(),
        });
        this.skippedCombinations++;
        continue;
      }
      await this.navigate(page, pageRow);
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
      const itemKey = `path:${path.join('>')}`;
      const startedAt = Date.now();
      if (this.shouldSkip(itemKey)) {
        this.tracker.recordPath(path);
        this.persistResult({
          componentId: null,
          testType: 'path-coverage',
          status: 'skipped',
          input: { path },
          output: { reason: '记忆中已有路径测试结果，本次跳过执行' },
          startedAt,
        });
        this.skippedPaths++;
        continue;
      }
      let failed = false;
      try {
        for (const pageId of path) {
          const pageRow = this.db.prepare(`
            SELECT id, url_pattern, title FROM pages WHERE id = ?
          `).get(pageId) as PageRow | undefined;
          if (pageRow) await this.navigate(page, pageRow);
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
          output: { error: error instanceof Error ? error.message : String(error) },
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
    await this.logger.runScript(
      { description: `进入页面执行测试：${pageRow.title ?? pageRow.url_pattern}`, module: 'TestEngine', method: 'navigate' },
      { type: 'navigate', target: pageRow.url_pattern },
      () => page.goto(pageRow.url_pattern, { waitUntil: 'domcontentloaded', timeout: 20000 }),
      { pageUrl: pageRow.url_pattern, phase: 'test' },
    );
    await this.revealer.reveal(page, { pageUrl: pageRow.url_pattern, phase: 'test' });
  }

  private getComponents(pageId: string): ComponentRow[] {
    return this.db.prepare(`
      SELECT id, page_id, type, selector, label, state_json, constraints_json
      FROM components WHERE page_id = ?
    `).all(pageId) as unknown as ComponentRow[];
  }

  private getActions(type: string): string[] {
    return ACTIONS_BY_TYPE[type] ?? ['click'];
  }

  private shouldSkip(itemKey: string): boolean {
    if (this.options.runMode === 'retest' || this.options.runMode === 'fresh') return false;

    const status = this.memory.getTestedStatus(this.options.targetId, itemKey);
    if (this.options.runMode === 'regression') return status !== 'failed';
    if (this.options.runMode === 'continue') return status !== null;
    return status === 'passed' || status === 'skipped';
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
  }
}
