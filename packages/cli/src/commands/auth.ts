import { Command } from 'commander';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserManager, ConfigManager } from '@wta/core';

interface StorageState {
  cookies: unknown[];
  origins: unknown[];
}

function statePath(targetName: string): string {
  return path.join(process.cwd(), '.wta', 'auth', targetName + '.json');
}

function target(name: string) {
  return new ConfigManager(process.cwd()).loadTarget(name);
}

function validateState(filePath: string): void {
  if (!existsSync(filePath)) throw new Error('认证状态文件不存在：' + filePath);
  try {
    const state = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<StorageState>;
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
      throw new Error('认证状态缺少 cookies 或 origins 数组');
    }
  } catch (error) {
    const reason = String(error).replace(/^Error: /, '');
    throw new Error('认证状态文件格式不正确：' + reason, { cause: error });
  }
}

async function waitForEnter(timeoutSeconds: number): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error('当前终端不支持交互认证，请使用 wta auth import 导入状态文件');
  }
  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await Promise.race([
      readline.question('请在打开的浏览器完成登录，然后按 Enter 保存认证状态：'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('人工认证等待超时')), timeoutSeconds * 1000)),
    ]);
  } finally {
    readline.close();
  }
}

export const authCommand = new Command('auth')
  .description('管理可复用登录状态');

authCommand
  .command('import <target> <file>')
  .description('导入 Cookie 和 LocalStorage 认证状态')
  .action((targetName: string, file: string) => {
    target(targetName);
    const source = path.resolve(file);
    validateState(source);
    const destination = statePath(targetName);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    console.log('认证状态已导入：' + destination);
  });

authCommand
  .command('export <target>')
  .description('导出目标的可复用认证状态')
  .option('-o, --output <file>', '输出文件路径')
  .action((targetName: string, options: { output?: string }) => {
    target(targetName);
    const source = statePath(targetName);
    validateState(source);
    const destination = path.resolve(options.output ?? (targetName + '-auth-state.json'));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    console.log('认证状态已导出：' + destination);
  });

authCommand
  .command('capture <target>')
  .description('使用项目内置浏览器人工登录并保存认证状态')
  .option('--timeout <seconds>', '等待人工认证秒数', '900')
  .action(async (targetName: string, options: { timeout?: string }) => {
    const targetConfig = target(targetName);
    const timeout = Number(options.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error('无效认证等待时间：' + options.timeout);
    }

    const config = new ConfigManager(process.cwd()).load();
    const browser = new BrowserManager(config.browserDir, config.defaultBrowser);
    try {
      const context = await browser.createContext('auth-capture-' + Date.now(), {
        headless: false,
        viewport: config.viewport,
      });
      const page = await context.newPage();
      await page.goto(targetConfig.url, { waitUntil: 'domcontentloaded', timeout: config.timeout.navigation });
      await waitForEnter(timeout);
      const destination = statePath(targetName);
      mkdirSync(path.dirname(destination), { recursive: true });
      await context.storageState({ path: destination });
      console.log('认证状态已保存：' + destination);
    } finally {
      await browser.close();
    }
  });
