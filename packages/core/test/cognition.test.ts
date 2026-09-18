import { describe, expect, it } from 'vitest';
import { classifyComponent } from '../src/cognition/ComponentModel.js';
import { QR001, QR002, QR006 } from '../src/cognition/QualityRule.js';
import type { ExtractedComponent, StructuredObservation } from '../src/perception/types.js';

function createComponent(overrides: Partial<ExtractedComponent> = {}): ExtractedComponent {
  return {
    tag: 'div',
    role: null,
    classes: [],
    ariaLabel: null,
    placeholder: null,
    state: {
      visible: true,
      enabled: true,
      inViewport: true,
      cursorPointer: true,
      userSelectNone: false,
    },
    clickability: {
      score: 0,
      isInteractive: false,
      isHighConfidence: false,
      signals: {
        isSemanticTag: false,
        hasAriaRole: false,
        cursorPointer: true,
        hasOnclick: false,
        hasTabIndex: false,
      },
    },
    rect: { x: 0, y: 0, w: 100, h: 30 },
    selector: null,
    ...overrides,
  };
}

function createObservation(overrides: Partial<StructuredObservation> = {}): StructuredObservation {
  return {
    type: 'structured',
    timestamp: Date.now(),
    url: 'https://example.com/page',
    title: '测试页面',
    components: [],
    forms: [],
    dialogCount: 0,
    loadingOverlayCount: 0,
    networkEvents: [],
    ...overrides,
  };
}

describe('classifyComponent', () => {
  it('按语义标签、ARIA 和组件库类名分类组件', () => {
    expect(classifyComponent(createComponent({ tag: 'button' })).type).toBe('button');
    expect(classifyComponent(createComponent({ tag: 'input', type: 'checkbox' })).type).toBe('checkbox');
    expect(classifyComponent(createComponent({ tag: 'input', type: 'radio' })).type).toBe('radio');
    expect(classifyComponent(createComponent({ tag: 'input', type: 'file' })).type).toBe('fileupload');
    expect(classifyComponent(createComponent({ role: 'dialog' })).type).toBe('modal');
    expect(classifyComponent(createComponent({ role: 'tab' })).type).toBe('tab');
    expect(classifyComponent(createComponent({ classes: ['ant-collapse'] })).type).toBe('accordion');
    expect(classifyComponent(createComponent({ classes: ['ant-pagination'] })).type).toBe('pagination');
    expect(classifyComponent(createComponent({
      clickability: {
        score: 0.6,
        isInteractive: true,
        isHighConfidence: true,
        signals: {
          isSemanticTag: false,
          hasAriaRole: false,
          cursorPointer: true,
          hasOnclick: false,
          hasTabIndex: false,
        },
      },
    })).type).toBe('button');
    expect(classifyComponent(createComponent({ clickability: { score: 0, isInteractive: false, isHighConfidence: false, signals: {
      isSemanticTag: false, hasAriaRole: false, cursorPointer: false, hasOnclick: false, hasTabIndex: false,
    } } })).type).toBe('unknown');
  });
});

describe('质量规则', () => {
  it('QR001：操作后有 DOM、URL、网络或控制台变化时通过', async () => {
    const before = createObservation({ components: [createComponent({ selector: '#a' })] });
    const after = createObservation({ components: [createComponent({ selector: '#b' })] });
    const result = await QR001.check({
      before,
      after,
      action: { type: 'click', target: '#a' },
      networkLog: [],
      consoleLog: [],
      componentModel: null,
      memory: null,
    });
    expect(result.verdict).toBe('pass');
  });

  it('QR001：操作后完全无反馈时失败', async () => {
    const observation = createObservation();
    const result = await QR001.check({
      before: observation,
      after: observation,
      action: { type: 'click', target: '#a' },
      networkLog: [],
      consoleLog: [],
      componentModel: null,
      memory: null,
    });
    expect(result.verdict).toBe('fail');
    expect(result.violation?.ruleId).toBe('QR001');
  });

  it('QR002：非法表单提交无验证且发出 API 请求时失败', async () => {
    const result = await QR002.check({
      before: createObservation(),
      after: createObservation(),
      action: { type: 'click', target: 'submit' },
      networkLog: [{ url: 'https://example.com/api/submit', method: 'POST' }],
      consoleLog: [],
      componentModel: null,
      memory: null,
    });
    expect(result.verdict).toBe('fail');
    expect(result.violation?.severity).toBe('critical');
  });

  it('QR002：非表单提交或存在验证信息时通过', async () => {
    const passNoForm = await QR002.check({
      before: createObservation(),
      after: createObservation(),
      action: { type: 'click', target: '#menu' },
      networkLog: [],
      consoleLog: [],
      componentModel: null,
      memory: null,
    });
    const passValidation = await QR002.check({
      before: createObservation(),
      after: createObservation({ components: [createComponent({ validationMessage: '必填' })] }),
      action: { type: 'click', target: 'submit' },
      networkLog: [{ url: 'https://example.com/api/submit', method: 'POST' }],
      consoleLog: [],
      componentModel: null,
      memory: null,
    });
    expect(passNoForm.verdict).toBe('pass');
    expect(passValidation.verdict).toBe('pass');
  });

  it('QR006：控制台错误、服务端错误或白屏时失败', async () => {
    const jsError = await QR006.check({
      before: createObservation(),
      after: createObservation(),
      action: { type: 'click', target: '#a' },
      networkLog: [],
      consoleLog: ['Uncaught TypeError: x is not a function'],
      componentModel: null,
      memory: null,
    });
    const serverError = await QR006.check({
      before: createObservation(),
      after: createObservation({ components: [createComponent()] }),
      action: { type: 'click', target: '#a' },
      networkLog: [{ url: 'https://example.com/api', method: 'GET', status: 500 }],
      consoleLog: [],
      componentModel: null,
      memory: null,
    });
    expect(jsError.verdict).toBe('fail');
    expect(serverError.verdict).toBe('fail');
  });

  it('QR006：页面有内容且无异常时通过', async () => {
    const result = await QR006.check({
      before: createObservation(),
      after: createObservation({ components: [createComponent()] }),
      action: { type: 'click', target: '#a' },
      networkLog: [],
      consoleLog: [],
      componentModel: null,
      memory: null,
    });
    expect(result.verdict).toBe('pass');
  });
});
