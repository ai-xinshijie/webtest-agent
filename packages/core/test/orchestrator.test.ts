import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const page = {
    goto: vi.fn(async (url: string) => url),
    url: vi.fn(() => 'https://example.com/page'),
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  };
  const observation = {
    type: 'structured',
    timestamp: 1,
    url: 'https://example.com/page?x=1',
    title: '测试页面',
    components: [{
      tag: 'button',
      role: 'button',
      text: '提交',
      classes: ['btn'],
      ariaLabel: '提交',
      placeholder: null,
      state: { visible: true, enabled: true, inViewport: true, cursorPointer: true, userSelectNone: false },
      clickability: {
        score: 1,
        isInteractive: true,
        isHighConfidence: true,
        signals: {
          isSemanticTag: true,
          hasAriaRole: true,
          cursorPointer: true,
          hasOnclick: false,
          hasTabIndex: false,
        },
      },
      required: true,
      maxLength: 10,
      pattern: '^a',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      selector: 'button',
    }],
    forms: [],
    dialogCount: 0,
    loadingOverlayCount: 0,
    networkEvents: [],
  };
  const testResult = {
    executedActions: 1,
    skippedActions: 0,
    executedCombinations: 1,
    skippedCombinations: 0,
    executedPaths: 1,
    skippedPaths: 0,
    chaosTests: 1,
    coverage: {
      actions: { visited: 1, blocked: 0, pending: 0, percentage: 100 },
      combinations: { covered: 1, total: 1, percentage: 100 },
      paths: { covered: 1, total: 1, percentage: 100 },
    },
  };
  return {
    page,
    context,
    observation,
    testResult,
    createContext: vi.fn(async () => context),
    closeSession: vi.fn(async () => {}),
    restart: vi.fn(async () => ({})),
    close: vi.fn(async () => {}),
    getSessionIds: vi.fn(() => [] as string[]),
    capture: vi.fn(async () => observation),
    login: vi.fn(async () => ({ success: true, performed: false })),
    saveState: vi.fn(async () => {}),
    explore: vi.fn(async () => ({ pages: 1 })),
    runTest: vi.fn(async () => testResult),
    screenshot: vi.fn(async () => ({ filePath: 'screenshot.png' })),
    saveReport: vi.fn(() => 'report.md'),
    clearMemory: vi.fn(),
    clearTestedItems: vi.fn(),
    getTargetMemory: vi.fn(() => ({ testedItems: [], rules: [], patterns: [], summaries: [] })),
    compressSession: vi.fn(async () => ({ summary: '会话摘要' })),
  };
});

vi.mock('../src/browser/BrowserManager.js', () => ({
  BrowserManager: class {
    async createContext(...args: unknown[]) { return mocks.createContext(...args); }
    async closeSession(...args: unknown[]) { return mocks.closeSession(...args); }
    async restart(...args: unknown[]) { return mocks.restart(...args); }
    async close(...args: unknown[]) { return mocks.close(...args); }
    getSessionIds(...args: unknown[]) { return mocks.getSessionIds(...args); }
  },
}));
vi.mock('../src/perception/StructuredPerceiver.js', () => ({
  StructuredPerceiver: class { async capture(...args: unknown[]) { return mocks.capture(...args); } },
}));
vi.mock('../src/tester/InteractionExecutor.js', () => ({
  InteractionExecutor: class { setLogger() {} },
}));
vi.mock('../src/tester/TestEngine.js', () => ({
  TestEngine: class { async run(...args: unknown[]) { return mocks.runTest(...args); } },
}));
vi.mock('../src/exploration/BFSExplorer.js', () => ({
  BFSExplorer: class { async explore(...args: unknown[]) { return mocks.explore(...args); } },
}));
vi.mock('../src/exploration/ComponentRevealer.js', () => ({
  ComponentRevealer: class {},
}));
vi.mock('../src/auth/AuthSessionManager.js', () => ({
  AuthSessionManager: class {
    async login(...args: unknown[]) { return mocks.login(...args); }
    async saveState(...args: unknown[]) { return mocks.saveState(...args); }
  },
}));
vi.mock('../src/memory/MemoryManager.js', () => ({
  MemoryManager: class {
    clear(...args: unknown[]) { return mocks.clearMemory(...args); }
    clearTestedItems(...args: unknown[]) { return mocks.clearTestedItems(...args); }
    getTargetMemory(...args: unknown[]) { return mocks.getTargetMemory(...args); }
    async compressSession(...args: unknown[]) { return mocks.compressSession(...args); }
  },
}));
vi.mock('../src/llm/LLMRouter.js', () => ({
  LLMRouter: class {},
}));
vi.mock('../src/reporter/ScreenshotManager.js', () => ({
  ScreenshotManager: class { async capture(...args: unknown[]) { return mocks.screenshot(...args); } },
}));
vi.mock('../src/reporter/ReportGenerator.js', () => ({
  ReportGenerator: class { save(...args: unknown[]) { return mocks.saveReport(...args); } },
}));

