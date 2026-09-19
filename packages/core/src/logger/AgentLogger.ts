import { randomUUID } from 'node:crypto';
import type { DatabaseManager } from '../db/Database.js';

export type AgentLogSource = 'script' | 'model' | 'system' | 'user';
export type AgentLogStatus = 'success' | 'failed' | 'skipped' | 'warning';

export interface AgentLogTrigger {
  description: string;
  module: string;
  method: string;
}

export interface AgentLogAction {
  type: string;
  target?: string;
  params?: Record<string, unknown>;
}

export interface AgentLogModel {
  provider: string;
  model: string;
  taskType: string;
  inputTokens: number;
  outputTokens: number;
  request: {
    messages: Array<{ role: string; content: string }>;
  };
  response: {
    content: string;
    parsed?: unknown;
  };
}

export interface AgentLogResult {
  status: AgentLogStatus;
  duration: number;
  output?: unknown;
  error?: string;
  screenshotId?: string;
}

export interface AgentLogContext {
  pageUrl?: string;
  phase: string;
  componentId?: string;
}

export interface AgentLog {
  id: string;
  sessionId: string;
  timestamp: number;
  sequence: number;
  source: AgentLogSource;
  trigger: AgentLogTrigger;
  action: AgentLogAction;
  model?: AgentLogModel;
  result: AgentLogResult;
  context: AgentLogContext;
}

export type AgentLogInput = Omit<AgentLog, 'id' | 'sessionId' | 'timestamp' | 'sequence'>;

export interface AgentLoggerOptions {
  consoleOutput?: boolean;
}

export interface ModelCallResult {
  content: string;
  parsed?: unknown;
}

/**
 * 智能体执行审计日志。
 *
 * 每一条日志对应一个可回溯步骤，包含触发来源、触发方式、执行参数、
 * 执行结果、耗时以及模型请求/响应（仅模型触发时）。
 */
export class AgentLogger {
  private logs: AgentLog[] = [];
  private sequence: number;
  private insertStatement;

  constructor(
    private db: DatabaseManager,
    private sessionId: string,
    private options: AgentLoggerOptions = { consoleOutput: true },
  ) {
    const current = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS max_sequence
      FROM agent_logs
      WHERE session_id = ?
    `).get(sessionId) as { max_sequence: number } | undefined;

    this.sequence = current?.max_sequence ?? 0;
    this.logs = this.db.prepare(`
      SELECT log_json FROM agent_logs WHERE session_id = ? ORDER BY sequence ASC
    `).all(sessionId).map(row => JSON.parse((row as { log_json: string }).log_json));
    this.insertStatement = this.db.prepare(`
      INSERT INTO agent_logs (id, session_id, timestamp, sequence, source, log_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /** 记录系统事件。 */
  logSystem(trigger: AgentLogTrigger, action: AgentLogAction, result: Omit<AgentLogResult, 'duration'> & { duration?: number }, context: AgentLogContext): AgentLog {
    return this.write({
      source: 'system',
      trigger,
      action,
      result: { duration: 0, ...result },
      context,
    });
  }

  /** 记录用户触发的事件。 */
  logUser(trigger: AgentLogTrigger, action: AgentLogAction, result: Omit<AgentLogResult, 'duration'> & { duration?: number }, context: AgentLogContext): AgentLog {
    return this.write({
      source: 'user',
      trigger,
      action,
      result: { duration: 0, ...result },
      context,
    });
  }

  /** 记录确定性脚本触发的已完成事件。 */
  logScript(
    trigger: AgentLogTrigger,
    action: AgentLogAction,
    result: Omit<AgentLogResult, 'duration'> & { duration?: number },
    context: AgentLogContext,
  ): AgentLog {
    return this.write({
      source: 'script',
      trigger,
      action,
      result: { duration: 0, ...result },
      context,
    });
  }

  /** 执行并记录脚本触发的操作。失败时保留原始异常。 */
  async runScript<T>(
    trigger: AgentLogTrigger,
    action: AgentLogAction,
    execution: () => Promise<T>,
    context: AgentLogContext,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const output = await execution();
      this.logScript(trigger, action, {
        status: 'success',
        duration: Date.now() - startedAt,
        output,
      }, context);
      return output;
    } catch (error) {
      this.logScript(trigger, action, {
        status: 'failed',
        duration: Date.now() - startedAt,
        error: this.errorMessage(error),
      }, context);
      throw error;
    }
  }

  /** 执行并记录模型触发的操作，保留完整请求和响应。 */
  async runModel<T extends ModelCallResult>(
    trigger: AgentLogTrigger,
    action: AgentLogAction,
    model: Omit<AgentLogModel, 'inputTokens' | 'outputTokens' | 'response'>,
    execution: () => Promise<T>,
    context: AgentLogContext,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const response = await execution();
      const outputText = response.content ?? '';
      this.write({
        source: 'model',
        trigger,
        action,
        model: {
          ...model,
          inputTokens: estimateTokens(model.request.messages.map(message => message.content).join('\n')),
          outputTokens: estimateTokens(outputText),
          response: {
            content: outputText,
            parsed: this.safeClone(response.parsed),
          },
        },
        result: {
          status: 'success',
          duration: Date.now() - startedAt,
          output: this.safeClone(response.parsed ?? outputText),
        },
        context,
      });
      return response;
    } catch (error) {
      const message = this.errorMessage(error);
      this.write({
        source: 'model',
        trigger,
        action,
        model: {
          ...model,
          inputTokens: estimateTokens(model.request.messages.map(message => message.content).join('\n')),
          outputTokens: 0,
          response: { content: '' },
        },
        result: {
          status: 'failed',
          duration: Date.now() - startedAt,
          error: message,
        },
        context,
      });
      throw error;
    }
  }

  /** 获取会话时间线，按序号升序。 */
  getTimeline(limit?: number): AgentLog[] {
    const logs = [...this.logs].sort((a, b) => a.sequence - b.sequence);
    return limit === undefined ? logs : logs.slice(-limit);
  }

  /** 获取模型调用日志。 */
  getModelCalls(): AgentLog[] {
    return this.getTimeline().filter(log => log.source === 'model');
  }

  private write(input: AgentLogInput): AgentLog {
    this.sequence += 1;
    const entry: AgentLog = {
      id: randomUUID(),
      sessionId: this.sessionId,
      timestamp: Date.now(),
      sequence: this.sequence,
      source: input.source,
      trigger: input.trigger,
      action: this.safeClone(input.action) as AgentLogAction,
      model: input.model ? this.safeClone(input.model) as AgentLogModel : undefined,
      result: {
        ...input.result,
        output: this.safeClone(input.result.output),
      },
      context: input.context,
    };

    this.insertStatement.run(
      entry.id,
      entry.sessionId,
      entry.timestamp,
      entry.sequence,
      entry.source,
      JSON.stringify(entry),
      Date.now(),
    );
    this.logs.push(entry);
    this.print(entry);
    return entry;
  }

  private print(entry: AgentLog): void {
    if (!this.options.consoleOutput) return;
    const status = entry.result.status;
    const model = entry.model ? `[${entry.model.provider}/${entry.model.model}] ` : '';
    console.log(`  [${String(entry.sequence).padStart(4, '0')}] ${entry.source} ${status} ${entry.trigger.description} ${model}${entry.result.duration}ms`);
    if (entry.result.error) console.warn(`    ${entry.result.error}`);
  }

  private safeClone(value: unknown): unknown {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}

/** 简化 token 估算，用于日志观测，不用于计费。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3);
}
