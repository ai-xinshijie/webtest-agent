import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { AuthSessionManager } from '../src/auth/AuthSessionManager.js';
import { PluginManager } from '../src/plugin/PluginManager.js';
import { MCPClient } from '../src/plugin/MCPClient.js';
import { DatabaseManager } from '../src/db/Database.js';
import { AgentLogger } from '../src/logger/AgentLogger.js';
import type { TargetConfig } from '../src/config/types.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

let tempDir = '';
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-integration-'));
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function createTarget(overrides: Partial<TargetConfig['credentials']> = {}): TargetConfig {
  return {
    name: '演示系统',
    url: 'https://example.com/login',
    credentials: {
      username: 'user',
      password: 'pass',
      ...overrides,
    },
    strategy: {
      runMode: 'continue',
      depth: 'deep',
      maxDuration: 600,
      maxPages: 10,
      parallel: 1,
      screenshot: 'always',
      video: false,
      headless: true,
    },
    scope: { includePaths: [], excludePaths: [] },
  };
}

describe('AuthSessionManager', () => {
  function createAuthPage(options: {
    passwordCount?: number;
    usernameSelectors?: string[];
    genericCount?: number;
    submitSelectors?: string[];
    failureVisible?: Promise<boolean>;
    failureError?: boolean;
    fillError?: unknown;
    challengeSelectors?: string[];
  } = {}) {
    const password = {
      count: vi.fn(async () => options.passwordCount ?? 1),
      first: vi.fn(() => password),
      fill: vi.fn(async () => {
        if (options.fillError) throw options.fillError;
      }),
      press: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
      addCookies: vi.fn().mockResolvedValue(undefined),
      addInitScript: vi.fn(),
    };
    const page = {
      url: vi.fn().mockReturnValue('https://example.com/login'),
      locator: vi.fn((selector: string) => {
        if (selector === 'input[type="password"]') return password;
        return {
          count: vi.fn(async () => {
            if (options.challengeSelectors?.includes(selector)) return 1;
            if (options.usernameSelectors?.includes(selector)) return 1;
            if (selector === 'form input:not([type="password"]):not([type="hidden"])') return options.genericCount ?? 0;
            if (options.submitSelectors?.includes(selector)) return 1;
            return 0;
          }),
          first() { return this; },
        };
      }),
      fill: vi.fn(async (_selector: string, value: string) => {
        if (value === 'user' && options.fillError) throw options.fillError;
      }),
      click: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      getByText: vi.fn(() => ({
        first: () => ({
          isVisible: vi.fn(async () => {
            if (options.failureError) throw new Error('元素不可见');
            return options.failureVisible ?? false;
          }),
        }),
      })),
      context: vi.fn(() => context),
    };
    return { page: page as unknown as Page, password };
  }

  it('没有凭证时跳过登录', async () => {
    const { page } = createAuthPage();
    const result = await new AuthSessionManager().login(page, createTarget({ username: '', password: '' }));
    expect(result).toEqual({ performed: false, success: true, reason: '目标未配置凭证，跳过登录' });
  });

  it('检测验证码或二次验证时要求人工认证，不填写登录表单', async () => {
    const captcha = createAuthPage({ challengeSelectors: ['[data-sitekey]'] });
    const captchaResult = await new AuthSessionManager().login(captcha.page, createTarget());
    expect(captchaResult).toMatchObject({
      performed: false,
      success: false,
      requiresManual: true,
      reason: '检测到验证码，需要人工认证后导入登录状态',
    });
    expect(captcha.page.fill).not.toHaveBeenCalled();

    const twoFactor = createAuthPage({ challengeSelectors: ['input[autocomplete="one-time-code"]'] });
    const twoFactorResult = await new AuthSessionManager().login(twoFactor.page, createTarget());
    expect(twoFactorResult).toMatchObject({
      performed: false,
      success: false,
      requiresManual: true,
      reason: '检测到二次验证，需要人工认证后导入登录状态',
    });
  });

  it('没有登录表单时跳过登录', async () => {
    const { page } = createAuthPage({ passwordCount: 0 });
    const result = await new AuthSessionManager().login(page, createTarget());
    expect(result).toEqual({ performed: false, success: true, reason: '当前页面没有登录表单' });
  });

  it('有密码框但无法识别用户名时返回失败', async () => {
    const { page } = createAuthPage({ usernameSelectors: [], genericCount: 0 });
    const result = await new AuthSessionManager().login(page, createTarget());
    expect(result).toEqual({ performed: false, success: false, reason: '未识别用户名输入框' });
  });

  it('识别推荐用户名和提交按钮并登录成功', async () => {
    const { page, password } = createAuthPage({
      usernameSelectors: ['input[name="username"]'],
      submitSelectors: ['form button[type="submit"]'],
      failureVisible: Promise.resolve(false),
    });
    const result = await new AuthSessionManager().login(page, createTarget());

    expect(result).toEqual({ performed: true, success: true });
    expect(page.fill).toHaveBeenCalledWith('input[name="username"]', 'user', { timeout: 10000 });
    expect(password.fill).toHaveBeenCalledWith('pass', { timeout: 10000 });
    expect(page.click).toHaveBeenCalledWith('form button[type="submit"]', { timeout: 10000 });
  });

  it('回退到通用用户名并使用回车提交', async () => {
    const { page, password } = createAuthPage({
      genericCount: 1,
      failureError: true,
    });
    const result = await new AuthSessionManager().login(page, createTarget());

    expect(result).toEqual({ performed: true, success: true });
    expect(page.fill).toHaveBeenCalledWith('form input:not([type="password"]):not([type="hidden"])', 'user', { timeout: 10000 });
    expect(password.press).toHaveBeenCalledWith('Enter');
  });

  it('登录失败文本可见时返回失败原因', async () => {
    const { page } = createAuthPage({
      usernameSelectors: ['input[name="username"]'],
      failureVisible: Promise.resolve(true),
    });
    const result = await new AuthSessionManager().login(page, createTarget());
    expect(result).toEqual({ performed: true, success: false, reason: '登录后页面仍显示登录错误' });
  });

  it('登录后的加载等待失败时仍可完成登录判定', async () => {
    const { page } = createAuthPage({ usernameSelectors: ['input[name="username"]'] });
    (page.waitForLoadState as any).mockRejectedValueOnce(new Error('页面仍在加载'));
    await expect(new AuthSessionManager().login(page, createTarget())).resolves.toEqual({ performed: true, success: true });
  });

  it('执行异常时返回中文失败原因', async () => {
    const { page } = createAuthPage({
      usernameSelectors: ['input[name="username"]'],
      fillError: new Error('输入框被遮挡'),
    });
    const result = await new AuthSessionManager().login(page, createTarget());
    expect(result).toMatchObject({ performed: true, success: false, reason: '输入框被遮挡' });
  });

  it('登录和状态操作写入审计日志并处理非 Error 异常', async () => {
    const db = new DatabaseManager(path.join(tempDir, 'auth-logs.db'));
    db.prepare(`
      INSERT INTO targets (id, name, url, config_json, created_at, updated_at)
      VALUES ('demo', '演示系统', 'https://example.com', '{}', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, target_id, status, started_at)
      VALUES ('session-1', 'demo', 'running', 1)
    `).run();
    const logger = new AgentLogger(db, 'session-1', { consoleOutput: false });
    const manager = new AuthSessionManager();
    manager.setLogger(logger);

    const failing = createAuthPage({
      usernameSelectors: ['input[name="username"]'],
      fillError: '页面已跳转',
    });
    const failed = await manager.login(failing.page, createTarget({ usernameHint: '演示账号' }));
    expect(failed).toMatchObject({ performed: true, success: false, reason: '页面已跳转' });

    const succeeding = createAuthPage({ usernameSelectors: ['input[name="username"]'] });
    expect(await manager.login(succeeding.page, createTarget())).toMatchObject({ performed: true, success: true });

    const statePath = path.join(tempDir, 'state.json');
    await manager.saveState(succeeding.page, statePath);
    writeFileSync(statePath, JSON.stringify({
      cookies: [],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'theme', value: 'dark' }] }],
    }), 'utf-8');
    await manager.restoreState(succeeding.page, statePath);

    const context = succeeding.page.context() as any;
    const initScript = context.addInitScript.mock.calls.at(-1)[0] as (origins: any[]) => void;
    const setItem = vi.fn();
    (globalThis as any).location = { origin: 'https://example.com' };
    (globalThis as any).localStorage = { setItem };
    initScript([{ origin: 'https://other.test', localStorage: [{ name: 'ignored', value: 'x' }] }]);
    initScript([{ origin: 'https://example.com', localStorage: [{ name: 'theme', value: 'dark' }] }]);
    expect(setItem).toHaveBeenCalledWith('theme', 'dark');
    delete (globalThis as any).location;
    delete (globalThis as any).localStorage;

    expect(logger.getTimeline().some(log => log.action.type === 'login')).toBe(true);
    expect(logger.getTimeline().some(log => log.action.type === 'save-auth-state')).toBe(true);
    expect(logger.getTimeline().some(log => log.action.type === 'restore-auth-state')).toBe(true);
    db.close();
  });

  it('保存和恢复登录状态', async () => {
    const { page } = createAuthPage();
    const manager = new AuthSessionManager();
    const statePath = path.join(tempDir, 'state.json');
    writeFileSync(statePath, JSON.stringify({
      cookies: [{ name: 'token', value: 'abc' }],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'theme', value: 'dark' }] }],
    }), 'utf-8');

    await manager.saveState(page, statePath);
    await manager.restoreState(page, statePath);

    const context = page.context() as any;
    expect(context.storageState).toHaveBeenCalledWith({ path: statePath });
    expect(context.addCookies).toHaveBeenCalledWith([{ name: 'token', value: 'abc' }]);
    expect(context.addInitScript).toHaveBeenCalled();

    const initScript = context.addInitScript.mock.calls[0][0] as (origins: any[]) => void;
    const setItem = vi.fn();
    (globalThis as any).location = { origin: 'https://example.com' };
    (globalThis as any).localStorage = { setItem };
    initScript([{ origin: 'https://example.com', localStorage: [{ name: 'theme', value: 'dark' }] }]);
    expect(setItem).toHaveBeenCalledWith('theme', 'dark');
    delete (globalThis as any).location;
    delete (globalThis as any).localStorage;
  });

  it('认证选择器覆盖邮箱、账号、自动完成、占位符和提交按钮回退', async () => {
    const selectors = [
      'input[name="email"]', 'input[name="account"]', 'input[autocomplete="username"]',
      'input[type="email"]', 'input[placeholder*="用户"]', 'input[placeholder*="账号"]', 'input[placeholder*="邮箱"]',
    ];
    for (const selector of selectors) {
      const { page } = createAuthPage({ usernameSelectors: [selector] });
      await expect((new AuthSessionManager() as any).findUsernameSelector(page)).resolves.toBe(selector);
    }
    for (const selector of ['form button:has-text("登录")', 'form button:has-text("Sign in")', 'form button:has-text("Login")']) {
      const { page } = createAuthPage({ submitSelectors: [selector] });
      await expect((new AuthSessionManager() as any).findSubmitSelector(page)).resolves.toBe(selector);
    }
  });

  it('验证码检测忽略选择器异常并覆盖所有验证码和二次验证入口', async () => {
    const captchaSelectors = ['iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', '[class*="captcha" i]'];
    for (const selector of captchaSelectors) {
      const { page } = createAuthPage({ challengeSelectors: [selector] });
      await expect((new AuthSessionManager() as any).detectChallenge(page)).resolves.toBe('验证码');
    }
    for (const selector of ['input[name*="otp" i]', 'input[name*="2fa" i]', 'input[name*="verification" i]']) {
      const { page } = createAuthPage({ challengeSelectors: [selector] });
      await expect((new AuthSessionManager() as any).detectChallenge(page)).resolves.toBe('二次验证');
    }
    const page = {
      locator: vi.fn(() => ({ count: vi.fn().mockRejectedValue(new Error('定位失败')) })),
    } as unknown as Page;
    await expect((new AuthSessionManager() as any).detectChallenge(page)).resolves.toBeNull();
  });
});

