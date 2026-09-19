import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { configCommand } from '../src/commands/config.js';
import { targetCommand } from '../src/commands/target.js';
import { pluginCommand } from '../src/commands/plugin.js';
import { reportCommand } from '../src/commands/report.js';
import { runCommand } from '../src/commands/run.js';
import { attachCommand } from '../src/commands/attach.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { initCommand } from '../src/commands/init.js';
import { ConfigManager, DatabaseManager } from '@wta/core';

let tempDir = '';
let originalCwd = '';
const versionDescriptor = Object.getOwnPropertyDescriptor(process, 'version')!;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-cli-branches-'));
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  Object.defineProperty(process, 'version', versionDescriptor);
  Object.defineProperty(process, 'platform', platformDescriptor);
  delete process.env.DISPLAY;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function runCliCommand(command: Command, ...args: string[]) {
const commandLoaders = {
  init: async () => (await import('../src/commands/init.js')).initCommand,
  config: async () => (await import('../src/commands/config.js')).configCommand,
  target: async () => (await import('../src/commands/target.js')).targetCommand,
  plugin: async () => (await import('../src/commands/plugin.js')).pluginCommand,
  report: async () => (await import('../src/commands/report.js')).reportCommand,
  run: async () => (await import('../src/commands/run.js')).runCommand,
  attach: async () => (await import('../src/commands/attach.js')).attachCommand,
  doctor: async () => (await import('../src/commands/doctor.js')).doctorCommand,
};
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
    logs.push(values.map(value => String(value)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
    errors.push(values.map(value => String(value)).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });

  try {
    vi.resetModules();
    const commandName = typeof command === 'string' ? command : command.name();
    const freshCommand = await commandLoaders[commandName as keyof typeof commandLoaders]();
    await freshCommand.parseAsync(args, { from: 'user' });
    return { logs, errors, exited: false };
  } catch (error) {
    if (error instanceof Error && error.message === 'process.exit') {
      return { logs, errors, exited: true };
    }
    throw error;
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

function addTarget(name: string, strategy?: string) {
  return runCliCommand(
    targetCommand,
    'add',
    '--name', name,
    '--url', 'https://example.com',
    '--username', 'user',
    '--password', 'pass',
    ...(strategy ? ['--strategy', strategy] : []),
  );
}

describe('配置与目标命令分支', () => {
  it('读取缺失配置路径并写入字符串和嵌套对象', async () => {
    await runCliCommand(initCommand);

    const missing = await runCliCommand(configCommand, 'get', 'models.not-exist.deep');
    expect(missing.logs.join('\n')).toBe('undefined');

    await runCliCommand(configCommand, 'set', 'defaultBrowser', 'firefox');
    await runCliCommand(configCommand, 'set', 'booleanFlag', 'true');
    await runCliCommand(configCommand, 'set', 'models.newTask.apiKey', 'test-key');

    const config = JSON.parse(readFileSync(path.join(tempDir, '.wta', 'config.json'), 'utf-8'));
    expect(config.defaultBrowser).toBe('firefox');
    expect(config.models.newTask.apiKey).toBe('test-key');
  });

  it('处理未初始化、空目标列表和不同测试深度', async () => {
    const uninitialized = await runCliCommand(targetCommand, 'list');
    expect(uninitialized.logs.join('\n')).toContain('项目尚未初始化');

    await runCliCommand(initCommand);
    const empty = await runCliCommand(targetCommand, 'list');
    expect(empty.logs.join('\n')).toContain('当前没有测试目标');

    await addTarget('quick-target', 'quick');
    await addTarget('default-target');
    await addTarget('standard-target', 'standard');
    await addTarget('deep-target', 'deep');

    const quick = JSON.parse(readFileSync(
      path.join(tempDir, '.wta', 'targets', 'quick-target.json'),
      'utf-8',
    ));
    const standard = JSON.parse(readFileSync(
      path.join(tempDir, '.wta', 'targets', 'standard-target.json'),
      'utf-8',
    ));
    expect(quick.strategy.maxPages).toBe(50);
    const defaultTarget = JSON.parse(readFileSync(
      path.join(tempDir, '.wta', 'targets', 'default-target.json'),
      'utf-8',
    ));
    expect(defaultTarget.strategy.depth).toBe('deep');
    expect(standard.strategy.maxPages).toBe(120);

    await runCliCommand(targetCommand, 'remove', 'quick-target');
    await expect(runCliCommand(targetCommand, 'show', 'quick-target')).rejects.toThrow('未找到测试目标：quick-target');
  });
});

describe('插件命令分支', () => {
  it('显示停用状态、安装本地插件并支持空参数调用', async () => {
    await runCliCommand(initCommand);
    await runCliCommand(pluginCommand, 'create', 'scaffold');
    await runCliCommand(pluginCommand, 'disable', 'scaffold');

    const disabled = await runCliCommand(pluginCommand, 'list');
    expect(disabled.logs.join('\n')).toContain('停用  scaffold@0.1.0');

    await runCliCommand(pluginCommand, 'enable', 'scaffold');
    const enabled = await runCliCommand(pluginCommand, 'list');
    expect(enabled.logs.join('\n')).toContain('启用  scaffold@0.1.0');

    const source = path.join(tempDir, 'source-plugin');
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({
      name: 'source-plugin',
      version: '1.0.0',
      entry: 'dist/index.js',
      enabled: true,
    }), 'utf-8');
    await runCliCommand(pluginCommand, 'install', source);
    expect(JSON.parse(readFileSync(
      path.join(tempDir, '.wta', 'plugins', 'source-plugin', 'plugin.json'),
      'utf-8',
    )).name).toBe('source-plugin');

    const callable = path.join(tempDir, '.wta', 'plugins', 'callable', 'dist');
    mkdirSync(callable, { recursive: true });
    writeFileSync(path.join(callable, '..', 'plugin.json'), JSON.stringify({
      name: 'callable',
      version: '0.1.0',
      entry: 'dist/index.js',
      enabled: true,
    }), 'utf-8');
    writeFileSync(path.join(callable, 'index.js'), `
      export default {
        name: 'callable',
        version: '0.1.0',
        tools: [{ name: 'callable.echo', description: '回显工具' }],
        async executeTool(toolName, params) { return { toolName, params }; },
      };
    `);
    const call = await runCliCommand(pluginCommand, 'call', 'callable.echo');
    expect(JSON.parse(call.logs.join('\n'))).toEqual({
      toolName: 'callable.echo',
      params: {},
    });
  });
});

describe('报告命令分支', () => {
  it('处理缺库、空会话、运行中会话和无效格式', async () => {
    const noDbShow = await runCliCommand(reportCommand, 'show', 'session-1');
    expect(noDbShow.exited).toBe(true);
    const noDbExport = await runCliCommand(reportCommand, 'export', 'session-1', '--format', 'md');
    expect(noDbExport.exited).toBe(true);

    await runCliCommand(initCommand);
    new DatabaseManager(new ConfigManager(tempDir).load().dbPath).close();
    const empty = await runCliCommand(reportCommand, 'list');

    expect(empty.logs.join('\n')).toContain('暂无测试会话');

    const config = new ConfigManager(tempDir).load();
    const db = new DatabaseManager(config.dbPath);
    db.prepare(`
      INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES ('demo', 'demo', 'https://example.com', '{}', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at, phase)
      VALUES ('session-1', 'demo', 'running', 1000, 'test')
    `).run();
    db.close();

    const running = await runCliCommand(reportCommand, 'list');
    expect(running.logs.join('\n')).toContain('运行中');

    const missingShow = await runCliCommand(reportCommand, 'show', '不存在');
    expect(missingShow.exited).toBe(true);
    const invalidFormat = await runCliCommand(reportCommand, 'export', 'session-1', '--format', 'yaml');
    expect(invalidFormat.exited).toBe(true);
    const exportMissing = await runCliCommand(reportCommand, 'export', '不存在', '--format', 'md');
    expect(exportMissing.errors.join('\n')).toContain('报告导出失败');
    expect(exportMissing.exited).toBe(true);
  });
});

describe('运行和附加命令分支', () => {
  it('提交默认参数并收敛并行数', async () => {
    await runCliCommand(initCommand);
    await addTarget('demo', 'deep');
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const invalidPhase = await runCliCommand(runCommand, 'demo', '--phase', 'invalid');
    expect(invalidPhase.errors.join('\n')).toContain('无效测试阶段：invalid');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const text = String(url);
      requests.push({ url: text, init });
      if (text.endsWith('/api/health')) return { ok: true } as Response;
      if (text.endsWith('/api/run')) return {
        ok: true,
        json: async () => ({ sessionId: 'session-1' }),
      } as Response;
      return { ok: false } as Response;
    }));

    const result = await runCliCommand(runCommand, 'demo');
    expect(result.logs.join('\n')).toContain('测试已提交：session-1');

    await runCliCommand(runCommand, 'demo', '--headed', '--parallel', '20');
    const high = requests.at(-1)!;
    expect(JSON.parse(String(high.init!.body))).toMatchObject({ parallel: 8, headless: false });

    await runCliCommand(runCommand, 'demo', '--parallel', '0');
    const low = requests.at(-1)!;
    expect(JSON.parse(String(low.init!.body))).toMatchObject({ parallel: 1, headless: true });
    vi.unstubAllGlobals();
  });

  it('提交失败时输出接口响应', async () => {
    await runCliCommand(initCommand);
    await addTarget('demo', 'deep');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/health')) return { ok: true } as Response;
      return {
        ok: false,
        status: 500,
        text: async () => '服务不可用',
      } as Response;
    }));

    const result = await runCliCommand(runCommand, 'demo');
    expect(result.errors.join('\n')).toContain('提交测试失败：500 服务不可用');
    vi.unstubAllGlobals();
  });

  it('启动失败支持非 Error 异常', async () => {
    await runCliCommand(initCommand);
    await addTarget('demo', 'deep');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/health')) return { ok: true } as Response;
      throw '接口异常';
    }));

    const result = await runCliCommand(runCommand, 'demo');
    expect(result.errors.join('\n')).toContain('测试启动失败：接口异常');
    vi.unstubAllGlobals();
  });

  it('附加最近会话并处理时间线字段缺失', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const text = String(url);
      if (text.endsWith('/api/health')) return { ok: true } as Response;
      if (text.endsWith('/api/sessions')) return {
        ok: true,
        json: async () => [{ id: 'session-1' }],
      } as Response;
      if (text.endsWith('/api/sessions/session-1/timeline')) return {
        ok: true,
        json: async () => [
          { sequence: 1, timestamp: 1, source: 'model', trigger: {}, result: {} },
          { sequence: 2, timestamp: 2, source: 'unknown', trigger: {}, result: {} },
          { sequence: 3, timestamp: 3, source: 'script', result: { error: '接口错误' } },
        ],
      } as Response;
      return { ok: false } as Response;
    }));

    const result = await runCliCommand(attachCommand);
    expect(result.logs.join('\n')).toContain('已附加会话：session-1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(result.logs.join('\n')).toContain('未命名操作 -> success');
    expect(result.logs.join('\n')).toContain('接口错误');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('会话列表为空时输出中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/health')) return { ok: true } as Response;
      return { ok: true, json: async () => [] } as Response;
    }));

    const result = await runCliCommand(attachCommand);
    expect(result.errors.join('\n')).toContain('当前没有测试会话');
    vi.unstubAllGlobals();
  });

  it('时间线接口失败时保持附加状态', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as any);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const text = String(url);
      if (text.endsWith('/api/health')) return { ok: true } as Response;
      if (text.endsWith('/api/sessions')) return {
        ok: true,
        json: async () => [{ id: 'session-1' }],
      } as Response;
      return { ok: false } as Response;
    }));

    const result = await runCliCommand(attachCommand);
    expect(result.logs.join('\n')).toContain('已附加会话：session-1');
    expect(result.logs.join('\n')).not.toContain('未命名操作');
    intervalSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('附加失败支持非 Error 异常', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/health')) return { ok: true } as Response;
      throw '接口异常';
    }));

    const result = await runCliCommand(attachCommand);
    expect(result.errors.join('\n')).toContain('附加失败：接口异常');
    vi.unstubAllGlobals();
  });

  it('附加失败时输出会话列表错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/health')) return { ok: true } as Response;
      return { ok: false, status: 500 } as Response;
    }));

    const result = await runCliCommand(attachCommand);
    expect(result.errors.join('\n')).toContain('读取会话列表失败：500');
    vi.unstubAllGlobals();
  });
});

