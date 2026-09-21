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
    tracker.markPathBlocked(['b', 'c']);

    const snapshot = tracker.snapshot();
    expect(tracker.isExhausted()).toBe(true);
    expect(snapshot.actions).toMatchObject({ visited: 2, blocked: 1, pending: 0, resolvedPercentage: 100 });
    expect(snapshot.actions.percentage).toBeCloseTo(200 / 3);
    expect(snapshot.combinations).toEqual({ covered: 1, reused: 0, blocked: 0, total: 2, percentage: 50, resolvedPercentage: 50 });
    expect(snapshot.paths).toEqual({ covered: 1, reused: 0, blocked: 1, total: 2, percentage: 50, resolvedPercentage: 100 });
  });

  it('空覆盖快照按未生成覆盖目标处理', () => {
    const snapshot = new CoverageTracker().snapshot();
    expect(snapshot.actions.percentage).toBe(0);
    expect(snapshot.combinations.percentage).toBe(0);
    expect(snapshot.paths.percentage).toBe(0);
  });

  it('独立记录记忆复用，不将其计入本会话实际覆盖', () => {
    const tracker = new CoverageTracker();
    tracker.initializeActions([{ pageId: 'p', componentId: 'c', action: 'click' }]);
    tracker.markReused('p', 'c', 'click');
    tracker.setExpectedCombinations(1);
    tracker.markCombinationReused(['click']);
    tracker.setExpectedPaths(1);
    tracker.markPathReused(['p', 'next']);

    expect(tracker.snapshot()).toMatchObject({
      actions: { visited: 0, reused: 1, percentage: 0, resolvedPercentage: 100 },
      combinations: { covered: 0, reused: 1, percentage: 0, resolvedPercentage: 100 },
      paths: { covered: 0, reused: 1, percentage: 0, resolvedPercentage: 100 },
    });

    tracker.markVisited('p', 'c', 'click');
    tracker.markReused('p', 'c', 'click');
    tracker.recordCombination(['click']);
    tracker.markCombinationReused(['click']);
    tracker.recordPath(['p', 'next']);
    tracker.markPathReused(['p', 'next']);
    expect(tracker.snapshot()).toMatchObject({
      actions: { visited: 1, reused: 0 },
      combinations: { covered: 1, reused: 0 },
      paths: { covered: 1, reused: 0 },
    });
  });

  it('处理退化强度、有限路径和重复覆盖记录', () => {
    const generator = new CoveringArrayGenerator();
    const single = generator.generate([['a', 'b']], 0);
    expect(single).toMatchObject({ strength: 1, exhaustive: false, totalCombinations: 2 });
    expect(generator.generate([['a'], ['b']], 0, 1).rows).toEqual([['a', 'b']]);

    const paths = new PathCoverageGenerator().generate({
      nodes: ['a', 'b', 'c'],
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'a' }],
    }, 4, 1);
    expect(paths).toEqual([['a', 'c']]);

    const tracker = new CoverageTracker();
    tracker.initializeActions([{ pageId: 'p', componentId: 'c', action: 'click' }]);
    tracker.markVisited('p', 'c', 'click');
    tracker.markBlocked('p', 'c', 'click');
    tracker.initializeActions([{ pageId: 'p', componentId: 'c', action: 'click' }]);
    tracker.recordCombination(['a']);
    tracker.recordCombination(['a']);
    tracker.markCombinationBlocked(['b']);
    tracker.markCombinationBlocked(['a']);
    tracker.recordPath(['a', 'b']);
    tracker.recordPath(['a', 'b']);
    tracker.markPathBlocked(['a', 'b']);
    tracker.setExpectedCombinations(1);
    tracker.setExpectedPaths(1);
    expect(tracker.snapshot()).toMatchObject({
      actions: { visited: 1, pending: 0 },
      combinations: { covered: 1, blocked: 1 },
      paths: { covered: 1 },
    });
  });

  it('覆盖数组跳过已覆盖赋值，路径在最大深度时保存路径', () => {
    const generator = new CoveringArrayGenerator() as any;
    expect(generator.covers(['a', 'b'], [{ factorIndex: 0, value: 'a' }])).toBe(true);
    expect(generator.covers(['a', 'b'], [{ factorIndex: 0, value: 'x' }])).toBe(false);
    const paths = new PathCoverageGenerator().generate({
      nodes: ['a', 'b', 'c'], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    }, 3);
    expect(paths).toContainEqual(['a', 'b', 'c']);
  });

  it('覆盖数组跳过重复行，最浅路径不生成单节点记录', () => {
    const result = new CoveringArrayGenerator().generate([['a', 'a'], ['b']], 1, 0);
    expect(result.rows).toEqual([['a', 'b']]);
    expect(new PathCoverageGenerator().generate({ nodes: ['a'], edges: [{ from: 'a', to: 'a' }] }, 1)).toEqual([]);
  });

  it('组合索引生成器处理零大小和超过元素数量的请求', () => {
    const generator = new CoveringArrayGenerator() as any;
    expect(generator.combineIndexes(['a', 'b'], 0)).toEqual([[]]);
    expect(generator.combineIndexes(['a'], 2)).toEqual([]);
    expect(generator.combineIndexes(['a', 'b'], 1)).toEqual([['a'], ['b']]);
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

  it('保留本地摘要、导入全部记忆并清理指定目标', async () => {
    const { db, manager } = createFullMemory();
    manager.markTested('demo', {
      itemKey: 'demo:button-1:click', componentId: 'button-1', testType: 'click', status: 'failed',
    });
    expect(manager.getTestedItems('demo')[0]?.testCount).toBe(2);
    expect(manager.getTestedStatus('demo', 'missing')).toBeNull();

    const fallback = await manager.compressSession('session-1');
    const arrayResult = await manager.compressSession('session-1', {
      llm: { call: vi.fn(async () => '[]') } as any,
    });
    const rejected = await manager.compressSession('session-1', {
      llm: { call: vi.fn(async () => { throw '模型不可用'; }) } as any,
    });
    expect(fallback.summary.结论).toBe('已生成本地结构化摘要');
    expect(arrayResult.summary.结论).toBe('已生成本地结构化摘要');
    expect(rejected.summary.模型压缩失败原因).toBe('模型不可用');

    const exported = manager.export();
    expect(exported.summaries).toHaveLength(3);
    const importedDir = mkdtempSync(path.join(tmpdir(), 'wta-memory-full-'));
    const imported = createManager(importedDir);
    expect(imported.manager.import(exported)).toBe(6);
    imported.manager.clearTestedItems();
    expect(imported.manager.getOverview().testedItemCount).toBe(0);
    imported.manager.clear('demo');
    expect(imported.manager.getOverview()).toMatchObject({ ruleCount: 0, patternCount: 0, summaryCount: 0 });
    imported.db.close();
    rmSync(importedDir, { recursive: true, force: true });
    db.close();
  });

  it('记忆摘要支持 fenced JSON、非对象 JSON 与最新测试项合并', async () => {
    const { db, manager } = createManager();
    const fence = String.fromCharCode(96).repeat(3);
    const fenced = await manager.compressSession('session-1', {
      llm: { call: vi.fn(async () => [fence + 'json', '{"结论":"围栏摘要"}', fence].join('\n')) } as any,
    });
    expect(fenced.summary).toEqual({ 结论: '围栏摘要' });
    const fallback = await manager.compressSession('session-1', {
      llm: { call: vi.fn(async () => 'null') } as any,
    });
    expect(fallback.summary.结论).toBe('已生成本地结构化摘要');

    const exported = manager.export('demo');
    const newer = { ...exported, testedItems: [{
      targetId: 'demo', itemKey: 'x', componentId: 'x', testType: 'click', status: 'passed' as const, lastTestedAt: 2, testCount: 1,
    }] };
    const older = { ...newer, testedItems: [{ ...newer.testedItems[0]!, lastTestedAt: 1, status: 'failed' as const }] };
    expect(manager.merge([newer, older]).testedItems[0]?.status).toBe('passed');
    db.close();
  });

  it('压缩包含审计日志的会话并覆盖日志映射', async () => {
    const { db, manager } = createManager();
    db.prepare(`
      INSERT INTO agent_logs (id, session_id, timestamp, sequence, source, log_json, created_at)
      VALUES ('log-1', 'session-1', 1, 1, 'script', '{"source":"script"}', 1)
    `).run();
    const summary = await manager.compressSession('session-1');
    expect(summary.summary.审计日志条数).toBe(1);
    db.close();
  });

  it('模型压缩抛出 Error 时保留错误消息', async () => {
    const { db, manager } = createManager();
    const summary = await manager.compressSession('session-1', {
      llm: { call: vi.fn(async () => { throw new Error('模型错误'); }) } as any,
    });
    expect(summary.summary.模型压缩失败原因).toBe('模型错误');
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

  it('浏览器嵌套配置缺省时依次使用顶层和默认配置', () => {
    mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'config.json'), JSON.stringify({
      browser: { defaultBrowser: 'webkit' },
      headless: false,
      viewport: { width: 800, height: 600 },
      parallel: 7,
    }), 'utf-8');
    const config = new ConfigManager(tempDir).load();
    expect(config.defaultBrowser).toBe('webkit');
    expect(config.headless).toBe(false);
    expect(config.viewport).toEqual({ width: 800, height: 600 });
    expect(config.parallel).toBe(7);
  });

  it('浏览器嵌套配置完整时优先覆盖顶层同名字段', () => {
    mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'config.json'), JSON.stringify({
      defaultBrowser: 'chromium', headless: true, viewport: { width: 1, height: 1 }, parallel: 1,
      browser: { defaultBrowser: 'firefox', headless: false, viewport: { width: 1280, height: 720 }, parallel: 4 },
    }), 'utf-8');
    expect(new ConfigManager(tempDir).load()).toMatchObject({
      defaultBrowser: 'firefox', headless: false, viewport: { width: 1280, height: 720 }, parallel: 4,
    });
  });

  it('配置文件字段缺失时回退到运行时默认值', () => {
    mkdirSync(path.join(tempDir, '.wta'), { recursive: true });
    writeFileSync(path.join(tempDir, '.wta', 'config.json'), JSON.stringify({}), 'utf-8');
    const config = new ConfigManager(tempDir).load();
    expect(config.defaultBrowser).toBe('chromium');
    expect(config.viewport).toEqual({ width: 1920, height: 1080 });
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

  it('组件揭示器可在创建后注入日志器', async () => {
    const { page } = createRevealPage();
    const logger = { runScript: vi.fn(async (_trigger: unknown, _action: unknown, execute: () => unknown) => execute()) };
    const revealer = new ComponentRevealer();
    revealer.setLogger(logger as never);
    await revealer.reveal(page, { phase: 'explore' });
    expect(logger.runScript).toHaveBeenCalled();
  });

  it('关闭临时层会跳过失效关闭按钮，揭示失败也继续后续候选并记录警告', async () => {
    const database = new DatabaseManager(path.join(tempDir, 'reveal-warning.db'));
    database.prepare("INSERT INTO targets (id, name, url, config_json, created_at, updated_at) VALUES ('demo', '演示系统', 'https://example.com', '{}', 1, 1)").run();
    database.prepare("INSERT INTO sessions (id, target_id, status, started_at) VALUES ('session-1', 'demo', 'running', 1)").run();
    const logger = new AgentLogger(database, 'session-1', { consoleOutput: false });
    const failedClose = { click: vi.fn().mockRejectedValue(new Error('遮罩拦截')) };
    const workingClose = { click: vi.fn().mockResolvedValue(undefined) };
    const failedReveal = { click: vi.fn().mockRejectedValue('已失效'), hover: vi.fn().mockRejectedValue('已失效') };
    const workingReveal = { click: vi.fn().mockResolvedValue(undefined), hover: vi.fn().mockResolvedValue(undefined) };
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn().mockResolvedValue({ components: [], title: '页面', forms: [], dialogs: 0, loadingOverlays: 0 }),
      locator: vi.fn((selector: string) => ({
        all: async () => selector === '.semi-modal-wrap button' ? [failedClose, workingClose]
          : selector.includes('aria-haspopup') ? [failedReveal, workingReveal] : [],
      })),
      keyboard: { press: vi.fn().mockResolvedValue(undefined) },
      mouse: { click: vi.fn().mockResolvedValue(undefined) },
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;

    await expect(new ComponentRevealer(logger).reveal(page, { phase: 'explore' })).resolves.toMatchObject({ interactions: 2 });
    expect(failedClose.click).toHaveBeenCalled();
    expect(workingClose.click).toHaveBeenCalled();
    expect(workingReveal.click).toHaveBeenCalled();
    expect(logger.getTimeline().some(log => log.action.type === 'reveal-skip' && log.result.status === 'warning')).toBe(true);
    database.close();
  });

  it('组件揭示失败为文本异常时同样记录可读告警', async () => {
    const database = new DatabaseManager(path.join(tempDir, 'reveal-text-warning.db'));
    database.prepare("INSERT INTO targets (id, name, url, config_json, created_at, updated_at) VALUES ('demo', '演示系统', 'https://example.com', '{}', 1, 1)").run();
    database.prepare("INSERT INTO sessions (id, target_id, status, started_at) VALUES ('session-1', 'demo', 'running', 1)").run();
    const logger = new AgentLogger(database, 'session-1', { consoleOutput: false });
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn().mockResolvedValue({ components: [], title: '页面', forms: [], dialogs: 0, loadingOverlays: 0 }),
      locator: vi.fn((selector: string) => ({ all: async () => selector.includes('aria-haspopup') ? [{ click: vi.fn().mockRejectedValue('文本异常'), hover: vi.fn().mockRejectedValue('文本异常') }] : [] })),
      keyboard: { press: vi.fn().mockResolvedValue(undefined) }, mouse: { click: vi.fn().mockResolvedValue(undefined) }, waitForTimeout: vi.fn(),
    } as unknown as Page;
    await new ComponentRevealer(logger).reveal(page, { phase: 'explore' });
    expect(logger.getTimeline().some(log => log.result.error === '文本异常')).toBe(true);
    database.close();
  });

  it('组件揭示失败为非 Error 值时也继续后续候选', async () => {
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn().mockResolvedValue({ components: [], title: '页面', forms: [], dialogs: 0, loadingOverlays: 0 }),
      locator: vi.fn((selector: string) => ({
        all: async () => selector.includes('aria-haspopup')
          ? [{ click: vi.fn().mockRejectedValue({ code: 'stale-handle' }), hover: vi.fn().mockRejectedValue({ code: 'stale-handle' }) }]
          : [],
      })),
      keyboard: { press: vi.fn().mockResolvedValue(undefined) },
      mouse: { click: vi.fn().mockResolvedValue(undefined) },
      waitForTimeout: vi.fn(),
    } as unknown as Page;

    await expect(new ComponentRevealer().reveal(page, { phase: 'explore' })).resolves.toMatchObject({ interactions: 0 });
  });

  it('组件揭示失败为 Error 时记录错误消息', async () => {
    const logger = {
      runScript: vi.fn(async (_trigger: unknown, _action: unknown, execute: () => unknown) => execute()),
      logScript: vi.fn(),
    };
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/page'),
      evaluate: vi.fn().mockResolvedValue({ components: [], title: '页面', forms: [], dialogs: 0, loadingOverlays: 0 }),
      locator: vi.fn((selector: string) => ({
        all: async () => selector.includes('aria-haspopup')
          ? [{ click: vi.fn().mockRejectedValue(new Error('元素已失效')), hover: vi.fn().mockRejectedValue(new Error('元素已失效')) }]
          : [],
      })),
      keyboard: { press: vi.fn().mockResolvedValue(undefined) },
      mouse: { click: vi.fn().mockResolvedValue(undefined) },
      waitForTimeout: vi.fn(),
    } as unknown as Page;

    await new ComponentRevealer(logger as never).reveal(page, { phase: 'explore' });
    expect(logger.logScript).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ error: '元素已失效' }), expect.anything());
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
