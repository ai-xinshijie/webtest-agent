/**
 * Agent-level self-healing: error boundaries, loop detection, health monitoring.
 */
export class AgentSelfHealer {
  private loopDetector: LoopDetector;
  private patchCounts: Map<string, number> = new Map();

  constructor() {
    this.loopDetector = new LoopDetector();
  }

  /**
   * Execute an operation safely with error recovery.
   */
  async executeSafely<T>(
    operation: () => Promise<T>,
    context: { operationName: string; sessionId: string; retryCount?: number },
  ): Promise<T | { skipped: true; reason: string }> {
    try {
      const result = await operation();

      // Check for loop after successful action
      if (this.loopDetector.onAction({ operation: context.operationName })) {
        return { skipped: true, reason: 'loop detected, strategy changed' };
      }

      return result;
    } catch (error) {
      return this.handle(error, context, operation);
    }
  }

  private async handle(
    error: unknown,
    ctx: { operationName: string; sessionId: string },
    retry: Function,
  ): Promise<any> {
    const err = error instanceof Error ? error : new Error(String(error));
    const classification = this.classify(err);

    switch (classification) {
      case 'retryable':
        return this.retryWithBackoff(retry, 3, [1000, 3000, 5000]);

      case 'browser-crash':
        console.warn(`Browser crashed during ${ctx.operationName}, needs restart`);
        return { skipped: true, reason: `browser crash: ${err.message}` };

      case 'llm-malformed':
        return { skipped: true, reason: `LLM output malformed: ${err.message}` };

      case 'fatal':
      default:
        console.error(`Fatal error in ${ctx.operationName}:`, err.message);
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

  private async retryWithBackoff(fn: Function, maxRetries: number, delays: number[]): Promise<any> {
    for (let i = 0; i < maxRetries; i++) {
      await new Promise(resolve => setTimeout(resolve, delays[i] ?? 5000));
      try {
        return await fn();
      } catch (error) {
        if (i === maxRetries - 1) throw error;
      }
    }
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
