import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const browser = {
    isConnected: vi.fn(() => true),
    close: vi.fn(async () => {}),
  };
  const context = {
    newPage: vi.fn(async () => ({ id: 'page' })),
    close: vi.fn(async () => {}),
  };
  return {
    browser,
    context,
    chromiumLaunch: vi.fn(async () => browser),
    firefoxLaunch: vi.fn(async () => browser),
    webkitLaunch: vi.fn(async () => browser),
  };
});

vi.mock('playwright', () => ({
  chromium: { launch: mocks.chromiumLaunch },
  firefox: { launch: mocks.firefoxLaunch },
  webkit: { launch: mocks.webkitLaunch },
}));

import { BrowserManager } from '../src/browser/BrowserManager.js';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-browser-'));
  mocks.browser.isConnected.mockReset().mockReturnValue(true);
  mocks.browser.close.mockClear();
  mocks.context.newPage.mockClear();
  mocks.context.close.mockClear();
  mocks.chromiumLaunch.mockClear();
  mocks.firefoxLaunch.mockClear();
  mocks.webkitLaunch.mockClear();
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function createExecutable(relativePath: string) {
  const file = path.join(tempDir, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
  return file;
}

describe('BrowserManager', () => {
  it('探测不到内置浏览器时返回不可用', () => {
    const manager = new BrowserManager(tempDir);

    expect(manager.isBrowserAvailable()).toBe(false);
    expect(manager.getSessionIds()).toEqual([]);
  });

  it('优先使用 Headless Shell 并跳过缺失浏览器', () => {
    const headless = createExecutable(path.join('chromium_headless_shell-1208', 'chrome-headless-shell.exe'));
    const manager = new BrowserManager(tempDir);

    expect(manager.isBrowserAvailable('chromium')).toBe(true);
    expect(manager.isBrowserAvailable('firefox')).toBe(false);
    expect(manager.isBrowserAvailable('webkit')).toBe(false);
    expect(headless).toBeTruthy();
  });

  it('有头模式优先使用完整浏览器', async () => {
    createExecutable('chrome-headless-shell.exe');
    createExecutable('chrome.exe');
    const manager = new BrowserManager(tempDir);

    await manager.launch({ headless: false });

    expect(mocks.chromiumLaunch).toHaveBeenCalledWith(expect.objectContaining({
      headless: false,
      executablePath: path.join(tempDir, 'chrome.exe'),
    }));
  });

  it('支持 WebKit 内置浏览器', async () => {
    createExecutable('webkitbrowser.exe');
    const manager = new BrowserManager(tempDir);

    await manager.launch({ browserType: 'webkit' });
    expect(mocks.webkitLaunch).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: path.join(tempDir, 'webkitbrowser.exe'),
    }));
  });

  it('支持递归查找 Linux 可执行文件', () => {
    const executable = createExecutable(path.join('chromium-1208', '1', '2', '3', '4', '5', 'chrome'));
    const manager = new BrowserManager(tempDir);

    expect(manager.isBrowserAvailable('chromium')).toBe(true);
    expect(executable).toBeTruthy();
  });

  it('复用同一浏览器并在切换类型时关闭旧浏览器', async () => {
    createExecutable('chrome.exe');
    createExecutable('firefox.exe');
    const manager = new BrowserManager(tempDir);

    const first = await manager.launch();
    const second = await manager.launch();
    expect(second).toBe(first);
    expect(mocks.chromiumLaunch).toHaveBeenCalledTimes(1);

    await manager.launch({ browserType: 'firefox' });
    expect(mocks.browser.close).toHaveBeenCalledTimes(1);
    expect(mocks.firefoxLaunch).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: path.join(tempDir, 'firefox.exe'),
    }));
  });

  it('使用默认上下文配置', async () => {
    createExecutable('chrome.exe');
    const manager = new BrowserManager(tempDir);
    const browser = mocks.browser as unknown as { newContext: typeof mocks.chromiumLaunch };
    browser.newContext = vi.fn(async () => mocks.context);

    await manager.createContext('session-default');
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1920, height: 1080 },
      storageState: undefined,
      recordVideo: undefined,
    });
  });

  it('创建上下文、页面并关闭指定会话', async () => {
    createExecutable('chrome-headless-shell.exe');
    const manager = new BrowserManager(tempDir);
    const browser = mocks.browser as unknown as { newContext: typeof mocks.chromiumLaunch };
    browser.newContext = vi.fn(async () => mocks.context);

    const context = await manager.createContext('session-1', {
      viewport: { width: 1280, height: 720 },
      recordVideo: true,
      videoDir: path.join(tempDir, 'videos'),
      storageStatePath: path.join(tempDir, 'not-exists.json'),
    });
    expect(context).toBe(mocks.context);

    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({
      viewport: { width: 1280, height: 720 },
      storageState: undefined,
      recordVideo: { dir: path.join(tempDir, 'videos') },
    }));

    await expect(manager.createPage('session-1')).resolves.toEqual({ id: 'page' });
    await manager.closeSession('not-exists');
    expect(mocks.context.close).not.toHaveBeenCalled();

    await manager.closeSession('session-1');
    expect(mocks.context.close).toHaveBeenCalledTimes(1);
    expect(manager.getSessionIds()).toEqual([]);
    await expect(manager.createPage('session-1')).rejects.toThrow('未找到会话的浏览器上下文：session-1');
  });

  it('跳过没有可执行文件的匹配目录', () => {
    mkdirSync(path.join(tempDir, 'chromium-a-empty'), { recursive: true });
    createExecutable(path.join('chromium-b', 'chrome'));
    const manager = new BrowserManager(tempDir);

    expect(manager.isBrowserAvailable('chromium')).toBe(true);
  });

  it('缺少浏览器时返回中文错误', async () => {
    const manager = new BrowserManager(tempDir);

    await expect(manager.launch()).rejects.toThrow('未找到项目内置浏览器：chromium，请执行 wta install browsers');
  });

  it('重启浏览器时先关闭再启动', async () => {
    createExecutable('chrome.exe');
    const manager = new BrowserManager(tempDir);
    await manager.launch();
    expect(manager.isAlive()).toBe(true);

    const restarted = await manager.restart();
    expect(restarted).toBe(mocks.browser);
    expect(mocks.browser.close).toHaveBeenCalledTimes(1);
    expect(mocks.chromiumLaunch).toHaveBeenCalledTimes(2);
  });

  it('关闭时忽略上下文和浏览器异常', async () => {
    createExecutable('chrome.exe');
    const manager = new BrowserManager(tempDir);
    const browser = mocks.browser as unknown as { newContext: typeof mocks.chromiumLaunch };
    browser.newContext = vi.fn(async () => mocks.context);
    await manager.createContext('session-1');
    mocks.context.close.mockRejectedValueOnce(new Error('上下文已关闭'));
    mocks.browser.close.mockRejectedValueOnce(new Error('浏览器已关闭'));

    await expect(manager.close()).resolves.toBeUndefined();
    expect(manager.isAlive()).toBe(false);
    expect(manager.getSessionIds()).toEqual([]);
  });
});
