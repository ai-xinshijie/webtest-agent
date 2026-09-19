import { Command } from 'commander';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ConfigManager, createDefaultConfig } from '@wta/core';

export const initCommand = new Command('init')
  .description('初始化 WebTestAgent 项目')
  .argument('[path]', '项目目录', '.')
  .action((targetPath: string) => {
    const root = path.resolve(targetPath);
    const wtaDir = path.join(root, '.wta');

    if (existsSync(wtaDir)) {
      console.log(`项目已初始化：${wtaDir}`);
      return;
    }

    mkdirSync(path.join(wtaDir, 'targets'), { recursive: true });
    mkdirSync(path.join(wtaDir, 'plugins'), { recursive: true });
    mkdirSync(path.join(wtaDir, 'sessions'), { recursive: true });
    mkdirSync(path.join(wtaDir, 'auth'), { recursive: true });
    mkdirSync(path.join(wtaDir, 'reports'), { recursive: true });
    mkdirSync(path.join(wtaDir, 'screenshots'), { recursive: true });
    mkdirSync(path.join(wtaDir, 'videos'), { recursive: true });

    new ConfigManager(root).save(createDefaultConfig(root));

    console.log(`WebTestAgent 项目已初始化：${root}`);
    console.log('  .wta/config.json       全局配置');
    console.log('  .wta/targets/          测试目标');
    console.log('  .wta/plugins/          本地插件');
    console.log('  .wta/sessions/         会话与登录状态');
    console.log('  .wta/auth/             可复用认证状态');
    console.log('  .wta/reports/          测试报告');
    console.log('  .wta/screenshots/      测试截图');
    console.log('');
    console.log('后续步骤：');
    console.log('  wta target add --name demo --url https://demoqa.com --username test --password test');
    console.log('  wta run demo');
    console.log('  wta gui');
  });
