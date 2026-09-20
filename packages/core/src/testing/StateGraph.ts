import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseManager } from '../db/Database.js';
import type { StructuredObservation } from '../perception/types.js';

export interface StateNode {
  id: string;
  fingerprint: string;
  summary: Record<string, unknown>;
}

export interface StateTransition {
  id: string;
  fromStateId: string;
  toStateId: string;
  action: string;
  status: 'passed' | 'failed';
}

/**
 * 将页面观察压缩为可持久化状态节点，以状态迁移而非单个控件动作衡量测试进度。
 */
export class StateGraph {
  constructor(private db: DatabaseManager) {}

  observe(targetId: string, pageId: string, observation: StructuredObservation): StateNode {
    const summary = this.summarize(observation);
    const fingerprint = this.fingerprint(summary);
    const existing = this.db.prepare(`
      SELECT id, fingerprint, summary_json FROM state_nodes
      WHERE target_id = ? AND page_id = ? AND fingerprint = ?
    `).get(targetId, pageId, fingerprint) as { id: string; fingerprint: string; summary_json: string } | undefined;
    if (existing) {
      this.db.prepare('UPDATE state_nodes SET last_seen_at = ?, visit_count = visit_count + 1 WHERE id = ?')
        .run(Date.now(), existing.id);
      return { id: existing.id, fingerprint, summary: JSON.parse(existing.summary_json) };
    }

    const node: StateNode = { id: randomUUID(), fingerprint, summary };
    this.db.prepare(`
      INSERT INTO state_nodes
        (id, target_id, page_id, fingerprint, summary_json, first_seen_at, last_seen_at, visit_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(node.id, targetId, pageId, fingerprint, JSON.stringify(summary), Date.now(), Date.now());
    return node;
  }

  recordTransition(input: {
    sessionId: string; targetId: string; from: StateNode; to: StateNode; componentId: string; action: string; status: 'passed' | 'failed'; evidence: Record<string, unknown>;
  }): StateTransition {
    const transition: StateTransition = {
      id: randomUUID(), fromStateId: input.from.id, toStateId: input.to.id, action: input.action, status: input.status,
    };
    this.db.prepare(`
      INSERT INTO state_transitions
        (id, session_id, target_id, from_state_id, to_state_id, component_id, action_type, status, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transition.id, input.sessionId, input.targetId, transition.fromStateId, transition.toStateId, input.componentId,
      input.action, input.status, JSON.stringify(input.evidence), Date.now(),
    );
    return transition;
  }

  private summarize(observation: StructuredObservation): Record<string, unknown> {
    return {
      url: observation.url,
      title: observation.title,
      dialogs: observation.dialogCount,
      loading: observation.loadingOverlayCount,
      components: observation.components.map(component => ({
        selector: component.selector ?? component.tag,
        role: component.role,
        visible: component.state?.visible ?? true,
        enabled: component.state?.enabled ?? true,
        value: component.value ?? '',
        validation: component.validationMessage ?? '',
      })).sort((a, b) => a.selector.localeCompare(b.selector)),
    };
  }

  private fingerprint(summary: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(summary)).digest('hex');
  }
}
