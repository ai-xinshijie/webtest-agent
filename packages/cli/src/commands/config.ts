import { Command } from 'commander';
import { ConfigManager, type AgentConfig } from '@wta/core';

function manager() {
  return new ConfigManager(process.cwd());
}

function readPath(config: AgentConfig, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => {
    if (value && typeof value === 'object') return (value as Record<string, unknown>)[part];
    return undefined;
  }, config);
}

function writePath(config: AgentConfig, key: string, value: unknown): void {
  const parts = key.split('.');
  let current = config as unknown as Record<string, unknown>;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index]!;
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

export const configCommand = new Command('config')
  .description('管理全局配置');

configCommand
  .command('show')
  .description('查看全部配置')
  .action(() => {
    console.log(JSON.stringify(manager().load(), null, 2));
  });

configCommand
  .command('get <key>')
  .description('查看配置项')
  .action((key: string) => {
    console.log(JSON.stringify(readPath(manager().load(), key), null, 2));
  });

configCommand
  .command('set <key> <value>')
  .description('设置配置项')
  .action((key: string, value: string) => {
    const configManager = manager();
    const config = configManager.load();
    let parsed: unknown = value;
    if (value === 'true') parsed = true;
    else if (value === 'false') parsed = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) parsed = Number(value);
    writePath(config, key, parsed);
    configManager.save(config);
    console.log(`配置已更新：${key}`);
  });
