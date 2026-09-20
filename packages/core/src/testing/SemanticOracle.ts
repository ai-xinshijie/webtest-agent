import type { StructuredObservation } from '../perception/types.js';

export interface OracleVerdict {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * 语义断言的确定性基础层。模型只能补充候选规则，不能直接改变通过结论。
 */
export class SemanticOracle {
  evaluate(input: { action: string; before: StructuredObservation; after: StructuredObservation }): OracleVerdict[] {
    const result: OracleVerdict[] = [this.noCrash(input.after)];
    if (input.action.startsWith('submit-empty') || input.action.startsWith('submit-partial')) {
      result.push(this.invalidSubmit(input.after));
    }
    if (input.action.startsWith('submit-valid')) {
      result.push(this.validSubmit(input.before, input.after));
    }
    return result;
  }

  private noCrash(after: StructuredObservation): OracleVerdict {
    const hasError = after.consoleEvents.some(item => /error|typeerror|referenceerror/i.test(item));
    const serverError = after.networkEvents.some(item => (item.status ?? 0) >= 500);
    const passed = !hasError && !serverError && after.components.length > 0 && after.loadingOverlayCount === 0;
    return { name: '页面稳定性', passed, detail: passed ? '未发现崩溃、服务端错误、白屏或持续加载' : '检测到页面稳定性异常' };
  }

  private invalidSubmit(after: StructuredObservation): OracleVerdict {
    const validation = after.components.some(component => Boolean(component.validationMessage)
      || component.classes.some(name => /error|invalid/i.test(name)));
    const requests = after.networkEvents.some(event => ['POST', 'PUT', 'PATCH'].includes(event.method));
    const passed = validation || !requests;
    return { name: '非法提交校验', passed, detail: passed ? '非法提交未绕过校验' : '非法提交未显示校验且发出了写请求' };
  }

  private validSubmit(before: StructuredObservation, after: StructuredObservation): OracleVerdict {
    const changed = before.url !== after.url
      || before.dialogCount !== after.dialogCount
      || before.components.length !== after.components.length
      || after.networkEvents.some(event => ['POST', 'PUT', 'PATCH'].includes(event.method) && (event.status ?? 200) < 400);
    return { name: '有效提交反馈', passed: changed, detail: changed ? '有效提交产生了可验证反馈' : '有效提交未观察到可验证反馈' };
  }
}
