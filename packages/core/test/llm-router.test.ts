import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseManager } from '../src/db/Database.js';
import { AgentLogger } from '../src/logger/AgentLogger.js';
import { LLMRouter, type ChatMessage } from '../src/llm/LLMRouter.js';
import type { ModelRouting } from '../src/config/types.js';

const messages: ChatMessage[] = [
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '用户输入' },
];

let fetchMock: ReturnType<typeof vi.fn>;
let tempDir = '';
let db: DatabaseManager | null = null;

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function createLogger(): AgentLogger {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-llm-'));
  db = new DatabaseManager(path.join(tempDir, 'test.db'));
  db.prepare(`
    INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
    VALUES ('target-1', '测试目标', 'https://example.com', '{}', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO sessions (id, target_id, status, started_at, phase)
    VALUES ('session-1', 'target-1', 'running', 1, 'test')
  `).run();
  return new AgentLogger(db, 'session-1', { consoleOutput: false });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  db?.close();
  db = null;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('LLMRouter', () => {
  it('调用 OpenAI 兼容接口并支持环境变量鉴权', async () => {
    process.env.OPENAI_API_KEY = '环境变量密钥';
    fetchMock.mockResolvedValue(response({ choices: [{ message: { content: 'OpenAI 结果' } }] }));
    const router = new LLMRouter({
      test: { provider: 'openai', model: 'gpt-test', baseUrl: 'http://openai.test', temperature: 0.1, maxTokens: 100 },
    });

    await expect(router.call('test', messages)).resolves.toBe('OpenAI 结果');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://openai.test/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer 环境变量密钥' }),
      }),
    );
  });

  it('调用 Anthropic 时拆分系统提示并传递密钥', async () => {
    fetchMock.mockResolvedValue(response({ content: [{ type: 'text', text: 'Anthropic 结果' }] }));
    const router = new LLMRouter({
      test: { provider: 'anthropic', model: 'claude-test', baseUrl: 'http://anthropic.test', apiKey: 'anthropic-key', temperature: 0, maxTokens: 100 },
    });

    await expect(router.call('test', messages)).resolves.toBe('Anthropic 结果');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      system: '系统提示',
      messages: [{ role: 'user', content: '用户输入' }],
    });
    expect(init.headers).toMatchObject({ 'x-api-key': 'anthropic-key' });
  });

  it('调用 Ollama 并返回模型消息', async () => {
    fetchMock.mockResolvedValue(response({ message: { content: 'Ollama 结果' } }));
    const router = new LLMRouter({
      test: { provider: 'ollama', model: 'llama-test', baseUrl: 'http://ollama.test', temperature: 0.2, maxTokens: 80 },
    });

    await expect(router.call('test', messages)).resolves.toBe('Ollama 结果');
    expect(fetchMock).toHaveBeenCalledWith('http://ollama.test/api/chat', expect.anything());
  });

  it('调用自定义模型并写入模型审计日志', async () => {
    fetchMock.mockResolvedValue(response({ choices: [{ message: { content: '自定义结果' } }] }));
    const logger = createLogger();
    const routing: ModelRouting = {
      test: { provider: 'custom', model: 'custom-model', baseUrl: 'http://custom.test', apiKey: 'custom-key', temperature: 0, maxTokens: 50 },
    };
    const router = new LLMRouter(routing);

    await expect(router.callWithLog('test', messages, logger, { phase: 'test' })).resolves.toBe('自定义结果');
    const call = logger.getModelCalls()[0]!;
    expect(call.model).toMatchObject({ provider: 'custom', model: 'custom-model', taskType: 'test' });
    expect(call.result.status).toBe('success');
  });

  it('任务类型、提供方和鉴权缺失时返回中文错误', async () => {
    const router = new LLMRouter({});
    await expect(router.call('missing', messages)).rejects.toThrow('未配置任务类型 missing 的模型路由');

    const invalid = new LLMRouter({
      test: { provider: 'unsupported' as never, model: 'x', temperature: 0, maxTokens: 1 },
    });
    await expect(invalid.call('test', messages)).rejects.toThrow('不支持的模型提供方：unsupported');

    const noKey = new LLMRouter({
      test: { provider: 'openai', model: 'gpt-test', temperature: 0, maxTokens: 1 },
    });
    await expect(noKey.call('test', messages)).rejects.toThrow('未配置 OpenAI API Key');

    const noAnthropicKey = new LLMRouter({
      test: { provider: 'anthropic', model: 'claude-test', temperature: 0, maxTokens: 1 },
    });
    await expect(noAnthropicKey.call('test', messages)).rejects.toThrow('未配置 Anthropic API Key');
  });

  it('模型 HTTP 失败时保留提供方错误信息', async () => {
    fetchMock.mockResolvedValue(response({ error: '请求失败' }, false));
    const router = new LLMRouter({
      openai: { provider: 'openai', model: 'gpt-test', apiKey: 'key', temperature: 0, maxTokens: 1 },
      anthropic: { provider: 'anthropic', model: 'claude-test', apiKey: 'key', temperature: 0, maxTokens: 1 },
      ollama: { provider: 'ollama', model: 'llama-test', temperature: 0, maxTokens: 1 },
      custom: { provider: 'custom', model: 'custom-test', baseUrl: 'http://custom.test', temperature: 0, maxTokens: 1 },
    });

    await expect(router.call('openai', messages)).rejects.toThrow('OpenAI API 请求失败：500');
    await expect(router.call('anthropic', messages)).rejects.toThrow('Anthropic API 请求失败：500');
    await expect(router.call('ollama', messages)).rejects.toThrow('Ollama API 请求失败：500');
    await expect(router.call('custom', messages)).rejects.toThrow('自定义模型请求失败：500');
  });

  it('模型响应缺失内容时返回空字符串并支持默认地址', async () => {
    fetchMock.mockResolvedValue(response({}));
    const router = new LLMRouter({
      openai: { provider: 'openai', model: 'gpt-test', apiKey: 'key', temperature: 0, maxTokens: 1 },
      anthropic: { provider: 'anthropic', model: 'claude-test', apiKey: 'key', temperature: 0, maxTokens: 1 },
      ollama: { provider: 'ollama', model: 'llama-test', temperature: 0, maxTokens: 1 },
      custom: { provider: 'custom', model: 'custom-test', baseUrl: 'http://custom.test', temperature: 0, maxTokens: 1 },
    });

    await expect(router.call('openai', messages)).resolves.toBe('');
    await expect(router.call('anthropic', messages)).resolves.toBe('');
    await expect(router.call('ollama', messages)).resolves.toBe('');
    await expect(router.call('custom', messages)).resolves.toBe('');
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://api.openai.com/v1/chat/completions',
      'https://api.anthropic.com/v1/messages',
      'http://localhost:11434/api/chat',
      'http://custom.test',
    ]);
  });

  it('自定义模型不配置密钥时不会传递认证头', async () => {
    fetchMock.mockResolvedValue(response({ content: [{ text: '备用内容' }] }));
    const router = new LLMRouter({
      test: { provider: 'custom', model: 'custom-model', baseUrl: 'http://custom.test', temperature: 0, maxTokens: 1 },
    });
    await expect(router.call('test', messages)).resolves.toBe('备用内容');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('Authorization');
  });
});
