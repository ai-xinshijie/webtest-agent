import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  AgentLogger,
  ConfigManager,
  DatabaseManager,
  MemoryManager,
  Orchestrator,
  PluginManager,
  type AgentConfig,
  type TargetConfig,
} from '@wta/core';

export interface GuiServerOptions {
  rootDir?: string;
  port?: number;
  host?: string;
}

export interface GuiServerHandle {
  fastify: FastifyInstance;
  port: number;
  close: () => Promise<void>;
}

interface RunRequestBody {
  target: string;
  mode?: TargetConfig['strategy']['runMode'];
  phase?: 'explore' | 'test' | 'combo' | 'chaos';
  parallel?: number;
  headless?: boolean;
  resume?: boolean;
  maxDuration?: number;
}

/**
 * 启动本地 GUI/API 服务。CLI 与 GUI 共用该服务，Agent 以常驻进程方式运行。
 */
export async function startGuiServer(options: GuiServerOptions = {}): Promise<GuiServerHandle> {
  const rootDir = options.rootDir ?? process.cwd();
  const port = options.port ?? 0;
  const host = options.host ?? '127.0.0.1';
  let actualPort = port;
  const configManager = new ConfigManager(rootDir);
  let agentConfig = configManager.load();
  const db = new DatabaseManager(agentConfig.dbPath);
  const memory = new MemoryManager(db);
  let orchestrator: Orchestrator | null = null;

  const fastify = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
  });

  const webRoot = path.join(rootDir, 'packages', 'web', 'dist');
  if (existsSync(webRoot)) {
    await fastify.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
    });
  }

  const screenshotRoot = path.join(rootDir, '.wta', 'screenshots');
  mkdirSync(screenshotRoot, { recursive: true });
  await fastify.register(fastifyStatic, {
    root: screenshotRoot,
    prefix: '/screenshots/',
    decorateReply: false,
  });

  await fastify.register(websocket);
  await fastify.register(async instance => {
    instance.get('/ws', { websocket: true }, connection => {
      const send = () => {
        connection.send(JSON.stringify({
          type: 'status',
          sessions: getSessionSummaries(),
        }));
      };
      send();
      const timer = setInterval(send, 1000);
      connection.on('close', () => clearInterval(timer));
      connection.on('message', () => send());
    });
  });

  const ensureOrchestrator = (): Orchestrator => {
    if (!orchestrator) orchestrator = new Orchestrator(agentConfig);
    return orchestrator;
  };

  const getSessionSummaries = () => db.prepare(`
    SELECT s.id, s.target_id, s.status, s.phase, s.started_at, s.ended_at, s.progress_json,
           t.name AS target_name, t.url AS target_url
    FROM sessions s
    JOIN targets t ON s.target_id = t.id
    ORDER BY s.started_at DESC
    LIMIT 100
  `).all().map(row => {
    const item = row as any;
    return {
      id: item.id,
      targetId: item.target_id,
      targetName: item.target_name,
      targetUrl: item.target_url,
      status: item.status,
      phase: item.phase,
      startedAt: item.started_at,
      endedAt: item.ended_at,
      progress: item.progress_json ? JSON.parse(item.progress_json) : null,
    };
  });

  fastify.get('/api/health', async () => ({
    status: '运行中',
    pid: process.pid,
    port: actualPort,
    startedAt: Math.floor(Date.now() / 1000),
  }));

  fastify.get('/api/config', async () => agentConfig);

  fastify.put('/api/config', async request => {
    const input = request.body as AgentConfig;
    if (!input || typeof input !== 'object') throw new Error('配置格式不正确');
    agentConfig = {
      ...agentConfig,
      ...input,
    };
    configManager.save(agentConfig);
    orchestrator = null;
    return agentConfig;
  });

  fastify.get('/api/targets', async () => configManager.listTargets());

  fastify.get('/api/sessions', async () => getSessionSummaries());

  fastify.get('/api/sessions/:sessionId', async request => {
    const { sessionId } = request.params as { sessionId: string };
    const session = getSessionSummaries().find(item => item.id === sessionId);
    if (!session) throw new Error(`未找到测试会话：${sessionId}`);
    return session;
  });

  fastify.get('/api/sessions/:sessionId/timeline', async request => {
    const { sessionId } = request.params as { sessionId: string };
    return new AgentLogger(db, sessionId).getTimeline();
  });

  fastify.post('/api/run', async (request, reply) => {
    const body = request.body as RunRequestBody;
    if (!body?.target) throw new Error('必须提供测试目标名称');
    const target = configManager.loadTarget(body.target);

    let resumeSessionId: string | undefined;
    if (body.resume) {
      const latest = db.prepare(`
        SELECT id FROM sessions WHERE target_id = ? ORDER BY started_at DESC LIMIT 1
      `).get(target.name) as { id: string } | undefined;
      resumeSessionId = latest?.id;
    }

    const sessionId = resumeSessionId ?? randomUUID();
    const runner = ensureOrchestrator();
    void runner.run(target, {
      sessionId,
      resumeSessionId,
      runMode: body.mode ?? target.strategy.runMode,
      phase: body.phase,
      parallel: body.parallel ?? target.strategy.parallel,
      headless: body.headless,
      maxDuration: body.maxDuration,
    }).catch(error => {
      console.error(`测试会话执行失败：${sessionId}，${error instanceof Error ? error.message : error}`);
    });

    reply.code(202);
    return { sessionId, status: 'running', target: target.name };
  });

  fastify.post('/api/sessions/:sessionId/stop', async request => {
    const { sessionId } = request.params as { sessionId: string };
    if (!orchestrator) throw new Error('当前没有运行中的测试代理');
    await orchestrator.stop(sessionId);
    return { sessionId, status: 'stopped' };
  });

  fastify.post('/api/sessions/:sessionId/resume', async request => {
    const { sessionId } = request.params as { sessionId: string };
    if (!orchestrator) throw new Error('当前没有运行中的测试代理');
    await orchestrator.resume(sessionId);
    return { sessionId, status: 'running' };
  });

  fastify.get('/api/reports', async () => {
    const reportDir = path.join(rootDir, '.wta', 'reports');
    if (!existsSync(reportDir)) return [];
    return readdirSync(reportDir)
      .filter(file => file.endsWith('.md') || file.endsWith('.json'))
      .map(file => {
        const filePath = path.join(reportDir, file);
        return {
          name: file,
          path: filePath,
          format: file.endsWith('.json') ? 'json' : 'md',
          size: statSync(filePath).size,
        };
      })
      .reverse();
  });

  fastify.get('/api/memory', async () => {
    const overview = memory.getOverview();
    const targets = configManager.listTargets().map(target => ({
      name: target.name,
      memory: memory.getTargetMemory(target.name),
    }));
    return { overview, targets };
  });

  const stateFile = path.join(rootDir, '.wta', 'daemon.json');
  let databaseClosed = false;
  const closeDatabase = () => {
    if (databaseClosed) return;
    db.close();
    databaseClosed = true;
  };
  fastify.get('/api/plugins', async () => {
    const manager = new PluginManager(path.join(rootDir, '.wta', 'plugins'));
    return manager.list();
  });

  fastify.post('/api/daemon/stop', async (_request, reply) => {
    reply.header('connection', 'close');
    reply.raw.once('close', () => {
      setImmediate(async () => {
        if (existsSync(stateFile)) rmSync(stateFile);
        await orchestrator?.close();
        await fastify.close();
        closeDatabase();
      });
    });
    return { status: '正在停止' };
  });

  mkdirSync(path.dirname(stateFile), { recursive: true });
  const close = async () => {
    if (existsSync(stateFile)) rmSync(stateFile);
    await orchestrator?.close();
    await fastify.close();
    closeDatabase();
  };

  await fastify.listen({ port, host });
  const address = fastify.server.address();
  actualPort = typeof address === 'object' && address ? address.port : port;
  writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port: actualPort, startedAt: Date.now() }, null, 2), 'utf-8');
  return { fastify, port: actualPort, close };
}
