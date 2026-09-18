import type { DatabaseManager } from '../db/Database.js';
import type { LLMRouter } from '../llm/LLMRouter.js';
import * as crypto from 'node:crypto';

export interface TestedItem {
  targetId: string;
  itemKey: string;
  componentId: string;
  testType: string;
  status: 'passed' | 'failed' | 'skipped';
  lastTestedAt: number;
  testCount: number;
}

export type TestedItemInput = Omit<TestedItem, 'targetId' | 'lastTestedAt' | 'testCount'>;

export interface MemoryRule {
  targetId: string;
  id: string;
  statement: string;
  confidence: number;
  positiveCount: number;
  negativeCount: number;
  learnedAt: number;
  lastValidatedAt: number | null;
}

export interface MemoryPattern {
  targetId: string;
  id: string;
  pattern: string;
  observedIn: string;
  reliability: number;
  lastSeenAt: number;
}

export interface SessionSummary {
  id: string;
  sessionId: string;
  targetId: string;
  summary: Record<string, unknown>;
  createdAt: number;
}

export interface MemoryOverview {
  targetCount: number;
  testedItemCount: number;
  ruleCount: number;
  patternCount: number;
  summaryCount: number;
}

export interface MemoryExport {
  format: 'wta-memory';
  version: 1;
  testedItems: TestedItem[];
  rules: MemoryRule[];
  patterns: MemoryPattern[];
  summaries: SessionSummary[];
}

interface CompressOptions {
  llm?: LLMRouter;
}

/**
 * 管理跨会话记忆：已测项、经验模式、学习规则和压缩摘要。
 */
export class MemoryManager {
  constructor(private db: DatabaseManager) {}

  getOverview(): MemoryOverview {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

    return {
      targetCount: count('targets'),
      testedItemCount: count('memory_tested_items'),
      ruleCount: count('memory_rules'),
      patternCount: count('memory_patterns'),
      summaryCount: count('memory_session_summaries'),
    };
  }

  getTestedItems(targetId: string): TestedItem[] {
    return this.db.prepare(`
      SELECT target_id, item_key, component_id, test_type, status, last_tested_at, test_count
      FROM memory_tested_items
      WHERE target_id = ?
      ORDER BY last_tested_at DESC
    `).all(targetId).map(row => {
      const item = row as any;
      return {
        targetId: item.target_id,
        itemKey: item.item_key,
        componentId: item.component_id,
        testType: item.test_type,
        status: item.status,
        lastTestedAt: item.last_tested_at,
        testCount: item.test_count,
      };
    });
  }

  isTested(targetId: string, itemKey: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM memory_tested_items WHERE target_id = ? AND item_key = ?
    `).get(targetId, itemKey) !== undefined;
  }

  getTestedStatus(targetId: string, itemKey: string): TestedItem['status'] | null {
    const row = this.db.prepare(`
      SELECT status FROM memory_tested_items WHERE target_id = ? AND item_key = ?
    `).get(targetId, itemKey) as { status: TestedItem['status'] } | undefined;
    return row?.status ?? null;
  }

  markTested(targetId: string, item: TestedItemInput): void {
    this.db.prepare(`
      INSERT INTO memory_tested_items
        (target_id, item_key, component_id, test_type, status, last_tested_at, test_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(target_id, item_key) DO UPDATE SET
        component_id = excluded.component_id,
        test_type = excluded.test_type,
        status = excluded.status,
        last_tested_at = excluded.last_tested_at,
        test_count = memory_tested_items.test_count + 1
    `).run(
      targetId,
      item.itemKey,
      item.componentId,
      item.testType,
      item.status,
      Date.now(),
    );
  }

  savePattern(targetId: string, pattern: string, observedIn: string, reliability: number): void {
    this.db.prepare(`
      INSERT INTO memory_patterns (id, target_id, pattern, observed_in, reliability, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), targetId, pattern, observedIn, reliability, Date.now());
  }

