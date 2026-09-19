import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page, Route } from 'playwright';
import {
  AgentLogger,
  ConfigManager,
  ComponentRevealer,
  CoveringArrayGenerator,
  CoverageTracker,
  DatabaseManager,
  MemoryManager,
  NetworkFaultInjector,
  PathCoverageGenerator,
  type MemoryExport,
} from '../src/index.js';
import type { TargetConfig } from '../src/config/types.js';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-core-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('CoverageGuarantee', () => {
  it('小参数空间生成全组合并返回覆盖统计', () => {
    const generator = new CoveringArrayGenerator();
    const result = generator.generate([['新增', '删除'], ['弹框', '页面']], 2);

    expect(result.rows).toHaveLength(4);
    expect(result.exhaustive).toBe(true);
    expect(result.coveredCombinations).toBe(4);
    expect(result.totalCombinations).toBe(4);
  });

  it('空参数和空因子返回空结果', () => {
    const generator = new CoveringArrayGenerator();

    expect(generator.generate([], 2)).toMatchObject({
      rows: [],
      strength: 0,
      exhaustive: false,
      coveredCombinations: 0,
      totalCombinations: 0,
    });
    expect(generator.generate([[]], 2)).toMatchObject({ rows: [], totalCombinations: 0 });
  });

  it('大参数空间生成 t-way 覆盖数组', () => {
    const generator = new CoveringArrayGenerator();
    const factors = Array.from({ length: 8 }, () => ['新增', '编辑', '删除'] as const);
    const result = generator.generate(factors, 2, 100);

    expect(result.exhaustive).toBe(false);
    expect(result.strength).toBe(2);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.coveredCombinations).toBe(result.totalCombinations);
  });

  it('枚举无环路径并限制最大深度', () => {
    const generator = new PathCoverageGenerator();
    const paths = generator.generate({
      nodes: ['a', 'b', 'c'],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    }, 2, 100);

    expect(paths).toEqual([['a', 'b'], ['b', 'c'], ['c', 'a']]);
    expect(generator.generate({ nodes: ['a'], edges: [] })).toEqual([]);
  });

  it('追踪动作、组合和路径覆盖快照', () => {
    const tracker = new CoverageTracker();
    tracker.initializeActions([
      { pageId: 'p1', componentId: 'c1', action: 'click' },
      { pageId: 'p1', componentId: 'c2', action: 'fill' },
      { pageId: 'p1', componentId: 'c3', action: 'clear' },
    ]);

    expect(tracker.isExhausted()).toBe(false);
    tracker.markVisited('p1', 'c1', 'click');
    tracker.markBlocked('p1', 'c2', 'fill');
    tracker.markVisited('p1', 'c3', 'clear');
    tracker.setExpectedCombinations(2);
    tracker.recordCombination(['click', 'fill']);
    tracker.setExpectedPaths(2);
    tracker.recordPath(['a', 'b']);

    const snapshot = tracker.snapshot();
    expect(tracker.isExhausted()).toBe(true);
    expect(snapshot.actions).toEqual({ visited: 2, blocked: 1, pending: 0, percentage: 66.66666666666666 });
    expect(snapshot.combinations).toEqual({ covered: 1, total: 2, percentage: 50 });
    expect(snapshot.paths).toEqual({ covered: 1, total: 2, percentage: 50 });
  });

  it('空覆盖快照按 100% 处理', () => {
    const snapshot = new CoverageTracker().snapshot();
    expect(snapshot.actions.percentage).toBe(100);
    expect(snapshot.combinations.percentage).toBe(100);
    expect(snapshot.paths.percentage).toBe(100);
  });
});

