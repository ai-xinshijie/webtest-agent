import type { ModelRouting } from '../config/types.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class LLMRouter {
  private routing: ModelRouting;

  constructor(routing: ModelRouting) {
    this.routing = routing;
  }

  /**
   * Call LLM for a specific task type.
   */
  async call(taskType: string, messages: ChatMessage[]): Promise<string> {
    const config = this.routing[taskType];
    if (!config) {
      throw new Error(`No model routing configured for task: ${taskType}`);
    }

    switch (config.provider) {
      case 'openai':
        return this.callOpenAI(config, messages);
      case 'anthropic':
        return this.callAnthropic(config, messages);
      case 'ollama':
        return this.callOllama(config, messages);
      default:
        throw new Error(`Unsupported provider: ${config.provider}`);
    }
  }

  private async callOpenAI(
    config: { model: string; apiKey?: string; baseUrl?: string; temperature: number; maxTokens: number },
    messages: ChatMessage[],
  ): Promise<string> {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAI API key not configured');

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
      throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as any;
    return data.choices[0]?.message?.content ?? '';
  }

  private async callAnthropic(
    config: { model: string; apiKey?: string; baseUrl?: string; temperature: number; maxTokens: number },
    messages: ChatMessage[],
  ): Promise<string> {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Anthropic API key not configured');

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
      throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
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
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json() as any;
    return data.message?.content ?? '';
  }
}
