import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { exec } from 'node:child_process';

interface DaemonState {
  pid?: number;
  port?: number;
}

function rootDir(): string {
  return process.cwd();
}

function stateFile(): string {
  return path.join(rootDir(), '.wta', 'daemon.json');
}

function readState(): DaemonState | null {
  const file = stateFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as DaemonState;
  } catch {
    return null;
  }
}

function serverFile(): string {
  return fileURLToPath(new URL('../../../gui/dist/main.js', import.meta.url));
}

async function health(port = 7878): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureDaemon(port = 7878): Promise<string> {
  if (await health(port)) return `http://127.0.0.1:${port}`;

  const entry = serverFile();
  if (!existsSync(entry)) {
    throw new Error(`GUI 服务不存在：${entry}，请先执行 pnpm build`);
  }

  const child = spawn(process.execPath, [entry], {
    cwd: rootDir(),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WTA_PORT: String(port) },
  });
  child.unref();

  for (let index = 0; index < 40; index++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (await health(port)) return `http://127.0.0.1:${port}`;
  }

  throw new Error(`GUI 服务启动超时：http://127.0.0.1:${port}`);
}

async function stopDaemon(): Promise<void> {
  const state = readState();
  const port = state?.port ?? 7878;
  if (!(await health(port))) {
    console.log('常驻代理未运行');
    return;
  }

  const response = await fetch(`http://127.0.0.1:${port}/api/daemon/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`停止常驻代理失败：${response.status}`);

  for (let index = 0; index < 40; index++) {
    if (!(await health(port))) {
      console.log('常驻代理已停止');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('常驻代理停止超时');
}

async function printStatus(): Promise<void> {
  const state = readState();
  const port = state?.port ?? 7878;
  const running = await health(port);
  console.log(`状态：${running ? '运行中' : '未运行'}`);
  if (state?.pid) console.log(`PID：${state.pid}`);
  console.log(`地址：http://127.0.0.1:${port}`);
}

export const daemonCommand = new Command('daemon')
  .description('管理常驻测试代理');

daemonCommand
  .command('start')
  .description('启动常驻测试代理')
  .option('--port <port>', '服务端口')
  .action(async (options: { port?: string }) => {
    const port = Number(options.port ?? 7878);
    const url = await ensureDaemon(port);
    console.log(`常驻测试代理已启动：${url}`);
  });

daemonCommand
  .command('stop')
  .description('停止常驻测试代理')
  .action(async () => {
    await stopDaemon();
  });

daemonCommand
  .command('status')
  .description('查看常驻测试代理状态')
  .action(async () => {
    await printStatus();
  });

export const guiCommand = new Command('gui')
  .description('启动 GUI 控制台')
  .option('--port <port>', '服务端口')
  .option('--no-open', '不自动打开浏览器')
  .action(async (options: { port?: string; open?: boolean }) => {
    const port = Number(options.port ?? 7878);
    const url = await ensureDaemon(port);
    console.log(`GUI 已启动：${url}`);
    if (options.open !== false) {
      if (process.platform === 'win32') exec(`start "" "${url}"`);
      else if (process.platform === 'darwin') exec(`open "${url}"`);
      else exec(`xdg-open "${url}"`);
    }
  });