describe('MemoryManager', () => {
  function createManager(dir = tempDir) {
    const db = new DatabaseManager(path.join(dir, 'memory.db'));
    db.prepare(`
      INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES ('demo', '演示系统', 'https://example.com', '{}', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at, phase)
      VALUES ('session-1', 'demo', 'completed', 1, 'report')
    `).run();
    return { db, manager: new MemoryManager(db) };
  }

  function createFullMemory() {
    const { db, manager } = createManager();
    manager.markTested('demo', {
      itemKey: 'demo:button-1:click',
      componentId: 'button-1',
      testType: 'click',
      status: 'passed',
    });
    manager.savePattern('demo', '提交后出现成功提示', '演示系统', 0.9);
    manager.saveRule('demo', '必填字段为空时应阻止提交', 0.8);
    manager.saveRule('demo', '必填字段为空时应阻止提交', 0.85);
    return { db, manager };
  }

  it('写入并查询目标记忆', () => {
    const { db, manager } = createFullMemory();
    const memory = manager.getTargetMemory('demo');

    expect(manager.getOverview()).toEqual({
      targetCount: 1,
      testedItemCount: 1,
      ruleCount: 1,
      patternCount: 1,
      summaryCount: 0,
    });
    expect(manager.isTested('demo', 'demo:button-1:click')).toBe(true);
    expect(manager.getTestedStatus('demo', 'demo:button-1:click')).toBe('passed');
    expect(memory.testedItems[0]).toMatchObject({ targetId: 'demo', componentId: 'button-1' });
    expect(memory.rules[0]).toMatchObject({ targetId: 'demo', confidence: 0.85 });
    expect(memory.patterns[0]).toMatchObject({ targetId: 'demo', reliability: 0.9 });
    db.close();
  });

  it('压缩会话并保存结构化摘要', async () => {
    const { db, manager } = createManager();
    db.prepare(`
      INSERT INTO test_results (id, session_id, test_type, status, started_at, duration_ms)
      VALUES ('r1', 'session-1', 'click', 'passed', 1, 10)
    `).run();
    db.prepare(`
      INSERT INTO bugs (id, session_id, target_id, severity, title, detected_at)
      VALUES ('b1', 'session-1', 'demo', 'medium', '按钮无反馈', 1)
    `).run();

    const summary = await manager.compressSession('session-1', {
      llm: { call: vi.fn(async () => JSON.stringify({ 结论: '模型压缩完成' })) } as any,
    });
    const invalid = await manager.compressSession('session-1', {
      llm: { call: vi.fn(async () => '不是 JSON') } as any,
    });

    expect(summary.summary).toEqual({ 结论: '模型压缩完成' });
    expect((invalid.summary as any).模型压缩失败原因).toContain('模型输出不是合法 JSON');
    expect(manager.getTargetMemory('demo').summaries).toHaveLength(2);
    db.close();
  });

  it('完整导出、导入、合并和清理记忆', () => {
    const { db, manager } = createFullMemory();
    const exported = manager.export('demo');

    expect(exported.format).toBe('wta-memory');
    expect(exported.testedItems[0].targetId).toBe('demo');
    expect(exported.rules[0].targetId).toBe('demo');
    expect(exported.patterns[0].targetId).toBe('demo');

    const secondTemp = mkdtempSync(path.join(tmpdir(), 'wta-import-'));
    const second = createManager(secondTemp);
    expect(second.manager.import(exported)).toBe(3);
    expect(second.manager.getOverview()).toMatchObject({
      testedItemCount: 1,
      ruleCount: 1,
      patternCount: 1,
    });

    const merged = manager.merge([exported, second.manager.export('demo')]);
    expect(merged.testedItems).toHaveLength(1);
    expect(merged.rules).toHaveLength(1);
    expect(merged.patterns).toHaveLength(1);

    manager.clearTestedItems('demo');
    expect(manager.getOverview().testedItemCount).toBe(0);
    manager.clear();
    expect(manager.getOverview()).toMatchObject({
      testedItemCount: 0,
      ruleCount: 0,
      patternCount: 0,
    });

    second.db.close();
    rmSync(secondTemp, { recursive: true, force: true });
    db.close();
  });

  it('缺少会话时压缩返回中文错误', async () => {
    const { db, manager } = createManager();
    await expect(manager.compressSession('不存在')).rejects.toThrow('未找到测试会话：不存在');
    db.close();
  });
});

