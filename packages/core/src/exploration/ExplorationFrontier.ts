/**
 * Frontier Queue: formal exhaustiveness check for exploration.
 * Queue is empty = exploration is exhausted (necessary and sufficient).
 */
interface FrontierItem {
  pageId: string;
  componentId: string;
  action: string;
  priority: number;
  discoveryMethod: string;
}

export class ExplorationFrontier {
  private queue: FrontierItem[] = [];
  private visited: Set<string> = new Set();
  private blocked: Set<string> = new Set();

  /**
   * Initialize frontier with a page's components.
   */
  initialize(pageId: string, components: Array<{ id: string; type: string }>): void {
    for (const component of components) {
      for (const action of this.getApplicableActions(component.type)) {
        this.enqueue(pageId, component.id, action);
      }
    }
  }

  /**
   * Add an item to the frontier queue.
   */
  enqueue(pageId: string, componentId: string, action: string, priority = 0): void {
    const hash = `${pageId}:${componentId}:${action}`;
    if (this.visited.has(hash) || this.blocked.has(hash)) return;

    this.queue.push({ pageId, componentId, action, priority, discoveryMethod: 'initial' });
    // Keep highest priority first
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get next item to explore.
   */
  dequeue(): FrontierItem | null {
    return this.queue.shift() ?? null;
  }

  /**
   * Mark item as visited.
   */
  markVisited(pageId: string, componentId: string, action: string): void {
    this.visited.add(`${pageId}:${componentId}:${action}`);
  }

  /**
   * Mark item as blocked (cannot execute due to preconditions).
   */
  markBlocked(pageId: string, componentId: string, action: string): void {
    this.blocked.add(`${pageId}:${componentId}:${action}`);
  }

  /**
   * Check if exploration is exhausted.
   */
  isExhausted(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Get coverage statistics.
   */
  getCoverage(): {
    visited: number;
    pending: number;
    blocked: number;
    percentage: number;
  } {
    const total = this.visited.size + this.queue.length + this.blocked.size;
    return {
      visited: this.visited.size,
      pending: this.queue.length,
      blocked: this.blocked.size,
      percentage: total > 0 ? (this.visited.size / total) * 100 : 0,
    };
  }

  private getApplicableActions(componentType: string): string[] {
    const actionsByType: Record<string, string[]> = {
      button: ['click', 'double-click', 'right-click'],
      link: ['click'],
      input: ['fill', 'clear', 'fill-max'],
      textarea: ['fill', 'clear', 'fill-max'],
      select: ['select-first', 'select-last', 'select-random'],
      form: ['submit-empty', 'submit-partial', 'submit-valid'],
      modal: ['open', 'close-esc', 'close-overlay', 'close-button'],
      accordion: ['expand', 'collapse', 'expand-all'],
      tab: ['switch'],
      checkbox: ['check', 'uncheck'],
      radio: ['select'],
      pagination: ['next', 'prev', 'first', 'last'],
      dropdown: ['open', 'select-option'],
      table: ['sort', 'filter', 'row-click'],
    };
    return actionsByType[componentType] ?? ['click'];
  }
}