import { DatabaseManager } from '../src/db/Database.js';
import { AgentLogger } from '../src/logger/AgentLogger.js';
import { BUILTIN_RULES } from '../src/cognition/QualityRule.js';
import { Orchestrator } from '../src/orchestrator/Orchestrator.js';
import type { AgentConfig, TargetConfig } from '../src/config/types.js';

let tempDir = '';
let originalCwd = '';
let db: DatabaseManager;
let consoleSpy: ReturnType<typeof vi.spyOn>;

function createTarget(overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    name: 'demo',
    url: 'https://example.com/home',
    credentials: { username: 'user', password: 'pass' },
    strategy: {
      runMode: 'continue',
      depth: 'deep',
      maxDuration: 600,
      maxPages: 20,
      parallel: 1,
      screenshot: 'always',
      video: false,
      headless: true,
    },
    scope: { includePaths: [], excludePaths: [] },
    ...overrides,
  };
}

function createConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    dbPath: path.join(tempDir, 'wta.db'),
    browserDir: path.join(tempDir, 'browsers'),
    defaultBrowser: 'chromium',
    headless: true,
    viewport: { width: 1920, height: 1080 },
    timeout: { navigation: 1000, action: 1000, screenshot: 1000 },
    parallel: 1,
    models: {},
    logLevel: 'info',
    ...overrides,
  };
}

