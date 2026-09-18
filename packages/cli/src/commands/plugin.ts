import { Command } from 'commander';
import path from 'node:path';
import { PluginManager } from '@wta/core';

function createManager() {
  return new PluginManager(path.join(process.cwd(), '.wta', 'plugins'));
}

export const pluginCommand = new Command('plugin')
  .description('管理本地插件');

pluginCommand
  .command('list')
  .description('列出已安装插件')
  .action(async () => {
    const plugins = createManager().list();
    if (plugins.length === 0) {
      console.log('当前没有插件');
      return;
    }
    for (const plugin of plugins) {
      console.log(`${plugin.enabled ? '启用' : '停用'}  ${plugin.name}@${plugin.version}  工具 ${plugin.toolCount} 个`);
    }
  });

pluginCommand
  .command('install <source>')
  .description('安装本地目录或 Git 插件')
  .action((source: string) => {
    const destination = createManager().install(source);
    console.log(`插件已安装：${destination}`);
  });

pluginCommand
  .command('create <name>')
  .description('创建插件脚手架')
  .action((name: string) => {
    const destination = createManager().create(name);
    console.log(`插件已创建：${destination}`);
    console.log('进入插件目录后执行 pnpm install && pnpm build');
  });

pluginCommand
  .command('enable <name>')
  .description('启用插件')
  .action((name: string) => {
    createManager().setEnabled(name, true);
    console.log(`插件已启用：${name}`);
  });

pluginCommand
  .command('disable <name>')
  .description('停用插件')
  .action((name: string) => {
    createManager().setEnabled(name, false);
    console.log(`插件已停用：${name}`);
  });

pluginCommand
  .command('call <tool>')
  .description('调用插件工具')
  .argument('[params]', 'JSON 参数')
  .action(async (tool: string, params?: string) => {
    const manager = createManager();
    await manager.loadAll();
    const parsed = params ? JSON.parse(params) as Record<string, unknown> : {};
    const result = await manager.executeTool(tool, parsed);
    console.log(JSON.stringify(result, null, 2));
  });
