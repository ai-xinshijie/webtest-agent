import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MCPClient, type MCPTool } from '@wta/core';

interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function loadConfig(): McpServerConfig[] {
  const file = path.join(process.cwd(), '.wta', 'mcp.json');
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf-8')) as McpServerConfig[];
}

function findServer(name: string): McpServerConfig {
  const server = loadConfig().find(item => item.name === name);
  if (!server) throw new Error(`未找到 MCP 服务：${name}`);
  return server;
}

export const mcpCommand = new Command('mcp')
  .description('管理 MCP 外部工具');

mcpCommand
  .command('list')
  .description('列出 MCP 服务')
  .action(() => {
    const servers = loadConfig();
    if (servers.length === 0) {
      console.log('暂无 MCP 服务配置：.wta/mcp.json');
      return;
    }
    for (const server of servers) {
      console.log(`${server.name}  ${server.command} ${(server.args ?? []).join(' ')}`.trimEnd());
    }
  });

mcpCommand
  .command('tools <server>')
  .description('列出 MCP 工具')
  .action(async (name: string) => {
    const config = findServer(name);
    const client = new MCPClient(config);
    await client.connect();
    const tools = await client.listTools();
    await client.close();
    if (tools.length === 0) {
      console.log('该服务没有可用工具');
      return;
    }
    for (const tool of tools as MCPTool[]) {
      console.log(`${tool.name}  ${tool.description ?? ''}`.trimEnd());
    }
  });

mcpCommand
  .command('call <server> <tool>')
  .description('调用 MCP 工具')
  .argument('[params]', 'JSON 参数')
  .action(async (serverName: string, tool: string, params?: string) => {
    const config = findServer(serverName);
    const client = new MCPClient(config);
    await client.connect();
    const result = await client.callTool(tool, params ? JSON.parse(params) as Record<string, unknown> : {});
    await client.close();
    console.log(JSON.stringify(result, null, 2));
  });
