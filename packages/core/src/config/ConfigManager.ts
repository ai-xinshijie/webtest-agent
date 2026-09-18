import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDefaultConfig, type AgentConfig, type TargetConfig } from './types.js';

/**
 * 加载并保存 WebTestAgent 项目配置，兼容旧版 browser 配置结构。
 */
export class ConfigManager {
  constructor(private rootDir: string) {}

  load(): AgentConfig {
    const defaults = createDefaultConfig(this.rootDir);
    const file = path.join(this.rootDir, '.wta', 'config.json');
    if (!existsSync(file)) return defaults;

    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AgentConfig> & {
      browser?: Partial<AgentConfig>;
    };
    const browser = raw.browser ?? {};
    return {
      ...defaults,
      ...raw,
      defaultBrowser: browser.defaultBrowser ?? raw.defaultBrowser ?? defaults.defaultBrowser,
      headless: browser.headless ?? raw.headless ?? defaults.headless,
      viewport: browser.viewport ?? raw.viewport ?? defaults.viewport,
      parallel: browser.parallel ?? raw.parallel ?? defaults.parallel,
      models: {
        ...defaults.models,
        ...(raw.models ?? {}),
      },
    };
  }

  save(config: AgentConfig): void {
    const dir = path.join(this.rootDir, '.wta');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
  }

  listTargets(): TargetConfig[] {
    const dir = path.join(this.rootDir, '.wta', 'targets');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(readFileSync(path.join(dir, file), 'utf-8')) as TargetConfig)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  loadTarget(name: string): TargetConfig {
    const file = path.join(this.rootDir, '.wta', 'targets', `${name}.json`);
    if (!existsSync(file)) throw new Error(`未找到测试目标：${name}`);
    return JSON.parse(readFileSync(file, 'utf-8')) as TargetConfig;
  }

  saveTarget(target: TargetConfig): void {
    const dir = path.join(this.rootDir, '.wta', 'targets');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${target.name}.json`),
      JSON.stringify(target, null, 2),
      'utf-8',
    );
  }
}
