import { Command } from 'commander';
import { ConfigManager, DatabaseManager, LLMRouter } from '@wta/core';

export const modelCommand = new Command('model')
  .description('管理模型路由');

modelCommand
  .command('list')
  .description('列出模型路由')
  .action(() => {
    const config = new ConfigManager(process.cwd()).load();
    for (const [task, model] of Object.entries(config.models)) {
      console.log(`${task}  ${model.provider}/${model.model}`);
    }
  });

modelCommand
  .command('set <task>')
  .description('设置任务模型')
  .requiredOption('--provider <provider>', 'openai、anthropic、ollama 或 custom')
  .requiredOption('--model <model>', '模型名称')
  .option('--base-url <url>', '自定义或兼容 API 地址')
  .option('--api-key <key>', 'API Key')
  .option('--temperature <temperature>', '温度')
  .option('--max-tokens <tokens>', '最大输出 Token')
  .action((task: string, options: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
    temperature?: string;
    maxTokens?: string;
  }, command: Command) => {
    const configManager = new ConfigManager(process.cwd());
    const config = configManager.load();
    const modelConfig = {
      provider: options.provider as 'openai' | 'anthropic' | 'ollama' | 'custom',
      model: options.model,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      temperature: Number(options.temperature ?? 0),
      maxTokens: Number(options.maxTokens ?? 2000),
    };

    // Commander 的同一个命令对象可重复解析，可选参数不会自动复位。
    for (const key of ['baseUrl', 'apiKey', 'temperature', 'maxTokens'] as const) {
      command.setOptionValue(key, undefined);
    }
    config.models[task] = modelConfig;
    configManager.save(config);
    console.log(`模型路由已更新：${task} -> ${options.provider}/${options.model}`);
  });

modelCommand
  .command('test <task>')
  .description('测试模型连通性')
  .action(async (task: string) => {
    const config = new ConfigManager(process.cwd()).load();
    const router = new LLMRouter(config.models);
    const response = await router.call(task, [
      { role: 'user', content: '请返回：连接正常' },
    ]);
    console.log(response);
  });

modelCommand
  .command('stats')
  .description('查看模型调用统计')
  .action(() => {
    const config = new ConfigManager(process.cwd()).load();
    const db = new DatabaseManager(config.dbPath);
    let rows: Array<{ log_json: string }>;
    try {
      rows = db.prepare(`
        SELECT log_json FROM agent_logs WHERE source = 'model'
      `).all() as Array<{ log_json: string }>;
    } finally {
      db.close();
    }
    const stats = new Map<string, { calls: number; failed: number; tokens: number }>();
    for (const row of rows) {
      const log = JSON.parse(row.log_json) as {
        model?: { model?: string };
        result?: { status?: string };
      };
      const name = log.model?.model ?? '未知模型';
      const current = stats.get(name) ?? { calls: 0, failed: 0, tokens: 0 };
      current.calls++;
      if (log.result?.status === 'failed') current.failed++;
      stats.set(name, current);
    }

    if (stats.size === 0) {
      console.log('暂无模型调用记录');
      return;
    }
    for (const [name, stat] of stats) {
      console.log(`${name}  调用 ${stat.calls} 次  失败 ${stat.failed} 次`);
    }
  });
