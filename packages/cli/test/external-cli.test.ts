import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { initCommand } from '../src/commands/init.js';
import { modelCommand } from '../src/commands/model.js';
import { mcpCommand } from '../src/commands/mcp.js';
import { ConfigManager, DatabaseManager } from '@wta/core';

vi.mock('@wta/core', async () => {
  const actual = await vi.importActual<typeof import('@wta/core')>('@wta/core');

  class MockMCPClient {
    static instances: MockMCPClient[] = [];
    static tools: Array<{ name: string; description?: string }> = [];
    connected = false;
    closed = false;

    constructor(public config: unknown) {
      MockMCPClient.instances.push(this);
    }

    async connect() {
      this.connected = true;
    }

    async listTools() {
      return MockMCPClient.tools;
    }

    async callTool(name: string, params: Record<string, unknown>) {
      return { name, params };
    }

    async close() {
      this.closed = true;
    }
  }

  class MockLLMRouter {
    static instances: MockLLMRouter[] = [];

    constructor(public models: unknown) {
      MockLLMRouter.instances.push(this);
    }

    async call(task: string, messages: Array<{ role: string; content: string }>) {
      return `${task}:${messages[0]!.content}`;
    }
  }

  return {
    ...actual,
    MCPClient: MockMCPClient,
    LLMRouter: MockLLMRouter,
    MockMCPClient,
    MockLLMRouter,
  };
});

let tempDir = '';
let originalCwd = '';

beforeEach(async () => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-external-cli-'));
  process.chdir(tempDir);

  const core = await import('@wta/core') as unknown as {
    MockMCPClient: { instances: unknown[]; tools: unknown[] };
    MockLLMRouter: { instances: unknown[] };
  };
  core.MockMCPClient.instances = [];
  core.MockMCPClient.tools = [];
  core.MockLLMRouter.instances = [];
});

afterEach(() => {
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function runCliCommand(command: Command, ...args: string[]) {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
    logs.push(values.map(value => String(value)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
    errors.push(values.map(value => String(value)).join(' '));
  });

  try {
    await command.parseAsync(args, { from: 'user' });
    return { logs, errors };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

function createMcpConfig() {
  mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
  writeFileSync(path.join(tempDir, '.wta', 'mcp.json'), JSON.stringify([
    { name: 'demo', command: 'node', args: ['server.js'] },
  ]), 'utf-8');
}

describe('模型命令', () => {
  it('设置完整模型参数并测试连通性', async () => {
    await runCliCommand(initCommand);
    await runCliCommand(
      modelCommand,
      'set', 'visual-analysis',
      '--provider', 'custom',
      '--model', 'vision-model',
      '--base-url', 'http://127.0.0.1:8000/v1',
      '--api-key', 'test-key',
      '--temperature', '0.1',
      '--max-tokens', '512',
    );

    const config = new ConfigManager(tempDir).load();
    expect(config.models['visual-analysis']).toMatchObject({
      provider: 'custom',
      model: 'vision-model',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: 'test-key',
      temperature: 0.1,
      maxTokens: 512,
    });

    const result = await runCliCommand(modelCommand, 'test', 'visual-analysis');
    expect(result.logs.join('\n')).toBe('visual-analysis:请返回：连接正常');
    expect((await import('@wta/core') as any).MockLLMRouter.instances).toHaveLength(1);
  });

  it('未指定可选参数时使用默认模型配置', async () => {
    await runCliCommand(initCommand);
    await runCliCommand(modelCommand, 'set', 'memory-compression', '--provider', 'ollama', '--model', 'local-model');

    const config = new ConfigManager(tempDir).load();
    expect(config.models['memory-compression']).toMatchObject({
      provider: 'ollama',
      model: 'local-model',
      temperature: 0,
      maxTokens: 2000,
    });
  });

  it('统计模型调用次数和失败次数', async () => {
    await runCliCommand(initCommand);
    const config = new ConfigManager(tempDir).load();
    const db = new DatabaseManager(config.dbPath);
    db.prepare(`
      INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES ('demo', 'demo', 'https://example.com', '{}', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at)
      VALUES ('session-1', 'demo', 'running', 1)
    `).run();
    const insert = db.prepare(`
      INSERT INTO agent_logs (id, session_id, timestamp, sequence, source, log_json, created_at)
      VALUES (?, 'session-1', 1, ?, 'model', ?, 1)
    `);
    for (const [sequence, status] of [['1', 'success'], ['2', 'failed']] as const) {
      insert.run(`log-${sequence}`, sequence, JSON.stringify({
        model: { model: 'demo-model' },
        result: { status },
      }));
    }
    insert.run('log-3', 3, JSON.stringify({ result: { status: 'success' } }));
    db.close();

    const result = await runCliCommand(modelCommand, 'stats');
    expect(result.logs.join('\n')).toContain('demo-model  调用 2 次  失败 1 次');
    expect(result.logs.join('\n')).toContain('未知模型  调用 1 次  失败 0 次');
  });
});

describe('MCP 命令', () => {
  it('列出工具并在没有工具时输出提示', async () => {
    createMcpConfig();
    await runCliCommand(mcpCommand, 'tools', 'demo');
    const result = await runCliCommand(mcpCommand, 'tools', 'demo');
    expect(result.logs.join('\n')).toContain('该服务没有可用工具');
    const core = await import('@wta/core') as any;

    expect(core.MockMCPClient.instances[0].connected).toBe(true);
    expect(core.MockMCPClient.instances[0].closed).toBe(true);
  });

  it('MCP 服务没有 args 时输出命令名称', async () => {
    mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'mcp.json'), JSON.stringify([
      { name: 'simple', command: 'node' },
    ]), 'utf-8');

    const result = await runCliCommand(mcpCommand, 'list');
    expect(result.logs.join('\n')).toContain('simple  node');
  });

  it('MCP 工具没有描述时仅输出名称', async () => {
    createMcpConfig();
    const core = await import('@wta/core') as any;
    core.MockMCPClient.tools = [{ name: 'demo.echo' }];

    const result = await runCliCommand(mcpCommand, 'tools', 'demo');
    expect(result.logs.join('\n')).toContain('demo.echo');
  });

  it('显示 MCP 工具描述', async () => {
    createMcpConfig();
    const core = await import('@wta/core') as any;
    core.MockMCPClient.tools = [{ name: 'demo.echo', description: '回显工具' }];

    const result = await runCliCommand(mcpCommand, 'tools', 'demo');
    expect(result.logs.join('\n')).toContain('demo.echo  回显工具');
  });

  it('调用 MCP 工具时支持 JSON 参数和空参数', async () => {
    createMcpConfig();

    const withParams = await runCliCommand(mcpCommand, 'call', 'demo', 'demo.echo', '{"value":1}');
    expect(JSON.parse(withParams.logs.join('\n'))).toEqual({
      name: 'demo.echo',
      params: { value: 1 },
    });

    const withoutParams = await runCliCommand(mcpCommand, 'call', 'demo', 'demo.echo');
    expect(JSON.parse(withoutParams.logs.join('\n'))).toEqual({
      name: 'demo.echo',
      params: {},
    });
  });

  it('未找到 MCP 服务时输出中文错误', async () => {
    await expect(runCliCommand(mcpCommand, 'tools', '不存在')).rejects.toThrow('未找到 MCP 服务：不存在');
  });
});
