import { Command } from 'commander';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseManager, TestCaseManager } from '@wta/core';
import { ensureDaemon } from './daemon.js';

function openCases(): { db: DatabaseManager; manager: TestCaseManager } {
  const dbPath = path.join(process.cwd(), '.wta', 'wta.db');
  if (!existsSync(dbPath)) throw new Error('未找到测试数据库，请先执行探索测试');
  const db = new DatabaseManager(dbPath);
  return { db, manager: new TestCaseManager(db) };
}

export const caseCommand = new Command('case')
  .description('查看和精确重跑编译后的测试用例');

caseCommand
  .command('list')
  .description('列出已编译测试用例')
  .option('--target <target>', '按测试目标过滤')
  .action((options: { target?: string }) => {
    const { db, manager } = openCases();
    try {
      const cases = manager.list(options.target);
      if (cases.length === 0) {
        console.log('暂无测试用例，请先执行：wta run <target> --phase explore');
        return;
      }
      console.log('测试用例：');
      for (const testCase of cases) {
        console.log(`  ${testCase.id.slice(0, 8)}  ${testCase.title}  ${testCase.lastStatus ?? '未执行'}`);
      }
    } finally {
      db.close();
    }
  });

caseCommand
  .command('show <caseId>')
  .description('显示一个用例的步骤和断言')
  .action((caseId: string) => {
    const { db, manager } = openCases();
    try {
      const testCase = manager.list().find(item => item.id === caseId);
      if (!testCase) throw new Error(`未找到测试用例：${caseId}`);
      console.log(`用例：${testCase.title}`);
      console.log('步骤：');
      for (const step of testCase.steps) console.log(`  ${step.order}. ${step.description}`);
      console.log('断言：');
      for (const assertion of testCase.assertions) console.log(`  - ${assertion}`);
    } finally {
      db.close();
    }
  });

caseCommand
  .command('run <caseId>')
  .description('精确重跑一个测试用例')
  .option('--headed', '使用有头浏览器')
  .action(async (caseId: string, options: { headed?: boolean }) => {
    const baseUrl = await ensureDaemon();
    const response = await fetch(`${baseUrl}/api/test-cases/${encodeURIComponent(caseId)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headless: !options.headed }),
    });
    if (!response.ok) throw new Error(`提交用例重跑失败：${response.status} ${await response.text()}`);
    const result = await response.json() as { sessionId: string };
    console.log(`用例重跑已提交：${result.sessionId}`);
  });
