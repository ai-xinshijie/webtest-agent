import { describe, expect, it } from 'vitest';
import { program } from '../src/index.js';

describe('CLI 程序装配', () => {
  it('注册全部智能体命令并暴露版本', () => {
    const names = program.commands.map(command => command.name());

    expect(names).toEqual([
      'init',
      'run',
      'doctor',
      'target',
      'report',
      'install',
      'daemon',
      'gui',
      'attach',
      'memory',
      'plugin',
      'config',
      'model',
      'mcp',
      'status',
      'stop',
      'auth',
      'case',
    ]);
    expect(program.name()).toBe('wta');
    expect(program.description()).toBe('自主 Web 界面深度测试代理');
    expect(program.version()).toBe('0.1.0');
  });
});
