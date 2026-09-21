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

  /**
   * 调用支持 OpenAI Chat Completions 协议的视觉模型。截图只随请求发送，
   * 审计日志保留文字摘要，避免把大尺寸图片重复写入本地数据库。
   */
  async callVisionWithLog(
    taskType: string,
    messages: ChatMessage[],
    screenshotBase64: string,
    logger: AgentLogger,
    context: AgentLogContext,
  ): Promise<string> {
    const config = this.routing[taskType];
    if (!config) throw new Error('未配置任务类型 ' + taskType + ' 的模型路由');
    if (config.provider !== 'openai' && config.provider !== 'custom') {
      throw new Error('视觉模型当前仅支持 OpenAI 兼容接口');
    }

    const response = await logger.runModel(
      { description: '调用 ' + taskType + ' 视觉模型', module: 'LLMRouter', method: 'callVisionWithLog' },
      { type: 'vision-model-call', target: config.model, params: { taskType, provider: config.provider, screenshot: '已附加' } },
      {
        provider: config.provider,
        model: config.model,
        taskType,
        request: { messages: [...messages, { role: 'user', content: '已附加当前页面 PNG 截图。' }] },
      },
      async () => ({ content: await this.callOpenAICompatibleVision(config, messages, screenshotBase64) }),
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

  private async callOpenAICompatibleVision(
    config: { model: string; apiKey?: string; baseUrl?: string; temperature: number; maxTokens: number },
    messages: ChatMessage[],
    screenshotBase64: string,
  ): Promise<string> {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('未配置视觉模型 API Key');
    if (!config.baseUrl) throw new Error('自定义视觉模型必须配置 baseUrl');
    const imageDataUrl = 'data' + ':image/png;base64,' + screenshotBase64;

    const response = await fetch(config.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: config.model,
        messages: [
          ...messages,
          {
            role: 'user',
            content: [
              { type: 'text', text: '请结合这张当前页面截图完成上面的任务。' },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      }),
    });
    if (!response.ok) throw new Error('视觉模型请求失败：' + response.status + ' ' + await response.text());
    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content ?? '';
  }
}
