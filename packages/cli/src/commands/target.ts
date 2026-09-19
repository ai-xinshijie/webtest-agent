import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TargetConfig } from '@wta/core';

const STRATEGIES = ['quick', 'standard', 'deep'] as const;

function targetsDir(): string {
  return path.join(process.cwd(), '.wta', 'targets');
}

function parseStrategy(value: string | undefined): typeof STRATEGIES[number] {
  const strategy = value ?? 'deep';
  if (!STRATEGIES.includes(strategy as typeof STRATEGIES[number])) {
    throw new Error(`无效测试深度：${strategy}，可选值：${STRATEGIES.join('、')}`);
  }
  return strategy as typeof STRATEGIES[number];
}

export const targetCommand = new Command('target')
  .description('管理测试目标');

targetCommand
  .command('add')
  .description('添加测试目标')
  .requiredOption('--name <name>', '测试目标名称')
  .requiredOption('--url <url>', '测试目标地址')
  .requiredOption('--username <username>', '登录用户名')
  .requiredOption('--password <password>', '登录密码')
    .option('--strategy <strategy>', '测试深度：quick、standard、deep')
  .action((options: {
    name: string;
    url: string;
    username: string;
    password: string;
    strategy?: string;
  }) => {
    const directory = targetsDir();
    if (!existsSync(directory)) {
      throw new Error('项目尚未初始化，请先执行：wta init');
    }

    const file = path.join(directory, `${options.name}.json`);
    if (existsSync(file)) {
      throw new Error(`测试目标已存在：${options.name}`);
    }

    const target: TargetConfig = {
      name: options.name,
      url: options.url,
      credentials: {
        username: options.username,
        password: options.password,
      },
      strategy: {
        runMode: 'continue',
        depth: parseStrategy(options.strategy),
        maxDuration: 86400,
        maxPages: options.strategy === 'quick' ? 50 : options.strategy === 'standard' ? 120 : 300,
        parallel: 1,
        screenshot: 'always',
        video: true,
        headless: 'auto',
      },
      scope: {
        includePaths: [],
        excludePaths: [],
      },
    };

    writeFileSync(file, JSON.stringify(target, null, 2), 'utf-8');
    console.log(`测试目标已添加：${options.name}`);
    console.log(`  地址：${options.url}`);
    console.log(`  文件：${file}`);
  });

targetCommand
  .command('list')
  .description('列出全部测试目标')
  .action(() => {
    const directory = targetsDir();
    if (!existsSync(directory)) {
      console.log('项目尚未初始化，请先执行：wta init');
      return;
    }

    const files = readdirSync(directory).filter(file => file.endsWith('.json'));
    if (files.length === 0) {
      console.log('当前没有测试目标');
      return;
    }

    console.log('测试目标：');
    for (const file of files) {
      const target = JSON.parse(readFileSync(path.join(directory, file), 'utf-8')) as TargetConfig;
      console.log(`  ${target.name.padEnd(20)} ${target.url}`);
    }
  });

targetCommand
  .command('show <name>')
  .description('查看测试目标详情')
  .action((name: string) => {
    const file = path.join(targetsDir(), `${name}.json`);
    if (!existsSync(file)) {
      throw new Error(`未找到测试目标：${name}`);
    }
    console.log(readFileSync(file, 'utf-8'));
  });

targetCommand
  .command('remove <name>')
  .description('移除测试目标')
  .action((name: string) => {
    const file = path.join(targetsDir(), `${name}.json`);
    if (!existsSync(file)) {
      throw new Error(`未找到测试目标：${name}`);
    }
    unlinkSync(file);
    console.log(`测试目标已移除：${name}`);
  });
