import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BrowserManager } from '@wta/core';

function browserRoot(): string {
  return path.join(process.cwd(), 'vendor', 'browsers');
}

function installBrowsers(browser: string): void {
  execSync(`pnpm exec playwright install ${browser}`, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browserRoot(),
    },
  });
}

export const installCommand = new Command('install')
  .description('安装项目内置浏览器和系统依赖');

installCommand
  .command('browsers')
  .description('下载或更新项目内置浏览器')
  .option('--all', '安装 Chromium、Firefox 和 WebKit')
  .option('--browser <browser>', '指定浏览器：chromium、firefox、webkit')
  .action((options: { all?: boolean; browser?: string }) => {
    const browsers = options.all
      ? ['chromium', 'firefox', 'webkit']
      : [options.browser ?? 'chromium'];

    console.log('开始安装项目内置浏览器...');
    for (const browser of browsers) {
      console.log(`正在安装：${browser}`);
      installBrowsers(browser);
      console.log(`安装完成：${browser}`);
    }

    console.log(`浏览器目录：${browserRoot()}`);
  });

installCommand
  .command('deps')
  .description('安装 Linux 无头模式系统依赖')
  .action(() => {
    if (process.platform !== 'linux') {
      console.log('当前系统不需要安装 Linux 浏览器依赖');
      return;
    }

    execSync('pnpm exec playwright install-deps', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browserRoot(),
      },
    });
    console.log('系统依赖安装完成');
  });

installCommand
  .command('status')
  .description('查看项目内置浏览器状态')
  .action(() => {
    const root = browserRoot();
    if (!existsSync(root)) {
      console.log(`浏览器目录不存在：${root}`);
      return;
    }

    const manager = new BrowserManager(root, 'chromium');
    for (const browser of ['chromium', 'firefox', 'webkit'] as const) {
      console.log(`${browser}：${manager.isBrowserAvailable(browser) ? '已安装' : '未安装'}`);
    }
  });
