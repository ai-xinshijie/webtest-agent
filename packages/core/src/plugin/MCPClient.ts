import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * 标准 MCP stdio 客户端，使用换行分隔的 JSON-RPC 消息。
 */
export class MCPClient {
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private buffer = '';
  private initialized = false;

  constructor(private config: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }) {}

  async connect(): Promise<void> {
    if (this.initialized) return;
    this.process = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout.setEncoding('utf-8');
    this.process.stdout.on('data', chunk => this.handleChunk(chunk));
    this.process.stderr.setEncoding('utf-8');
    this.process.stderr.on('data', chunk => {
      const text = chunk.trim();
      if (text) console.warn(`MCP 服务日志：${text}`);
    });
    this.process.on('exit', () => this.rejectAll(new Error('MCP 服务已退出')));

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'WebTestAgent', version: '1.0.0' },
    });
    await this.notify('notifications/initialized');
    this.initialized = true;
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request('tools/list') as { tools?: MCPTool[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args });
  }

  async close(): Promise<void> {
    if (!this.process) return;
    this.process.kill();
    this.process = undefined;
    this.initialized = false;
    this.rejectAll(new Error('MCP 客户端已关闭'));
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleMessage(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private handleMessage(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      console.warn(`忽略无法解析的 MCP 消息：${line.slice(0, 200)}`);
      return;
    }

    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID();
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
    return new Promise((resolve, reject) => {
      const timeoutMs = this.config.timeoutMs ?? 30000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage(message);
    });
  }

  private notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.writeMessage({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    return Promise.resolve();
  }

  private writeMessage(message: JsonRpcRequest | { jsonrpc: '2.0'; method: string; params?: Record<string, unknown> }): void {
    if (!this.process?.stdin.writable) throw new Error('MCP 服务未连接');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
