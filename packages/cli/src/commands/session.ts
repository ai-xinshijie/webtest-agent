import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseManager } from '@wta/core';

interface SessionRow {
  id: string;
  target_name: string;
  status: string;
  phase: string | null;
  started_at: number;
  ended_at: number | null;
}

interface DaemonState {
  port?: number;
}

function daemonPort(): number {
  const statePath = path.join(process.cwd(), '.wta', 'daemon.json');
  if (!existsSync(statePath)) return 7878;

  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as DaemonState;
    return Number.isFinite(state.port) ? Number(state.port) : 7878;
  } catch {
    return 7878;
  }
}

function databasePath(): string {
  return path.join(process.cwd(), '.wta', 'wta.db');
}

function loadSessions(sessionId?: string, all = false): SessionRow[] {
  const dbPath = databasePath();
  if (!existsSync(dbPath)) return [];

  const db = new DatabaseManager(dbPath);
  try {
    if (sessionId) {
      return db.prepare(`
        SELECT s.id, t.name AS target_name, s.status, s.phase, s.started_at, s.ended_at
        FROM sessions s JOIN targets t ON s.target_id = t.id
        WHERE s.id = ?
      `).all(sessionId) as unknown as SessionRow[];
    }

    const activeOnly = all ? '' : "WHERE s.status IN ('running', 'paused')";
    return db.prepare(`
      SELECT s.id, t.name AS target_name, s.status, s.phase, s.started_at, s.ended_at
      FROM sessions s JOIN targets t ON s.target_id = t.id
      ${activeOnly}
      ORDER BY s.started_at DESC
      LIMIT 100
    `).all() as unknown as SessionRow[];
  } finally {
    db.close();
  }
}

function duration(row: SessionRow): string {
  const end = row.ended_at ?? Date.now();
  return `${((end - row.started_at) / 1000).toFixed(1)}秒`;
}

function printSessions(rows: SessionRow[]): void {
  for (const row of rows) {
    console.log(`  ${row.id.slice(0, 8)}  ${row.target_name.padEnd(15)} ${row.status.padEnd(10)} ${row.phase ?? '-'}  ${duration(row)}`);
  }
}

async function daemonAvailable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export const statusCommand = new Command('status')
  .description('查看测试会话状态')
  .argument('[sessionId]', '测试会话 ID')
  .option('--all', '包含已完成、失败和已停止会话')
  .action(async (sessionId: string | undefined, options: { all?: boolean }) => {
    const port = daemonPort();
    const available = await daemonAvailable(port);
    console.log(`常驻代理：${available ? '运行中' : '未运行'}（http://127.0.0.1:${port}）`);

    const rows = loadSessions(sessionId, Boolean(options.all));
    if (sessionId && rows.length === 0) {
      console.log(`未找到测试会话：${sessionId}`);
      return;
    }
    if (rows.length === 0) {
      console.log(options.all ? '暂无测试会话' : '当前没有运行中的测试会话');
      return;
    }

    console.log('测试会话：');
    printSessions(rows);
  });

export const stopCommand = new Command('stop')
  .description('停止一个或全部活动测试会话')
  .argument('[sessionId]', '要停止的测试会话 ID')
  .option('--all', '停止全部运行中或已暂停的测试会话')
  .option('--port <port>', '常驻代理端口')
  .action(async (sessionId: string | undefined, options: { all?: boolean; port?: string }) => {
    if (!sessionId && !options.all) {
      throw new Error('必须指定测试会话 ID 或 --all');
    }

    const port = Number(options.port ?? daemonPort());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`无效端口：${options.port}`);
    }
    if (!(await daemonAvailable(port))) {
      throw new Error('常驻代理未运行，无法停止活动测试会话');
    }

    const sessions = options.all
      ? loadSessions(undefined, false).map(row => row.id)
      : [sessionId!];
    if (sessions.length === 0) {
      console.log('当前没有可停止的测试会话');
      return;
    }

    for (const id of sessions) {
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/stop`, {
        method: 'POST',
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`停止测试会话失败：${id} ${response.status}${detail ? ` ${detail}` : ''}`);
      }
      console.log(`测试会话已停止：${id}`);
    }
  });