function insertTarget(target = createTarget()) {
  db.prepare(`
    INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(target.name, target.name, target.url, JSON.stringify(target), 1, 1);
}

function insertPage(id: string, urlPattern: string, targetId = 'demo') {
  db.prepare(`
    INSERT INTO pages (id, target_id, url_pattern, title, role, first_seen_at, last_visited_at, visit_count, test_status)
    VALUES (?, ?, ?, '页面', 'unknown', 1, 1, 1, 'partial')
  `).run(id, targetId, urlPattern);
}

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-orchestrator-'));
  process.chdir(tempDir);
  mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
  db = new DatabaseManager(createConfig().dbPath);
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  vi.clearAllMocks();
  mocks.page.goto.mockClear();
  mocks.page.url.mockClear();
  mocks.context.newPage.mockClear().mockImplementation(async () => mocks.page);
  mocks.createContext.mockClear().mockImplementation(async () => mocks.context);
  mocks.closeSession.mockClear().mockResolvedValue(undefined);
  mocks.restart.mockClear().mockResolvedValue({});
  mocks.close.mockClear().mockResolvedValue(undefined);
  mocks.getSessionIds.mockClear().mockReturnValue([]);
  mocks.capture.mockClear().mockResolvedValue(mocks.observation);
  mocks.login.mockClear().mockResolvedValue({ success: true, performed: false });
  mocks.saveState.mockClear().mockResolvedValue(undefined);
  mocks.explore.mockClear().mockResolvedValue({ pages: 1 });
  mocks.runTest.mockClear().mockResolvedValue(mocks.testResult);
  mocks.screenshot.mockClear().mockResolvedValue({ filePath: 'screenshot.png' });
  mocks.saveReport.mockClear().mockReturnValue('report.md');
  mocks.clearMemory.mockClear();
  mocks.clearTestedItems.mockClear();
  mocks.getTargetMemory.mockClear().mockReturnValue({ testedItems: [], rules: [], patterns: [], summaries: [] });
  mocks.compressSession.mockClear().mockResolvedValue({ summary: '会话摘要' });
});

afterEach(async () => {
  await new Orchestrator(createConfig()).close().catch(() => undefined);
  db?.close();
  consoleSpy?.mockRestore();
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('Orchestrator', () => {
  it('执行完整深度测试并生成双格式报告', async () => {
    insertTarget();
    insertPage('page-1', '/page');
    const orchestrator = new Orchestrator(createConfig());

    const session = await orchestrator.run(createTarget(), { sessionId: 'session-1' });

    expect(session.status).toBe('completed');
    expect(session.phase).toBe('report');
    expect(session.reportPaths).toEqual(['report.md', 'report.md']);
    expect(session.progress).toMatchObject({ executedActions: 1, executedCombinations: 1 });
    expect(mocks.page.goto).toHaveBeenCalledWith('https://example.com/home', expect.anything());
    expect(mocks.explore).toHaveBeenCalled();
    expect(mocks.runTest).toHaveBeenCalled();
    expect(mocks.compressSession).toHaveBeenCalledWith('session-1', expect.anything());

    const row = db.prepare(`SELECT status, phase, progress_json FROM sessions WHERE id = 'session-1'`).get() as any;
    expect(row.status).toBe('completed');
    expect(row.phase).toBe('report');
    expect(JSON.parse(row.progress_json).coverage.actions.percentage).toBe(100);
    await orchestrator.close();
  });

  it('仅执行探索阶段并跳过测试引擎', async () => {
    insertTarget();
    insertPage('page-1', '/page');
    const orchestrator = new Orchestrator(createConfig());

    const session = await orchestrator.run(createTarget(), { sessionId: 'session-explore', phase: 'explore' });

    expect(session.status).toBe('completed');
    expect(mocks.explore).toHaveBeenCalled();
    expect(mocks.runTest).not.toHaveBeenCalled();
    await orchestrator.close();
  });

  it('直接执行测试阶段并按并行数创建工作页面', async () => {
    insertTarget();
    insertPage('page-1', '/page-1');
    insertPage('page-2', '/page-2');
    const orchestrator = new Orchestrator(createConfig());

    const session = await orchestrator.run(
      createTarget({ strategy: { ...createTarget().strategy, parallel: 2 } }),
      { sessionId: 'session-test', phase: 'test', parallel: 2 },
    );

    expect(session.status).toBe('completed');
    expect(mocks.explore).not.toHaveBeenCalled();
    expect(mocks.createContext).toHaveBeenCalledTimes(2);
    expect(mocks.runTest).toHaveBeenCalledTimes(2);
    expect(mocks.closeSession).toHaveBeenCalledWith('session-test:worker-1');
    await orchestrator.close();
  });

  it('fresh 和 retest 模式清理对应记忆', async () => {
    insertTarget();
    insertPage('page-1', '/page');
    const orchestrator = new Orchestrator(createConfig());

    await orchestrator.run(createTarget({ strategy: { ...createTarget().strategy, runMode: 'fresh' } }), { sessionId: 'fresh' });
    await orchestrator.run(createTarget({ strategy: { ...createTarget().strategy, runMode: 'retest' } }), { sessionId: 'retest' });

    expect(mocks.clearMemory).toHaveBeenCalledWith('demo');
    expect(mocks.clearTestedItems).toHaveBeenCalledWith('demo');
    await orchestrator.close();
  });

  it('登录成功后保存会话状态', async () => {
    insertTarget();
    insertPage('page-1', '/page');
    mocks.login.mockResolvedValueOnce({ success: true, performed: true, reason: undefined });
    const orchestrator = new Orchestrator(createConfig());

    const session = await orchestrator.run(createTarget(), { sessionId: 'login-success' });
    expect(session.status).toBe('completed');
    expect(mocks.saveState).toHaveBeenCalled();
    await orchestrator.close();
  });

  it('自动登录失败时会话失败并写入中文错误', async () => {
    insertTarget();
    mocks.login.mockResolvedValueOnce({ success: false, performed: true, reason: '账号密码错误' });
    const orchestrator = new Orchestrator(createConfig());

    await expect(orchestrator.run(createTarget(), { sessionId: 'login-failed' }))
      .rejects.toThrow('自动登录失败：账号密码错误');
    const row = db.prepare(`SELECT status FROM sessions WHERE id = 'login-failed'`).get() as any;
    expect(row.status).toBe('failed');
    await orchestrator.close();
  });

  it('测试阶段没有页面时返回中文错误', async () => {
    insertTarget();
    const orchestrator = new Orchestrator(createConfig());

    await expect(orchestrator.run(createTarget(), { sessionId: 'no-page', phase: 'test' }))
      .rejects.toThrow('探索完成后没有可测试页面');
    await orchestrator.close();
  });

  it('浏览器崩溃后自愈重启并继续执行', async () => {
    insertTarget();
    insertPage('page-1', '/page');
    mocks.createContext
      .mockRejectedValueOnce(new Error('Target closed'))
      .mockResolvedValueOnce(mocks.context);
    const orchestrator = new Orchestrator(createConfig());

    const session = await orchestrator.run(createTarget(), { sessionId: 'recover' });
    expect(session.status).toBe('completed');
    expect(mocks.restart).toHaveBeenCalledTimes(1);
    expect(mocks.createContext).toHaveBeenCalledTimes(2);
    await orchestrator.close();
  });

  it('人为停止后不再把会话标记为失败', async () => {
    insertTarget();
    let rejectCreateContext: ((error: Error) => void) | null = null;
    mocks.createContext.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectCreateContext = reject;
    }));
    const orchestrator = new Orchestrator(createConfig());
    const running = orchestrator.run(createTarget(), { sessionId: 'stopped' });

    await orchestrator.stop('stopped');
    rejectCreateContext?.(new Error('用户停止'));
    const session = await running;

    expect(session.status).toBe('stopped');
    const row = db.prepare(`SELECT status FROM sessions WHERE id = 'stopped'`).get() as any;
    expect(row.status).toBe('stopped');
    await orchestrator.close();
  });

  it('停止时关闭主会话和全部工作会话', async () => {
    insertTarget();
    insertPage('page-1', '/page');
    const orchestrator = new Orchestrator(createConfig());
    const session = await orchestrator.run(createTarget(), { sessionId: 'stop-workers' });
    mocks.getSessionIds.mockReturnValue(['stop-workers:worker-1', 'other:worker-1']);

    await orchestrator.stop('stop-workers');

    expect(session.status).toBe('stopped');
    expect(mocks.closeSession).toHaveBeenCalledWith('stop-workers');
    expect(mocks.closeSession).toHaveBeenCalledWith('stop-workers:worker-1');
    expect(mocks.closeSession).not.toHaveBeenCalledWith('other:worker-1');
    await orchestrator.close();
  });

  it('暂停、恢复、查询状态和读取时间线', async () => {
    insertTarget();
    insertPage('page-1', '/page');
    const orchestrator = new Orchestrator(createConfig());
    await orchestrator.run(createTarget(), { sessionId: 'session-state' });

    await orchestrator.pause('session-state');
    expect((orchestrator.getStatus('session-state') as any).status).toBe('paused');

    const resumed = await orchestrator.resume('session-state');
    expect(resumed.status).toBe('completed');

    expect(orchestrator.getStatus()).toBeInstanceOf(Map);
    expect(orchestrator.getTimeline('session-state').length).toBeGreaterThan(0);
    await orchestrator.close();
  });

  it('从数据库恢复没有内存态的会话', async () => {
    insertTarget();
    insertPage('page-1', '/page');
    const orchestrator = new Orchestrator(createConfig());
    await orchestrator.run(createTarget(), { sessionId: 'db-resume' });
    await orchestrator.close();

    const restored = new Orchestrator(createConfig());
    expect(restored.getTimeline('db-resume').length).toBeGreaterThan(0);
    const session = await restored.resume('db-resume');
    expect(session.status).toBe('completed');
    await restored.close();
  });

  it('恢复会话与目标不一致时返回中文错误', async () => {
    insertTarget();
    insertTarget(createTarget({ name: 'other' }));
    db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at, phase)
      VALUES ('mismatch', 'other', 'completed', 1, 'report')
    `).run();
    const orchestrator = new Orchestrator(createConfig());

    await expect(orchestrator.run(createTarget(), { resumeSessionId: 'mismatch' }))
      .rejects.toThrow('恢复会话与测试目标不一致');
    await orchestrator.close();
  });

  it('质量规则发现缺陷并记录规则异常', async () => {
    insertTarget();
    db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at, phase)
      VALUES ('quality', 'demo', 'running', 1, 'test')
    `).run();
    const orchestrator = new Orchestrator(createConfig());
    const session = {
      id: 'quality',
      targetId: 'demo',
      logger: new AgentLogger(db, 'quality', { consoleOutput: false }),
    } as any;
    const brokenObservation = {
      ...mocks.observation,
      networkEvents: [{ url: 'https://example.com/api', method: 'GET', status: 500, resourceType: 'fetch' }],
    };

    const results = await (orchestrator as any).runQualityRules(session, brokenObservation);
    expect(results[0].violation).toMatchObject({ ruleId: 'QR006', severity: 'critical' });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM bugs`).get()).toEqual({ count: 1 });

    const crashRule = BUILTIN_RULES.find(rule => rule.id === 'QR006')!;
    const checkSpy = vi.spyOn(crashRule, 'check').mockRejectedValue(new Error('规则失败'));
    const caughtResults = await (orchestrator as any).runQualityRules(session, mocks.observation);
    checkSpy.mockRestore();

    expect(caughtResults).toEqual([]);
    expect(session.logger.getTimeline().some(log => log.result.error === '规则失败')).toBe(true);
    await orchestrator.close();
  });

  it('合并结果并处理零覆盖分支', async () => {
    const orchestrator = new Orchestrator(createConfig()) as any;
    const empty = orchestrator.mergeResults([]);
    expect(empty.coverage.actions.percentage).toBe(100);
    expect(empty.coverage.combinations.percentage).toBe(100);
    expect(empty.coverage.paths.percentage).toBe(100);

    const merged = orchestrator.mergeResults([mocks.testResult, {
      ...mocks.testResult,
      coverage: {
        actions: { visited: 1, blocked: 1, pending: 1, percentage: 0 },
        combinations: { covered: 1, total: 2, percentage: 0 },
        paths: { covered: 1, total: 2, percentage: 0 },
      },
    }]);
    expect(merged.executedActions).toBe(2);
    expect(merged.coverage.actions.percentage).toBe(50);
    expect(merged.coverage.combinations.percentage).toBeCloseTo(66.67);
    await orchestrator.close();
  });

  it('提取组件约束并标准化 URL', async () => {
    const orchestrator = new Orchestrator(createConfig()) as any;
    expect(orchestrator.extractConstraints(mocks.observation.components[0])).toEqual([
      { type: 'required', value: true },
      { type: 'maxLength', value: 10 },
      { type: 'pattern', value: '^a' },
    ]);
    expect(orchestrator.normalizeUrl('https://example.com/page?x=1')).toBe('https://example.com/page');
    expect(orchestrator.normalizeUrl('不是 URL')).toBe('不是 URL');
    await orchestrator.close();
  });

  it('构建已存在和新建两种页面组件模型', async () => {
    insertTarget();
    insertPage('existing-page', 'https://example.com/page');
    const orchestrator = new Orchestrator(createConfig()) as any;
    orchestrator.currentTargetId = 'demo';

    const existing = orchestrator.buildComponentModel(mocks.observation);
    expect(existing.pages[0].id).toBe('existing-page');

    const created = orchestrator.buildComponentModel({ ...mocks.observation, url: 'https://example.com/new-page' });
    expect(created.pages[0].id).not.toBe('existing-page');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM components`).get()).toEqual({ count: 2 });
    await orchestrator.close();
  });

  it('截图失败时记录警告日志', async () => {
    const orchestrator = new Orchestrator(createConfig()) as any;
    const logger = { logScript: vi.fn() };
    orchestrator.logScreenshot(logger, null, 'final', 'https://example.com', 'report');
    expect(logger.logScript).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: 'warning', error: '截图失败' }),
      expect.anything(),
    );
    await orchestrator.close();
  });

  it('根据配置和系统判断无头模式', async () => {
    const auto = new Orchestrator(createConfig({ headless: 'auto' })) as any;
    const headless = new Orchestrator(createConfig({ headless: true })) as any;
    const headed = new Orchestrator(createConfig({ headless: false })) as any;

    expect(auto.shouldHeadless()).toBe(process.platform === 'linux');
    expect(headless.shouldHeadless()).toBe(true);
    expect(headed.shouldHeadless()).toBe(false);
    await auto.close();
    await headless.close();
    await headed.close();
  });

  it('查询不存在的会话返回空或中文错误', async () => {
    const orchestrator = new Orchestrator(createConfig());

    expect(orchestrator.getStatus('missing')).toBeNull();
    await expect(orchestrator.stop('missing')).rejects.toThrow('未找到测试会话：missing');
    await expect(orchestrator.pause('missing')).rejects.toThrow('未找到测试会话：missing');
    await expect(orchestrator.resume('missing')).rejects.toThrow('未找到测试会话：missing');
    await orchestrator.close();
  });
});
