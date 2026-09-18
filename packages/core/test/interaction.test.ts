import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { InteractionExecutor } from '../src/tester/InteractionExecutor.js';
import type { ExtractedComponent } from '../src/perception/types.js';

function createField(overrides: Partial<ExtractedComponent> = {}): ExtractedComponent {
  return {
    tag: 'input',
    role: 'textbox',
    text: '用户名',
    classes: [],
    ariaLabel: '用户名',
    placeholder: '请输入用户名',
    state: {
      visible: true,
      enabled: true,
      inViewport: true,
      cursorPointer: false,
      userSelectNone: false,
    },
    clickability: {
      score: 0.4,
      isInteractive: true,
      isHighConfidence: false,
      signals: {
        isSemanticTag: true,
        hasAriaRole: true,
        cursorPointer: false,
        hasOnclick: false,
        hasTabIndex: false,
      },
    },
    type: 'text',
    maxLength: 10,
    required: true,
    selector: '#username',
    rect: { x: 0, y: 0, w: 200, h: 30 },
    ...overrides,
  };
}

function createPage(): Page {
  return {
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

describe('InteractionExecutor', () => {
  it('按字段类型生成正常、异常和边界测试值', async () => {
    const executor = new InteractionExecutor();
    const page = createPage();
    const email = createField({ type: 'email', text: '邮箱', ariaLabel: '邮箱', placeholder: '邮箱', selector: '#email' });

    const valid = await executor.fillForm(page, [email], 'valid');
    expect(valid).toEqual({ 邮箱: 'test@example.com' });
    expect(page.fill).toHaveBeenCalledWith('#email', 'test@example.com', { timeout: 5000 });

    const invalid = await executor.fillForm(page, [createField()], 'invalid');
    expect(invalid.用户名).toBe('a'.repeat(110));
    expect(invalid.用户名).toHaveLength(110);

    const boundary = await executor.fillForm(page, [createField()], 'boundary');
    expect(boundary.用户名).toHaveLength(10);
  });

  it('为电话、数字、URL、密码、日期和文本域生成测试数据', async () => {
    const executor = new InteractionExecutor();
    const page = createPage();
    const fields = [
      createField({ type: 'tel', text: '手机号', ariaLabel: '手机号', selector: '#phone' }),
      createField({ type: 'number', text: '数量', ariaLabel: '数量', selector: '#count' }),
      createField({ type: 'url', text: '网站', ariaLabel: '网站', selector: '#site' }),
      createField({ type: 'password', text: '密码', ariaLabel: '密码', selector: '#password' }),
      createField({ type: 'date', text: '日期', ariaLabel: '日期', selector: '#date' }),
      createField({ tag: 'textarea', type: undefined, text: '地址', ariaLabel: '地址', selector: '#address' }),
      createField({ type: 'text', text: '邮箱地址', ariaLabel: '邮箱地址', selector: '#email-like' }),
    ];

    const values = await executor.fillForm(page, fields, 'valid');
    expect(values.手机号).toBe('13800138000');
    expect(values.数量).toBe('42');
    expect(values.网站).toBe('https://example.com');
    expect(values.密码).toBe('TestPass123!');
    expect(values.日期).toBe('2024-01-15');
    expect(values.地址).toContain('automated testing');
    expect(values.邮箱地址).toBe('test@example.com');
  });

  it('提交表单时点击提交按钮并等待反馈', async () => {
    const executor = new InteractionExecutor();
    const page = createPage();
    const submit = createField({
      tag: 'button',
      role: 'button',
      text: '提交',
      ariaLabel: '提交',
      type: undefined,
      selector: '#submit',
    });

    await executor.submitForm(page, submit);
    expect(page.click).toHaveBeenCalledWith('#submit', { timeout: 5000 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(1000);
  });

  it('执行下拉选择、无效选择器异常和无选择器点击', async () => {
    const executor = new InteractionExecutor();
    const page = createPage();
    const select = createField({ tag: 'select', role: 'combobox', type: undefined, selector: '#city' });

    await executor.selectOption(page, select, '北京');
    expect(page.selectOption).toHaveBeenCalledWith('#city', '北京', { timeout: 5000 });

    await expect(executor.click(page, createField({
      selector: null,
      ariaLabel: null,
      placeholder: null,
    }))).rejects.toThrow('组件没有可用选择器：input');
  });
});
