import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { ConfigManager, DatabaseManager, MemoryManager, type MemoryExport } from '@wta/core';

function createManager() {
  const config = new ConfigManager(process.cwd()).load();
  return new MemoryManager(new DatabaseManager(config.dbPath));
}

export const memoryCommand = new Command('memory')
  .description('管理跨会话测试记忆');

memoryCommand
  .command('show')
  .description('查看记忆概览')
  .option('--app <app>', '指定测试目标')
  .action((options: { app?: string }) => {
    const manager = createManager();
    if (options.app) {
      const memory = manager.getTargetMemory(options.app);
      console.log(`测试目标：${options.app}`);
      console.log(`  已测项：${memory.testedItems.length}`);
      console.log(`  学习规则：${memory.rules.length}`);
      console.log(`  经验模式：${memory.patterns.length}`);
      console.log(`  会话摘要：${memory.summaries.length}`);
      return;
    }

    const overview = manager.getOverview();
    console.log(`测试目标：${overview.targetCount}`);
    console.log(`已测项：${overview.testedItemCount}`);
    console.log(`学习规则：${overview.ruleCount}`);
    console.log(`经验模式：${overview.patternCount}`);
    console.log(`会话摘要：${overview.summaryCount}`);
  });

memoryCommand
  .command('export')
  .description('导出记忆')
  .requiredOption('-o <file>', '输出 JSON 文件')
  .option('--app <app>', '指定测试目标')
  .action((options: { o: string; app?: string }) => {
    const data = createManager().export(options.app);
    writeFileSync(options.o, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`记忆已导出：${options.o}`);
  });

memoryCommand
  .command('import <file>')
  .description('导入记忆')
  .action((file: string) => {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as MemoryExport;
    const count = createManager().import(data);
    console.log(`已导入 ${count} 条已测项记忆`);
  });

memoryCommand
  .command('merge <files...>')
  .description('合并多个记忆文件')
  .requiredOption('-o <file>', '输出 JSON 文件')
  .action((files: string[], options: { o: string }) => {
    const inputs = files.map(file => JSON.parse(readFileSync(file, 'utf-8')) as MemoryExport);
    const merged = createManager().merge(inputs);
    writeFileSync(options.o, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`记忆已合并：${options.o}`);
  });

memoryCommand
  .command('clear')
  .description('清除记忆')
  .option('--app <app>', '指定测试目标')
  .option('--all', '清除全部记忆')
  .action((options: { app?: string; all?: boolean }) => {
    if (!options.app && !options.all) {
      throw new Error('必须指定 --app <app> 或 --all');
    }
    createManager().clear(options.app);
    console.log(options.app ? `已清除 ${options.app} 的记忆` : '已清除全部记忆');
  });
