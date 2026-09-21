import type { Page } from 'playwright';
import type { AgentLogger } from '../logger/AgentLogger.js';
import type { LLMRouter } from '../llm/LLMRouter.js';
import { StructuredPerceiver } from '../perception/StructuredPerceiver.js';
import type { StructuredObservation } from '../perception/types.js';

export interface DecisionCandidate {
  id: string;
  componentId: string;
  action: string;
  label: string;
}

export interface ModelDecision {
  candidateId: string;
  reason: string;
  expectedState: string;
}

export interface DecisionGateInput {
  page: Page;
  pageUrl: string;
  before: StructuredObservation;
  after: StructuredObservation;
  executedAction: { componentId: string; action: string; label: string };
  candidates: DecisionCandidate[];
}

/**
 * 只在页面发生语义变化时请求视觉模型。模型只能从既有测试计划中选择动作，
 * 不拥有执行任意脚本、选择器或跳转地址的权限。
 */
export class ModelDecisionGate {
  /** 同一页面的相同语义状态只咨询一次视觉模型，避免页面间互相耗尽配额。 */
  private readonly seenStates = new Set<string>();
  private readonly decisionsByPage = new Map<string, number>();
  private readonly missingRouterLogged = new Set<string>();

  constructor(
    private router: LLMRouter | undefined,
    private logger: AgentLogger,
    private readonly maxDecisions = 3,
    private perceiver = new StructuredPerceiver(),
  ) {}

  async selectNext(input: DecisionGateInput): Promise<ModelDecision | null> {
    const pageKey = this.pageKey(input);
    if (!this.router) {
      if (!this.missingRouterLogged.has(pageKey)) {
        this.missingRouterLogged.add(pageKey);
        this.logSkip(input, '未配置视觉模型，当前页面继续按脚本计划执行');
      }
      return null;
    }
    if (input.candidates.length === 0) {
      this.logSkip(input, '当前状态没有待执行的受控候选动作，跳过模型决策');
      return null;
    }
    const beforeFingerprint = this.fingerprint(input.before);
    const afterFingerprint = this.fingerprint(input.after);
    const stateKey = pageKey + ':' + afterFingerprint;
    const decisions = this.decisionsByPage.get(pageKey) ?? 0;
    if (beforeFingerprint === afterFingerprint) {
      this.logSkip(input, '页面未发生语义变化，跳过视觉模型决策');
      return null;
    }
    if (decisions >= this.maxDecisions) {
      this.logSkip(input, '已达到当前页面视觉模型决策上限，继续执行脚本计划');
      return null;
    }
    if (this.seenStates.has(stateKey)) {
      this.logSkip(input, '当前语义状态已经咨询过视觉模型，避免重复决策');
      return null;
    }

    this.seenStates.add(stateKey);
    this.decisionsByPage.set(pageKey, decisions + 1);
    const candidates = input.candidates.slice(0, 12);
    try {
      const screenshot = await this.perceiver.captureVisual(input.page, false);
      const content = await this.router.callVisionWithLog(
        'visual-analysis',
        [
          {
            role: 'system',
            content: '你是 Web 测试动作排序器。只能从候选动作中选择一个 candidateId。不得输出 CSS 选择器、JavaScript、URL 或候选列表外的动作。仅返回 JSON：{"candidateId":string,"reason":string,"expectedState":string}。reason 和 expectedState 用中文。',
          },
          {
            role: 'user',
            content: JSON.stringify({
              页面: input.after.url,
              已执行动作: input.executedAction,
              状态变化: this.describeChange(input.before, input.after),
              候选动作: candidates.map(item => ({ id: item.id, 名称: item.label, 动作: item.action })),
            }),
          },
        ],
        screenshot,
        this.logger,
        { pageUrl: input.pageUrl, phase: 'test', componentId: input.executedAction.componentId },
      );
      const decision = this.parseDecision(content, candidates);
      if (!decision) {
        this.logWarning(input, '模型响应不符合受控候选动作协议，继续执行脚本计划');
        return null;
      }
      this.logger.logSystem(
        { description: '模型决定下一测试动作优先级', module: 'ModelDecisionGate', method: 'selectNext' },
        { type: 'model-action-priority', target: decision.candidateId, params: { reason: decision.reason, expectedState: decision.expectedState } },
        { status: 'success', duration: 0, output: decision },
        { pageUrl: input.pageUrl, phase: 'test', componentId: input.executedAction.componentId },
      );
      return decision;
    } catch (error) {
      this.logWarning(input, '视觉模型调用失败，继续执行脚本计划：' + this.errorMessage(error));
      return null;
    }
  }

  private parseDecision(content: string, candidates: DecisionCandidate[]): ModelDecision | null {
    try {
      const parsed = JSON.parse(content.replace(/^```json\s*|```$/g, '').trim()) as Partial<ModelDecision>;
      if (typeof parsed.candidateId !== 'string' || !candidates.some(item => item.id === parsed.candidateId)) return null;
      if (typeof parsed.reason !== 'string' || typeof parsed.expectedState !== 'string') return null;
      return { candidateId: parsed.candidateId, reason: parsed.reason.slice(0, 500), expectedState: parsed.expectedState.slice(0, 500) };
    } catch {
      return null;
    }
  }

  private pageKey(input: DecisionGateInput): string {
    return input.pageUrl || input.after.url;
  }

  private fingerprint(observation: StructuredObservation): string {
    const components = observation.components
      .filter(item => item.state.visible && item.state.enabled)
      .map(item => [item.selector ?? item.tag, item.role ?? '', item.text ?? '', item.parentDialog ?? ''].join('|'))
      .sort();
    return JSON.stringify({ url: observation.url, title: observation.title, dialogs: observation.dialogCount, loading: observation.loadingOverlayCount, components });
  }

  private describeChange(before: StructuredObservation, after: StructuredObservation): Record<string, unknown> {
    return {
      地址变化: before.url !== after.url ? { 前: before.url, 后: after.url } : undefined,
      标题变化: before.title !== after.title ? { 前: before.title, 后: after.title } : undefined,
      弹窗数量: [before.dialogCount, after.dialogCount],
      加载遮罩数量: [before.loadingOverlayCount, after.loadingOverlayCount],
      可见组件数量: [
        before.components.filter(item => item.state.visible).length,
        after.components.filter(item => item.state.visible).length,
      ],
    };
  }

  private logWarning(input: DecisionGateInput, error: string): void {
    this.logger.logSystem(
      { description: '模型动作排序已回退到脚本计划', module: 'ModelDecisionGate', method: 'selectNext' },
      { type: 'model-action-priority', target: input.pageUrl },
      { status: 'warning', duration: 0, error },
      { pageUrl: input.pageUrl, phase: 'test', componentId: input.executedAction.componentId },
    );
  }

  private logSkip(input: DecisionGateInput, reason: string): void {
    this.logger.logSystem(
      { description: '跳过视觉模型决策', module: 'ModelDecisionGate', method: 'selectNext' },
      { type: 'vision-decision-skip', target: input.pageUrl, params: { reason } },
      { status: 'skipped', duration: 0, output: { reason } },
      { pageUrl: input.pageUrl, phase: 'test', componentId: input.executedAction.componentId },
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
