/**
 * GUI 独立进程入口。库模块不自动监听端口，便于测试和被 CLI 复用。
 */
import { startGuiServer } from './server.js';

export async function startGuiProcess(port: number): Promise<void> {
  const handle = await startGuiServer({ port });
  console.log(`WebTestAgent GUI 已启动：http://127.0.0.1:${handle.port}`);
}

const port = Number(process.env.WTA_PORT ?? 7878);
startGuiProcess(port).catch(error => {
  console.error(`GUI 启动失败：${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
