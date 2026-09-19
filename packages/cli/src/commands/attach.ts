import { Command } from 'commander';
import { ensureDaemon } from './daemon.js';

interface TimelineLog {
  id: string;
  sequence: number;
  timestamp: number;
  source: string;
  trigger?: { description?: string };
  result?: { status?: string; error?: string };
}

const sourceText: Record<string, string> = {
  script: '脚本',
  model: '模型',
  system: '系统',
  user: '用户',
};

export const attachCommand = new Command('attach')
  .description('附加到测试会话并实时查看时间线')
  .argument('[sessionId]', '测试会话 ID，默认最近会话')
  .option('--port <port>', 'GUI 服务端口', '7878')
  .action(async (sessionId: string | undefined, options: { port?: string }) => {
    try {
      const baseUrl = await ensureDaemon(Number(options.port));
      let targetSession = sessionId;

      if (!targetSession) {
        const response = await fetch(`${baseUrl}/api/sessions`);
        if (!response.ok) throw new Error(`读取会话列表失败：${response.status}`);
        const sessions = await response.json() as Array<{ id: string }>;
        if (sessions.length === 0) throw new Error('当前没有测试会话');
        targetSession = sessions[0]!.id;
      }

      console.log(`已附加会话：${targetSession}`);
      console.log('按 Ctrl+C 退出');
      let lastSequence = 0;

      const poll = async () => {
        const response = await fetch(`${baseUrl}/api/sessions/${targetSession}/timeline`);
        if (!response.ok) return;
        const logs = await response.json() as TimelineLog[];
        for (const log of logs) {
          if (log.sequence <= lastSequence) continue;
          lastSequence = log.sequence;
          const source = sourceText[log.source] ?? log.source;
          const description = log.trigger?.description ?? '未命名操作';
          const status = log.result?.status ?? 'success';
          const error = log.result?.error ? `，${log.result.error}` : '';
          console.log(`[${new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}] [${source}] ${description} -> ${status}${error}`);
        }
      };

      await poll();
      setInterval(() => void poll(), 1000);
    } catch (error) {
      console.error(`附加失败：${error instanceof Error ? error.message : error}`);
      process.exit(2);
    }
  });
