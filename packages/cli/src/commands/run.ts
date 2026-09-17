import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createDefaultConfig } from '@wta/core';
import type { TargetConfig } from '@wta/core';

export const runCommand = new Command('run')
  .description('Start a test session')
  .argument('<target>', 'target name')
  .option('--mode <mode>', 'run mode: continue|fresh|retest|expand|regression', 'continue')
  .option('--phase <phase>', 'specific phase: explore|test|combo|chaos')
  .option('--headed', 'run browser in headed mode')
  .option('--headless', 'run browser in headless mode')
  .option('--parallel <n>', 'parallel browser count', '1')
  .option('--max-time <time>', 'max duration (e.g. 4h)')
  .option('--resume', 'resume from last checkpoint')
  .option('--foreground', 'run in foreground (print output)')
  .action(async (targetName: string, options: {
    mode?: string;
    phase?: string;
    headed?: boolean;
    headless?: boolean;
    parallel?: string;
    maxTime?: string;
    resume?: boolean;
    foreground?: boolean;
  }) => {
    const cwd = process.cwd();
    const jsonFile = path.join(cwd, '.wta', 'targets', `${targetName}.json`);

    if (!existsSync(jsonFile)) {
      console.error(`Target not found: ${targetName}`);
      console.error(`Expected: ${jsonFile}`);
      process.exit(1);
    }

    let targetConfig: TargetConfig;
    try {
      const raw = readFileSync(jsonFile, 'utf-8');
      targetConfig = JSON.parse(raw) as TargetConfig;
    } catch {
      console.error(`Failed to parse target config: ${jsonFile}`);
      process.exit(1);
    }

    console.log(`Starting test: ${targetName}`);
    console.log(`  URL: ${targetConfig.url}`);
    console.log(`  Mode: ${options.mode}`);
    console.log(`  Phase: ${options.phase ?? 'all'}`);

    const { Orchestrator } = await import('@wta/core');
    const config = createDefaultConfig(cwd);
    const orchestrator = new Orchestrator(config);

    try {
      const session = await orchestrator.run(targetConfig, {
        runMode: options.mode,
        phase: options.phase,
        headless: options.headless ?? !options.headed,
        parallel: parseInt(options.parallel ?? '1', 10),
      });

      console.log(`Session ${session.id} completed`);
      console.log(`  Status: ${session.status}`);
      console.log(`  Duration: ${((session.endedAt! - session.startedAt) / 1000).toFixed(1)}s`);

      if (session.status === 'failed') {
        process.exit(1);
      }
    } catch (error) {
      console.error('Test failed:', error instanceof Error ? error.message : error);
      process.exit(2);
    }
  });
