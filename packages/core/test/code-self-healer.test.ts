import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeSelfHealer } from '../src/healing/CodeSelfHealer.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function createSource(content = 'export const answer = 1;'): string {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wta-code-healer-'));
  const file = path.join(tempDir, 'packages', 'core', 'src', 'demo.ts');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf-8');
  return file;
}

function router(response: unknown) {
  return { call: async () => JSON.stringify(response) } as any;
}

describe('CodeSelfHealer', () => {
  it('优先启用预注册降级策略并记录会话级热修复报告', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'wta-code-healer-'));
    const healer = new CodeSelfHealer({ rootDir: tempDir });
    let activated = 0;
    healer.strategies.register('selector-fallback', async () => {
      activated++;
      return true;
    });

    const report = await healer.recover(new Error('选择器失效'), {
      sessionId: 'session-1',
      strategyName: 'selector-fallback',
    });

    expect(activated).toBe(1);
    expect(report.status).toBe('fallback-applied');
    expect(healer.strategies.isActivated('selector-fallback')).toBe(true);
    expect(healer.getReports('session-1')).toEqual([report]);
  });

  it('审查模式只记录模型提出的安全补丁，不修改源码', async () => {
    const file = createSource();
    const healer = new CodeSelfHealer({
      rootDir: tempDir,
      router: router({
        rootCause: '常量错误',
        explanation: '将常量改为正确值',
        patch: { file: 'packages/core/src/demo.ts', find: 'answer = 1', replace: 'answer = 2' },
      }),
    });

    const report = await healer.recover(new Error('断言失败'), {
      sessionId: 'session-1',
      strategyName: 'demo',
      sourceFile: file,
    });

    expect(report.status).toBe('proposed');
    expect(report.explanation).toContain('等待审核');
    expect(readFileSync(file, 'utf-8')).toContain('answer = 1');
  });

  it('拒绝越界、危险、无法唯一定位和超过次数的补丁', async () => {
    createSource('export const answer = 1; export const second = 1;');
    const responses = [
      { patch: { file: '../outside.ts', find: 'x', replace: 'y' } },
      { patch: { file: 'packages/core/src/demo.ts', find: 'answer = 1', replace: 'fetch("https://bad.example")' } },
      { patch: { file: 'packages/core/src/demo.ts', find: '= 1', replace: '= 2' } },
    ];

    for (const response of responses) {
      const healer = new CodeSelfHealer({ rootDir: tempDir, router: router(response) });
      const report = await healer.recover(new Error('失败'), { sessionId: 'session-1', strategyName: 'demo' });
      expect(report.status).toBe('rejected');
      expect(report.error).toBeTruthy();
    }

    const first = new CodeSelfHealer({
      rootDir: tempDir,
      sourceRepairMode: 'auto',
      maxPatchesPerStrategy: 1,
      router: router({ patch: { file: 'packages/core/src/demo.ts', find: 'answer = 1', replace: 'answer = 2' } }),
      commandRunner: () => ({ status: 0, output: '' }),
    });
    expect((await first.recover(new Error('失败'), { sessionId: 'a', strategyName: 'demo' })).status).toBe('applied');
    const second = await first.recover(new Error('失败'), { sessionId: 'b', strategyName: 'demo' });
    expect(second.status).toBe('rejected');
    expect(second.error).toContain('最大修复次数');
  });

  it('自动模式在构建或测试失败时回滚源码', async () => {
    const file = createSource();
    const healer = new CodeSelfHealer({
      rootDir: tempDir,
      sourceRepairMode: 'auto',
      router: router({ patch: { file: 'packages/core/src/demo.ts', find: 'answer = 1', replace: 'answer = 2' } }),
      commandRunner: () => ({ status: 1, output: '编译失败' }),
    });

    const report = await healer.recover(new Error('失败'), { sessionId: 'session-1', strategyName: 'demo' });
    expect(report.status).toBe('rolled-back');
    expect(report.error).toContain('构建验证失败');
    expect(readFileSync(file, 'utf-8')).toContain('answer = 1');
  });

  it('没有模型、无有效 JSON 和源码堆栈都可安全退化', async () => {
    const file = createSource();
    const noRouter = new CodeSelfHealer({ rootDir: tempDir });
    const fallback = await noRouter.recover(new Error(`异常\n at demo (${file}:3:4)`), {
      sessionId: 'session-1',
      strategyName: 'demo',
    });
    expect(fallback.status).toBe('proposed');
    expect(fallback.patch).toBeUndefined();

    const malformed = new CodeSelfHealer({
      rootDir: tempDir,
      router: { call: async () => '不是 JSON' } as any,
    });
    const report = await malformed.recover(new Error('失败'), { sessionId: 'session-2', strategyName: 'demo' });
    expect(report.status).toBe('proposed');
    expect(report.rootCause).toBe('失败');
  });

  it('处理策略未激活、模型异常、无效补丁形状和不存在的源码', async () => {
    const file = createSource();
    const inactive = new CodeSelfHealer({
      rootDir: tempDir,
      router: { call: async () => { throw new Error('模型不可用'); } } as any,
    });
    inactive.strategies.register('未启用策略', () => false);
    const fallback = await inactive.recover('非 Error 异常', {
      sessionId: 'one', strategyName: '未启用策略', sourceFile: file,
    });
    expect(fallback).toMatchObject({ status: 'proposed', rootCause: '非 Error 异常' });
    expect(inactive.strategies.isActivated('未启用策略')).toBe(false);
    expect(inactive.getReports('other')).toEqual([]);

    const invalid = new CodeSelfHealer({
      rootDir: tempDir,
      router: router({ rootCause: 1, explanation: 2, strategyName: 3, patch: { file: 1 } }),
    });
    expect((await invalid.recover(new Error('原始错误'), { sessionId: 'two', strategyName: 'demo' })))
      .toMatchObject({ status: 'proposed', rootCause: '原始错误' });

    const missing = new CodeSelfHealer({
      rootDir: tempDir,
      router: router({ patch: { file: 'packages/core/src/missing.ts', find: 'a', replace: 'b' } }),
    });
    expect((await missing.recover(new Error('失败'), { sessionId: 'three', strategyName: 'demo' })).error)
      .toContain('目标文件不存在');
  });

  it('拒绝空或超长补丁，并在测试验证失败时回滚', async () => {
    createSource();
    for (const patch of [
      { file: 'packages/core/src/demo.ts', find: '', replace: 'x' },
      { file: 'packages/core/src/demo.ts', find: 'answer = 1', replace: 'x'.repeat(20001) },
    ]) {
      const healer = new CodeSelfHealer({ rootDir: tempDir, router: router({ patch }) });
      expect((await healer.recover(new Error('失败'), { sessionId: randomUUID(), strategyName: 'demo' })).error)
        .toContain('补丁内容为空或超过安全长度限制');
    }

    const healer = new CodeSelfHealer({
      rootDir: tempDir,
      sourceRepairMode: 'auto',
      router: router({ patch: { file: 'packages/core/src/demo.ts', find: 'answer = 1', replace: 'answer = 2' } }),
      commandRunner: (_command, args) => args[0] === 'build'
        ? { status: 0, output: '' }
        : { status: 1, output: '测试失败' },
    });
    const report = await healer.recover(new Error('失败'), { sessionId: 'test-failure', strategyName: 'demo' });
    expect(report).toMatchObject({ status: 'rolled-back' });
    expect(report.error).toContain('测试验证失败');
  });

  it('解析带包裹文本的补丁、拒绝损坏 JSON 并识别堆栈边界', () => {
    const file = createSource();
    const healer = new CodeSelfHealer({ rootDir: tempDir }) as any;
    const fallback = { rootCause: '原始原因', explanation: '原始说明', strategyName: 'demo' };

    expect(healer.parseProposal('说明 {"rootCause":"新原因","explanation":"新说明","strategyName":"新策略","patch":{"file":"a.ts","find":"a","replace":"b"}} 尾部', fallback))
      .toMatchObject({ rootCause: '新原因', explanation: '新说明', strategyName: '新策略', patch: { file: 'a.ts' } });
    expect(healer.parseProposal('{损坏}', fallback)).toEqual(fallback);
    expect(healer.parseProposal('没有对象', fallback)).toEqual(fallback);
    expect(healer.sourceFileFromStack()).toBeUndefined();
    expect(healer.sourceFileFromStack(' at x (/tmp/other.ts:1:2)')).toBeUndefined();
    expect(healer.sourceFileFromStack(' at demo (' + file + ':3:4)')).toBe(file);
    expect(healer.isPatchShape(null)).toBe(false);
  });

  it('默认命令执行器、时间戳和构建验证的安全分支可被观测', () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'wta-code-healer-default-'));
    const now = () => 42;
    const healer = new CodeSelfHealer({ rootDir: tempDir, now }) as any;
    const command = healer.runCommand(process.execPath, ['--version'], tempDir);
    expect(command.status).toBe(0);
    expect(command.output).toContain('v');

    const testFailure = new CodeSelfHealer({
      rootDir: tempDir,
      commandRunner: (_command, args) => args[0] === 'build'
        ? { status: 0, output: '构建通过' }
        : { status: 1, output: '测试失败' },
      now,
    }) as any;
    expect(testFailure.validateBuildAndTests()).toEqual({ ok: false, error: '测试验证失败：测试失败' });
    const report = testFailure.record({
      sessionId: 'session', strategyName: 'demo', status: 'proposed', rootCause: '原因', explanation: '说明',
    });
    expect(report).toMatchObject({ id: 'session-42-1', createdAt: 42 });
  });

  it('默认命令缺少输出时安全合并空文本，并保留空错误原因与堆栈回退', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'wta-code-healer-empty-'));
    const healer = new CodeSelfHealer({ rootDir: tempDir }) as any;
    expect(healer.runCommand('__wta_missing_command__', [], tempDir)).toMatchObject({ status: null, output: '' });
    const error = new Error('');
    error.stack = undefined;
    const proposal = await healer.diagnose(error, { sessionId: 'x', strategyName: 'demo' });
    expect(proposal.rootCause).toBe('未知运行时错误');

    const withRouter = new CodeSelfHealer({
      rootDir: tempDir,
      router: { call: async () => '{"rootCause":"ok","explanation":"ok"}' } as any,
    }) as any;
    await withRouter.diagnose(error, { sessionId: 'x', strategyName: 'demo' });
  });
});
