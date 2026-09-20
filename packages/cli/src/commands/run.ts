import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TargetConfig } from '@wta/core';
import { ensureDaemon } from './daemon.js';

const RUN_MODES = ['continue', 'fresh', 'retest', 'expand', 'regression'] as const;
const PHASES = ['explore', 'test', 'combo', 'chaos'] as const;

type RunMode = typeof RUN_MODES[number];
type Phase = typeof PHASES[number];

interface RunOptions {
  mode?: string;
  phase?: string;
  headed?: boolean;
  headless?: boolean;
  parallel?: string;
  maxTime?: string;
  resume?: boolean;
  foreground?: boolean;
}

function loadTarget(targetName: string): TargetConfig {
  const file = path.join(process.cwd(), '.wta', 'targets', `${targetName}.json`);
  if (!existsSync(file)) {
    throw new Error(`未找到测试目标：${targetName}，期望路径：${file}`);
  }
  return JSON.parse(readFileSync(file, 'utf-8')) as TargetConfig;
}

function parseMode(value: string | undefined): RunMode {
  const mode = value ?? 'continue';
  if (!RUN_MODES.includes(mode as RunMode)) {
    throw new Error(`无效运行模式：${mode}，可选值：${RUN_MODES.join('、')}`);
  }
  return mode as RunMode;
}

function parsePhase(value: string | undefined): Phase | undefined {
  if (!value) return undefined;
  if (!PHASES.includes(value as Phase)) {
    throw new Error(`无效测试阶段：${value}，可选值：${PHASES.join('、')}`);
  }
  return value as Phase;
}

function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(value.trim());
  if (!match) throw new Error(`无效最大运行时长：${value}，示例：90s、30m、4h`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const seconds = Math.floor(amount * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1));
  if (seconds <= 0) throw new Error('最大运行时长必须大于 0');
  return seconds;
}

export const runCommand = new Command('run')
  .description('启动测试会话，默认提交给常驻代理后台执行')
  .argument('<target>', '测试目标名称')
  .option('--mode <mode>', '运行模式：continue、fresh、retest、expand、regression')
  .option('--phase <phase>', '测试阶段：explore、test、combo、chaos')
  .option('--headed', '有头模式运行浏览器')
  .option('--headless', '无头模式运行浏览器')
  .option('--parallel <n>', '并行浏览器数量')
  .option('--max-time <time>', '最大运行时长，例如 4h')
  .option('--resume', '恢复上一次会话')
  .option('--foreground', '前台执行，不提交给常驻代理')
  .action(async (targetName: string, options: RunOptions) => {
    try {
      const target = loadTarget(targetName);
      const mode = parseMode(options.mode);
      const phase = parsePhase(options.phase);
      const parallel = Math.max(1, Math.min(Number(options.parallel ?? '1'), 8));
      const headless = options.headless ?? !options.headed;
      const maxDuration = parseDuration(options.maxTime);

      console.log(`启动测试：${target.name}`);
      console.log(`  地址：${target.url}`);
      console.log(`  模式：${mode}`);
      console.log(`  阶段：${phase ?? '全部'}`);
      console.log(`  并行：${parallel}`);
      if (maxDuration) console.log(`  最大时长：${maxDuration} 秒`);

      if (options.foreground) {
        const { Orchestrator, ConfigManager } = await import('@wta/core');
        const config = new ConfigManager(process.cwd()).load();
        const orchestrator = new Orchestrator(config);
        const session = await orchestrator.run(target, {
          runMode: mode,
          phase,
          parallel,
          headless,
          resumeSessionId: undefined,
          maxDuration,
        });

        console.log(`会话完成：${session.id}`);
        console.log(`  状态：${session.status}`);
        console.log(`  报告：${session.reportPaths?.join('、') ?? '未生成'}`);
        process.exit(session.status === 'failed' ? 1 : 0);
        return;
      }

      const baseUrl = await ensureDaemon();
      const response = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: target.name,
          mode,
          phase,
          parallel,
          headless,
          resume: Boolean(options.resume),
          maxDuration,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`提交测试失败：${response.status} ${text}`);
      }

      const result = await response.json() as { sessionId: string };
      console.log(`测试已提交：${result.sessionId}`);
      console.log(`查看进度：wta attach ${result.sessionId}`);
      console.log(`GUI 监控：${baseUrl}/?session=${result.sessionId}`);
    } catch (error) {
      console.error(`测试启动失败：${error instanceof Error ? error.message : error}`);
      process.exit(2);
    }
  });