describe('ConfigManager', () => {
  it('兼容顶层浏览器字段、缺少模型并返回空目标列表', () => {
    mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'config.json'), JSON.stringify({
      defaultBrowser: 'firefox',
      headless: false,
      parallel: 3,
    }), 'utf-8');
    const manager = new ConfigManager(tempDir);

    expect(manager.load()).toMatchObject({
      defaultBrowser: 'firefox',
      headless: false,
      parallel: 3,
    });
    expect(manager.listTargets()).toEqual([]);

    const db = new DatabaseManager(path.join(tempDir, 'wta.db'));
    db.close();
    db.close();
  });

  it('加载默认配置、旧版浏览器配置和目标列表', () => {
    mkdirSync(path.join(tempDir, '.wta', 'targets'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'config.json'), JSON.stringify({
      browser: { defaultBrowser: 'firefox', headless: false, parallel: 4 },
      models: { 'component-identify': { provider: 'custom', model: 'local', baseUrl: 'http://localhost', temperature: 0, maxTokens: 10 } },
    }), 'utf-8');
    const target: TargetConfig = {
      name: '演示',
      url: 'https://example.com',
      credentials: { username: '', password: '' },
      strategy: {
        runMode: 'continue', depth: 'deep', maxDuration: 600, maxPages: 20,
        parallel: 2, screenshot: 'always', video: true, headless: true,
      },
      scope: { includePaths: [], excludePaths: [] },
    };
    writeFileSync(path.join(tempDir, '.wta', 'targets', '演示.json'), JSON.stringify(target), 'utf-8');
    const manager = new ConfigManager(tempDir);

    const config = manager.load();
    expect(config.defaultBrowser).toBe('firefox');
    expect(config.headless).toBe(false);
    expect(config.parallel).toBe(4);
    expect(config.models['component-identify']).toMatchObject({ provider: 'custom', baseUrl: 'http://localhost' });
    expect(manager.listTargets()).toEqual([target]);
    expect(manager.loadTarget('演示')).toEqual(target);

    manager.save(config);
    expect(new ConfigManager(tempDir).load()).toMatchObject({ defaultBrowser: 'firefox' });
    manager.saveTarget({ ...target, url: 'https://example.com/home' });
    expect(manager.loadTarget('演示').url).toBe('https://example.com/home');
  });

  it('目标列表按名称排序', () => {
    const dir = path.join(tempDir, '.wta', 'targets');
    mkdirSync(dir, { recursive: true });
    for (const name of ['zeta', 'alpha']) {
      writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ name }), 'utf-8');
    }

    expect(new ConfigManager(tempDir).listTargets().map(target => target.name))
      .toEqual(['alpha', 'zeta']);
  });

  it('目标不存在时返回中文错误', () => {
    const manager = new ConfigManager(tempDir);
    expect(() => manager.loadTarget('不存在')).toThrow('未找到测试目标：不存在');
  });
});

describe('ComponentRevealer', () => {
  function createRevealPage() {
    let captureCount = 0;
    const click = vi.fn().mockResolvedValue(undefined);
    const hover = vi.fn().mockResolvedValue(undefined);
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn(async () => {
        captureCount++;
        return {
          components: captureCount === 1
            ? [{ selector: '#before', tag: 'button' }, { selector: null, tag: 'base' }]
            : [
              { selector: '#before', tag: 'button' },
              { selector: null, tag: 'base' },
              { selector: '#after', tag: 'input' },
              { selector: null, tag: 'revealed-tag' },
            ],
          title: '演示页面',
          forms: [],
          dialogs: 0,
          loadingOverlays: 0,
        };
      }),
      locator: vi.fn((selector: string) => ({
        all: async () => selector.includes('aria-haspopup') ? [{ click, hover }] : [],
      })),
      keyboard: { press: vi.fn().mockResolvedValue(undefined) },
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      mouse: { click: vi.fn().mockResolvedValue(undefined) },
    };
    return { page: page as unknown as Page, click, hover };
  }

  it('展开隐藏组件并计算新增选择器', async () => {
    const { page, click, hover } = createRevealPage();
    const result = await new ComponentRevealer().reveal(page);

    expect(click).toHaveBeenCalled();
    expect(hover).toHaveBeenCalled();
    expect(result).toEqual({
      interactions: 2,
      revealedComponents: 2,
      revealedSelectors: ['#after', 'revealed-tag'],
    });
  });

  it('关闭临时层时忽略键盘和鼠标异常', async () => {
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn(async () => ({
        components: [], title: '演示页面', forms: [], dialogs: 0, loadingOverlays: 0,
      })),
      locator: vi.fn(() => ({ all: async () => [] })),
      keyboard: { press: vi.fn().mockRejectedValue(new Error('键盘不可用')) },
      mouse: { click: vi.fn().mockRejectedValue(new Error('鼠标不可用')) },
    } as unknown as Page;

    const result = await new ComponentRevealer().reveal(page);
    expect(result).toEqual({ interactions: 0, revealedComponents: 0, revealedSelectors: [] });
  });

  it('通过审计日志执行组件揭示', async () => {
    const { page } = createRevealPage();
    const db = new DatabaseManager(path.join(tempDir, 'logs.db'));
    db.prepare(`
      INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES ('demo', '演示系统', 'https://example.com', '{}', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at)
      VALUES ('session-1', 'demo', 'running', 1)
    `).run();
    const logger = new AgentLogger(db, 'session-1', { consoleOutput: false });
    const result = await new ComponentRevealer(logger).reveal(page, { phase: 'explore' });

    expect(result.revealedComponents).toBe(2);
    expect(logger.getTimeline().some(log => log.action.type === 'reveal')).toBe(true);
    db.close();
  });
});