describe('环境检查分支', () => {
  it('未初始化项目时输出初始化提示', async () => {
    const result = await runCliCommand(doctorCommand);
    expect(result.logs.join('\n')).toContain('未初始化，请执行 wta init');
  });

  it('配置异常支持非 Error 描述', async () => {
    const loadSpy = vi.spyOn(ConfigManager.prototype, 'load').mockImplementationOnce(() => {
      throw '配置不是对象';
    });
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
      logs.push(values.map(value => String(value)).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    try {
      await doctorCommand.parseAsync([], { from: 'user' });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'process.exit') throw error;
    } finally {
      loadSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(logs.join('\n')).toContain('配置不是对象');
  });

  it('配置损坏时输出中文错误', async () => {
    mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'config.json'), '不是 JSON', 'utf-8');

    const result = await runCliCommand(doctorCommand);
    expect(result.logs.join('\n')).toContain('配置与数据库');
    expect(result.logs.join('\n')).toContain('必需检查失败');
  });

  it('详细模式显示可选检查和模型凭证', async () => {
    await runCliCommand(initCommand);
    const configPath = path.join(tempDir, '.wta', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.models['component-identify'] = {
      provider: 'ollama',
      model: 'local-model',
      temperature: 0,
      maxTokens: 1000,
    };
    config.models['visual-analysis'] = {
      provider: 'custom',
      model: 'vision',
      apiKey: 'test-key',
      temperature: 0,
      maxTokens: 1000,
    };
    writeFileSync(configPath, JSON.stringify(config), 'utf-8');

    const browserRoot = path.join(tempDir, 'vendor', 'browsers');
    mkdirSync(browserRoot, { recursive: true });
    for (const name of ['chrome.exe', 'firefox.exe', 'webkitbrowser.exe']) {
      writeFileSync(path.join(browserRoot, name), '');
    }

    const result = await runCliCommand(doctorCommand, '--verbose');
    expect(result.logs.join('\n')).toContain('内置浏览器 firefox：已安装');
    expect(result.logs.join('\n')).toContain('模型 component-identify');
    expect(result.logs.join('\n')).toContain('模型 visual-analysis');
    expect(result.logs.join('\n')).toContain('必需检查全部通过');
  });

  it('覆盖 Linux 显示环境和 Node 版本检查', async () => {
    await runCliCommand(initCommand);
    const browserRoot = path.join(tempDir, 'vendor', 'browsers');
    mkdirSync(browserRoot, { recursive: true });
    writeFileSync(path.join(browserRoot, 'chrome.exe'), '');

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env.DISPLAY = ':0';
    const withDisplay = await runCliCommand(doctorCommand, '--verbose');
    expect(withDisplay.logs.join('\n')).toContain('DISPLAY=:0');

    delete process.env.DISPLAY;
    const withoutDisplay = await runCliCommand(doctorCommand, '--verbose');
    expect(withoutDisplay.logs.join('\n')).toContain('无 DISPLAY，将使用无头模式');

    Object.defineProperty(process, 'version', { value: 'v18.0.0', configurable: true });
    const oldNode = await runCliCommand(doctorCommand, '--verbose');
    expect(oldNode.logs.join('\n')).toContain('Node.js');
    expect(oldNode.logs.join('\n')).toContain('必需检查失败 1 项');
  });
});
