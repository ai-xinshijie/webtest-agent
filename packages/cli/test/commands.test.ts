import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { initCommand } from '../src/commands/init.js';
import { targetCommand } from '../src/commands/target.js';
import { configCommand } from '../src/commands/config.js';
import { modelCommand } from '../src/commands/model.js';
import { memoryCommand } from '../src/commands/memory.js';
import { pluginCommand } from '../src/commands/plugin.js';
import { installCommand } from '../src/commands/install.js';
import { reportCommand } from '../src/commands/report.js';
import { mcpCommand } from '../src/commands/mcp.js';
import { ConfigManager, DatabaseManager, MemoryManager } from '@wta/core';

let tempDir = '';
let originalCwd = '';
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  // 本文件验证通用命令流程；Linux 系统依赖安装由 install-cli.test.ts 中的隔离 mock 用例覆盖。
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-cli-'));
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  Object.defineProperty(process, 'platform', platformDescriptor);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function loadCommand(name: keyof typeof commandLoaders) {
  const loader = commandLoaders[name];
  return loader();
}

const commandLoaders = {
  init: async () => (await import('../src/commands/init.js')).initCommand,
  target: async () => (await import('../src/commands/target.js')).targetCommand,
  config: async () => (await import('../src/commands/config.js')).configCommand,
  model: async () => (await import('../src/commands/model.js')).modelCommand,
  memory: async () => (await import('../src/commands/memory.js')).memoryCommand,
  plugin: async () => (await import('../src/commands/plugin.js')).pluginCommand,
  install: async () => (await import('../src/commands/install.js')).installCommand,
  report: async () => (await import('../src/commands/report.js')).reportCommand,
  mcp: async () => (await import('../src/commands/mcp.js')).mcpCommand,
};

