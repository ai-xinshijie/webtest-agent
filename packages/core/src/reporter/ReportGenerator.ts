import { writeFileSync, mkdirSync } from 'node:fs';
import type { DatabaseManager } from '../db/Database.js';
import path from 'node:path';

export interface ReportOptions {
  outputDir: string;
  format: 'md' | 'json';
}

/**
 * 生成中文测试报告，Markdown 面向用户，JSON 面向机器读取。
 */
export class ReportGenerator {
  constructor(
    private db: DatabaseManager,
    private options: ReportOptions,
  ) {}

  /**
   * 生成指定会话的报告内容。
   */
  generate(sessionId: string): string {
    const session = this.db.prepare(`
      SELECT s.*, t.name as target_name, t.url as target_url
      FROM sessions s JOIN targets t ON s.target_id = t.id
      WHERE s.id = ?
    `).get(sessionId) as any;

    if (!session) throw new Error(`未找到测试会话：${sessionId}`);

    const pages = this.db.prepare(`
      SELECT * FROM pages WHERE target_id = ?
    `).all(session.target_id) as any[];

    const components = this.db.prepare(`
      SELECT * FROM components WHERE target_id = ?
    `).all(session.target_id) as any[];

    const bugs = this.db.prepare(`
      SELECT * FROM bugs WHERE session_id = ?
    `).all(sessionId) as any[];

    const testResults = this.db.prepare(`
      SELECT * FROM test_results WHERE session_id = ?
    `).all(sessionId) as any[];
    const logs = this.getLogs(sessionId);
    const progress = session.progress_json ? JSON.parse(session.progress_json) : null;
    const hotPatches = this.getHotPatches(sessionId);

    if (this.options.format === 'json') {
      return this.generateJSON(session, pages, components, bugs, testResults, logs, progress, hotPatches);
    }
    return this.generateMarkdown(session, pages, components, bugs, testResults, logs, progress, hotPatches);
  }

  private getLogs(sessionId: string): any[] {
    return (this.db.prepare(`
      SELECT sequence, source, log_json
      FROM agent_logs
      WHERE session_id = ?
      ORDER BY sequence ASC
    `).all(sessionId) as any[]).map(row => JSON.parse(row.log_json));
  }

  private getHotPatches(sessionId: string): any[] {
    return (this.db.prepare(`
      SELECT report_json FROM hot_patch_reports WHERE session_id = ? ORDER BY created_at ASC
    `).all(sessionId) as Array<{ report_json: string }>).map(row => JSON.parse(row.report_json));
  }

