import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { InteractionExecutor } from '../src/tester/InteractionExecutor.js';
import type { ExtractedComponent } from '../src/perception/types.js';

function createComponent(overrides: Partial<ExtractedComponent> = {}): ExtractedComponent {
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
    type: 'text',
    selector: '#component',
    rect: { x: 0, y: 0, w: 100, h: 30 },
    ...overrides,
  };
}

function createBasePage(): Page {
  return {
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    selectOption: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
  } as unknown as Page;
}

function createActionPage(): Page {
  return {
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    dblclick: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    uncheck: vi.fn(async () => {}),
    selectOption: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    keyboard: { press: vi.fn(async () => {}) },
    mouse: { click: vi.fn(async () => {}) },
    locator: vi.fn(() => ({
      locator: vi.fn(() => ({ count: vi.fn(async () => 3) })),
    })),
  } as unknown as Page;
}

describe('InteractionExecutor 动作分支', () => {
  it('按 ID、testId、aria-label 和 placeholder 推导选择器', async () => {
    const executor = new InteractionExecutor();
    const page = createBasePage();
    const fields = [
      createComponent({ selector: null, id: 'by-id', text: 'ID 字段', ariaLabel: 'ID 字段', placeholder: 'ID 字段' }),
      createComponent({ selector: null, id: null, testId: 'by-testid', text: '测试字段', ariaLabel: '测试字段', placeholder: '测试字段' }),
      createComponent({ selector: null, id: null, testId: null, ariaLabel: '邮箱', placeholder: '邮箱', text: '邮箱', type: 'email' }),
      createComponent({ selector: null, id: null, testId: null, ariaLabel: null, placeholder: '请输入邮箱', text: '邮箱占位', type: undefined }),
    ];

    await executor.fillForm(page, fields, 'valid');

    const selectors = (page.fill as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0]);
    expect(selectors).toEqual([
      '#by-id',
      '[data-testid="by-testid"]',
      'input[aria-label="邮箱"]',
      'input[placeholder="请输入邮箱"]',
    ]);
  });

  it('覆盖正常、异常、边界值和字段类型分支', async () => {
    const executor = new InteractionExecutor();
    const page = createBasePage();
    const validFields = [
      createComponent({ selector: '#label-email', type: undefined, text: 'Email', ariaLabel: 'Email', placeholder: 'Email' }),
      createComponent({ selector: '#placeholder-email', type: undefined, text: '邮箱地址', ariaLabel: '邮箱地址', placeholder: 'email here' }),
      createComponent({ selector: '#chinese-email', type: undefined, text: '邮箱', ariaLabel: '邮箱', placeholder: '邮箱' }),
      createComponent({ selector: '#phone-label', type: undefined, text: 'Phone', ariaLabel: 'Phone', placeholder: 'Phone' }),
      createComponent({ selector: '#website-label', type: undefined, text: 'Website', ariaLabel: 'Website', placeholder: 'Website' }),
      createComponent({ selector: '#name-label', type: undefined, text: 'Name', ariaLabel: 'Name', placeholder: 'Name' }),
      createComponent({ selector: '#user-label', type: undefined, text: 'User', ariaLabel: 'User', placeholder: 'User' }),
      createComponent({ selector: '#default', type: undefined, text: '普通字段', ariaLabel: '普通字段', placeholder: '普通字段' }),
      createComponent({ tag: 'div', role: 'generic', selector: '#not-field', type: undefined, text: '不是字段', ariaLabel: '不是字段', placeholder: '不是字段' }),
    ];

    const valid = await executor.fillForm(page, validFields, 'valid');
    expect(valid['Email']).toBe('test@example.com');
    expect(valid['邮箱地址']).toBe('test@example.com');
    expect(valid['邮箱']).toBe('test@example.com');
    expect(valid['Phone']).toBe('13800138000');
    expect(valid['Website']).toBe('https://example.com');
    expect(valid['Name']).toBe('Test User');
    expect(valid['User']).toBe('Test User');
    expect(valid['普通字段']).toBe('Test Value');
    expect(valid['不是字段']).toBeUndefined();

    const invalid = await executor.fillForm(page, [
      createComponent({ selector: '#invalid-email', type: 'email', text: '邮箱', ariaLabel: '邮箱', placeholder: '邮箱' }),
      createComponent({ selector: '#invalid-number', type: 'number', text: '数量', ariaLabel: '数量', placeholder: '数量' }),
      createComponent({ selector: '#invalid-url', type: 'url', text: '网站', ariaLabel: '网站', placeholder: '网站' }),
      createComponent({ selector: '#invalid-default', type: undefined, maxLength: undefined, text: '默认', ariaLabel: '默认', placeholder: '默认' }),
    ], 'invalid');
    expect(invalid['邮箱']).toBe('not-an-email');
    expect(invalid['邮箱']).toHaveLength(12);
    expect(Object.values(invalid)).toContain('not-a-number');
    expect(Object.values(invalid)).toContain('not-a-url');
    expect(Object.values(invalid)).toContain('<script>alert(1)</script>');

    const boundary = await executor.fillForm(page, [
      createComponent({ selector: '#boundary-default', maxLength: undefined }),
    ], 'boundary');
    expect(boundary['用户名']).toHaveLength(1000);
  });

  it('带日志器时记录填充、点击和动作执行', async () => {
    const executor = new InteractionExecutor();
    const page = createBasePage();
    const logger = {
      runScript: vi.fn(async (_trigger: unknown, _action: unknown, execute: () => unknown) => execute()),
    };
    executor.setLogger(logger as never);

    await executor.fill(page, createComponent(), '测试值', { context: { phase: 'test' } });
    await executor.click(page, createComponent(), { context: { phase: 'test' } });
    const result = await executor.executeAction(page, createComponent(), 'click', { context: { phase: 'test' } });

    expect(result).toEqual({ action: 'click', selector: '#component' });
    expect(logger.runScript).toHaveBeenCalledTimes(3);
    expect(page.fill).toHaveBeenCalledWith('#component', '测试值', { timeout: 5000 });
    expect(page.click).toHaveBeenCalledWith('#component', { timeout: 5000 });

    await executor.submitForm(page, createComponent(), { context: { phase: 'test' } });
    expect(logger.runScript).toHaveBeenCalledTimes(5);
  });

  it('执行全部内置动作并覆盖键盘、鼠标和下拉逻辑', async () => {
    const executor = new InteractionExecutor();
    const page = createActionPage();
    const actions = [
      'click', 'open', 'expand', 'switch', 'row-click', 'next', 'prev', 'first', 'last', 'sort', 'filter',
      'double-click', 'right-click', 'fill', 'fill-max', 'fill-invalid', 'clear', 'check', 'uncheck',
      'select', 'select-first', 'select-last', 'select-random', 'collapse', 'close-button', 'close-esc',
      'close-overlay', 'submit-empty', 'submit-partial', 'submit-valid',
    ];
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const results = [];
    for (const action of actions) {
      results.push(await executor.executeAction(page, createComponent(), action));
    }
    randomSpy.mockRestore();

    expect(results).toHaveLength(actions.length);
    expect(page.dblclick).toHaveBeenCalledWith('#component', { timeout: 5000 });
    expect(page.click).toHaveBeenCalledWith('#component', { timeout: 5000, button: 'right' });
    expect(page.check).toHaveBeenCalledWith('#component', { timeout: 5000 });
    expect(page.uncheck).toHaveBeenCalledWith('#component', { timeout: 5000 });
    expect(page.selectOption).toHaveBeenCalledWith('#component', { index: 0 }, { timeout: 5000 });
    expect(page.selectOption).toHaveBeenCalledWith('#component', { index: 2 }, { timeout: 5000 });
    expect(page.selectOption).toHaveBeenCalledWith('#component', { index: 1 }, { timeout: 5000 });
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape');
    expect(page.mouse.click).toHaveBeenCalledWith(2, 2);
    expect(page.fill).toHaveBeenCalledWith('#component', 'Test Value', { timeout: 5000 });
    expect(page.fill).toHaveBeenCalledWith('#component', 'a'.repeat(1000), { timeout: 5000 });
    expect(page.fill).toHaveBeenCalledWith('#component', '<script>alert(1)</script>', { timeout: 5000 });
    expect(page.fill).toHaveBeenCalledWith('#component', '', { timeout: 5000 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(150);
    expect(page.waitForTimeout).toHaveBeenCalledWith(1000);
  });

  it('动作和选择器无效时返回中文错误', async () => {
    const executor = new InteractionExecutor();
    const page = createBasePage();

    await expect(executor.executeAction(page, createComponent(), 'unknown'))
      .rejects.toThrow('不支持的测试动作：unknown');
    await expect(executor.executeAction(page, createComponent({
      selector: null,
      id: null,
      testId: null,
      ariaLabel: null,
      placeholder: null,
    }), 'click')).rejects.toThrow('组件没有可用选择器：input');
    await expect(executor.selectOption(page, createComponent({
      selector: null,
      id: null,
      testId: null,
      ariaLabel: null,
      placeholder: null,
    }), '北京')).rejects.toThrow('No selector for component: input');
  });

  it('字段值生成覆盖空值、特殊类型、长度约束与字段名回退', () => {
    const executor = new InteractionExecutor() as any;
    expect(executor.generateTestValue(createComponent(), 'empty')).toBe('');
    expect(executor.getValidValue(createComponent({ type: 'number' }))).toBe('42');
    expect(executor.getValidValue(createComponent({ type: 'password' }))).toBe('TestPass123!');
    expect(executor.getValidValue(createComponent({ type: 'date' }))).toBe('2024-01-15');
    expect(executor.getValidValue(createComponent({ tag: 'textarea', type: undefined }))).toContain('automated testing');
    expect(executor.getInvalidValue(createComponent({ maxLength: 2, type: undefined }))).toHaveLength(102);
    expect(executor.getBoundaryValue(createComponent({ maxLength: 2 }))).toBe('aa');
    expect(executor.getFieldName(createComponent({ text: undefined, ariaLabel: null, placeholder: null, testId: 'field-id' }))).toBe('field-id');
    expect(executor.isFormField(createComponent({ tag: 'div', role: 'textbox' }))).toBe(true);
    expect(executor.isFormField(createComponent({ tag: 'div', role: 'generic' }))).toBe(false);
  });

  it('缺少选择器、单选下拉和字段名称回退保持可预期行为', async () => {
    const executor = new InteractionExecutor() as any;
    const page = createActionPage();
    (page.locator as any).mockReturnValue({ locator: vi.fn(() => ({ count: vi.fn(async () => 1) })) });
    const noSelector = createComponent({ selector: null, id: null, testId: null, ariaLabel: null, placeholder: null });
    await expect(executor.fill(page, noSelector, '值')).rejects.toThrow('组件没有可用选择器');
    await expect(executor.click(page, noSelector)).rejects.toThrow('组件没有可用选择器');
    await executor.executeAction(page, createComponent(), 'select-random');
    expect(page.selectOption).toHaveBeenLastCalledWith('#component', { index: 0 }, { timeout: 5000 });
    expect(executor.getFieldName(createComponent({ text: undefined, ariaLabel: null, placeholder: null, testId: undefined }))).toBe('input');
  });

  it('空文本字段和缺省类型按默认值及标签回退填充', async () => {
    const executor = new InteractionExecutor() as any;
    const page = createBasePage();
    const field = createComponent({ text: undefined, ariaLabel: null, placeholder: null, type: undefined });
    await executor.fillForm(page, [field], 'valid');
    expect(page.fill).toHaveBeenCalledWith('#component', 'Test Value', { timeout: 5000 });
    expect(executor.getValidValue(createComponent({ text: undefined, ariaLabel: null, placeholder: null, type: 'tel' }))).toBe('13800138000');
    expect(executor.getValidValue(createComponent({ text: undefined, ariaLabel: null, placeholder: null, type: 'url' }))).toBe('https://example.com');
  });

  it('字段值生成器允许跳过无值字段并覆盖 placeholder 标签回退', async () => {
    const executor = new InteractionExecutor() as any;
    const page = createBasePage();
    const field = createComponent({ text: undefined, ariaLabel: null, placeholder: '提示', type: 'text' });
    vi.spyOn(executor, 'generateTestValue').mockReturnValueOnce(undefined);
    await expect(executor.fillForm(page, [field], 'valid')).resolves.toEqual({});
    expect(page.fill).not.toHaveBeenCalled();
    expect(executor.getFieldName(field)).toBe('提示');
  });
});
