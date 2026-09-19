import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { LLMRouter } from '../llm/LLMRouter.js';

export type HotPatchStatus =
  | 'fallback-applied'
  | 'proposed'
  | 'applied'
  | 'rejected'
  | 'rolled-back';

export interface SourcePatch {
  file: string;
  find: string;
  replace: string;
}

export interface RepairProposal {
  rootCause: string;
  explanation: string;
  strategyName?: string;
  patch?: SourcePatch;
}

export interface HotPatchReport {
  id: string;
  sessionId: string;
  strategyName: string;
  status: HotPatchStatus;
  rootCause: string;
  explanation: string;
  sourceFile?: string;
  patch?: SourcePatch;
  error?: string;
  createdAt: number;
}

export interface CodeRepairContext {
  sessionId: string;
  strategyName: string;
  recentActions?: string[];
  sourceFile?: string;
}

export interface CommandResult {
  status: number | null;
  output: string;
}

export interface CodeSelfHealerOptions {
  rootDir: string;
  router?: LLMRouter;
  sourceRepairMode?: 'disabled' | 'review' | 'auto';
  maxPatchesPerStrategy?: number;
  commandRunner?: (command: string, args: string[], cwd: string) => CommandResult;
  now?: () => number;
}

type FallbackStrategy = () => Promise<boolean> | boolean;

/**
 * 仅允许切换预注册的保守策略，不执行模型返回的可执行代码。
 */
export class StrategyRegistry {
  private strategies = new Map<string, FallbackStrategy>();
  private activated = new Set<string>();

  register(name: string, strategy: FallbackStrategy): void {
    this.strategies.set(name, strategy);
  }

  async activate(name: string): Promise<boolean> {
    const strategy = this.strategies.get(name);
    if (!strategy) return false;
    const result = await strategy();
    if (result) this.activated.add(name);
    return result;
  }

  isActivated(name: string): boolean {
    return this.activated.has(name);
  }
}

/**
 * 代码级自愈：记录诊断、启用受控降级策略，并可在严格白名单内应用经验证的最小源码补丁。
 */
export class CodeSelfHealer {
  readonly strategies = new StrategyRegistry();
  private readonly reports: HotPatchReport[] = [];
  private readonly patchCounts = new Map<string, number>();
  private readonly mode: NonNullable<CodeSelfHealerOptions['sourceRepairMode']>;
  private readonly maxPatches: number;
  private readonly now: () => number;
  private readonly runCommand: NonNullable<CodeSelfHealerOptions['commandRunner']>;

  constructor(private options: CodeSelfHealerOptions) {
    this.mode = options.sourceRepairMode ?? 'review';
    this.maxPatches = options.maxPatchesPerStrategy ?? 3;
    this.now = options.now ?? (() => Date.now());
    this.runCommand = options.commandRunner ?? ((command, args, cwd) => {
      const result = spawnSync(command, args, { cwd, encoding: 'utf-8', shell: false });
      return {
        status: result.status,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      };
    });
  }

  async recover(error: unknown, context: CodeRepairContext): Promise<HotPatchReport> {
    const err = error instanceof Error ? error : new Error(String(error));
    const fallbackApplied = await this.strategies.activate(context.strategyName);
    const proposal = await this.diagnose(err, context);

    if (fallbackApplied) {
      return this.record({
        sessionId: context.sessionId,
        strategyName: context.strategyName,
        status: 'fallback-applied',
        rootCause: proposal.rootCause,
        explanation: `${proposal.explanation} 已切换预注册保守策略继续测试。`,
      });
    }

    if (!proposal.patch) {
      return this.record({
        sessionId: context.sessionId,
        strategyName: context.strategyName,
        status: 'proposed',
        rootCause: proposal.rootCause,
        explanation: proposal.explanation,
      });
    }

    return this.applyProposal(proposal, context);
  }

  getReports(sessionId?: string): HotPatchReport[] {
    return this.reports.filter(report => !sessionId || report.sessionId === sessionId);
  }

  private async diagnose(error: Error, context: CodeRepairContext): Promise<RepairProposal> {
    const fallback: RepairProposal = {
      rootCause: error.message || '未知运行时错误',
      explanation: '未配置可用的代码修复模型，仅记录错误并等待人工处理。',
      strategyName: context.strategyName,
    };
    if (!this.options.router) return fallback;

    const sourceFile = context.sourceFile ?? this.sourceFileFromStack(error.stack);
    const source = sourceFile && existsSync(sourceFile)
      ? readFileSync(sourceFile, 'utf-8').slice(0, 30000)
      : '未能定位到可读取的源码文件。';

    try {
      const raw = await this.options.router.call('code-repair', [
        {
          role: 'system',
          content: '你是受限代码修复器。只返回 JSON，不返回 Markdown。补丁必须是最小文本替换，不能新增网络、文件系统、子进程、动态执行或环境变量访问。',
        },
        {
          role: 'user',
          content: JSON.stringify({
            错误: error.message,
            堆栈: error.stack ?? '',
            策略: context.strategyName,
            最近动作: context.recentActions ?? [],
            源码文件: sourceFile ?? null,
            源码: source,
            输出格式: { rootCause: 'string', explanation: 'string', strategyName: 'string', patch: { file: 'string', find: 'string', replace: 'string' } },
          }),
        },
      ]);
      return this.parseProposal(raw, fallback);
    } catch {
      return fallback;
    }
  }

