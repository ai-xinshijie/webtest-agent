import { Command } from 'commander';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseManager, ReportGenerator } from '@wta/core';

export const reportCommand = new Command('report')
  .description('管理测试报告');

reportCommand
  .command('list')
  .description('列出全部测试报告')
  .action(() => {
    const cwd = process.cwd();
    const dbPath = path.join(cwd, '.wta', 'wta.db');

    if (!existsSync(dbPath)) {
      console.log('未找到测试数据库，请先执行：wta init && wta run <target>');
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
      console.log('暂无测试会话，请先执行：wta run <target>');
      db.close();
      return;
    }

    console.log('测试会话：');
    for (const session of sessions) {
      const duration = session.ended_at
        ? `${((session.ended_at - session.started_at) / 1000).toFixed(1)}秒`
        : '运行中';
      console.log(`  ${session.id.slice(0, 8)}  ${session.target_name.padEnd(15)} ${session.status.padEnd(10)} ${duration}`);
    }

    if (existsSync(reportsDir)) {
      const files = readdirSync(reportsDir).filter(file => file.endsWith('.md') || file.endsWith('.json'));
      if (files.length > 0) {
        console.log('报告文件：');
        for (const file of files) {
          console.log(`  ${path.join(reportsDir, file)}`);
        }
      }
    }
    db.close();
  });

reportCommand
  .command('show <sessionId>')
  .description('查看指定会话的 Markdown 报告')
  .action((sessionId: string) => {
    const cwd = process.cwd();
    const dbPath = path.join(cwd, '.wta', 'wta.db');

    if (!existsSync(dbPath)) {
      console.error('未找到测试数据库，请先执行：wta init && wta run <target>');
      process.exit(1);
    }

    const db = new DatabaseManager(dbPath);
    try {
      const reporter = new ReportGenerator(db, {
        outputDir: path.join(cwd, '.wta', 'reports'),
        format: 'md',
      });
      console.log(reporter.generate(sessionId));
    } catch (error) {
      console.error(`报告生成失败：${error instanceof Error ? error.message : error}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

reportCommand
  .command('export <sessionId>')
  .description('导出指定会话报告')
  .requiredOption('--format <format>', '输出格式：md 或 json')
  .option('-o, --output <file>', '输出文件路径')
  .action((sessionId: string, options: { format: string; output?: string }) => {
    const cwd = process.cwd();
    const dbPath = path.join(cwd, '.wta', 'wta.db');

    if (!existsSync(dbPath)) {
      console.error('未找到测试数据库，请先执行：wta init && wta run <target>');
      process.exit(1);
    }

    if (!['md', 'json'].includes(options.format)) {
      console.error(`无效报告格式：${options.format}，请使用 md 或 json`);
      process.exit(1);
    }

    const db = new DatabaseManager(dbPath);
    try {
      const reporter = new ReportGenerator(db, {
        outputDir: path.join(cwd, '.wta', 'reports'),
        format: options.format as 'md' | 'json',
      });
      const outputPath = reporter.save(sessionId, options.output);
      console.log(`报告已导出：${outputPath}`);
    } catch (error) {
      console.error(`报告导出失败：${error instanceof Error ? error.message : error}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });
