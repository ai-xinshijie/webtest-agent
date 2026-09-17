import { Command } from 'commander';
import { writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const targetCommand = new Command('target')
  .description('Manage test targets');

targetCommand
  .command('add')
  .description('Add a new test target')
  .requiredOption('--name <name>', 'target name')
  .requiredOption('--url <url>', 'target URL')
  .requiredOption('--username <username>', 'login username')
  .requiredOption('--password <password>', 'login password')
  .option('--strategy <strategy>', 'test strategy: quick|standard|deep', 'deep')
  .action((options: {
    name: string;
    url: string;
    username: string;
    password: string;
    strategy?: string;
  }) => {
    const cwd = process.cwd();
    const targetsDir = path.join(cwd, '.wta', 'targets');

    if (!existsSync(targetsDir)) {
      console.error('Project not initialized. Run: wta init');
      process.exit(1);
    }

    const targetFile = path.join(targetsDir, `${options.name}.json`);
    if (existsSync(targetFile)) {
      console.error(`Target already exists: ${options.name}`);
      process.exit(1);
    }

    const targetConfig = {
      name: options.name,
      url: options.url,
      credentials: {
        username: options.username,
        password: options.password,
      },
      strategy: {
        runMode: 'continue',
        depth: options.strategy ?? 'deep',
        maxDuration: 86400,
        maxPages: 200,
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

    writeFileSync(targetFile, JSON.stringify(targetConfig, null, 2));
    console.log(`Target added: ${options.name}`);
    console.log(`  URL: ${options.url}`);
    console.log(`  File: ${targetFile}`);
  });

targetCommand
  .command('list')
  .description('List all targets')
  .action(() => {
    const cwd = process.cwd();
    const targetsDir = path.join(cwd, '.wta', 'targets');

    if (!existsSync(targetsDir)) {
      console.log('No targets. Run: wta target add');
      return;
    }

    const files = readdirSync(targetsDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      console.log('No targets found.');
      return;
    }

    console.log('\nTargets:\n');
    for (const file of files) {
      const content = JSON.parse(readFileSync(path.join(targetsDir, file), 'utf-8'));
      console.log(`  ${content.name.padEnd(20)} ${content.url}`);
    }
  });

targetCommand
  .command('remove <name>')
  .description('Remove a target')
  .action((name: string) => {
    const cwd = process.cwd();
    const targetFile = path.join(cwd, '.wta', 'targets', `${name}.json`);
    if (!existsSync(targetFile)) {
      console.error(`Target not found: ${name}`);
      process.exit(1);
    }
    const { unlinkSync } = require('node:fs');
    unlinkSync(targetFile);
    console.log(`Target removed: ${name}`);
  });