  private parseProposal(raw: string, fallback: RepairProposal): RepairProposal {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const json = start >= 0 && end > start ? raw.slice(start, end + 1) : undefined;
    if (!json) return fallback;
    try {
      const value = JSON.parse(json) as Partial<RepairProposal>;
      const patch = value.patch && this.isPatchShape(value.patch) ? value.patch : undefined;
      return {
        rootCause: typeof value.rootCause === 'string' ? value.rootCause : fallback.rootCause,
        explanation: typeof value.explanation === 'string' ? value.explanation : fallback.explanation,
        strategyName: typeof value.strategyName === 'string' ? value.strategyName : fallback.strategyName,
        patch,
      };
    } catch {
      return fallback;
    }
  }

  private isPatchShape(value: unknown): value is SourcePatch {
    if (!value || typeof value !== 'object') return false;
    const patch = value as Partial<SourcePatch>;
    return typeof patch.file === 'string'
      && typeof patch.find === 'string'
      && typeof patch.replace === 'string';
  }

  private applyProposal(proposal: RepairProposal, context: CodeRepairContext): HotPatchReport {
    const patch = proposal.patch!;
    const safety = this.validatePatch(patch, context.strategyName);
    if (!safety.safe) {
      return this.record({
        sessionId: context.sessionId,
        strategyName: context.strategyName,
        status: 'rejected',
        rootCause: proposal.rootCause,
        explanation: proposal.explanation,
        sourceFile: patch.file,
        patch,
        error: safety.reason,
      });
    }

    if (this.mode !== 'auto') {
      return this.record({
        sessionId: context.sessionId,
        strategyName: context.strategyName,
        status: 'proposed',
        rootCause: proposal.rootCause,
        explanation: `${proposal.explanation} 源码自动修复模式未开启，补丁已记录等待审核。`,
        sourceFile: safety.filePath,
        patch,
      });
    }

    const original = readFileSync(safety.filePath, 'utf-8');
    const patched = original.replace(patch.find, patch.replace);
    writeFileSync(safety.filePath, patched, 'utf-8');
    this.patchCounts.set(context.strategyName, (this.patchCounts.get(context.strategyName) ?? 0) + 1);

    const validation = this.validateBuildAndTests();
    if (validation.ok) {
      return this.record({
        sessionId: context.sessionId,
        strategyName: context.strategyName,
        status: 'applied',
        rootCause: proposal.rootCause,
        explanation: `${proposal.explanation} 补丁已通过构建与测试验证；常驻代理重启后生效。`,
        sourceFile: safety.filePath,
        patch,
      });
    }

    writeFileSync(safety.filePath, original, 'utf-8');
    return this.record({
      sessionId: context.sessionId,
      strategyName: context.strategyName,
      status: 'rolled-back',
      rootCause: proposal.rootCause,
      explanation: proposal.explanation,
      sourceFile: safety.filePath,
      patch,
      error: validation.error,
    });
  }

  private validatePatch(patch: SourcePatch, strategyName: string): { safe: boolean; reason?: string; filePath: string } {
    const filePath = path.resolve(this.options.rootDir, patch.file);
    const sourceRoot = path.resolve(this.options.rootDir, 'packages');
    const relativePath = path.relative(sourceRoot, filePath);
    const allowed = relativePath.length > 0
      && !relativePath.startsWith('..')
      && !path.isAbsolute(relativePath)
      && relativePath.split(path.sep).includes('src')
      && filePath.endsWith('.ts');
    if (!allowed) return { safe: false, reason: '补丁只能修改 packages 目录下的 TypeScript 源码文件', filePath };
    if (!existsSync(filePath)) return { safe: false, reason: '补丁目标文件不存在', filePath };
    if (!patch.find || patch.find.length > 20000 || patch.replace.length > 20000) {
      return { safe: false, reason: '补丁内容为空或超过安全长度限制', filePath };
    }
    if ((this.patchCounts.get(strategyName) ?? 0) >= this.maxPatches) {
      return { safe: false, reason: `策略 ${strategyName} 已达到最大修复次数`, filePath };
    }

    const forbidden = /node:fs|node:child_process|\b(?:eval|Function|fetch|XMLHttpRequest|WebSocket|process\.env|spawn|exec|rmSync|writeFileSync)\b/i;
    if (forbidden.test(patch.replace)) {
      return { safe: false, reason: '补丁包含被禁止的高风险能力', filePath };
    }

    const original = readFileSync(filePath, 'utf-8');
    if (original.indexOf(patch.find) < 0 || original.indexOf(patch.find) !== original.lastIndexOf(patch.find)) {
      return { safe: false, reason: '补丁定位文本必须在目标文件中唯一出现', filePath };
    }
    return { safe: true, filePath };
  }

  private validateBuildAndTests(): { ok: boolean; error?: string } {
    const build = this.runCommand('pnpm', ['build'], this.options.rootDir);
    if (build.status !== 0) return { ok: false, error: `构建验证失败：${build.output.slice(-2000)}` };

    const test = this.runCommand('pnpm', ['exec', 'vitest', 'run', '--coverage.enabled=false'], this.options.rootDir);
    if (test.status !== 0) return { ok: false, error: `测试验证失败：${test.output.slice(-2000)}` };
    return { ok: true };
  }

  private sourceFileFromStack(stack?: string): string | undefined {
    if (!stack) return undefined;
    const candidates = stack.matchAll(/(?:\(|\s)([A-Za-z]:[^\s()]+?\.(?:ts|js)|\/[^\s()]+?\.(?:ts|js)):\d+:\d+/g);
    for (const candidate of candidates) {
      const file = candidate[1]!;
      if (file.startsWith(path.resolve(this.options.rootDir)) && existsSync(file)) return file;
    }
    return undefined;
  }

  private record(input: Omit<HotPatchReport, 'id' | 'createdAt'>): HotPatchReport {
    const report: HotPatchReport = {
      ...input,
      id: `${input.sessionId}-${this.now()}-${this.reports.length + 1}`,
      createdAt: this.now(),
    };
    this.reports.push(report);
    return report;
  }
}