describe('NetworkFaultInjector', () => {
  function createRoute(resourceType: string) {
    return {
      request: vi.fn().mockReturnValue({ resourceType: vi.fn().mockReturnValue(resourceType) }),
      continue: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      fulfill: vi.fn().mockResolvedValue(undefined),
    } as unknown as Route;
  }

  function createPage() {
    const routes: Array<{ pattern: string; handler: (route: Route) => Promise<void> }> = [];
    return {
      page: {
        route: vi.fn(async (pattern: string, handler: (route: Route) => Promise<void>) => {
          routes.push({ pattern: String(pattern), handler });
        }),
        unroute: vi.fn(async () => undefined),
      } as unknown as Page,
      routes,
    };
  }

  it('注入并恢复各类网络故障', async () => {
    const { page, routes } = createPage();
    const injector = new NetworkFaultInjector();
    const faults = [
      { type: 'abort' as const, urlPattern: '**/abort' },
      { type: 'offline' as const, urlPattern: '**/offline' },
      { type: 'http-500' as const, urlPattern: '**/500', responseBody: '服务错误' },
      { type: 'http-503' as const, urlPattern: '**/503' },
      { type: 'slow' as const, urlPattern: '**/slow', delayMs: 1 },
      { type: 'timeout' as const, urlPattern: '**/timeout', delayMs: 1 },
    ];

    for (const fault of faults) await injector.apply(page, fault);
    await routes[0]!.handler(createRoute('document'));
    await routes[0]!.handler(createRoute('xhr'));
    await routes[1]!.handler(createRoute('xhr'));
    await routes[2]!.handler(createRoute('fetch'));
    await routes[3]!.handler(createRoute('xhr'));
    await routes[4]!.handler(createRoute('fetch'));
    await routes[5]!.handler(createRoute('xhr'));

    const unknownFault = { type: 'unknown', urlPattern: '**/unknown' } as any;
    await injector.apply(page, unknownFault);
    const unknownRoute = createRoute('xhr');
    await routes.at(-1)!.handler(unknownRoute);
    expect(unknownRoute.continue).toHaveBeenCalled();

    expect(injector.getActiveFaults()).toHaveLength(7);
    await injector.restore(page, faults[0]);
    expect(injector.getActiveFaults()).toHaveLength(6);
    await injector.restoreAll(page);
    expect(injector.getActiveFaults()).toHaveLength(0);
    expect(page.unroute).toHaveBeenCalled();
  });

  it('慢请求和超时使用默认延迟', async () => {
    vi.useFakeTimers();
    const { page, routes } = createPage();
    const injector = new NetworkFaultInjector();

    await injector.apply(page, { type: 'slow', urlPattern: '**/slow-default' });
    await injector.apply(page, { type: 'timeout', urlPattern: '**/timeout-default' });

    const slow = routes[0]!.handler(createRoute('xhr'));
    await vi.advanceTimersByTimeAsync(3000);
    await slow;
    const timeout = routes[1]!.handler(createRoute('xhr'));
    await vi.advanceTimersByTimeAsync(30000);
    await timeout;
    vi.useRealTimers();
  });

  it('网络故障操作写入结构化日志', async () => {
    const { page } = createPage();
    const db = new DatabaseManager(path.join(tempDir, 'fault.db'));
    db.prepare(`
      INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES ('demo', '演示系统', 'https://example.com', '{}', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at)
      VALUES ('session-1', 'demo', 'running', 1)
    `).run();
    const logger = new AgentLogger(db, 'session-1', { consoleOutput: false });
    const injector = new NetworkFaultInjector(logger);
    const fault = { type: 'http-500' as const, urlPattern: '**/api' };

    await injector.apply(page, fault, { phase: 'chaos' });
    await injector.restore(page, fault, { phase: 'chaos' });

    expect(logger.getTimeline().some(log => log.action.type === 'network-fault')).toBe(true);
    db.close();
  });
});
