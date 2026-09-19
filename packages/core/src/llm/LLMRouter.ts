import type { ModelRouting } from '../config/types.js';
import type { AgentLogger, AgentLogContext } from '../logger/AgentLogger.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type { ChatMessage };

export class LLMRouter {
  private routing: ModelRouting;

  constructor(routing: ModelRouting) {
    this.routing = routing;
  }

  /**
   * 按任务类型调用模型。
   */
  async call(taskType: string, messages: ChatMessage[]): Promise<string> {
    const config = this.routing[taskType];
    if (!config) {
      throw new Error(`未配置任务类型 ${taskType} 的模型路由`);
    }

    switch (config.provider) {
      case 'openai':
        return this.callOpenAI(config, messages);
      case 'anthropic':
        return this.callAnthropic(config, messages);
      case 'ollama':
        return this.callOllama(config, messages);
      case 'custom':
        return this.callCustom(config, messages);
      default:
        throw new Error(`不支持的模型提供方：${config.provider}`);
    }
  }

  /** 调用模型并写入完整审计日志。 */
  async callWithLog(
    taskType: string,
    messages: ChatMessage[],
    logger: AgentLogger,
    context: AgentLogContext,
  ): Promise<string> {
    const config = this.routing[taskType];
    if (!config) throw new Error(`未配置任务类型 ${taskType} 的模型路由`);

    const response = await logger.runModel(
      {
        description: `调用 ${taskType} 模型`,
        module: 'LLMRouter',
        method: 'callWithLog',
      },
      {
        type: 'model-call',
        target: config.model,
        params: { taskType, provider: config.provider },
      },
      {
        provider: config.provider,
        model: config.model,
        taskType,
        request: { messages },
      },
      async () => ({ content: await this.call(taskType, messages) }),
      context,
    );
    return response.content;
  }

  private async callOpenAI(
    config: { model: string; apiKey?: string; baseUrl?: string; temperature: number; maxTokens: number },
    messages: ChatMessage[],
  ): Promise<string> {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('未配置 OpenAI API Key');

    const response = await fetch(
      (config.baseUrl || 'https://api.openai.com/v1') + '/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`OpenAI API 请求失败：${response.status} ${await response.text()}`);
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content ?? '';
  }

  private async callAnthropic(
    config: { model: string; apiKey?: string; baseUrl?: string; temperature: number; maxTokens: number },
    messages: ChatMessage[],
  ): Promise<string> {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('未配置 Anthropic API Key');

    const systemMessage = messages.find(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const response = await fetch(
      (config.baseUrl || 'https://api.anthropic.com') + '/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          system: systemMessage?.content,
          messages: nonSystemMessages,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Anthropic API 请求失败：${response.status} ${await response.text()}`);
    }

    const data = await response.json() as any;
    return data.content?.[0]?.text ?? '';
  }

  private async callOllama(
    config: { model: string; baseUrl?: string; temperature: number; maxTokens: number },
    messages: ChatMessage[],
  ): Promise<string> {
    const response = await fetch(
      (config.baseUrl || 'http://localhost:11434') + '/api/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: false,
          options: {
            temperature: config.temperature,
            num_predict: config.maxTokens,
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Ollama API 请求失败：${response.status}`);
    }

    const data = await response.json() as any;
    return data.message?.content ?? '';
  }

  private async callCustom(
    config: { model: string; baseUrl?: string; apiKey?: string; temperature: number; maxTokens: number },
    messages: ChatMessage[],
  ): Promise<string> {
    if (!config.baseUrl) throw new Error('自定义模型必须配置 baseUrl');

    const response = await fetch(config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      }),
    });

    if (!response.ok) {
      throw new Error(`自定义模型请求失败：${response.status} ${await response.text()}`);
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? '';
  }
}
