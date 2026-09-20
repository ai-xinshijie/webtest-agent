export interface FactorValue {
  factorIndex: number;
  value: string;
}

export interface CoveringArrayResult {
  rows: string[][];
  strength: number;
  exhaustive: boolean;
  coveredCombinations: number;
  totalCombinations: number;
}

export interface PathGraph {
  nodes: string[];
  edges: Array<{ from: string; to: string; trigger?: string }>;
}

export interface CoverageSnapshot {
  actions: { visited: number; reused: number; blocked: number; pending: number; percentage: number; resolvedPercentage: number };
  combinations: { covered: number; reused: number; blocked: number; total: number; percentage: number; resolvedPercentage: number };
  paths: { covered: number; reused: number; blocked: number; total: number; percentage: number; resolvedPercentage: number };
}

/**
 * 生成覆盖数组。小规模参数空间使用全组合，大规模参数空间使用 t-way 覆盖。
 */
export class CoveringArrayGenerator {
  generate(
    factors: Array<readonly string[]>,
    strength = 2,
    exhaustiveLimit = 4096,
  ): CoveringArrayResult {
    if (factors.length === 0 || factors.some(factor => factor.length === 0)) {
      return {
        rows: [],
        strength: 0,
        exhaustive: false,
        coveredCombinations: 0,
        totalCombinations: 0,
      };
    }

    const total = factors.reduce((acc, factor) => acc * factor.length, 1);
    if (total <= exhaustiveLimit && strength >= factors.length) {
      const rows = this.cartesian(factors);
      const t = Math.min(strength, factors.length);
      const totalCombinations = this.countCombinations(factors, t);
      return {
        rows,
        strength: t,
        exhaustive: true,
        coveredCombinations: totalCombinations,
        totalCombinations,
      };
    }

    const t = Math.max(1, Math.min(strength, factors.length));
    const rows: string[][] = [];
    const assignments = this.generateAssignments(factors, t);

    for (const assignment of assignments) {
      if (rows.some(row => this.covers(row, assignment))) continue;
      const row = factors.map((factor, index) => factor[0]!);
      for (const item of assignment) row[item.factorIndex] = item.value;
      rows.push(row);
    }

    const coveredCombinations = this.countCovered(rows, factors, t);
    return {
      rows,
      strength: t,
      exhaustive: false,
      coveredCombinations,
      totalCombinations: assignments.length,
    };
  }

  private cartesian(factors: Array<readonly string[]>): string[][] {
    return factors.reduce<string[][]>(
      (rows, factor) => rows.flatMap(row => factor.map(value => [...row, value])),
      [[]],
    );
  }

  private generateAssignments(factors: Array<readonly string[]>, strength: number): FactorValue[][] {
    const indexCombinations = this.combineIndexes(factors.map((_, index) => index), strength);
    const assignments: FactorValue[][] = [];

    for (const indexes of indexCombinations) {
      const values = indexes.map(index => factors[index]!);
      for (const combination of this.cartesian(values)) {
        assignments.push(combination.map((value, position) => ({
          factorIndex: indexes[position]!,
          value,
        })));
      }
    }

    return assignments;
  }

  private countCombinations(factors: Array<readonly string[]>, strength: number): number {
    const indexCombinations = this.combineIndexes(factors.map((_, index) => index), strength);
    return indexCombinations.reduce(
      (sum, indexes) => sum + indexes.reduce((product, index) => product * factors[index]!.length, 1),
      0,
    );
  }

  private countCovered(rows: string[][], factors: Array<readonly string[]>, strength: number): number {
    const indexCombinations = this.combineIndexes(factors.map((_, index) => index), strength);
    const covered = new Set<string>();

    for (const row of rows) {
      for (const indexes of indexCombinations) {
        covered.add(indexes.map(index => `${index}=${row[index]}`).join('|'));
      }
    }

    return covered.size;
  }

  private covers(row: string[], assignment: FactorValue[]): boolean {
    return assignment.every(item => row[item.factorIndex] === item.value);
  }

  private combineIndexes<T>(items: T[], size: number): T[][] {
    if (size <= 0) return [[]];
    if (items.length < size) return [];
    if (size === 1) return items.map(item => [item]);

    const result: T[][] = [];
    for (let i = 0; i <= items.length - size; i++) {
      const rest = this.combineIndexes(items.slice(i + 1), size - 1);
      for (const combination of rest) result.push([items[i]!, ...combination]);
    }
    return result;
  }
}

/**
 * 枚举有向图路径，避免循环路径，用于序列覆盖。
 */
export class PathCoverageGenerator {
  generate(graph: PathGraph, maxDepth = 6, maxPaths = 10000): string[][] {
    const adjacency = new Map<string, PathGraph['edges']>();
    for (const edge of graph.edges) {
      const list = adjacency.get(edge.from) ?? [];
      list.push(edge);
      adjacency.set(edge.from, list);
    }

    const paths: string[][] = [];
    const visit = (node: string, current: string[]) => {
      if (paths.length >= maxPaths) return;
      if (current.length >= maxDepth) {
        if (current.length > 1) paths.push([...current]);
        return;
      }

      const edges = adjacency.get(node) ?? [];
      if (edges.length === 0) {
        if (current.length > 1) paths.push([...current]);
        return;
      }

      for (const edge of edges) {
        if (current.includes(edge.to)) continue;
        visit(edge.to, [...current, edge.to]);
      }
    };

    for (const node of graph.nodes) visit(node, [node]);
    return paths;
  }
}