  saveRule(targetId: string, statement: string, confidence: number): void {
    const existing = this.db.prepare(`
      SELECT id FROM memory_rules WHERE target_id = ? AND statement = ?
    `).get(targetId, statement) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE memory_rules
        SET confidence = ?, last_validated_at = ?
        WHERE id = ?
      `).run(confidence, Date.now(), existing.id);
      return;
    }

    this.db.prepare(`
      INSERT INTO memory_rules
        (id, target_id, statement, confidence, positive_count, negative_count, learned_at, last_validated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    `).run(crypto.randomUUID(), targetId, statement, confidence, Date.now(), Date.now());
  }

  getTargetMemory(targetId: string): {
    testedItems: TestedItem[];
    rules: MemoryRule[];
    patterns: MemoryPattern[];
    summaries: SessionSummary[];
  } {
    const rules = this.db.prepare(`
      SELECT id, target_id, statement, confidence, positive_count, negative_count, learned_at, last_validated_at
      FROM memory_rules WHERE target_id = ? ORDER BY learned_at DESC
    `).all(targetId).map(row => {
      const item = row as any;
      return {
        targetId: item.target_id,
        id: item.id,
        statement: item.statement,
        confidence: item.confidence,
        positiveCount: item.positive_count,
        negativeCount: item.negative_count,
        learnedAt: item.learned_at,
        lastValidatedAt: item.last_validated_at,
      };
    });

    const patterns = this.db.prepare(`
      SELECT id, target_id, pattern, observed_in, reliability, last_seen_at
      FROM memory_patterns WHERE target_id = ? ORDER BY last_seen_at DESC
    `).all(targetId).map(row => {
      const item = row as any;
      return {
        targetId: item.target_id,
        id: item.id,
        pattern: item.pattern,
        observedIn: item.observed_in,
        reliability: item.reliability,
        lastSeenAt: item.last_seen_at,
      };
    });

    const summaries = this.db.prepare(`
      SELECT id, session_id, summary_json, created_at
      FROM memory_session_summaries WHERE target_id = ? ORDER BY created_at DESC
    `).all(targetId).map(row => {
      const item = row as any;
      return {
        id: item.id,
        sessionId: item.session_id,
        targetId,
        summary: JSON.parse(item.summary_json),
        createdAt: item.created_at,
      };
    });

    return {
      testedItems: this.getTestedItems(targetId),
      rules,
      patterns,
      summaries,
    };
  }

  async compressSession(sessionId: string, options: CompressOptions = {}): Promise<SessionSummary> {
    const session = this.db.prepare(`
      SELECT id, target_id, status, phase FROM sessions WHERE id = ?
    `).get(sessionId) as { id: string; target_id: string; status: string; phase: string | null } | undefined;
    if (!session) throw new Error(`未找到测试会话：${sessionId}`);

    const logs = this.db.prepare(`
      SELECT sequence, source, log_json FROM agent_logs
      WHERE session_id = ? ORDER BY sequence ASC
    `).all(sessionId).map(row => JSON.parse((row as any).log_json));

    const testResults = this.db.prepare(`
      SELECT test_type, status, COUNT(*) AS count
      FROM test_results WHERE session_id = ?
      GROUP BY test_type, status
    `).all(sessionId);

    const bugs = this.db.prepare(`
      SELECT severity, title, description, page_url
      FROM bugs WHERE session_id = ? ORDER BY detected_at DESC
    `).all(sessionId);

    let summary: Record<string, unknown> = {
      会话: sessionId,
      状态: session.status,
      最终阶段: session.phase,
      审计日志条数: logs.length,
      测试结果统计: testResults,
      问题列表: bugs,
      结论: '已生成本地结构化摘要',
    };

    if (options.llm) {
      try {
        const raw = await options.llm.call('memory-compression', [
          {
            role: 'system',
            content: '你是 Web 测试记忆压缩器。只输出一个 JSON 对象，所有字段和值使用中文。',
          },
          {
            role: 'user',
            content: JSON.stringify({
              要求: '压缩以下测试会话，保留可继承经验、高风险路径、已知问题和后续建议。',
              会话: summary,
            }),
          },
        ]);
        summary = this.parseSummary(raw, summary);
      } catch (error) {
        summary = {
          ...summary,
          模型压缩失败原因: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const result: SessionSummary = {
      id: crypto.randomUUID(),
      sessionId,
      targetId: session.target_id,
      summary,
      createdAt: Date.now(),
    };

    this.db.prepare(`
      INSERT INTO memory_session_summaries (id, session_id, target_id, summary_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(result.id, sessionId, session.target_id, JSON.stringify(summary), result.createdAt);

    return result;
  }

  export(targetId?: string): MemoryExport {
    const where = targetId ? 'WHERE target_id = ?' : '';
    const params = targetId ? [targetId] : [];

    const testedItems = this.db.prepare(`
      SELECT target_id, item_key, component_id, test_type, status, last_tested_at, test_count
      FROM memory_tested_items ${where}
    `).all(...params).map(row => {
      const item = row as any;
      return {
        targetId: item.target_id,
        itemKey: item.item_key,
        componentId: item.component_id,
        testType: item.test_type,
        status: item.status,
        lastTestedAt: item.last_tested_at,
        testCount: item.test_count,
      };
    });

    const rules = this.db.prepare(`
      SELECT id, target_id, statement, confidence, positive_count, negative_count, learned_at, last_validated_at
      FROM memory_rules ${where}
    `).all(...params).map(row => {
      const item = row as any;
      return {
        targetId: item.target_id,
        id: item.id,
        statement: item.statement,
        confidence: item.confidence,
        positiveCount: item.positive_count,
        negativeCount: item.negative_count,
        learnedAt: item.learned_at,
        lastValidatedAt: item.last_validated_at,
      };
    });

    const patterns = this.db.prepare(`
      SELECT id, target_id, pattern, observed_in, reliability, last_seen_at
      FROM memory_patterns ${where}
    `).all(...params).map(row => {
      const item = row as any;
      return {
        targetId: item.target_id,
        id: item.id,
        pattern: item.pattern,
        observedIn: item.observed_in,
        reliability: item.reliability,
        lastSeenAt: item.last_seen_at,
      };
    });

    const summaries = this.db.prepare(`
      SELECT id, session_id, target_id, summary_json, created_at
      FROM memory_session_summaries ${where}
    `).all(...params).map(row => {
      const item = row as any;
      return {
        id: item.id,
        sessionId: item.session_id,
        targetId: item.target_id,
        summary: JSON.parse(item.summary_json),
        createdAt: item.created_at,
      };
    });

    return { format: 'wta-memory', version: 1, testedItems, rules, patterns, summaries };
  }

  import(exported: MemoryExport): number {
    let count = 0;
    for (const item of exported.testedItems) {
      this.markTested(item.targetId, item);
      count++;
    }

    const ruleInsert = this.db.prepare(`
      INSERT INTO memory_rules
        (id, target_id, statement, confidence, positive_count, negative_count, learned_at, last_validated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        target_id = excluded.target_id,
        statement = excluded.statement,
        confidence = excluded.confidence,
        positive_count = excluded.positive_count,
        negative_count = excluded.negative_count,
        learned_at = excluded.learned_at,
        last_validated_at = excluded.last_validated_at
    `);
    for (const rule of exported.rules) {
      ruleInsert.run(
        rule.id,
        rule.targetId,
        rule.statement,
        rule.confidence,
        rule.positiveCount,
        rule.negativeCount,
        rule.learnedAt,
        rule.lastValidatedAt,
      );
      count++;
    }

    const patternInsert = this.db.prepare(`
      INSERT INTO memory_patterns (id, target_id, pattern, observed_in, reliability, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        target_id = excluded.target_id,
        pattern = excluded.pattern,
        observed_in = excluded.observed_in,
        reliability = excluded.reliability,
        last_seen_at = excluded.last_seen_at
    `);
    for (const pattern of exported.patterns) {
      patternInsert.run(
        pattern.id,
        pattern.targetId,
        pattern.pattern,
        pattern.observedIn,
        pattern.reliability,
        pattern.lastSeenAt,
      );
      count++;
    }

    const summaryInsert = this.db.prepare(`
      INSERT INTO memory_session_summaries (id, session_id, target_id, summary_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        target_id = excluded.target_id,
        summary_json = excluded.summary_json,
        created_at = excluded.created_at
    `);
    for (const summary of exported.summaries) {
      summaryInsert.run(
        summary.id,
        summary.sessionId,
        summary.targetId,
        JSON.stringify(summary.summary),
        summary.createdAt,
      );
      count++;
    }
    return count;
  }

  merge(exports: MemoryExport[]): MemoryExport {
    const testedItems = new Map<string, TestedItem>();
    const rules = new Map<string, MemoryRule>();
    const patterns = new Map<string, MemoryPattern>();
    const summaries = new Map<string, SessionSummary>();

    for (const input of exports) {
      for (const item of input.testedItems) {
        const key = `${item.targetId}:${item.itemKey}`;
        const old = testedItems.get(key);
        if (!old || item.lastTestedAt > old.lastTestedAt) testedItems.set(key, item);
      }
      for (const rule of input.rules) rules.set(rule.statement, rule);
      for (const pattern of input.patterns) patterns.set(pattern.pattern, pattern);
      for (const summary of input.summaries) summaries.set(summary.sessionId, summary);
    }

    return {
      format: 'wta-memory',
      version: 1,
      testedItems: [...testedItems.values()],
      rules: [...rules.values()],
      patterns: [...patterns.values()],
      summaries: [...summaries.values()],
    };
  }

  clearTestedItems(targetId?: string): void {
    if (targetId) {
      this.db.prepare('DELETE FROM memory_tested_items WHERE target_id = ?').run(targetId);
      return;
    }
    this.db.exec('DELETE FROM memory_tested_items');
  }

  clear(targetId?: string): void {
    if (targetId) {
      this.db.prepare('DELETE FROM memory_tested_items WHERE target_id = ?').run(targetId);
      this.db.prepare('DELETE FROM memory_rules WHERE target_id = ?').run(targetId);
      this.db.prepare('DELETE FROM memory_patterns WHERE target_id = ?').run(targetId);
      this.db.prepare('DELETE FROM memory_session_summaries WHERE target_id = ?').run(targetId);
      return;
    }

    this.db.exec(`
      DELETE FROM memory_tested_items;
      DELETE FROM memory_rules;
      DELETE FROM memory_patterns;
      DELETE FROM memory_session_summaries;
    `);
  }

  private parseSummary(raw: string, fallback: Record<string, unknown>): Record<string, unknown> {
    const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : fallback;
    } catch {
      return {
        ...fallback,
        模型压缩失败原因: '模型输出不是合法 JSON，已保留本地结构化摘要',
        模型原始输出: trimmed,
      };
    }
  }

}
