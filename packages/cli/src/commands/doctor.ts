import { Command } from 'commander';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BrowserManager, ConfigManager, DatabaseManager } from '@wta/core';

interface CheckResult {
  name: string;
  pass: boolean;
  required: boolean;
  detail: string;
}

export const doctorCommand = new Command('doctor')
  .description('检查运行环境')
  .option('--verbose', '显示详细检查结果')
  .action((options: { verbose?: boolean }) => {
    const cwd = process.cwd();
    const results: CheckResult[] = [];

    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    results.push({
      name: 'Node.js',
      pass: majorVersion >= 20,
      required: true,
      detail: `${nodeVersion}，要求 >= 20`,
    });

    const initialized = existsSync(path.join(cwd, '.wta'));
    results.push({
      name: '项目配置',
      pass: initialized,
      required: true,
      detail: initialized ? '已初始化' : '未初始化，请执行 wta init',
    });

    let configOk = false;
    let dbOk = false;
    try {
      const config = new ConfigManager(cwd).load();
      configOk = true;
      new DatabaseManager(config.dbPath).close();
      dbOk = true;
    } catch (error) {
      results.push({
        name: '配置与数据库',
        pass: false,
        required: true,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (configOk) {
      results.push({
        name: '配置文件',
        pass: true,
        required: true,
        detail: '.wta/config.json 可读取',
      });
    }
    if (dbOk && configOk) {
      results.push({
        name: 'SQLite 数据库',
        pass: true,
        required: true,
        detail: '可打开并初始化',
      });
    }

    const browserRoot = path.join(cwd, 'vendor', 'browsers');
    const browserManager = new BrowserManager(browserRoot, 'chromium');
    for (const browser of ['chromium', 'firefox', 'webkit'] as const) {
      const installed = browserManager.isBrowserAvailable(browser);
      results.push({
        name: `内置浏览器 ${browser}`,
        pass: installed,
        required: browser === 'chromium',
        detail: installed ? '已安装' : '未安装，可执行 wta install browsers',
      });
    }

    const config = configOk ? new ConfigManager(cwd).load() : null;
    for (const [task, model] of Object.entries(config?.models ?? {})) {
      const hasCredential = model.provider === 'ollama' || Boolean(model.apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
      results.push({
        name: `模型 ${task}`,
        pass: hasCredential,
        required: false,
        detail: hasCredential
          ? `${model.provider}/${model.model}`
          : `${model.provider}/${model.model}，未配置凭证`,
      });
    }

    const isLinux = process.platform === 'linux';
    results.push({
      name: '显示环境',
      pass: !isLinux || Boolean(process.env.DISPLAY),
      required: false,
      detail: isLinux
        ? process.env.DISPLAY
          ? `DISPLAY=${process.env.DISPLAY}`
          : '无 DISPLAY，将使用无头模式'
        : '桌面环境',
    });

    console.log('WebTestAgent 环境检查');
    for (const result of results) {
      if (!options.verbose && !result.required && result.pass) continue;
      const icon = result.pass ? '[正常]' : result.required ? '[失败]' : '[提示]';
      console.log(`${icon} ${result.name}：${result.detail}`);
    }

    const failures = results.filter(result => result.required && !result.pass);
    if (failures.length > 0) {
      console.log(`必需检查失败 ${failures.length} 项`);
      process.exit(1);
    }
    console.log('必需检查全部通过');
  });
