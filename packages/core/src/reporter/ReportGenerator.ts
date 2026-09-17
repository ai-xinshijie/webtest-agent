import type { DatabaseManager } from '../db/Database.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface ReportOptions {
  outputDir: string;
  format: 'md' | 'json';
}

/**
 * Generate test reports in Markdown and JSON formats.
 */
export class ReportGenerator {
  constructor(
    private db: DatabaseManager,
    private options: ReportOptions,
  ) {}

  /**
   * Generate a report for a test session.
   */
  generate(sessionId: string): string {
    const session = this.db.prepare(`
      SELECT s.*, t.name as target_name, t.url as target_url
      FROM sessions s JOIN targets t ON s.target_id = t.id
      WHERE s.id = ?
    `).get(sessionId) as any;

    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const pages = this.db.prepare(`
      SELECT * FROM pages WHERE target_id = ?
    `).all(session.target_id) as any[];

    const components = this.db.prepare(`
      SELECT * FROM components WHERE target_id = ?
    `).all(session.target_id) as any[];

    const bugs = this.db.prepare(`
      SELECT * FROM bugs WHERE session_id = ?
    `).all(sessionId) as any[];

    const testResults = this.db.prepare(`
      SELECT * FROM test_results WHERE session_id = ?
    `).all(sessionId) as any[];

    if (this.options.format === 'json') {
      return this.generateJSON(session, pages, components, bugs, testResults);
    }
    return this.generateMarkdown(session, pages, components, bugs, testResults);
  }

  private generateMarkdown(
    session: any,
    pages: any[],
    components: any[],
    bugs: any[],
    testResults: any[],
  ): string {
    const duration = session.ended_at ? ((session.ended_at - session.started_at) / 1000).toFixed(1) : 'N/A';
    const reportTime = new Date().toISOString();

    let md = `# WebTestAgent Report

## Summary

| Metric | Value |
|--------|-------|
| Target | ${session.target_name} (${session.target_url}) |
| Session | ${session.id} |
| Status | ${session.status} |
| Duration | ${duration}s |
| Pages Visited | ${pages.length} |
| Components Found | ${components.length} |
| Tests Executed | ${testResults.length} |
| Bugs Found | ${bugs.length} |
| Generated | ${reportTime} |

## Coverage

### Pages (${pages.length})

`;

    for (const page of pages) {
      md += `- **${page.title || 'Untitled'}**: \`${page.url_pattern}\` (${page.test_status})\n`;
    }

    md += `\n### Component Types\n\n`;

    const typeCounts = new Map<string, number>();
    for (const c of components) {
      typeCounts.set(c.type, (typeCounts.get(c.type) || 0) + 1);
    }
    for (const [type, count] of typeCounts) {
      md += `- ${type}: ${count}\n`;
    }

    if (bugs.length > 0) {
      md += `\n## Bugs (${bugs.length})\n\n`;

      for (let i = 0; i < bugs.length; i++) {
        const bug = bugs[i];
        md += `### Bug #${i + 1}: ${bug.title}

- **Severity**: ${bug.severity}
- **Rule**: ${bug.rule_id || 'N/A'}
- **Page**: ${bug.page_url || 'N/A'}
- **Description**: ${bug.description || 'N/A'}
- **Detected**: ${new Date(bug.detected_at).toISOString()}

`;
      }
    } else {
      md += `\n## Bugs\n\nNo bugs found. 🎉\n\n`;
    }

    if (testResults.length > 0) {
      md += `## Test Results (${testResults.length})\n\n| Test | Status | Duration |\n|------|--------|----------|\n`;
      for (const tr of testResults) {
        md += `| ${tr.test_type} | ${tr.status} | ${tr.duration_ms}ms |\n`;
      }
    }

    return md;
  }

  private generateJSON(
    session: any,
    pages: any[],
    components: any[],
    bugs: any[],
    testResults: any[],
  ): string {
    return JSON.stringify({
      session: {
        id: session.id,
        target: session.target_name,
        url: session.target_url,
        status: session.status,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        duration: session.ended_at ? session.ended_at - session.started_at : null,
      },
      coverage: {
        pagesVisited: pages.length,
        componentsFound: components.length,
        componentTypes: components.reduce((acc: Record<string, number>, c: any) => {
          acc[c.type] = (acc[c.type] || 0) + 1;
          return acc;
        }, {}),
      },
      bugs: bugs.map(b => ({
        id: b.id,
        severity: b.severity,
        title: b.title,
        description: b.description,
        pageUrl: b.page_url,
        ruleId: b.rule_id,
        detectedAt: b.detected_at,
      })),
      testResults: testResults.map(tr => ({
        testType: tr.test_type,
        status: tr.status,
        durationMs: tr.duration_ms,
        input: tr.input_json ? JSON.parse(tr.input_json) : null,
      })),
    }, null, 2);
  }

  /**
   * Save report to file.
   */
  save(sessionId: string, filename?: string): string {
    const content = this.generate(sessionId);
    const ext = this.options.format === 'json' ? 'json' : 'md';
    const defaultName = `report-${sessionId.slice(0, 8)}.${ext}`;
    const outputPath = path.join(this.options.outputDir, filename ?? defaultName);

    const dir = path.dirname(outputPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, content, 'utf-8');

    console.log(`Report saved: ${outputPath}`);
    return outputPath;
  }
}