/**
 * 汇总动作、组合和路径三类覆盖，用于判断测试是否穷尽。
 */
export class CoverageTracker {
  private visitedActions = new Set<string>();
  private reusedActions = new Set<string>();
  private blockedActions = new Set<string>();
  private pendingActions = new Set<string>();
  private combinations = new Map<string, string[]>();
  private reusedCombinations = new Map<string, string[]>();
  private blockedCombinations = new Map<string, string[]>();
  private expectedCombinationCount = 0;
  private paths = new Set<string>();
  private reusedPaths = new Set<string>();
  private blockedPaths = new Set<string>();
  private expectedPathCount = 0;

  initializeActions(items: Array<{ pageId: string; componentId: string; action: string }>): void {
    for (const item of items) {
      const key = this.actionKey(item.pageId, item.componentId, item.action);
      if (!this.visitedActions.has(key) && !this.blockedActions.has(key)) {
        this.pendingActions.add(key);
      }
    }
  }

  markVisited(pageId: string, componentId: string, action: string): void {
    const key = this.actionKey(pageId, componentId, action);
    this.blockedActions.delete(key);
    this.pendingActions.delete(key);
    this.visitedActions.add(key);
    this.reusedActions.delete(key);
  }

  markReused(pageId: string, componentId: string, action: string): void {
    const key = this.actionKey(pageId, componentId, action);
    if (this.visitedActions.has(key)) return;
    this.pendingActions.delete(key);
    this.blockedActions.delete(key);
    this.reusedActions.add(key);
  }

  markBlocked(pageId: string, componentId: string, action: string): void {
    const key = this.actionKey(pageId, componentId, action);
    if (this.visitedActions.has(key)) return;
    this.pendingActions.delete(key);
    this.blockedActions.add(key);
  }

  isPendingAction(pageId: string, componentId: string, action: string): boolean {
    return this.pendingActions.has(this.actionKey(pageId, componentId, action));
  }


  setExpectedCombinations(count: number): void {
    this.expectedCombinationCount = count;
  }

  recordCombination(values: string[]): void {
    const key = values.join('\u0000');
    this.blockedCombinations.delete(key);
    this.combinations.set(key, values);
    this.reusedCombinations.delete(key);
  }

  markCombinationReused(values: string[]): void {
    const key = values.join('\u0000');
    if (this.combinations.has(key)) return;
    this.blockedCombinations.delete(key);
    this.reusedCombinations.set(key, values);
  }

  markCombinationBlocked(values: string[]): void {
    const key = values.join('\u0000');
    if (!this.combinations.has(key)) this.blockedCombinations.set(key, values);
  }

  setExpectedPaths(count: number): void {
    this.expectedPathCount = count;
  }

  recordPath(nodes: string[]): void {
    const key = nodes.join(' -> ');
    this.blockedPaths.delete(key);
    this.paths.add(key);
    this.reusedPaths.delete(key);
  }

  markPathReused(nodes: string[]): void {
    const key = nodes.join(' -> ');
    if (this.paths.has(key)) return;
    this.blockedPaths.delete(key);
    this.reusedPaths.add(key);
  }

  markPathBlocked(nodes: string[]): void {
    const key = nodes.join(' -> ');
    if (!this.paths.has(key)) this.blockedPaths.add(key);
  }

  isExhausted(): boolean {
    return this.pendingActions.size === 0;
  }

  snapshot(): CoverageSnapshot {
    const totalActions = this.visitedActions.size + this.reusedActions.size + this.blockedActions.size
      + this.pendingActions.size;
    return {
      actions: {
        visited: this.visitedActions.size,
        reused: this.reusedActions.size,
        blocked: this.blockedActions.size,
        pending: this.pendingActions.size,
        percentage: totalActions === 0
          ? 0
          : (this.visitedActions.size / totalActions) * 100,
        resolvedPercentage: totalActions === 0
          ? 0
          : ((this.visitedActions.size + this.reusedActions.size + this.blockedActions.size) / totalActions) * 100,
      },
      combinations: {
        covered: this.combinations.size,
        reused: this.reusedCombinations.size,
        blocked: this.blockedCombinations.size,
        total: this.expectedCombinationCount,
        percentage: this.expectedCombinationCount === 0
          ? 0
          : (this.combinations.size / this.expectedCombinationCount) * 100,
        resolvedPercentage: this.expectedCombinationCount === 0
          ? 0
          : ((this.combinations.size + this.reusedCombinations.size + this.blockedCombinations.size) / this.expectedCombinationCount) * 100,
      },
      paths: {
        covered: this.paths.size,
        reused: this.reusedPaths.size,
        blocked: this.blockedPaths.size,
        total: this.expectedPathCount,
        percentage: this.expectedPathCount === 0
          ? 0
          : (this.paths.size / this.expectedPathCount) * 100,
        resolvedPercentage: this.expectedPathCount === 0
          ? 0
          : ((this.paths.size + this.reusedPaths.size + this.blockedPaths.size) / this.expectedPathCount) * 100,
      },
    };
  }

  private actionKey(pageId: string, componentId: string, action: string): string {
    return `${pageId}:${componentId}:${action}`;
  }
}