  private generateMarkdown(
    session: any,
    pages: any[],
    components: any[],
    bugs: any[],
    testResults: any[],
    logs: any[],
    progress: any,
    hotPatches: any[],
  ): string {
    const duration = session.ended_at ? ((session.ended_at - session.started_at) / 1000).toFixed(1) : 'N/A';
    const reportTime = new Date().toISOString();

    let md = `# WebTestAgent 测试报告

## 概要

| 指标 | 数值 |
|------|------|
| 测试目标 | ${session.target_name}（${session.target_url}） |
| 会话 ID | ${session.id} |
| 状态 | ${this.translateStatus(session.status)} |
| 持续时间 | ${duration} 秒 |
| 已访问页面 | ${pages.length} |
| 已识别组件 | ${components.length} |
| 已执行测试 | ${testResults.length} |
| 已发现问题 | ${bugs.length} |
| 审计日志条数 | ${logs.length} |
| 报告生成时间 | ${reportTime} |

## 功能覆盖

### 页面（${pages.length} 个）

`;

    for (const page of pages) {
      md += `- **${page.title || '未命名页面'}**：\`${page.url_pattern}\`（${this.translateTestStatus(page.test_status)}）\n`;
    }

    md += `\n### 组件类型\n\n`;

    const typeCounts = new Map<string, number>();
    for (const c of components) {
      typeCounts.set(c.type, (typeCounts.get(c.type) || 0) + 1);
    }
    for (const [type, count] of typeCounts) {
      md += `- ${this.translateComponentType(type)}：${count} 个\n`;
    }
    md += `\n### 深度覆盖\n\n${this.coverageMarkdown(progress)}`;

    if (bugs.length > 0) {
      md += `\n## 问题列表（${bugs.length} 个）\n\n`;

      for (let i = 0; i < bugs.length; i++) {
        const bug = bugs[i];
        md += `### 问题 ${i + 1}：${bug.title}

- **严重级别**：${this.translateSeverity(bug.severity)}
- **质量规则**：${bug.rule_id || '无'}
- **页面**：${bug.page_url || '未知'}
- **描述**：${bug.description || '无'}
- **发现时间**：${new Date(bug.detected_at).toISOString()}

`;
      }
    } else {
      md += `\n## 问题列表\n\n本次测试未发现问题。\n\n`;
    }

    const failedResults = testResults.filter(result => result.status === 'failed');
    if (failedResults.length > 0) {
      md += `## 执行异常（${failedResults.length} 条）\n\n`;
      md += '以下记录表示测试执行未能完成，不会自动归类为产品缺陷；请结合输入、错误证据和执行时间线复现判断。\n\n';
      for (let index = 0; index < failedResults.length; index++) {
        const result = failedResults[index];
        md += `### 执行异常 ${index + 1}：${result.test_type}\n\n- **耗时**：${result.duration_ms ?? 0} 毫秒\n- **输入**：\`${result.input_json ?? '{}'}\`\n- **错误证据**：\`${result.output_json ?? '{}'}\`\n\n`;
      }
    }

    if (testResults.length > 0) {
      md += `## 测试结果（${testResults.length} 条）\n\n| 测试类型 | 状态 | 耗时 |\n|----------|------|------|\n`;
      for (const tr of testResults) {
        md += `| ${tr.test_type} | ${this.translateStatus(tr.status)} | ${tr.duration_ms ?? 0} 毫秒 |\n`;
      }
    }

    md += `\n## 代码自愈\n\n`;
    if (hotPatches.length === 0) {
      md += '本次会话未触发代码级自愈。\n';
    } else {
      md += '| 策略 | 状态 | 根因 | 说明 |\n|------|------|------|------|\n';
      for (const patch of hotPatches) {
        md += `| ${patch.strategyName} | ${this.translateHotPatchStatus(patch.status)} | ${patch.rootCause} | ${patch.explanation} |\n`;
      }
    }

    md += `\n## 执行时间线\n\n| 序号 | 时间 | 来源 | 描述 | 状态 | 耗时 |\n|------|------|------|------|------|------|\n`;
    if (logs.length === 0) {
      md += `| 无 | - | - | 暂无审计日志 | - | - |\n`;
    }
    for (const log of logs) {
      const error = log.result?.error ? `（${log.result.error}）` : '';
      md += `| ${log.sequence} | ${new Date(log.timestamp).toISOString()} | ${this.translateSource(log.source)} | ${log.trigger?.description || '未命名操作'}${error} | ${this.translateStatus(log.result?.status || 'success')} | ${log.result?.duration ?? 0} 毫秒 |\n`;
    }

    return md;
  }

  private generateJSON(
    session: any,
    pages: any[],
    components: any[],
    bugs: any[],
    testResults: any[],
    logs: any[],
    progress: any,
    hotPatches: any[],
  ): string {
    return JSON.stringify({
      会话: {
        标识: session.id,
        测试目标: session.target_name,
        目标地址: session.target_url,
        状态: this.translateStatus(session.status),
        开始时间: session.started_at,
        结束时间: session.ended_at,
        持续毫秒: session.ended_at ? session.ended_at - session.started_at : null,
      },
      覆盖: {
        已访问页面数: pages.length,
        已识别组件数: components.length,
        组件类型: components.reduce((acc: Record<string, number>, c: any) => {
          acc[c.type] = (acc[c.type] || 0) + 1;
          return acc;
        }, {}),
      },
      深度覆盖: progress?.coverage ?? null,
      问题列表: bugs.map(b => ({
        标识: b.id,
        严重级别: this.translateSeverity(b.severity),
        标题: b.title,
        描述: b.description,
        页面: b.page_url,
        质量规则: b.rule_id,
        发现时间: b.detected_at,
      })),
      执行异常: testResults.filter(tr => tr.status === 'failed').map(tr => ({
        测试类型: tr.test_type,
        耗时毫秒: tr.duration_ms,
        输入: tr.input_json ? JSON.parse(tr.input_json) : null,
        错误证据: tr.output_json ? JSON.parse(tr.output_json) : null,
      })),
      测试结果: testResults.map(tr => ({
        测试类型: tr.test_type,
        状态: this.translateStatus(tr.status),
        耗时毫秒: tr.duration_ms,
        输入: tr.input_json ? JSON.parse(tr.input_json) : null,
        输出: tr.output_json ? JSON.parse(tr.output_json) : null,
      })),
      执行时间线: logs.map(log => ({
        序号: log.sequence,
        时间: log.timestamp,
        来源: log.source,
        触发: log.trigger,
        操作: log.action,
        模型: log.model,
        结果: log.result,
        上下文: log.context,
      })),
      代码自愈: hotPatches,
    }, null, 2);
  }

