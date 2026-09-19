import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPort = process.env.WTA_PORT;

afterEach(() => {
  if (originalPort === undefined) delete process.env.WTA_PORT;
  else process.env.WTA_PORT = originalPort;
  vi.resetModules();
  vi.doUnmock('../src/server.js');
});

describe('GUI 进程入口', () => {
  it('未设置端口时使用默认端口 7878', async () => {
    delete process.env.WTA_PORT;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
      logs.push(values.map(value => String(value)).join(' '));
    });
    const startGuiServer = vi.fn(async () => ({ port: 7878 }));

    vi.resetModules();
    vi.doMock('../src/server.js', () => ({ startGuiServer }));
    await import('../src/main.js');
    await new Promise(resolve => setImmediate(resolve));

    expect(startGuiServer).toHaveBeenCalledWith({ port: 7878 });
    expect(logs.join('\n')).toContain('WebTestAgent GUI 已启动：http://127.0.0.1:7878');
    logSpy.mockRestore();
  });

  it('启动成功时输出中文地址', async () => {
    process.env.WTA_PORT = '1234';
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...values) => {
      logs.push(values.map(value => String(value)).join(' '));
    });
    const startGuiServer = vi.fn(async () => ({ port: 1234 }));

    vi.resetModules();
    vi.doMock('../src/server.js', () => ({ startGuiServer }));
    await import('../src/main.js');
    await new Promise(resolve => setImmediate(resolve));

    expect(startGuiServer).toHaveBeenCalledWith({ port: 1234 });
    expect(logs.join('\n')).toContain('WebTestAgent GUI 已启动：http://127.0.0.1:1234');
    logSpy.mockRestore();
  });

  it('启动失败支持非 Error 异常', async () => {
    process.env.WTA_PORT = '1236';
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
      errors.push(values.map(value => String(value)).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    vi.doMock('../src/server.js', () => ({
      startGuiServer: vi.fn(async () => {
        throw '端口异常';
      }),
    }));

    vi.resetModules();
    await import('../src/main.js');
    await new Promise(resolve => setImmediate(resolve));

    expect(errors.join('\n')).toContain('GUI 启动失败：端口异常');
    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('启动失败时输出中文错误并退出进程', async () => {
    process.env.WTA_PORT = '1235';
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
      errors.push(values.map(value => String(value)).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    vi.doMock('../src/server.js', () => ({
      startGuiServer: vi.fn(async () => {
        throw new Error('端口被占用');
      }),
    }));

    vi.resetModules();
    await import('../src/main.js');
    await new Promise(resolve => setImmediate(resolve));

    expect(errors.join('\n')).toContain('GUI 启动失败：端口被占用');
    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
