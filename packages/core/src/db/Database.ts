import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id),
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  phase TEXT,
  progress_json TEXT,
  checkpoint_json TEXT
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  url_pattern TEXT NOT NULL,
  title TEXT,
  role TEXT,
  first_seen_at INTEGER,
  last_visited_at INTEGER,
  visit_count INTEGER DEFAULT 0,
  test_status TEXT DEFAULT 'untested',
  UNIQUE(target_id, url_pattern)
);

CREATE TABLE IF NOT EXISTS components (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  type TEXT NOT NULL,
  selector TEXT NOT NULL,
  label TEXT,
  state_json TEXT,
  constraints_json TEXT,
  parent_id TEXT REFERENCES components(id),
  confidence REAL,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(id),
  action_type TEXT NOT NULL,
  preconditions_json TEXT,
  expected_effects_json TEXT,
  side_effects_json TEXT
);

CREATE TABLE IF NOT EXISTS navigation_edges (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  from_page_id TEXT NOT NULL REFERENCES pages(id),
  to_page_id TEXT NOT NULL REFERENCES pages(id),
  trigger_component_id TEXT REFERENCES components(id),
  method TEXT
);

CREATE TABLE IF NOT EXISTS test_results (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  component_id TEXT,
  test_type TEXT NOT NULL,
  status TEXT NOT NULL,
  rule_id TEXT,
  input_json TEXT,
  output_json TEXT,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS bugs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  target_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  page_url TEXT,
  component_id TEXT,
  rule_id TEXT,
  reproduction_json TEXT,
  expected TEXT,
  actual TEXT,
  evidence_json TEXT,
  detected_at INTEGER NOT NULL,
  status TEXT DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS navigation_macros (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  url TEXT,
  selector TEXT,
  cached_at INTEGER NOT NULL,
  valid INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS compiled_test_cases (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  test_type TEXT NOT NULL,
  navigation_macro_id TEXT REFERENCES navigation_macros(id),
  actions_json TEXT NOT NULL,
  assertions_json TEXT NOT NULL,
  timeout INTEGER DEFAULT 30000,
  last_passed_at INTEGER,
  execute_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS component_signatures (
  id TEXT PRIMARY KEY,
  component_name TEXT NOT NULL,
  dom_pattern TEXT,
  a11y_pattern TEXT,
  visual_pattern TEXT,
  confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'learned',
  observed_in TEXT,
  usage_count INTEGER DEFAULT 0,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS memory_tested_items (
  target_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  component_id TEXT NOT NULL,
  test_type TEXT NOT NULL,
  status TEXT NOT NULL,
  last_tested_at INTEGER NOT NULL,
  test_count INTEGER DEFAULT 1,
  PRIMARY KEY (target_id, item_key)
);

CREATE TABLE IF NOT EXISTS memory_rules (
  id TEXT PRIMARY KEY,
  target_id TEXT,
  statement TEXT NOT NULL,
  confidence REAL NOT NULL,
  positive_count INTEGER DEFAULT 0,
  negative_count INTEGER DEFAULT 0,
  learned_at INTEGER,
  last_validated_at INTEGER
);

CREATE TABLE IF NOT EXISTS memory_patterns (
  id TEXT PRIMARY KEY,
  target_id TEXT,
  pattern TEXT NOT NULL,
  observed_in TEXT,
  reliability REAL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS memory_session_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_files (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  bug_id TEXT,
  file_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  timestamp INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  source TEXT NOT NULL,
  log_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_components_page ON components(page_id);
DELETE FROM components WHERE id NOT IN (
  SELECT MIN(id) FROM components GROUP BY target_id, page_id, selector
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_components_unique ON components(target_id, page_id, selector);
CREATE INDEX IF NOT EXISTS idx_components_target ON components(target_id);
CREATE INDEX IF NOT EXISTS idx_test_results_session ON test_results(session_id);
CREATE INDEX IF NOT EXISTS idx_bugs_session ON bugs(session_id);
CREATE INDEX IF NOT EXISTS idx_bugs_target ON bugs(target_id);
DELETE FROM navigation_edges WHERE id NOT IN (
  SELECT MIN(id) FROM navigation_edges GROUP BY target_id, from_page_id, to_page_id, method
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_navigation_edges_unique ON navigation_edges(target_id, from_page_id, to_page_id, method);
CREATE INDEX IF NOT EXISTS idx_memory_tested ON memory_tested_items(target_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_session ON agent_logs(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_logs_source ON agent_logs(session_id, source);
`;

export class DatabaseManager {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  exec(sql: string) {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}