describe('PluginManager', () => {
  function writePlugin(name: string, options: { enabled?: boolean; entry?: string; manifest?: Record<string, unknown>; code?: string } = {}) {
    const pluginPath = path.join(tempDir, 'plugins', name, 'dist');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(path.join(pluginPath, 'index.js'), options.code ?? `
      export default {
        name: '${name}',
        version: '0.1.0',
        tools: [{ name: '${name}.example', description: '示例工具' }],
        async onInit(context) {
          context.log('初始化');
          context.log('警告', 'warn');
          context.log('错误', 'error');
        },
        async onDispose() {},
        async executeTool(toolName, params) { return { toolName, params }; },
      };
    `);
    writeFileSync(path.join(pluginPath, '..', 'plugin.json'), JSON.stringify({
      name,
      version: '0.1.0',
      entry: options.entry ?? 'dist/index.js',
      enabled: options.enabled ?? true,
      ...options.manifest,
    }), 'utf-8');
    return path.join(tempDir, 'plugins', name);
  }

  function createManager() {
    return new PluginManager(path.join(tempDir, 'plugins'), path.join(tempDir, 'data'));
  }

  it('加载本地插件、执行工具并释放', async () => {
    writePlugin('demo');
    writeFileSync(path.join(tempDir, 'plugins', 'ignored.txt'), '');
    mkdirSync(path.join(tempDir, 'plugins', '.hidden'), { recursive: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const manager = createManager();

    const plugins = await manager.loadAll();
    expect(plugins).toHaveLength(1);
    expect(manager.getTools()).toEqual([{ name: 'demo.example', description: '示例工具' }]);
    expect(await manager.executeTool('demo.example', { value: 1 })).toEqual({
      toolName: 'demo.example',
      params: { value: 1 },
    });
    expect(manager.list()).toEqual([{
      name: 'demo',
      version: '0.1.0',
      entry: 'dist/index.js',
      enabled: true,
      loaded: true,
      toolCount: 1,
    }]);

    await manager.disposeAll();
    expect(manager.getTools()).toHaveLength(0);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('支持命名导出、禁用插件和状态更新', async () => {
    writePlugin('named', {
      code: `
        export const plugin = {
          name: 'named',
          version: '0.1.0',
          tools: [{ name: 'named.example', description: '示例工具' }],
          async executeTool(toolName, params) { return { toolName, params }; },
        };
      `,
    });
    writePlugin('disabled', { enabled: false });
    const manager = createManager();

    expect(await manager.loadAll()).toHaveLength(1);
    expect(manager.list().find(item => item.name === 'disabled')?.loaded).toBe(false);
    manager.setEnabled('disabled', true);
    expect(JSON.parse(readFileSync(path.join(tempDir, 'plugins', 'disabled', 'plugin.json'), 'utf-8')).enabled).toBe(true);
  });

  it('校验插件清单、入口越界和名称一致性', async () => {
    const manager = createManager();
    expect(await manager.load(path.join(tempDir, 'plugins', '不存在'))).toBeNull();

    const invalidJson = path.join(tempDir, 'plugins', 'invalid-json');
    mkdirSync(invalidJson, { recursive: true });
    writeFileSync(path.join(invalidJson, 'plugin.json'), '不是 JSON');
    await expect(manager.load(invalidJson)).rejects.toThrow('插件清单解析失败');

    const missingFields = path.join(tempDir, 'plugins', 'missing-fields');
    mkdirSync(missingFields, { recursive: true });
    writeFileSync(path.join(missingFields, 'plugin.json'), JSON.stringify({ name: 'missing' }));
    await expect(manager.load(missingFields)).rejects.toThrow('插件清单必须包含 name、version 和 entry');

    const invalidName = path.join(tempDir, 'plugins', 'invalid-name');
    mkdirSync(invalidName, { recursive: true });
    writeFileSync(path.join(invalidName, 'plugin.json'), JSON.stringify({ name: 'bad name', version: '1', entry: 'x.js' }));
    await expect(manager.load(invalidName)).rejects.toThrow('插件名称不合法');

    const escape = writePlugin('escape', { entry: '../outside.js' });
    await expect(manager.load(escape)).rejects.toThrow('插件入口越界');

    const mismatch = writePlugin('mismatch', {
      code: `export default { name: 'other', version: '0.1.0', tools: [], async executeTool() {} };`,
    });
    await expect(manager.load(mismatch)).rejects.toThrow('插件名称与清单不一致');

    expect(() => manager.setEnabled('不存在', true)).toThrow('未找到插件：不存在');
  });

  it('安装本地插件并处理来源和目录冲突', () => {
    const source = path.join(tempDir, 'source-plugin');
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, 'plugin.json'), '{}');
    const manager = createManager();

    const installed = manager.install(source);
    expect(installed).toContain('source-plugin');
    expect(() => manager.install(source)).toThrow('插件目录已存在');
    expect(() => manager.install(path.join(tempDir, '不存在'))).toThrow('插件来源不存在');
  });

  it('安装 Git 插件并处理克隆失败', async () => {
    const { spawnSync } = await import('node:child_process');
    const manager = createManager();

    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as any);
    expect(manager.install('https://example.com/demo.git')).toContain('demo');

    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1 } as any);
    expect(() => manager.install('git@example.com:demo/demo.git')).toThrow('Git 插件安装失败');
  });

  it('创建插件脚手架并阻止重复创建', () => {
    const manager = createManager();
    const pluginPath = manager.create('scaffold', '示例描述');

    expect(existsSync(path.join(pluginPath, 'plugin.json'))).toBe(true);
    expect(existsSync(path.join(pluginPath, 'src', 'index.ts'))).toBe(true);
    expect(() => manager.create('scaffold')).toThrow('插件目录已存在');
  });

  it('未构建、无初始化或无释放回调的插件具备可预期行为', async () => {
    const manager = createManager();
    const unbuilt = path.join(tempDir, 'plugins', 'unbuilt');
    mkdirSync(unbuilt, { recursive: true });
    writeFileSync(path.join(unbuilt, 'plugin.json'), JSON.stringify({
      name: 'unbuilt', version: '1.0.0', entry: 'dist/index.js', enabled: true,
    }), 'utf-8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(manager.load(unbuilt)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('跳过未构建插件：unbuilt');

    writePlugin('minimal', {
      code: "export default { name: 'minimal', version: '1', tools: [], async executeTool() { return null; } };",
    });
    await expect(manager.load(path.join(tempDir, 'plugins', 'minimal'))).resolves.toMatchObject({ name: 'minimal' });
    await manager.disposeAll();
    await expect(manager.executeTool('minimal.missing')).rejects.toThrow('未找到插件工具：minimal.missing');
    warnSpy.mockRestore();
  });

  it('未先批量加载时使用受限默认上下文初始化插件', async () => {
    const manager = createManager();
    const messages: string[] = [];
    writePlugin('direct', {
      code: `export default {
        name: 'direct', version: '1', tools: [],
        onInit(context) { context.log('直接初始化'); },
        async executeTool() { return null; },
      };`,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(message => messages.push(String(message)));
    await manager.load(path.join(tempDir, 'plugins', 'direct'));
    expect(messages).toContain('插件：直接初始化');
    logSpy.mockRestore();
  });

  it('插件列表忽略无清单目录，工具匹配会跳过前置插件，Git 安装拒绝重名目录', async () => {
    const manager = createManager();
    mkdirSync(path.join(tempDir, 'plugins', 'no-manifest'), { recursive: true });
    writePlugin('first', { code: "export default { name: 'first', version: '1', tools: [], async executeTool() { return null; } };" });
    writePlugin('second', { code: "export default { name: 'second', version: '1', tools: [{ name: 'second.tool', description: 'x' }], async executeTool() { return 'ok'; } };" });
    await manager.loadAll();
    expect(manager.list().map(item => item.name)).toContain('first');
    await expect(manager.executeTool('second.tool')).resolves.toBe('ok');
    mkdirSync(path.join(tempDir, 'plugins', 'same'), { recursive: true });
    expect(() => manager.install('https://example.com/same.git')).toThrow('插件目录已存在');
  });

  it('插件可直接使用模块命名导出作为实现', async () => {
    const manager = createManager();
    writePlugin('namespace', {
      code: `
        export const name = 'namespace';
        export const version = '1';
        export const tools = [{ name: 'namespace.tool', description: '命名导出工具' }];
        export async function executeTool() { return 'namespace-result'; }
      `,
    });
    await expect(manager.load(path.join(tempDir, 'plugins', 'namespace'))).resolves.toMatchObject({ name: 'namespace' });
    await expect(manager.executeTool('namespace.tool')).resolves.toBe('namespace-result');
  });
});

describe('MCPClient', () => {
  function createServerCode() {
    return `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      process.stdout.write('不是 JSON\\n');
      process.stderr.write('MCP 服务日志\\n');
      rl.on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'demo' } } }) + '\\n');
        } else if (message.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'demo.tool' }] } }) + '\\n');
        } else if (message.method === 'tools/call') {
          if (message.params.name === 'demo.tool') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }) + '\\n');
          } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: '工具不存在' } }) + '\\n');
          }
        }
      });
    `;
  }

  function createClient(timeoutMs = 5000) {
    return new MCPClient({
      command: process.execPath,
      args: ['-e', createServerCode()],
      timeoutMs,
    });
  }

  it('未连接时请求返回中文错误', async () => {
    const client = createClient();
    await expect(client.listTools()).rejects.toThrow('MCP 服务未连接');
    await expect(client.close()).resolves.toBe(undefined);
  });

  it('连接 MCP 服务、列出工具并调用工具', async () => {
    const client = createClient();
    await client.connect();
    await client.connect();

    expect(await client.listTools()).toEqual([{ name: 'demo.tool' }]);
    expect(await client.callTool('demo.tool', { value: 1 })).toEqual({ ok: true });
    await expect(client.callTool('不存在')).rejects.toThrow('工具不存在');

    const internal = client as any;
    internal.handleMessage(JSON.stringify({ jsonrpc: '2.0', result: {} }));
    internal.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: '未知', result: {} }));
    internal.process.stderr.emit('data', '   ');
    internal.handleChunk(JSON.stringify({ jsonrpc: '2.0' }) + '\\n');

    await client.close();
  });

  it('连接超时和服务退出时返回中文错误', async () => {
    const timeoutClient = new MCPClient({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1000)'],
      timeoutMs: 10,
    });
    await expect(timeoutClient.connect()).rejects.toThrow('MCP 请求超时：initialize');
    await timeoutClient.close();

    const exitClient = new MCPClient({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 5000,
    });
    await expect(exitClient.connect()).rejects.toThrow('MCP 服务已退出');
  });

  it('协议边界忽略空行和通知，支持空工具列表、请求错误与关闭拒绝', async () => {
    const client = createClient() as any;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.handleChunk('  \n');
    client.handleChunk('not-json\n');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('忽略无法解析的 MCP 消息'));

    client.request = vi.fn(async () => undefined);
    await expect(client.listTools()).resolves.toEqual([]);

    const writes: string[] = [];
    client.process = { stdin: { writable: true, write: (line: string) => writes.push(line) } };
    await client.notify('test/notification', { value: 1 });
    expect(JSON.parse(writes[0])).toMatchObject({ jsonrpc: '2.0', method: 'test/notification', params: { value: 1 } });

    const pending = new Promise((resolve, reject) => {
      client.pending.set('pending', { resolve, reject, timer: setTimeout(() => {}, 1000) });
    });
    client.rejectAll(new Error('主动关闭'));
    await expect(pending).rejects.toThrow('主动关闭');
    client.process = { stdin: { writable: false } };
    expect(() => client.writeMessage({ jsonrpc: '2.0', method: 'blocked' })).toThrow('MCP 服务未连接');
    warnSpy.mockRestore();
  });

  it('MCP 默认参数和超时配置在无参数启动时仍可受控关闭', async () => {
    const client = new MCPClient({ command: process.execPath }) as any;
    client.process = { stdin: { writable: true, write: vi.fn() } };
    const pending = client.request('默认超时');
    client.rejectAll(new Error('测试关闭'));
    await expect(pending).rejects.toThrow('测试关闭');
  });

  it('MCP 未提供参数时使用空参数数组启动并受超时控制', async () => {
    const client = new MCPClient({ command: process.execPath, timeoutMs: 10 });
    await expect(client.connect()).rejects.toThrow(/MCP 请求超时：initialize|MCP 服务已退出/);
    await client.close();
  });
});
