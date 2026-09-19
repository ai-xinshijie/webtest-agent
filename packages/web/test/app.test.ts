// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import App from '../src/App.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
}

const target = {
  name: 'demo',
  url: 'https://demo.test',
  strategy: { runMode: 'continue' as const, depth: 'deep' as const, parallel: 1 },
};

const session = {
  id: 'session-progress',
  targetName: 'demo',
  status: 'running',
  phase: 'test',
  startedAt: 1700000000000,
  progress: {
    executedActions: 10,
    skippedActions: 2,
    executedCombinations: 4,
    executedPaths: 3,
    chaosTests: 5,
    coverage: {
      actions: { visited: 9, blocked: 1, pending: 0, percentage: 90 },
      combinations: { covered: 4, total: 4, percentage: 100 },
      paths: { covered: 3, total: 4, percentage: 75 },
    },
  },
};

const legacySession = {
  id: 'legacy-session',
  targetName: 'demo',
  status: 'custom-status',
  phase: 'report',
  startedAt: 1700000000000,
  progress: null,
};

const timeline = [
  {
    id: 'script-log',
    sequence: 1,
    timestamp: 1700000000000,
    source: 'script' as const,
    trigger: { description: '执行登录', module: 'Auth', method: 'login' },
    action: { type: 'login', target: '#user' },
    result: { status: 'warning' as const, duration: 20, output: 'D:/shots/login.png' },
    context: { phase: 'login' },
  },
  {
    id: 'model-log',
    sequence: 2,
    timestamp: 1700000001000,
    source: 'model' as const,
    trigger: { description: '识别组件', module: 'LLM', method: 'identify' },
    action: { type: 'model-call', params: { count: 1 } },
    model: { provider: 'custom', model: 'test-model', request: { messages: [] }, response: { content: '按钮' } },
    result: { status: 'failed' as const, duration: 30, error: '模型失败' },
  },
  {
    id: 'user-log',
    sequence: 3,
    timestamp: 1700000002000,
    source: 'user' as const,
    trigger: { description: '启动会话', module: 'Orchestrator', method: 'run' },
    result: { status: 'success' as const, duration: 1, output: 'x.png' },
  },
  {
    id: 'system-log',
    sequence: 4,
    timestamp: 1700000003000,
    source: 'system' as const,
    trigger: { module: 'System', method: 'init' },
    result: { status: 'success' as const, duration: 2, output: 123 },
  },
  {
    id: 'missing-result-log',
    sequence: 5,
    timestamp: 1700000004000,
    source: 'script' as const,
    trigger: { description: '未返回结果' },
  },
];

const memory = {
  overview: { targetCount: 1, testedItemCount: 3, ruleCount: 4, patternCount: 5, summaryCount: 6 },
  targets: [{
    name: 'demo',
    memory: {
      testedItems: [{ itemKey: 'demo:/login:click', status: 'success', testCount: 2, lastTestedAt: 1 }],
      rules: [{ statement: '按钮必须可点击', confidence: 0.9 }],
      patterns: [{ pattern: '登录页必测', reliability: 0.8 }],
      summaries: [{ sessionId: 'session-progress', createdAt: 1 }],
    },
  }],
};

const plugins = [{
  name: '示例插件',
  version: '1.0.0',
  enabled: true,
  loaded: true,
  toolCount: 2,
  description: '测试插件',
}, {
  name: '停用插件',
  version: '0.2.0',
  enabled: false,
  loaded: false,
  toolCount: 0,
  description: '停用示例',
}];

let fetchMock: ReturnType<typeof vi.fn>;