  /**
   * 保存报告文件。
   */
  save(sessionId: string, filename?: string): string {
    const content = this.generate(sessionId);
    const ext = this.options.format === 'json' ? 'json' : 'md';
    const defaultName = `report-${sessionId.slice(0, 8)}.${ext}`;
    const outputPath = filename
      ? path.resolve(filename)
      : path.join(this.options.outputDir, defaultName);

    const dir = path.dirname(outputPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, content, 'utf-8');

    console.log(`测试报告已保存：${outputPath}`);
    return outputPath;
  }

  private translateStatus(status: string): string {
    const map: Record<string, string> = {
      running: '运行中', completed: '已完成', success: '成功', failed: '失败', paused: '已暂停',
      passed: '通过', failed_test: '未通过', skipped: '已跳过', warning: '警告',
    };
    return map[status] ?? status;
  }

  private translateTestStatus(status: string): string {
    const map: Record<string, string> = {
      untested: '未测试', partial: '部分测试', tested: '已测试',
    };
    return map[status] ?? status;
  }

  private translateSeverity(severity: string): string {
    const map: Record<string, string> = {
      critical: '严重', major: '重要', minor: '一般', info: '提示',
    };
    return map[severity] ?? severity;
  }

  private translateSource(source: string): string {
    const map: Record<string, string> = {
      script: '脚本', model: '模型', system: '系统', user: '用户',
    };
    return map[source] ?? source;
  }

  private translateComponentType(type: string): string {
    const map: Record<string, string> = {
      button: '按钮', input: '输入框', textarea: '文本域', select: '下拉选择',
      form: '表单', table: '表格', modal: '弹框', accordion: '手风琴',
      tab: '标签页', toast: '通知', checkbox: '复选框', radio: '单选框',
      navigation: '导航', breadcrumb: '面包屑', pagination: '分页', link: '链接',
      dropdown: '下拉菜单', datepicker: '日期选择', fileupload: '文件上传',
      unknown: '未知组件',
    };
    return map[type] ?? type;
  }

  private coverageMarkdown(progress: any): string {
    const coverage = progress?.coverage;
    if (!coverage) return '本次会话尚未生成深度覆盖快照。\n';

    const actions = coverage.actions;
    const actionTotal = actions.visited + actions.blocked + actions.pending;
    const actionResolved = actions.resolvedPercentage ?? (actionTotal === 0
      ? 100
      : ((actions.visited + actions.blocked) / actionTotal) * 100);
    let markdown = '| 维度 | 已执行 | 受阻 | 待覆盖 | 总数 | 实际覆盖率 | 已解析率 |\n|------|--------|------|--------|------|------------|----------|\n';
    markdown += `| 动作 | ${actions.visited} | ${actions.blocked} | ${actions.pending} | ${actionTotal} | ${Number(actions.percentage ?? 0).toFixed(2)}% | ${Number(actionResolved).toFixed(2)}% |\n`;

    for (const [name, item] of [['组合', coverage.combinations], ['路径', coverage.paths]] as const) {
      const blocked = item.blocked ?? 0;
      const resolved = item.resolvedPercentage ?? (item.total === 0 ? 100 : ((item.covered + blocked) / item.total) * 100);
      markdown += `| ${name} | ${item.covered} | ${blocked} | ${Math.max(0, item.total - item.covered - blocked)} | ${item.total} | ${Number(item.percentage ?? 0).toFixed(2)}% | ${Number(resolved).toFixed(2)}% |\n`;
    }
    return `${markdown}\n实际覆盖率只计入真正执行的项目；已解析率包含已确认受阻项目。受阻项保留在报告中，便于后续解除条件后重测。\n`;
  }

  private translateHotPatchStatus(status: string): string {
    const map: Record<string, string> = {
      'fallback-applied': '已切换降级策略',
      proposed: '待人工审核',
      applied: '已应用',
      rejected: '已拒绝',
      'rolled-back': '已回滚',
    };
    return map[status] ?? status;
  }
}
