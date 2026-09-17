import { Command } from 'commander';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseManager, ReportGenerator } from '@wta/core';

export const reportCommand = new Command('report')
  .description('Manage test reports');

reportCommand
  .command('list')
  .description('List all test reports')
  .action(() => {
    const cwd = process.cwd();
    const dbPath = path.join(cwd, '.wta', 'wta.db');

    if (!existsSync(dbPath)) {
      console.log('No database found. Run: wta init && wta run <target>');
      return;
    }

    const db = new DatabaseManager(dbPath);
    const reportsDir = path.join(cwd, '.wta', 'reports');

    const sessions = db.prepare(`
      SELECT s.id, s.status, s.started_at, s.ended_at, t.name as target_name
      FROM sessions s JOIN targets t ON s.target_id = t.id
      ORDER BY s.started_at DESC
    `).all() as any[];

    if (sessions.length === 0) {
      console.log('No test sessions found.');
      return;
    }

    console.log('\nTest Sessions:\n');
    for (const session of sessions) {
      const duration = session.ended_at
        ? ((session.ended_at - session.started_at) / 1000).toFixed(1) + 's'
        : 'running';
      console.log(`  ${session.id.slice(0, 8)}  ${session.target_name.padEnd(15)} ${session.status.padEnd(10)} ${duration}`);
    }

    // Check for existing report files
    if (existsSync(reportsDir)) {
      const files = readdirSync(reportsDir).filter(f => f.endsWith('.md') || f.endsWith('.json'));
      if (files.length > 0) {
        console.log('\nReport Files:\n');
        for (const file of files) {
          console.log(`  ${path.join(reportsDir, file)}`);
        }
      }
    }
  });

reportCommand
  .command('show <sessionId>')
  .description('Show report for a session')
  .action((sessionId: string) => {
    const cwd = process.cwd();
    const dbPath = path.join(cwd, '.wta', 'wta.db');

    if (!existsSync(dbPath)) {
      console.error('No database found. Run: wta init && wta run <target>');
      process.exit(1);
    }

    const db = new DatabaseManager(dbPath);

    try {
      const reporter = new ReportGenerator(db, { outputDir: path.join(cwd, '.wta', 'reports'), format: 'md' });
      const content = reporter.generate(sessionId);
      console.log(content);
    } catch (error) {
      console.error(`Failed to generate report: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

reportCommand
  .command('export <sessionId>')
  .description('Export report to file')
  .requiredOption('--format <format>', 'output format: md|json')
  .option('-o, --output <file>', 'output file path')
  .action((sessionId: string, options: { format: string; output?: string }) => {
    const cwd = process.cwd();
    const dbPath = path.join(cwd, '.wta', 'wta.db');

    if (!existsSync(dbPath)) {
      console.error('No database found. Run: wta init && wta run <target>');
      process.exit(1);
    }

    if (!['md', 'json'].includes(options.format)) {
      console.error(`Invalid format: ${options.format}. Use: md or json`);
      process.exit(1);
    }

    const db = new DatabaseManager(dbPath);

    try {
      const reporter = new ReportGenerator(db, {
        outputDir: path.join(cwd, '.wta', 'reports'),
        format: options.format as 'md' | 'json',
      });
      const outputPath = reporter.save(sessionId, options.output);
      console.log(`Report exported to: ${outputPath}`);
    } catch (error) {
      console.error(`Failed to export report: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });
