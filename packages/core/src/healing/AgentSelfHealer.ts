/**
 * Agent 级自愈：错误边界、循环检测和健康恢复。
 */
export class AgentSelfHealer {
  private loopDetector: LoopDetector;
  private patchCounts: Map<string, number> = new Map();

  constructor() {
    this.loopDetector = new LoopDetector();
  }

  /**
   * 带错误恢复能力地执行操作。
  */
  async executeSafely<T>(
    operation: () => Promise<T>,
    context: { operationName: string; sessionId: string; retryCount?: number },
  ): Promise<T | { skipped: true; reason: string }> {
    try {
      const result = await operation();

      // 成功执行后检查是否进入循环。
      if (this.loopDetector.onAction({ operation: context.operationName })) {
        return { skipped: true, reason: '检测到重复动作循环，已切换测试策略' };
      }

      return result;
    } catch (error) {
      return this.handle(error, context, operation);
    }
  }

  private async handle<T>(
    error: unknown,
    ctx: { operationName: string; sessionId: string },
    retry: () => Promise<T>,
  ): Promise<T | { skipped: true; reason: string }> {
    const err = error instanceof Error ? error : new Error(String(error));
    const classification = this.classify(err);

    switch (classification) {
      case 'retryable':
        return this.retryWithBackoff(retry, 3, [1000, 3000, 5000]);

      case 'browser-crash':
        console.warn(`执行 ${ctx.operationName} 时浏览器崩溃，需要重启`);
        return { skipped: true, reason: `浏览器崩溃：${err.message}` };

      case 'llm-malformed':
        return { skipped: true, reason: `模型输出格式错误：${err.message}` };

      case 'fatal':
      default:
        console.error(`执行 ${ctx.operationName} 时发生致命错误：`, err.message);
        return { skipped: true, reason: err.message };
    }
  }

  private classify(error: Error): 'retryable' | 'browser-crash' | 'llm-malformed' | 'fatal' {
    const msg = error.message;
    if (msg.includes('Timeout') || msg.includes('timeout')) return 'retryable';
    if (msg.includes('Target closed') || msg.includes('Browser closed') || msg.includes('Connection closed')) {
      return 'browser-crash';
    }
    if (msg.includes('ZodError') || msg.includes('validation')) return 'llm-malformed';
    return 'fatal';
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number, delays: number[]): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      await new Promise(resolve => setTimeout(resolve, delays[i] ?? 5000));
      try {
        return await fn();
      } catch (error) {
        if (i === maxRetries - 1) throw error;
      }
    }
    return fn();
  }
}

/**
 * Detect if agent is stuck in a loop (repeated actions).
 */
class LoopDetector {
  private recentActions: string[] = [];
  private readonly WINDOW_SIZE = 10;
  private readonly REPEAT_THRESHOLD = 6;

  onAction(action: { operation: string }): boolean {
    this.recentActions.push(action.operation);
    if (this.recentActions.length > this.WINDOW_SIZE) {
      this.recentActions.shift();
    }
    return this.detectLoop();
  }

  private detectLoop(): boolean {
    // Check for excessive repetition
    const counts = new Map<string, number>();
    for (const action of this.recentActions) {
      counts.set(action, (counts.get(action) || 0) + 1);
      if (counts.get(action)! >= this.REPEAT_THRESHOLD) return true;
    }

    // Check for alternating pattern (A→B→A→B...)
    if (this.recentActions.length >= 4) {
      const recent = this.recentActions.slice(-4);
      if (recent[0] === recent[2] && recent[1] === recent[3] && recent[0] !== recent[1]) {
        return true;
      }
    }

    return false;
  }
}