function response(data: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/targets') return response([target]);
    if (url === '/api/sessions') return response([session, legacySession]);
    if (url === '/api/run') return response({ sessionId: 'new-session' });
    if (url === '/api/sessions/session-progress/timeline') return response(timeline);
    if (url === '/api/sessions/legacy-session/timeline') return response([]);
    if (url === '/api/sessions/new-session/timeline') return response([]);
    if (url === '/api/reports') {
      return response([{ name: 'report.md', path: 'D:/reports/report.md', format: 'md' }]);
    }
    if (url === '/api/memory') return response(memory);
    if (url === '/api/plugins') return response(plugins);
    if (url === '/api/config') return response({ browserDir: 'vendor/browsers' });
    if (url === '/api/sessions/session-progress/stop') return response({ status: 'stopped' });
    if (url === '/api/sessions/session-progress/resume') return response({ status: 'running' });
    return response({ error: '未模拟接口' }, false);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Web GUI', () => {
  it('展示总览并提交深度测试配置', async () => {
    render(createElement(App));
    expect((await screen.findAllByText('demo')).length).toBeGreaterThan(0);
    expect(screen.getByText('https://demo.test')).toBeTruthy();
    expect(screen.getByText('session-')).toBeTruthy();
    expect(screen.getByText('运行中')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('运行模式'), { target: { value: 'regression' } });
    fireEvent.change(screen.getByLabelText('阶段'), { target: { value: 'chaos' } });
    fireEvent.change(screen.getByLabelText('并行数'), { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText('无头模式'));
    fireEvent.click(screen.getByRole('button', { name: '启动' }));

    await screen.findByText('执行时间线');
    const runCall = fetchMock.mock.calls.find(call => String(call[0]) === '/api/run');
    expect(runCall).toBeDefined();
    expect(JSON.parse(String(runCall![1]!.body))).toEqual({
      target: 'demo',
      mode: 'regression',
      phase: 'chaos',
      parallel: 4,
      headless: false,
    });
  });

  it('监控会话、展开时间线并展示截图详情', async () => {
    const { container } = render(createElement(App));
    await screen.findAllByText('demo');
    fireEvent.click(screen.getByRole('button', { name: '监控' }));

    expect(await screen.findByText('demo / session-')).toBeTruthy();
    expect(screen.getByText('90.0%')).toBeTruthy();
    expect(screen.getByText('100.0%')).toBeTruthy();
    expect(screen.getByText('75.0%')).toBeTruthy();
    expect(screen.getByText('警告')).toBeTruthy();
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getAllByText('脚本').length).toBeGreaterThan(0);
    expect(screen.getByText('模型')).toBeTruthy();
    expect(screen.getByText('系统')).toBeTruthy();
    expect(screen.getByText('用户')).toBeTruthy();
    expect(screen.getByText('未返回结果')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /执行登录/ }));
    fireEvent.click(screen.getByRole('button', { name: /识别组件/ }));
    expect(container.textContent).toContain('识别组件');
    expect(container.textContent).toContain('模型失败');
    expect(screen.getByAltText('测试截图').getAttribute('src')).toBe('/screenshots/shots/login.png');

    fireEvent.click(screen.getByTitle('停止'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-progress/stop', { method: 'POST' }));
    fireEvent.click(screen.getByTitle('恢复'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-progress/resume', { method: 'POST' }));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'legacy-session' } });
    await waitFor(() => expect(container.textContent).toContain('custom-status'));
    expect(screen.getAllByText('0.0%')).toHaveLength(3);
  });

  it('使用 HTTPS 页面时建立 WSS 连接', async () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'secure.test' });
    render(createElement(App));
    await screen.findAllByText('demo');
    const socket = MockWebSocket.instances.at(-1)!;
    expect(socket.url).toBe('wss://secure.test/ws');
  });

  it('通过 WebSocket 刷新会话状态', async () => {
    render(createElement(App));
    await screen.findAllByText('demo');
    const socket = MockWebSocket.instances.at(-1)!;

    socket.onmessage?.({ data: JSON.stringify({ sessions: [{ ...session, status: 'stopped' }] }) });
    await screen.findByText('已停止');

    socket.onmessage?.({ data: JSON.stringify({ type: 'status' }) });
    await Promise.resolve();
    expect(screen.getByText('已停止')).toBeTruthy();
  });

  it('默认阶段为全部并容忍无会话 ID 响应', async () => {
    render(createElement(App));
    await screen.findAllByText('demo');
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/run') return response({});
      return originalFetch(input, init);
    });

    fireEvent.click(screen.getByRole('button', { name: '启动' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]) === '/api/run')).toBe(true));
    const runCall = fetchMock.mock.calls.find(call => String(call[0]) === '/api/run')!;
    expect(JSON.parse(String(runCall[1]!.body))).toEqual({
      target: 'demo',
      mode: 'continue',
      parallel: 1,
      headless: true,
    });
    await screen.findByText('执行时间线');
  });

  it('展示报告、记忆、插件并保存配置', async () => {
    render(createElement(App));
    await screen.findAllByText('demo');

    fireEvent.click(screen.getByRole('button', { name: '报告' }));
    expect(await screen.findByText('report.md')).toBeTruthy();
    expect(screen.getByText('MD')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    expect(await screen.findByText('记忆概览')).toBeTruthy();
    expect(screen.getByText('demo:/login:click · success · 2 次')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '插件' }));
    expect(await screen.findByText('示例插件')).toBeTruthy();
    expect(screen.getByText('启用')).toBeTruthy();
    expect(screen.getByText('停用')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const textarea = await screen.findByRole('textbox');
    expect(textarea.textContent).toContain('browserDir');
    fireEvent.change(textarea, { target: { value: '{"parallel":2}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(item => String(item[0]) === '/api/config' && item[1]?.method === 'PUT');
      expect(call).toBeDefined();
      expect(call![1]!.body).toBe('{"parallel":2}');
    });
  });

  it('支持刷新、切换目标和从最近会话进入监控', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/targets') {
        return response([target, { ...target, name: 'second', url: 'https://second.test' }]);
      }
      if (url === '/api/sessions') return response([session]);
      if (url === '/api/sessions/session-progress/timeline') return response(timeline);
      return response([]);
    });

    render(createElement(App));
    await screen.findAllByText('demo');
    fireEvent.click(screen.getByTitle('刷新'));
    await waitFor(() => expect(fetchMock.mock.calls.filter(call => String(call[0]) === '/api/targets').length).toBeGreaterThanOrEqual(2));

    fireEvent.change(screen.getByLabelText('测试目标'), { target: { value: 'second' } });
    expect((screen.getByLabelText('测试目标') as HTMLSelectElement).value).toBe('second');

    fireEvent.click(screen.getByText('session-').closest('tr')!);
    expect(await screen.findByText('demo / session-')).toBeTruthy();
  });

  it('监控请求未完成时卸载不会更新状态', async () => {
    let resolveTimeline: ((value: typeof timeline) => void) | undefined;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/targets') return response([target]);
      if (url === '/api/sessions') return response([session]);
      if (url === '/api/sessions/session-progress/timeline') {
        return new Promise<Response>(resolve => {
          resolveTimeline = (data: typeof timeline) => resolve(response(data));
        });
      }
      return response([]);
    });

    const { unmount } = render(createElement(App));
    await screen.findAllByText('demo');
    fireEvent.click(screen.getByRole('button', { name: '监控' }));
    unmount();
    resolveTimeline?.([]);
    await Promise.resolve();
  });

  it('没有测试目标时启动按钮不可用', async () => {

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      return response(url === '/api/targets' ? [] : []);
    });
    render(createElement(App));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/targets'));
    const button = screen.getByRole('button', { name: '启动' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(fetchMock.mock.calls.some(call => String(call[0]) === '/api/run')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '监控' }));
    fireEvent.click(screen.getByTitle('停止'));
    fireEvent.click(screen.getByTitle('恢复'));
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/stop'))).toBe(false);
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/resume'))).toBe(false);
  });
});