async function runCommand(command: Command | keyof typeof commandLoaders, ...args: string[]) {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
    logs.push(values.map(value => String(value)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
    errors.push(values.map(value => String(value)).join(' '));
  });

  try {
    vi.resetModules();
    const commandName = typeof command === 'string' ? command : command.name();
    const freshCommand = await loadCommand(commandName as keyof typeof commandLoaders);
    await freshCommand.parseAsync(args, { from: 'user' });
    return { logs, errors };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

function initializeProject() {
  return runCommand('init');
}

describe('CLI 命令', () => {
  it('初始化项目并支持重复初始化提示', async () => {
    const first = await initializeProject();
    expect(first.logs[0]).toContain('WebTestAgent 项目已初始化');
    expect(existsSync(path.join(tempDir, '.wta', 'config.json'))).toBe(true);

    const second = await initializeProject();
    expect(second.logs[0]).toContain('项目已初始化');
  });

  it('管理测试目标的添加、列表、查看和移除', async () => {
    await expect(runCommand(
      targetCommand,
      'add',
      '--name', 'demo',
      '--url', 'https://example.com',
      '--username', 'user',
      '--password', 'pass',
    )).rejects.toThrow('项目尚未初始化');

    await initializeProject();
    await runCommand(
      targetCommand,
      'add',
      '--name', 'demo',
      '--url', 'https://example.com',
      '--username', 'user',
      '--password', 'pass',
    );
    expect(existsSync(path.join(tempDir, '.wta', 'targets', 'demo.json'))).toBe(true);

    await expect(runCommand(
      targetCommand,
      'add',
      '--name', 'demo',
      '--url', 'https://example.com',
      '--username', 'user',
      '--password', 'pass',
    )).rejects.toThrow('测试目标已存在：demo');

    await expect(runCommand(
      targetCommand,
      'add',
      '--name', 'bad',
      '--url', 'https://example.com',
      '--username', 'user',
      '--password', 'pass',
      '--strategy', 'unknown',
    )).rejects.toThrow('无效测试深度');

    const list = await runCommand(targetCommand, 'list');
    expect(list.logs.join('\n')).toContain('demo');
    expect(list.logs.join('\n')).toContain('https://example.com');

    const show = await runCommand(targetCommand, 'show', 'demo');
    expect(show.logs.join('\n')).toContain('"name": "demo"');

    await runCommand(targetCommand, 'remove', 'demo');
    expect(existsSync(path.join(tempDir, '.wta', 'targets', 'demo.json'))).toBe(false);
    await expect(runCommand(targetCommand, 'remove', 'demo')).rejects.toThrow('未找到测试目标：demo');
  });

  it('查看和更新全局配置', async () => {
    await initializeProject();
    const show = await runCommand(configCommand, 'show');
    expect(show.logs.join('\n')).toContain('"defaultBrowser"');

    const get = await runCommand(configCommand, 'get', 'models.component-identify.provider');
    expect(get.logs.join('\n')).toContain('"anthropic"');

    await runCommand(configCommand, 'set', 'headless', 'false');
    await runCommand(configCommand, 'set', 'parallel', '4');
    const config = JSON.parse(readFileSync(path.join(tempDir, '.wta', 'config.json'), 'utf-8'));
    expect(config.headless).toBe(false);
    expect(config.parallel).toBe(4);
  });

  it('管理模型路由并查看统计', async () => {
    await initializeProject();
    const list = await runCommand(modelCommand, 'list');
    expect(list.logs.join('\n')).toContain('component-identify');

    await runCommand(
      modelCommand,
      'set', 'visual-analysis',
      '--provider', 'custom',
      '--model', 'local-vision',
      '--base-url', 'http://127.0.0.1:8000/v1',
      '--temperature', '0.2',
      '--max-tokens', '1200',
    );
    const config = JSON.parse(readFileSync(path.join(tempDir, '.wta', 'config.json'), 'utf-8'));
    expect(config.models['visual-analysis']).toMatchObject({
      provider: 'custom',
      model: 'local-vision',
      baseUrl: 'http://127.0.0.1:8000/v1',
      temperature: 0.2,
      maxTokens: 1200,
    });

    const stats = await runCommand(modelCommand, 'stats');
    expect(stats.logs.join('\n')).toContain('暂无模型调用记录');
  });

  it('导出、导入、合并和清除记忆', async () => {
    await initializeProject();
    const config = new ConfigManager(tempDir).load();
    const db = new DatabaseManager(config.dbPath);
    db.prepare(`
      INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES ('demo', 'demo', 'https://example.com', '{}', 1, 1)
    `).run();
    const memory = new MemoryManager(db);
    memory.markTested('demo', {
      itemKey: 'demo:button-1:click',
      componentId: 'button-1',
      testType: 'click',
      status: 'passed',
    });
    memory.close();

    const show = await runCommand(memoryCommand, 'show');
    expect(show.logs.join('\n')).toContain('已测项：1');

    const appShow = await runCommand(memoryCommand, 'show', '--app', 'demo');
    expect(appShow.logs.join('\n')).toContain('测试目标：demo');

    const exportPath = path.join(tempDir, 'memory.json');
    await runCommand(memoryCommand, 'export', '-o', exportPath, '--app', 'demo');
    expect(JSON.parse(readFileSync(exportPath, 'utf-8')).testedItems).toHaveLength(1);

    await runCommand(memoryCommand, 'clear', '--all');
    const cleared = await runCommand(memoryCommand, 'show');
    expect(cleared.logs.join('\n')).toContain('已测项：0');

    await runCommand(memoryCommand, 'import', exportPath);
    const imported = await runCommand(memoryCommand, 'show');
    expect(imported.logs.join('\n')).toContain('已测项：1');

    const mergedPath = path.join(tempDir, 'merged.json');
    await runCommand(memoryCommand, 'merge', exportPath, exportPath, '-o', mergedPath);
    expect(JSON.parse(readFileSync(mergedPath, 'utf-8')).testedItems).toHaveLength(1);

    await runCommand(memoryCommand, 'clear', '--app', 'demo');
    await expect(runCommand(memoryCommand, 'clear')).rejects.toThrow('必须指定 --app <app> 或 --all');
  });

  it('管理本地插件并调用插件工具', async () => {
    await initializeProject();
    const empty = await runCommand(pluginCommand, 'list');
    expect(empty.logs.join('\n')).toContain('当前没有插件');

    await runCommand(pluginCommand, 'create', 'scaffold');
    expect(existsSync(path.join(tempDir, '.wta', 'plugins', 'scaffold', 'plugin.json'))).toBe(true);

    await runCommand(pluginCommand, 'disable', 'scaffold');
    expect(JSON.parse(readFileSync(
      path.join(tempDir, '.wta', 'plugins', 'scaffold', 'plugin.json'),
      'utf-8',
    )).enabled).toBe(false);
    await runCommand(pluginCommand, 'enable', 'scaffold');

    const pluginPath = path.join(tempDir, '.wta', 'plugins', 'callable', 'dist');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(path.join(pluginPath, '..', 'plugin.json'), JSON.stringify({
      name: 'callable',
      version: '0.1.0',
      entry: 'dist/index.js',
      enabled: true,
    }), 'utf-8');
    writeFileSync(path.join(pluginPath, 'index.js'), `
      export default {
        name: 'callable',
        version: '0.1.0',
        tools: [{ name: 'callable.echo', description: '回显工具' }],
        async executeTool(toolName, params) { return { toolName, params }; },
      };
    `);
    const call = await runCommand(pluginCommand, 'call', 'callable.echo', '{"value":1}');
    expect(JSON.parse(call.logs.join('\n'))).toEqual({
      toolName: 'callable.echo',
      params: { value: 1 },
    });
  });

  it('安装状态和 Linux 依赖命令在当前平台可用', async () => {
    const deps = await runCommand(installCommand, 'deps');
    expect(deps.logs.join('\n')).toContain('当前系统不需要安装 Linux 浏览器依赖');

    const status = await runCommand(installCommand, 'status');
    expect(status.logs.join('\n')).toContain('浏览器目录不存在');
  });

  it('列出 MCP 服务配置', async () => {
    const empty = await runCommand(mcpCommand, 'list');
    expect(empty.logs.join('\n')).toContain('暂无 MCP 服务配置');

    mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'mcp.json'), JSON.stringify([
      { name: 'demo', command: 'node', args: ['server.js'] },
    ]), 'utf-8');
    const list = await runCommand(mcpCommand, 'list');
    expect(list.logs.join('\n')).toContain('demo  node server.js');
  });

  it('列出、查看和导出中文测试报告', async () => {
    const noDatabase = await runCommand(reportCommand, 'list');
    expect(noDatabase.logs.join('\n')).toContain('未找到测试数据库');

    await initializeProject();
    const config = new ConfigManager(tempDir).load();
    const db = new DatabaseManager(config.dbPath);
    db.prepare(`
      INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES ('demo', '演示系统', 'https://example.com', '{}', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at, ended_at, phase)
      VALUES ('session-1', 'demo', 'completed', 1000, 3000, 'report')
    `).run();
    db.close();

    mkdirSync(path.join(tempDir, '.wta', 'reports'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'reports', 'demo.md'), '# 报告', 'utf-8');
    const list = await runCommand(reportCommand, 'list');
    expect(list.logs.join('\n')).toContain('演示系统');
    expect(list.logs.join('\n')).toContain('demo.md');

    const show = await runCommand(reportCommand, 'show', 'session-1');
    expect(show.logs.join('\n')).toContain('WebTestAgent 测试报告');

    const outputPath = path.join(tempDir, 'export.json');
    const exported = await runCommand(reportCommand, 'export', 'session-1', '--format', 'json', '-o', outputPath);
    expect(exported.logs.join('\n')).toContain('报告已导出');
    expect(JSON.parse(readFileSync(outputPath, 'utf-8')).会话.标识).toBe('session-1');
  });
});
