# WebTestAgent 设计文档

> 自主 Web UI 测试智能体：给定目标系统 URL 和凭证，自动探索全部功能、执行深度组合测试、发现缺陷并生成报告。

---

## 1. 产品概述

### 1.1 定位

个人本地工具，CLI 为核心入口，GUI 作为 CLI 的可视化管理层。Agent 在本机运行，通过 Playwright 控制浏览器，对任意 Web 系统执行自主深度测试。

### 1.2 核心能力

| 能力 | 描述 |
|------|------|
| 自主探索 | 登录目标系统，广度优先遍历全部可达页面，构建完整 组件模型 |
| 功能发现 | 识别表单、手风琴、按钮、下拉菜单、弹框、标签页等组件及其交互关系 |
| 深度测试 | 穷举功能路径 + n-wise 组合 + 边界值 + 异常输入，持续 8-24 小时 |
| 缺陷检测 | 基于质量规则体系自动判断异常，输出含复现步骤的 Bug 报告 |
| 覆盖追踪 | 记录已测/未测功能，生成覆盖率报告 |
| 经验沉淀 | 跨会话积累 UI 模式、测试策略、已知缺陷，越用越智能 |
| 插件扩展 | Tool 插件本地加载，MCP Client 连接外部工具服务 |

### 1.3 目标用户

开发者/QA/产品经理，本机单用户使用，无需多租户。

---

## 2. 需求设计

### 2.1 用户工作流

```
用户执行 wta init 创建项目
       │
       ▼
用户配置 target.yaml（URL、账号密码、测试策略）
       │
       ▼
用户执行 wta run <target>
       │
       ▼
Agent 自主执行（后台运行，可 attach 查看）
  ├── Phase 1: 登录 + 会话建立
  ├── Phase 2: 广度探索 + UI 组件模型建模
  ├── Phase 3: 逐组件深度测试
  ├── Phase 4: n-wise 组合测试
  ├── Phase 5: 混沌/异常测试
  └── Phase 6: 报告生成
       │
       ▼
用户查看报告（CLI 或 GUI）
       │
       ▼
经验自动沉淀到 memory store
       │
       ▼
下次运行同一目标时继承记忆，跳过已测项，优先高风险区域
```

### 2.2 功能需求

#### FR-01 CLI

| 编号 | 命令 | 功能 |
|------|------|------|
| FR-01-01 | `wta init` | 初始化项目目录，生成默认配置 |
| FR-01-02 | `wta target add/list/remove` | 管理测试目标（URL、凭证、策略） |
| FR-01-03 | `wta run <target>` | 启动测试 Agent |
| FR-01-04 | `wta run <target> --phase <p>` | 指定执行阶段（explore/test/combo/chaos） |
| FR-01-05 | `wta run <target> --deep` | 深度测试模式（默认完整流程） |
| FR-01-06 | `wta run <target> --mode <m>` | 运行模式：continue/fresh/retest/expand/regression |
| FR-01-07 | `wta run <target> --resume` | 从上次中断点恢复（同一 session） |
| FR-01-08 | `wta run <target> --parallel <n>` | 并行浏览器数量 |
| FR-01-09 | `wta run <target> --headless/--headed` | 浏览器显示模式 |
| FR-01-10 | `wta attach [session]` | 连接到正在运行的 Agent，实时查看 |
| FR-01-11 | `wta status` | 显示当前运行中的 Agent 状态 |
| FR-01-12 | `wta stop [session]` | 停止 Agent |
| FR-01-13 | `wta install browsers/deps` | 安装浏览器二进制和系统依赖 |
| FR-01-14 | `wta doctor` | 环境诊断（浏览器、依赖、模型连通性） |
| FR-01-15 | `wta report list/show/export` | 查看和导出测试报告 |
| FR-01-16 | `wta memory show/export/clear/merge` | 管理记忆库 |
| FR-01-17 | `wta plugin list/install/create` | 管理插件 |
| FR-01-18 | `wta config get/set/list` | 管理配置（模型、策略、参数） |
| FR-01-19 | `wta model list/set/test` | 管理模型配置 |

#### FR-02 GUI

| 编号 | 页面 | 功能 |
|------|------|------|
| FR-02-01 | Dashboard | 总览：Agent 运行状态、最近测试结果、记忆统计 |
| FR-02-02 | Targets | 目标管理：添加/编辑测试目标，配置凭证和策略 |
| FR-02-03 | Monitor | 实时监控：当前页面截图、执行日志、进度条、已发现 Bug |
| FR-02-04 | Reports | 报告列表和详情：Bug 列表、覆盖矩阵、复现步骤 |
| FR-02-05 | Memory | 记忆浏览器：查看沉淀的经验、UI 模式、已学质量规则 |
| FR-02-06 | Settings | 设置：模型配置、插件管理、质量规则开关 |

GUI 技术形态：本地 Web 服务（`wta gui` 启动），浏览器打开 `http://localhost:7878`。不打包桌面应用，保持轻量。

#### FR-03 Agent 核心

| 编号 | 功能 | 描述 |
|------|------|------|
| FR-03-01 | 自主登录 | 根据登录页结构自动填入凭证，处理验证码失败重试 |
| FR-03-02 | 页面探索 | BFS 遍历全部可达页面，识别导航入口 |
| FR-03-03 | 组件识别 | 从 DOM/A11y 树识别：表单、手风琴、按钮、下拉、弹框、标签页、表格、通知 |
| FR-03-04 | 组件模型建模 | 构建页面→组件→控件→交互的结构化模型并持久化 |
| FR-03-05 | 质量规则校验 | 6 条通用质量规则 + 领域质量规则 + 实例推断质量规则的运行时检查 |
| FR-03-06 | 测试生成 | 基于组件类型自动生成测试用例（正常/边界/异常） |
| FR-03-07 | 组合测试 | 对关联功能执行 pairwise/t-wise 组合 |
| FR-03-08 | 缺陷判定 | 质量规则违反、视觉异常、网络错误、状态不一致 |
| FR-03-09 | 截图/录屏 | 每次关键操作截图，可开启全流程录屏 |
| FR-03-10 | 断点恢复 | Agent 中断后可从最近的检查点恢复 |
| FR-03-11 | 点击可能性检测 | 多信号加权评分（语义标签/ARIA role/cursor:pointer/onclick/tabindex） |
| FR-03-12 | Agent 级自愈 | 错误分级处理、循环检测、浏览器重启恢复、健康监控降级 |

#### FR-04 记忆系统

| 编号 | 功能 | 描述 |
|------|------|------|
| FR-04-01 | 应用记忆 | 同一目标的 组件模型、已测项、历史 Bug、推断的模式 |
| FR-04-02 | 跨应用记忆 | 通用 UI 模式经验（如"管理后台通常有侧边导航"） |
| FR-04-03 | 策略记忆 | 哪些测试策略发现了最多 Bug，优先级自动调整 |
| FR-04-04 | 会话压缩 | 完成后用 LLM 压缩情节记忆为结构化摘要 |
| FR-04-05 | 记忆继承 | 新会话自动加载相关记忆，跳过已测、优先高风险 |
| FR-04-06 | 记忆导出/导入 | JSON 格式，可跨机器迁移 |
| FR-04-07 | 记忆合并 | 多次测试的记忆自动合并去重 |

#### FR-05 插件系统

| 编号 | 功能 | 描述 |
|------|------|------|
| FR-05-01 | Tool 插件 | 本地 plugins/ 目录自动加载，提供新工具能力 |
| FR-05-02 | MCP Client | Agent 连接外部 MCP Server，将其工具纳入工具集 |

### 2.3 非功能需求

| 编号 | 需求 | 标准 |
|------|------|------|
| NFR-01 | 稳定性 | Agent 连续运行 24h 不崩溃，异常自动恢复 |
| NFR-02 | 可观测性 | 全链路日志、每步操作可回溯 |
| NFR-03 | 可扩展性 | 新增一种组件识别无需改核心代码 |
| NFR-04 | 数据安全 | 凭证仅本地存储，报告不泄露敏感信息 |
| NFR-05 | 断点恢复 | 任意阶段中断，恢复后不重测已完成项 |
| NFR-06 | 报告质量 | Bug 报告含：复现步骤、预期/实际、截图、严重级别 |
| NFR-07 | 测试覆盖 | 所有功能必须有对应测试用例，代码覆盖率目标 100%，CI 中统计并展示 |
| NFR-08 | 中文输出 | 所有报告、注释、日志、错误信息均使用中文 |
| NFR-09 | 完整交付 | 设计文档中的所有功能都必须实现，不允许标记"not implemented"或"TODO" |
| NFR-10 | 日志模块 | 每一步操作记录详细日志：触发来源（脚本/模型）、触发方式、执行参数、执行结果、耗时；模型触发记录发送内容和响应内容；GUI 按时间线展示，默认简单显示可展开详情 |

---

## 3. 架构设计

### 3.1 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        用户层                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────────┐   │
│  │   CLI     │  │   GUI    │  │  wta attach (终端)       │   │
│  │ commander │  │ Web UI   │  │  实时交互                │   │
│  └─────┬────┘  └────┬─────┘  └───────────┬──────────────┘   │
│        │             │                     │                  │
├────────┼─────────────┼─────────────────────┼──────────────────┤
│        ▼             ▼                     ▼                  │
│  ┌─────────────────────────────────────────────────────┐     │
│  │              Agent Daemon (常驻服务)                  │     │
│  │  ┌─────────────────────────────────────────────┐    │     │
│  │  │           Orchestrator (调度器)               │    │     │
│  │  │  任务队列 │ 状态机 │ 资源管理 │ 断点/恢复      │    │     │
│  │  └─────────────────────────────────────────────┘    │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐     │     │
│  │  │ Explorer  │ │ Tester   │ │ Reporter          │     │     │
│  │  │ 探索引擎   │ │ 测试引擎  │ │ 报告引擎          │     │     │
│  │  └──────────┘ └──────────┘ └──────────────────┘     │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐     │     │
│  │  │ Perception│ │ Cognition│ │ Detection         │     │     │
│  │  │ 感知路由  │ │ 组件模型+质量规则 │ │ 缺陷检测           │     │     │
│  │  └──────────┘ └──────────┘ └──────────────────┘     │     │
│  │  ┌─────────────────────────────────────────────┐    │     │
│  │  │           Memory Store (记忆系统)             │    │     │
│  │  │  应用记忆 │ 跨应用记忆 │ 策略记忆 │ 压缩归档   │    │     │
│  │  └─────────────────────────────────────────────┘    │     │
│  │  ┌─────────────────────────────────────────────┐    │     │
│  │  │           Plugin Registry (插件系统)          │    │     │
│  │  │  Tools │ Axioms │ Perceivers │ MCP Client    │    │     │
│  │  └─────────────────────────────────────────────┘    │     │
│  │  ┌─────────────────────────────────────────────┐    │     │
│  │  │           LLM Router (模型路由)               │    │     │
│  │  │  按任务类型路由到不同模型                       │    │     │
│  │  └─────────────────────────────────────────────┘    │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                        基础设施层                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐   │
│  │Playwright │ │ SQLite   │ │ Logger    │ │ Process Manager│   │
│  │ Browser  │ │ Database  │ │ (pino)   │ │ (child_process)│   │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| Agent 框架 | 自定义循环 + 直调 LLM API | 精确控制 token、上下文、错误处理；不用 LangChain |
| 语言 | TypeScript (Node.js ≥ 20) | Playwright Node API 最完整且性能最好；推理由 LLM 远程完成，本地语言只需调度，Python 的 AI 生态无优势；CLI/GUI/Core 统一一种语言，避免跨语言调用 |

补充说明：不用 Python 是因为 Playwright 的 Node API 是第一优先维护目标（Python 是 wrapper），且 GUI 前端必然是 JS，用 TS 可以全栈统一。AI 推理依赖的是外部 LLM API（OpenAI/Anthropic），不依赖本地 ML 库，所以 Python 在这方面没有额外收益。
| CLI 框架 | Commander.js | 成熟、子命令、类型支持好 |
| GUI 后端 | Fastify + WebSocket | 轻量、WS 推送实时状态 |
| GUI 前端 | React 18 + Vite | 组件化、实时更新 |
| 浏览器控制 | Playwright | DOM/A11y/截图/网络拦截/多浏览器 |
| 持久化 | better-sqlite3 | 零配置、单文件、事务安全 |
| Schema 验证 | Zod | LLM 输出结构化验证 |
| 日志 | pino | JSON 日志、高性能 |
| 进程管理 | 自研 daemon + IPC | Agent 后台运行、CLI attach |
| 包管理 | pnpm monorepo | CLI/GUI/core 分包 |

### 3.2.1 日志模块（Log Module）

每一步操作都有结构化文字日志，记录触发来源、参数、结果和耗时。

#### 日志数据结构

```typescript
interface AgentLog {
  id: string;                      // 唯一 ID
  sessionId: string;               // 所属会话
  timestamp: number;               // 时间戳（毫秒）
  sequence: number;                 // 序号（会话内递增）

  // 触发来源
  source: 'script' | 'model' | 'system' | 'user';
  // script: 确定性脚本触发（规则匹配、导航、截图等）
  // model:  LLM 推理触发（组件识别、质量判断、策略决策等）
  // system: 系统事件（浏览器启动、数据库操作、错误恢复）
  // user:   用户操作（CLI 命令、GUI 点击）

  trigger: {
    description: string;           // 触发描述（中文）
    module: string;                // 触发模块名
    method: string;                // 触发方法名
  };

  // 执行内容
  action: {
    type: string;                  // 操作类型 (navigate/click/fill/identify/check...)
    target?: string;               // 操作目标（selector 或 URL）
    params?: Record<string, any>;  // 参数
  };

  // 模型触发专用字段
  model?: {
    provider: string;              // openai / anthropic / ollama
    model: string;                 // 模型名
    taskType: string;              // 任务类型
    inputTokens: number;           // 输入 token 数
    outputTokens: number;          // 输出 token 数
    request: {
      messages: Array<{ role: string; content: string }>;
    };
    response: {
      content: string;             // LLM 响应文本
      parsed?: any;                // 解析后的结构化结果
    };
  };

  // 结果
  result: {
    status: 'success' | 'failed' | 'skipped' | 'warning';
    duration: number;              // 耗时（毫秒）
    output?: any;                  // 执行输出
    error?: string;               // 错误信息（中文）
    screenshotId?: string;         // 关联截图 ID
  };

  // 上下文
  context: {
    pageUrl?: string;              // 当前页面 URL
    phase: string;                 // 当前阶段
    componentId?: string;           // 相关组件 ID
  };
}
```

#### 日志记录器实现

```typescript
class AgentLogger {
  private logs: AgentLog[] = [];
  private sequence = 0;
  private db: DatabaseManager;
  private sessionId: string;

  /**
   * 记录脚本触发的操作
   */
  logScript(
    trigger: { description: string; module: string; method: string },
    action: { type: string; target?: string; params?: any },
    context: { pageUrl?: string; phase: string; componentId?: string },
  ): void {
    this.write({
      source: 'script',
      trigger,
      action,
      context,
      result: { status: 'success', duration: 0 },
    });
  }

  /**
   * 记录脚本触发的操作（含结果）
   */
  async logScriptResult(
    trigger: { description: string; module: string; method: string },
    action: { type: string; target?: string; params?: any },
    execution: () => Promise<any>,
    context: { pageUrl?: string; phase: string; componentId?: string },
  ): Promise<any> {
    const start = Date.now();
    let output: any;
    let status: string = 'success';
    let error: string | undefined;

    try {
      output = await execution();
    } catch (e) {
      status = 'failed';
      error = e instanceof Error ? e.message : String(e);
    }

    const duration = Date.now() - start;

    this.write({
      source: 'script',
      trigger,
      action,
      context,
      result: { status, duration, output, error },
    });

    if (error) throw new Error(error);
    return output;
  }

  /**
   * 记录模型触发的操作（含 LLM 请求和响应）
   */
  async logModel(
    trigger: { description: string; module: string; method: string },
    modelCall: () => Promise<{ content: string; parsed?: any }>,
    action: { type: string; target?: string; params?: any },
    modelConfig: { provider: string; model: string; taskType: string },
    context: { pageUrl?: string; phase: string; componentId?: string },
  ): Promise<any> {
    const start = Date.now();
    let response: any;
    let status: string = 'success';
    let error: string | undefined;

    try {
      response = await modelCall();
    } catch (e) {
      status = 'failed';
      error = e instanceof Error ? e.message : String(e);
    }

    const duration = Date.now() - start;

    this.write({
      source: 'model',
      trigger,
      action,
      model: {
        ...modelConfig,
        inputTokens: estimateTokens(modelCall.toString()),
        outputTokens: estimateTokens(response?.content ?? ''),
        request: { messages: [] }, // 从 LLMRouter 获取
        response: response,
      },
      context,
      result: { status, duration, output: response?.parsed, error },
    });

    if (error) throw new Error(error);
    return response;
  }

  /**
   * 持久化到数据库
   */
  private write(log: Omit<AgentLog, 'id' | 'sessionId' | 'timestamp' | 'sequence'>): void {
    const entry: AgentLog = {
      id: randomUUID(),
      sessionId: this.sessionId,
      timestamp: Date.now(),
      sequence: ++this.sequence,
      ...log,
    } as AgentLog;

    this.logs.push(entry);

    // 写入数据库
    this.db.prepare(`
      INSERT INTO agent_logs (id, session_id, timestamp, sequence, source, log_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entry.id, entry.sessionId, entry.timestamp, entry.sequence, entry.source, JSON.stringify(entry));

    // 控制台输出（简单格式）
    const icon = entry.source === 'model' ? '🤖' : entry.source === 'script' ? '⚙️' : '📋';
    const statusIcon = entry.result.status === 'success' ? '✓' : entry.result.status === 'failed' ? '✗' : '⏭';
    console.log(
      `  ${icon} [${entry.sequence}] ${statusIcon} ${entry.trigger.description} (${entry.result.duration}ms)`
    );
  }

  /**
   * 获取会话的完整时间线
   */
  getTimeline(): AgentLog[] {
    return this.logs;
  }

  /**
   * 获取模型的调用日志
   */
  getModelCalls(): AgentLog[] {
    return this.logs.filter(l => l.source === 'model');
  }
}
```

#### GUI 时间线展示

```
┌─────────────────────────────────────────────────────────┐
│  执行时间线                                    [简单|详细] │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ▶ 00:00:01  ⚙️ 启动浏览器                               │
│    Chromium 无头模式启动成功 (234ms)                      │
│                                                          │
│  ▶ 00:00:02  ⚙️ 导航到目标页面                            │
│    https://demoqa.com/text-box 加载完成 (1567ms)          │
│                                                          │
│  ▼ 00:00:04  🤖 识别页面组件                              │
│    │ 模型: claude-sonnet-4                               │
│    │ 输入: 47 个交互元素的结构化数据                       │
│    │ 输出: 4 个 input, 2 个 textarea, 1 个 button       │
│    │ 耗时: 892ms                                         │
│    │ [展开请求详情] [展开响应详情]                          │
│                                                          │
│  ▶ 00:00:05  ⚙️ 截图: 初始页面                            │
│    screenshot-001.png 保存成功 (45ms)                    │
│                                                          │
│  ▼ 00:00:06  ⚙️ 填充表单字段                              │
│    │ 字段: Full Name → "测试用户"                         │
│    │ 字段: Email → "test@example.com"                    │
│    │ 耗时: 234ms                                         │
│                                                          │
│  ▶ 00:00:07  ⚙️ 提交表单                                  │
│    点击提交按钮，等待响应 (1234ms)                         │
│                                                          │
│  ▼ 00:00:09  🤖 检查表单验证规则                          │
│    │ 模型: o1                                           │
│    │ 规则: QR002 (表单验证)                               │
│    │ 判定: 通过 (置信度 0.95)                             │
│    │ 耗时: 456ms                                         │
│    │ [展开推理过程]                                       │
│                                                          │
└─────────────────────────────────────────────────────────┘

简单模式: 只显示 ▶ 行（操作描述 + 耗时）
详细模式: 展开 ▼ 行的完整参数、模型请求/响应、执行结果
```

#### 数据库表

```sql
CREATE TABLE IF NOT EXISTS agent_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  timestamp INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  source TEXT NOT NULL,           -- script | model | system | user
  log_json TEXT NOT NULL,         -- 完整日志 JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_session ON agent_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_source ON agent_logs(session_id, source);
```
### 3.3 进程模型

```
用户终端                          Agent Daemon                    Browser Worker
────────                          ─────────────                    ──────────────
  │                                  │                               │
  │ wta run target                   │                               │
  │──────────────────────────────────>│                               │
  │                                  │ 启动 Playwright Worker         │
  │ 返回 session-id                  │──────────────────────────────>│
  │<─────────────────────────────────│                               │
  │                                  │<───── 状态/事件 ──────────────│
  │ (后台运行)                        │                               │
  │                                  │                               │
  │ wta attach <session>             │                               │
  │──────────────────────────────────>│                               │
  │<───── WebSocket 流 ──────────────│<───── WebSocket 流 ──────────│
  │  (实时日志/截图/进度)             │                               │
  │                                  │                               │
```

Agent Daemon 是常驻 Node.js 进程，管理一个或多个测试 Session。每个 Session 对应一个 Playwright Browser Context。

#### Daemon 生命周期

```
启动:
  wta run <target>     → 检测 Daemon 是否存活
  wta daemon start     → 显式启动
  wta gui              → 启动 Daemon + GUI

  Daemon 未运行 → 自动启动 → 注册 PID → 写入 .wta/daemon.pid
  Daemon 已运行 → 直接复用

运行中:
  - 监听 IPC (Unix Socket / Named Pipe): \\.\pipe\wta-daemon 或 /tmp/wta-daemon.sock
  - 管理多个 Session 的生命周期
  - Session 崩溃 → Daemon 自动重启该 Session（从 checkpoint 恢复）
  - Daemon 自身异常退出 → watchdog 进程自动拉起（最多 5 次/小时）
  - 定期持久化状态（每 30 秒 checkpoint）

停止:
  wta stop <session>   → 停止单个 Session
  wta stop --all       → 停止所有 Session（Daemon 存活）
  wta daemon stop      → 优雅停止 Daemon（等待所有 Session 保存 checkpoint）
  wta daemon kill      → 强制停止
  Ctrl+C (前台模式)    → 优雅停止
```

```typescript
class DaemonManager {
  private watchdog: Watchdog;

  // 检测 Daemon 是否存活
  async isAlive(): Promise<boolean> {
    const pid = await this.readPidFile();
    if (!pid) return false;
    return process.kill(pid, 0); // signal 0 = 检测进程是否存在
  }

  // 确保运行（不存在则启动）
  async ensureRunning(): Promise<DaemonConnection> {
    if (await this.isAlive()) {
      return this.connect();
    }
    await this.start();
    await this.waitForReady(5000);
    return this.connect();
  }

  // Watchdog: Daemon 崩溃自动拉起
  startWatchdog(): void {
    const WATCH_INTERVAL = 5000;
    const MAX_RESTART_PER_HOUR = 5;

    setInterval(async () => {
      if (!(await this.isAlive())) {
        const recentRestarts = this.getRecentRestarts();

        if (recentRestarts.length >= MAX_RESTART_PER_HOUR) {
          this.logger.error('Daemon crashed too many times, giving up');
          return; // 不再拉起，等待人工介入
        }

        this.logger.warn('Daemon died, restarting...');
        await this.start();
        this.recordRestart();
      }
    }, WATCH_INTERVAL);
  }

  // Session 崩溃时自动恢复
  async onSessionCrash(sessionId: string): Promise<void> {
    const session = await this.sessionStore.get(sessionId);
    const restartCount = session.restartCount + 1;

    if (restartCount > 3) {
      // 同一 Session 重启超过 3 次 → 标记为需要人工介入
      session.status = 'failed';
      session.failureReason = 'exceeded max restarts';
      return;
    }

    // 从最近 checkpoint 恢复
    await this.restoreFromCheckpoint(session);
    session.restartCount = restartCount;
    this.logger.warn(`Session ${sessionId} restarted (attempt ${restartCount})`);
  }
}
```

#### 开发与发布流程

开发过程中边开发边 git 管理：

```
每个功能模块完成后:
  git add <files>
  git commit -m "feat(core): add structured perceiver with cursor:pointer scoring"

开发完成后:
  全量测试 → 修复 → 再测试
  git tag v0.1.0
  git push origin main
```

### 3.4 浏览器管理

浏览器二进制在项目构建时已打包到 `vendor/browsers/`，用户无需下载：

```
webtest-agent/
├── vendor/
│   └── browsers/                 # 随项目分发的浏览器
│       ├── chromium/             # Chromium (固定版本)
│       ├── firefox/              # Firefox (可选)
│       └── webkit/               # WebKit (可选)
├── .wta/
│   ├── browser-profiles/         # 运行时 profile（临时）
│   └── ...
└── packages/
    └── core/
        └── browser/
            └── BrowserManager.ts # 自动使用 vendor 路径
```

BrowserManager 启动时自动指向 `vendor/browsers/<browser>/`，不调用 Playwright 的默认下载逻辑。用户克隆项目即可运行，零额外步骤。

#### 浏览器更新（可选）

```bash
# 更新 vendor 中的浏览器版本（构建/升级时用）
wta install browsers              # 更新 Chromium
wta install browsers --all        # 更新全部
wta install browsers --browser firefox

# 安装 Linux 系统依赖（headless 模式所需）
wta install deps

# 环境诊断
wta doctor
wta doctor --verbose
```

#### 浏览器配置

```yaml
# config.yaml
browser:
  # 浏览器二进制存放路径（默认 .wta/browsers）
  executableDir: .wta/browsers

  # 默认浏览器
  default: chromium

  # 下载镜像（国内加速）
  downloadHost: https://npmmirror.com/mirrors/playwright

  # 并行浏览器数量
  parallel: 1

  # 无头模式（Linux 默认 true，Windows/macOS 默认 false）
  headless: auto                  # auto | true | false

  # 视口
  viewport:
    width: 1920
    height: 1080

  # 超时
  timeout:
    navigation: 30000             # 页面加载
    action: 10000                 # 单个操作
    screenshot: 5000              # 截图

  # 录制
  recordVideo: true               # 全程录屏
  videoDir: .wta/videos
```

#### 并行浏览器架构

```
Agent Daemon
  │
  ├── Session 1 (Worker A)
  │     └── Browser Context 1 ──> 测试区域: 用户管理
  │
  ├── Session 2 (Worker B)
  │     └── Browser Context 2 ──> 测试区域: 订单管理
  │
  └── Session 3 (Worker C)
        └── Browser Context 3 ──> 测试区域: 系统设置
```

并行策略：按页面/功能区域划分测试范围，每个 Worker 负责一组页面。共享同一个 AppMemory（读写锁保护），每个 Worker 有独立的 Browser Context（隔离 cookie 和会话状态）。

```typescript
class ParallelOrchestrator {
  async runParallel(target: Target, workers: number): Promise<void> {
    const regions = await this.partitionByRegion(target);
    const pool = new WorkerPool(workers);

    for (const region of regions) {
      await pool.submit(async (browserContext) => {
        const session = new Session(browserContext, region);
        await this.agentLoop(session);
      });
    }

    await pool.drain();
  }

  // 按导航图分区，确保并行不冲突
  private async partitionByRegion(target: Target): Promise<Region[]> {
    // 将导航图按一级路由分组
    // /users/* → Region A
    // /orders/* → Region B
    // /settings/* → Region C
  }
}
```

### 3.5 部署模式

#### 本地运行（Windows/macOS/Linux）

```bash
# 克隆项目后，浏览器已包含在 vendor/browsers/ 中
wta init

# 直接运行（无需额外安装浏览器）
wta run myapp --headed

# 无头模式
wta run myapp --headless
```

#### Linux 服务器（无头模式）

```bash
# 只需安装系统依赖（字体、库等）
wta install deps

# 无头模式运行（Linux 默认无头）
wta run myapp

# 指定 Display（如果有 Xvfb）
DISPLAY=:99 wta run myapp
```

#### CI/CD 集成

```bash
# GitHub Actions
- name: Run Web Test
  run: |
    wta run myapp --headless --mode regression
    wta report export latest --format json -o report.json

# 退出码: 0=全部通过, 1=有 Bug, 2=执行错误
```

---
## 4. CLI 设计

### 4.1 命令结构

```
wta <command> [subcommand] [options]

Commands:
  init              初始化项目
  target            管理测试目标
  run               启动测试
  install           安装浏览器 / 系统依赖
  doctor            环境诊断（浏览器、依赖、模型连通性）
  attach            连接到运行中的 Agent
  status            查看 Agent 状态
  stop              停止 Agent
  report            管理测试报告
  memory            管理记忆库
  plugin            管理插件
  config            管理配置
  model             管理模型配置
  gui               启动 GUI 服务
```

### 4.2 核心命令详细设计

#### `wta init`

```bash
wta init [path]

# 效果
# 创建 .wta/ 目录
#   ├── config.yaml          # 全局配置
#   ├── targets/             # 测试目标配置
#   ├── memory/              # 记忆库
#   ├── plugins/             # 插件
#   ├── sessions/            # 会话数据
#   └── reports/             # 报告输出
#   └── wta.db               # SQLite 数据库
```

#### `wta target`

```bash
# 添加目标（交互式）
wta target add

# 添加目标（命令行）
wta target add \
  --name myapp \
  --url https://app.example.com \
  --username admin \
  --password 'xxx' \
  --strategy deep

# 列出所有目标
wta target list

# 查看目标详情（含 组件模型摘要）
wta target show myapp

# 移除目标
wta target remove myapp
```

**Target 配置文件格式** (`targets/myapp.yaml`):

```yaml
name: myapp
url: https://app.example.com
credentials:
  username: admin
  password: 'xxx'
  loginHint: '用户名输入框'   # 可选，帮助 Agent 定位
  passwordHint: '密码输入框'

strategy:
  runMode: continue            # continue | fresh | retest | expand | regression
  depth: deep                  # quick | standard | deep
  maxDuration: 24h             # 最长运行时间
  maxPages: 200                # 最大探索页面数
  parallel: 1                  # 并行浏览器数
  screenshot: always           # always | on-error | never
  video: true                  # 全程录屏
  headless: auto               # auto | true | false（Linux 默认 true）

scope:
  includePaths: []            # 空则全站
  excludePaths:
    - /logout
    - /admin/settings/billing  # 跳过付费页面

axioms:
  enabled: [QR001, QR002, QR003, QR004, QR005, QR006]
  custom: []                  # 自定义质量规则 ID

models:
  exploration: claude-sonnet-4    # 探索/组件识别
  reasoning: o1                   # 质量规则推理/缺陷判定
  summarization: haiku           # 记忆压缩
```

#### `wta run`

Agent 运行模式决定如何使用已有记忆：

```bash
# ═══ 运行模式 ═══

# continue（默认）: 继承记忆，跳过已通过项，补测未测项
wta run myapp
wta run myapp --mode continue

# fresh: 忽略全部记忆，从头完整测试
wta run myapp --mode fresh

# retest: 重新测试所有项（包括已通过的），用于版本升级后的全量回归
wta run myapp --mode retest

# expand: 在现有基础上发散测试，探索更深组合、新路径、未尝试的交互序列
wta run myapp --mode expand

# regression: 只回归历史 Bug 和之前失败的项
wta run myapp --mode regression

# ═══ 范围控制 ═══

# 只重测特定页面
wta run myapp --mode retest --page "用户管理"

# 只重测特定组件
wta run myapp --mode retest --component form-123

# 只重测之前失败的项
wta run myapp --mode regression --failed

# 只重测特定质量规则的违反项
wta run myapp --mode regression --bug QR002

# ═══ 浏览器与并行 ═══

# 并行浏览器数量（多 Session 同时测试不同区域）
wta run myapp --parallel 3

# 指定浏览器和视口
wta run myapp --browser chromium --viewport 1920x1080

# 有头模式（调试时用）
wta run myapp --headed

# 无头模式（Linux 服务器 / CI 默认）
wta run myapp --headless

# ═══ 会话恢复 ═══

# 从上次断点恢复（同一 session 继续）
wta run myapp --resume

# 后台运行（默认）
wta run myapp

# 前台运行（输出直接打印）
wta run myapp --foreground

# 限制时长
wta run myapp --max-time 4h

# 指定阶段
wta run myapp --phase explore     # 只探索
wta run myapp --phase test        # 只测试
wta run myapp --phase combo       # 只组合测试
```

#### 运行模式对照表

| 模式 | 记忆使用 | 已通过项 | 未测项 | 历史 Bug | 行为 |
|------|---------|----------|--------|----------|------|
| `continue` | 全部加载 | 跳过 | 优先测试 | 回归验证 | 默认增量测试 |
| `fresh` | 不加载 | 重新测试 | 测试 | 不参考 | 完整重新开始 |
| `retest` | 加载 UI Model | 重新测试 | 测试 | 回归验证 | 全量回归 |
| `expand` | 全部加载 | 不重测 | 优先测试 | 回归验证 | 发散新路径 |
| `regression` | 全部加载 | 不重测 | 不测试 | 只测 Bug | 只验历史缺陷 |

#### `expand` 发散测试策略

expand 模式在现有 UI Model 和测试历史基础上，向五个方向发散：

1. **组合加深**: 上次 pairwise → 这次 3-wise / 4-wise
   对发现过 Bug 的组合区域，提高组合深度

2. **序列探索**: 尝试未执行过的操作序列
   例如: A→B→C 未测过，尝试 A→C→B、B→A→C
   从 NavigationGraph 中寻找未走通的路径

3. **状态扩散**: 在同一页面制造不同前置状态后测试
   例如: 先筛选再排序再编辑 vs 直接编辑
   先打开弹框A再触发弹框B

4. **边界推进**: 对已测字段使用更极端的输入
   上次 1000 字符 → 这次 10000 字符、二进制数据、超长 Unicode

5. **交互异常**: 模拟真实用户的不规则操作
   操作中途返回、刷新、开新标签、前进后退、快速重复点击

#### `wta attach`

```bash
# 附加到最近的 session
wta attach

# 附加到指定 session
wta attach abc123

# 效果: 进入实时终端界面
# ┌─────────────────────────────────────────┐
# │ Session: abc123                         │
# │ Target: myapp                           │
# │ Phase: testing                          │
# │ Progress: 47/120 components             │
# │ ┌─────────────────────────────────────┐ │
# │ │ [截图] 当前页面                       │ │
# │ └─────────────────────────────────────┘ │
# │ > 点击了"提交"按钮                       │
# │ > 检查 QR002 (表单验证)... PASS          │
# │ > 输入超长文本到"备注"字段                │
# │ > 检查 QR006 (无崩溃)... FAIL           │
# │   ⚠ Bug #3: 页面白屏                    │
# │ [q] 退出  [s] 截图  [p] 暂停             │
# └─────────────────────────────────────────┘
```

#### `wta report`

```bash
# 列出所有报告
wta report list

# 查看报告摘要
wta report show <report-id>

# 导出为 Markdown
wta report export <report-id> --format md -o report.md

# 导出为 JSON（机器可读）
wta report export <report-id> --format json -o report.json

# 只看 Bug 列表
wta report bugs <report-id>
```

#### `wta memory`

```bash
# 查看记忆概览
wta memory show

# 查看某个应用的记忆
wta memory show --app myapp

# 导出记忆
wta memory export -o backup.json

# 导入记忆
wta memory import backup.json

# 合并记忆文件
wta memory merge a.json b.json -o merged.json

# 清除特定应用记忆
wta memory clear --app myapp

# 清除全部
wta memory clear --all
```

#### `wta config`

```bash
# 查看全部配置
wta config list

# 设置模型
wta config set models.exploration claude-sonnet-4
wta config set models.reasoning o1
wta config set models.vision gpt-4o

# 设置默认策略
wta config set defaults.strategy deep

# 查看某项
wta config get models.reasoning
```

#### `wta model`

```bash
# 列出已配置的模型
wta model list

# 设置 API 密钥
wta model set openai --api-key sk-xxx
wta model set anthropic --api-key sk-xxx
wta model set ollama --url http://localhost:11434

# 测试模型连通性
wta model test claude-sonnet-4

# 查看模型使用统计
wta model usage
```

#### `wta plugin`

```bash
# 列出已安装插件
wta plugin list

# 从本地安装
wta plugin install ./my-plugin

# 从 Git 安装
wta plugin install https://github.com/user/wta-plugin-ecommerce

# 创建插件脚手架
wta plugin create my-plugin --type domain

# 启用/禁用
wta plugin enable ecommerce
wta plugin disable ecommerce
```

#### `wta install`

浏览器已包含在项目 `vendor/browsers/` 中，正常使用无需执行 install。此命令用于更新浏览器版本或安装系统依赖：

```bash
# 更新浏览器版本（默认 Chromium）
wta install browsers

# 更新所有浏览器
wta install browsers --all

# 安装指定浏览器
wta install browsers --browser firefox

# 安装 Linux 系统依赖（headless 模式所需）
wta install deps

# 查看安装状态
wta install status
```

#### `wta doctor`

```bash
# 环境诊断
wta doctor

# 输出示例:
# [✓] Node.js v20.11.0
# [✓] Playwright browsers installed (chromium)
# [✓] SQLite database accessible
# [✓] OpenAI API connected (gpt-4o)
# [✓] Anthropic API connected (claude-sonnet-4)
# [✓] Display: headless available
# [✗] Firefox not installed (optional)
#
# Run 'wta install browsers --all' to install

# 详细模式
wta doctor --verbose
```

#### `wta gui`

```bash
# 启动 GUI（默认 7878 端口）
wta gui

# 指定端口
wta gui --port 3000

# 不自动打开浏览器
wta gui --no-open
```

### 4.3 CLI 全局选项

```bash
--config <path>     # 指定配置文件目录
--verbose           # 详细日志
--quiet             # 静默模式
--no-color          # 禁用颜色
--json              # 输出 JSON 格式（脚本友好）
```

---

## 5. GUI 设计

### 5.1 技术方案

GUI 是一个本地 Web 服务，由 `wta gui` 启动。前端 React SPA，后端 Fastify，WebSocket 实时推送。

```
浏览器 (http://localhost:7878)
  │
  ├── HTTP API (REST)       → 目标管理、报告查询、配置
  └── WebSocket             → Agent 实时状态、日志流、截图流
        │
        ▼
  GUI Server (Fastify)
        │
        ├── 调用 Core Agent API（同 CLI 调用的接口）
        └── 转发 Agent 事件给前端
```

### 5.2 页面设计

#### Dashboard (`/`)

```
┌─────────────────────────────────────────────────────────┐
│  WebTestAgent                    [Targets] [Settings]    │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─ 运行状态 ─────────────────────────────────────────┐  │
│  │  ● Session abc123 running                          │  │
│  │  Target: myapp | Phase: testing | 47/120            │  │
│  │  [████████░░░░░░░░░░░░░░] 39%                      │  │
│  │  Bugs found: 3 | Elapsed: 2h 15m                    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─ 最近测试 ────────┐  ┌─ 记忆统计 ─────────────────┐   │
│  │ myapp  2h ago    │  │ Applications: 3              │   │
│  │   3 bugs, 87%    │  │ UI Patterns: 45              │   │
│  │ admin   yesterday │  │ Learned Axioms: 12          │   │
│  │   7 bugs, 92%    │  │ Test History: 28 sessions    │   │
│  │ ...              │  └─────────────────────────────┘   │
│  └──────────────────┘                                    │
│                                                          │
│  [▶ New Test Run]  [📁 Import Memory]                    │
└─────────────────────────────────────────────────────────┘
```

#### Monitor (`/monitor/:sessionId`)

```
┌─────────────────────────────────────────────────────────┐
│  Monitoring: myapp (abc123)          [⏸ Pause] [⏹ Stop] │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐  ┌─ Test Progress ───────────┐ │
│  │                     │  │  Phase: Component Testing  │ │
│  │   [实时截图]         │  │  Current: 用户管理 → 编辑表单│ │
│  │   (WebSocket 推送)   │  │  Components: 47/120       │ │
│  │                     │  │  Axioms checked: 234      │ │
│  │                     │  │  Bugs: 3                   │ │
│  └─────────────────────┘  └───────────────────────────┘ │
│                                                          │
│  ┌─ 发现的 Bug ──────────────────────────────────────┐   │
│  │ 🔴 #1 编辑用户时备注字段输入超长文本导致页面崩溃   │   │
│  │ 🟡 #2 下拉菜单选择后未更新联动字段                  │   │
│  │ 🟡 #3 弹框关闭后背景滚动未恢复                      │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  ┌─ 执行日志 ────────────────────────────────────────┐  │
│  │ 14:32:01 点击"编辑"按钮                              │  │
│  │ 14:32:02 等待弹框出现... OK                         │  │
│  │ 14:32:03 在"备注"输入 5000 字符                      │  │
│  │ 14:32:05 检查 QR006 (无崩溃)... FAIL                │  │
│  │ 14:32:05 ⚠ Bug #1: 页面白屏                        │  │
│  │ ...                                                │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

#### Reports (`/reports`)

报告列表 → 点击进入详情：
- Bug 列表（含复现步骤、截图、严重级别）
- 覆盖矩阵（页面 × 组件 × 测试类型）
- 测试摘要（耗时、通过/失败/跳过）
- 导出按钮（Markdown / JSON）

#### Memory (`/memory`)

- 应用记忆列表
- 每个应用的：组件模型图、已学模式、推断质量规则
- 跨应用通用经验
- 导出/导入按钮

#### Settings (`/settings`)

- 模型配置（各阶段的模型选择）
- 质量规则管理（启用/禁用/自定义）
- 插件管理（安装/启用/配置）
- 通用参数（超时、重试、截图策略）

### 5.3 GUI 与 CLI 关系

GUI 不直接操作 Playwright 或 Agent 核心。GUI 调用的每个 API 就是 CLI 使用的同一个 Core API。这确保：

1. CLI 和 GUI 功能完全一致
2. GUI 的每个操作都可以用 CLI 复现
3. 不会有 GUI 特有的 bug 路径

```
CLI 命令 ──────┐
              ├──> Core API (Agent Orchestrator) ──> Playwright
GUI API ──────┘
```

---

## 6. Agent 核心设计

### 6.1 Agent Loop

Agent 采用 **计划-执行-观察-反思** 循环：

```typescript
async function agentLoop(session: Session): Promise<TestResult> {
  const plan = await createPlan(session);

  while (!plan.isComplete && !session.isStopped) {
    // 1. 感知：获取当前页面状态
    const observation = await perceive(session);

    // 2. 认知：更新 组件模型，匹配组件模型
    const componentModel = await reason(observation, session.memory);

    // 3. 决策：选择下一步操作
    const action = await decide(componentModel, plan, session.memory);

    // 4. 执行：Playwright 操作
    const result = await execute(action, session);

    // 5. 检测：校验质量规则
    const violations = await detect(result, session.axioms);

    // 6. 记录：更新记忆和进度
    await record(session, { observation, action, result, violations });

    // 7. 反思：定期评估策略效果
    if (shouldReflect(session)) {
      await reflect(session);
    }

    // 8. 检查点
    await checkpoint(session);
  }

  return generateReport(session);
}
```

### 6.2 感知层

#### 感知路由

```typescript
type PerceptionMode = 'dom' | 'visual' | 'fused';

class PerceptionRouter {
  async perceive(page: Page, task: TaskContext): Promise<Observation> {
    const mode = this.route(task);

    switch (mode) {
      case 'dom':
        return this.domPerceiver.capture(page);
      case 'visual':
        return this.visualPerceiver.capture(page);
      case 'fused':
        return this.fusedPerceiver.capture(page);
    }
  }

  private route(task: TaskContext): PerceptionMode {
    // 默认 DOM（80% 场景）
    if (task.type === 'layout-check' || task.type === 'visual-verify') {
      return 'visual';
    }
    if (task.type === 'component-identify' && task.confidence < 0.7) {
      return 'fused'; // DOM 不确定时加截图
    }
    if (task.needsCrossVerify) return 'fused';
    return 'dom';
  }
}
```

#### 结构化感知器（自定义提取脚本）

不用原始 DOM，也不用纯 a11y snapshot。在浏览器上下文中执行自定义提取脚本，一次性获取所有测试相关的结构化信息。

```typescript
class StructuredPerceiver {
  // 注入到浏览器上下文的提取脚本
  private readonly EXTRACTION_SCRIPT = `
    () => {
      const components = [];
      const seen = new Set();

      const INTERACTIVE_SELECTOR = [
        'button', 'a', 'input', 'select', 'textarea',
        '[role="button"]', '[role="combobox"]', '[role="tab"]',
        '[role="dialog"]', '[role="checkbox"]', '[role="switch"]',
        '[role="menuitem"]', '[role="option"]',
        '[onclick]', '[tabindex]',
        '.ant-select', '.el-select', '.ant-collapse',
        '[class*="dropdown"]', '[class*="accordion"]', '[class*="modal"]'
      ].join(', ');

      document.querySelectorAll(INTERACTIVE_SELECTOR).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);

        components.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          text: el.textContent?.trim().slice(0, 80),
          id: el.id || undefined,
          classes: Array.from(el.classList).slice(0, 8),
          testId: el.dataset.testid || el.getAttribute('data-testid'),
          ariaLabel: el.getAttribute('aria-label'),
          placeholder: el.getAttribute('placeholder'),

          // 精确状态（a11y snapshot 拿不到的）
          state: {
            visible: rect.width > 0 && rect.height > 0,
            enabled: !el.disabled
                   && !el.hasAttribute('disabled')
                   && style.pointerEvents !== 'none'
                   && !Array.from(el.classList).some(c =>
                        c.includes('disabled') || c.includes('readonly')),
            inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
            cursorPointer: style.cursor === 'pointer',
            userSelectNone: style.userSelect === 'none',
          },

          // 多信号点击可能性评分（含 cursor:pointer）
          clickability: (() => {
            const isSemanticTag = ['button', 'a', 'input', 'select', 'textarea']
              .includes(el.tagName.toLowerCase());
            const hasAriaRole = ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'switch']
              .includes(el.getAttribute('role'));
            const cursorPointer = style.cursor === 'pointer';
            const hasOnclick = el.hasAttribute('onclick');
            const hasTabIndex = el.hasAttribute('tabindex');

            const score =
              (isSemanticTag ? 0.3 : 0) +
              (hasAriaRole ? 0.25 : 0) +
              (cursorPointer ? 0.2 : 0) +
              (hasOnclick ? 0.15 : 0) +
              (hasTabIndex ? 0.1 : 0);

            return {
              score,
              isInteractive: score >= 0.3,
              isHighConfidence: score >= 0.5,
              signals: { isSemanticTag, hasAriaRole, cursorPointer, hasOnclick, hasTabIndex },
            };
          })(),

          // 表单字段信息
          value: el.value !== undefined ? String(el.value).slice(0, 100) : undefined,
          type: el.type,
          required: el.required || el.hasAttribute('required'),
          maxLength: el.maxLength > 0 ? el.maxLength : undefined,
          pattern: el.pattern || undefined,
          validationMessage: el.validationMessage || undefined,

          // 层级关系
          parentDialog: el.closest('[role="dialog"], .ant-modal')?.id || undefined,
          parentForm: el.closest('form')?.id || undefined,
          parentAccordion: el.closest('.ant-collapse-item, details')?.id || undefined,

          // 位置（用于视觉重叠检测）
          rect: {
            x: Math.round(rect.x), y: Math.round(rect.y),
            w: Math.round(rect.width), h: Math.round(rect.height)
          },

          // 生成用于后续 Playwright 操作的精确 selector
          selector: (() => {
            if (el.dataset.testid) return '[data-testid="' + el.dataset.testid + '"]';
            if (el.id) return '#' + CSS.escape(el.id);
            if (el.getAttribute('aria-label')) {
              const tag = el.tagName.toLowerCase();
              return tag + '[aria-label="' + el.getAttribute('aria-label') + '"]';
            }
            if (el.getAttribute('role')) {
              return '[role="' + el.getAttribute('role') + '"]';
            }
            return null; // 需要生成更复杂的 selector
          })(),
        });
      });

      return {
        components,
        url: location.href,
        title: document.title,
        forms: Array.from(document.querySelectorAll('form')).map(f => ({
          id: f.id,
          fieldCount: f.querySelectorAll('input, select, textarea').length,
          hasFileInput: f.querySelector('input[type="file"]') !== null,
        })),
        dialogs: Array.from(document.querySelectorAll('[role="dialog"], .ant-modal')).length,
        loadingOverlays: Array.from(document.querySelectorAll(
          '.ant-spin, .loading, [class*="loading"]'
        )).filter(el => el.getBoundingClientRect().height > 0).length,
      };
    }
  `;

  async capture(page: Page): Promise<StructuredObservation> {
    const [extracted, a11y, network] = await Promise.all([
      page.evaluate(this.EXTRACTION_SCRIPT),     // 主通道: 结构化提取
      page.accessibility.snapshot(),             // 辅助: 树结构参考
      this.captureNetwork(page),                 // 网络
    ]);

    return {
      type: 'structured',
      extracted,        // 自定义脚本提取的结构化数据
      a11yTree: a11y,   // 辅助树结构
      networkEvents: network,
      url: page.url(),
      timestamp: Date.now(),
    };
  }
}
```

**对比优势**：

| 对比 | 原始 DOM | a11y snapshot | 自定义提取 |
|------|---------|-------------|-----------|
| Token 消耗 | 50,000 | 3,000 | 2,000-5,000 |
| CSS 状态 | 有（噪声大） | 无 | 精确提取 |
| 精确 selector | 需解析 | 无 | 直接生成 |
| 表单约束 | 需解析 | 部分 | 直接提取 |
| 组件库适配 | 不处理 | 不处理 | 可加 ant/el 规则 |
| LLM 友好度 | 差 | 好 | 最好 |

#### 视觉感知器

```typescript
class VisualPerceiver {
  async capture(page: Page): Promise<VisualObservation> {
    const [viewport, fullPage] = await Promise.all([
      page.screenshot({ type: 'png', timeout: 5000 }),
      page.screenshot({ type: 'png', fullPage: true, timeout: 10000 }),
    ]);

    return {
      type: 'visual',
      viewport: viewport,   // base64
      fullPage: fullPage,   // base64
      viewportSize: page.viewportSize(),
      timestamp: Date.now(),
    };
  }
}
```

### 6.3 组件模型

不使用形式化"组件模型"概念，直接建模为组件分类 + 页面图。两层结构：

```
Layer 1: 内置组件类型（通用，代码定义）
  Page, Navigation, Button, Input, Select, Form, Table,
  Modal, Accordion, Tab, Toast, Tooltip, Checkbox, Radio,
  Pagination, Breadcrumb, Dropdown, DatePicker, FileUpload

Layer 2: 学习到的组件签名（运行时积累，跨应用复用）
  "DatePicker: .ant-picker + input[readonly]"
  "VirtualTable: .ant-table-virtual .ant-table-tbody"
  "TreeSelect: .ant-select-tree"
  → 来自 ComponentSignature 库（6.9 自进化）

领域上下文（电商/CRM/管理后台）不单独建模。
LLM 从页面文本、组件组合、操作结果中自然推断领域语义，
不预定义领域插件。这样可以适应任意目标系统。
```

#### 核心类型定义

```typescript
// 页面节点
interface PageNode {
  id: string;
  url: string;
  title: string;
  urlPattern: string;           // 去参数化后的 URL 模式
  role: PageRole;
  components: Component[];
  navigationTargets: NavigationEdge[];
  meta: {
    firstSeenAt: number;
    lastVisitedAt: number;
    visitCount: number;
    testStatus: 'untested' | 'partial' | 'tested';
  };
}

type PageRole =
  | 'login' | 'dashboard' | 'list' | 'detail'
  | 'form' | 'settings' | 'report' | 'modal' | 'unknown';

// 组件
interface Component {
  id: string;
  pageId: string;
  type: ComponentType;
  selector: string;              // Playwright selector
  label: string;                 // 人类可读标签
  state: ComponentState;
  constraints: Constraint[];
  parent?: string;               // 父组件 ID（如 Modal 内的 Form）
  children: string[];
  meta: {
    confidence: number;          // 识别置信度
    source: 'a11y' | 'dom' | 'visual' | 'inferred';
  };
}

type ComponentType =
  | 'button' | 'input' | 'textarea' | 'select'
  | 'form' | 'table' | 'modal' | 'accordion'
  | 'tab' | 'toast' | 'checkbox' | 'radio'
  | 'navigation' | 'breadcrumb' | 'pagination'
  | 'unknown';

// 组件状态
interface ComponentState {
  visible: boolean;
  enabled: boolean;
  value?: string;
  options?: string[];            // select 的选项
  expanded?: boolean;            // accordion/tab
  validationErrors?: string[];
}

// 交互
interface Interaction {
  id: string;
  componentId: string;
  action: ActionType;
  preconditions: Condition[];
  expectedEffects: Effect[];
  sideEffects: string[];        // 可能影响的其他组件
}

type ActionType =
  | 'click' | 'type' | 'select'
  | 'hover' | 'scroll' | 'drag'
  | 'focus' | 'blur' | 'keyboard';

// 导航边
interface NavigationEdge {
  fromPageId: string;
  toPageId: string;
  trigger: string;               // 触发此导航的组件 ID
  method: 'link' | 'button' | 'redirect' | 'menu';
}
```

#### 组件识别流程

```
结构化感知器获取组件数据（自定义提取脚本）
       │
       ▼
Layer 1: 规则匹配（确定性，不消耗 LLM）
  role="button" → Button
  tag="input" + type="text" → Input
  role="combobox" → Select
  role="dialog" → Modal
  role="tablist" + role="tab" → Tab
  .ant-select → Select (组件库规则)
  .ant-collapse → Accordion
  ...
       │
       ▼
Layer 2: 签名库匹配（查 ComponentSignature，不消耗 LLM）
  查找 domPattern / a11yPattern 是否匹配
  匹配且 confidence > 0.8 → 直接识别
       │
       ▼
仍未识别（confidence < 0.7）
       │
       ▼
LLM 识别（结构化数据 + 截图）
  输入: 提取的组件 JSON + a11y 子树 + 截图
  输出: { type, label, confidence, reasoning }
       │
       ▼
写入组件模型，持久化到 SQLite
```

### 6.4 质量规则

替代形式化"质量规则"概念，使用置信度加权的质量规则。不是二元 pass/fail，而是产出置信度评分。

#### 规则接口

```typescript
interface QualityRule {
  id: string;
  layer: 'builtin' | 'learned';          // 内置 or 运行时学习
  name: string;
  statement: string;                     // 自然语言描述
  check: (ctx: RuleContext) => Promise<RuleResult>;
  severity: 'critical' | 'major' | 'minor' | 'info';
  appliesTo?: ComponentType[];
}

interface RuleContext {
  before: Observation;           // 操作前状态
  action: ExecutedAction;        // 执行的操作
  after: Observation;            // 操作后状态
  networkLog: NetworkEvent[];
  consoleLog: ConsoleMessage[];
  componentModel: ComponentModel; // 当前组件模型
  memory: AppMemory;
}

interface RuleResult {
  // 不是二元，而是置信度加权
  score: number;                  // 0-1, >0.7 = 通过, 0.3-0.7 = 待定, <0.3 = 疑似违反
  verdict: 'pass' | 'suspect' | 'fail';
  confidence: number;            // 判断的置信度
  violation?: {
    ruleId: string;
    description: string;
    evidence: Evidence;
    severity: 'critical' | 'major' | 'minor' | 'info';
    reproduction?: string[];
  };
}
```

#### 三层判断机制

```
Layer 1: 内置规则（代码定义，快速）
  反馈性、验证性、无崩溃、可恢复性、数据持久性、状态一致性
  产出: pass / fail / suspect

Layer 2: 学习到的规则（运行时归纳，置信度加权）
  "这个 app 所有删除都有确认框" → 第 14 次删除没有 → suspect
  产出: confidence-weighted suspect

Layer 3: LLM 即时判断（上下文推理，最强 oracle）
  当 Layer 1/2 产出 suspect 或 fail 时，发给 LLM 做最终判断
  输入: 操作前后截图 + 结构化数据 + 网络日志 + console
  输出: { isBug: boolean, severity, reasoning, confidence }
```

**为什么需要 Layer 3**：很多 bug 无法用预定义规则捕获。例如"这个下拉菜单选择后联动字段没有更新"——只有 LLM 看到截图和前后对比才能判断这是 bug 还是产品设计。内置规则是第一道防线（快、便宜），LLM 是最终 oracle（准、贵）。

#### 内置质量规则（Layer 1）

```yaml
QR001:
  name: 反馈性
  statement: "任何用户操作必须在 2 秒内产生可感知反馈"
  severity: major
  check: |
    执行 action 后 2000ms 内检查：
    - DOM 是否变化 (MutationObserver)
    - URL 是否变化
    - Loading 状态是否出现
    - Console 是否有新输出
    - Network 是否有新请求
    若均无 → 违反
  appliesTo: [button, form, tab, accordion]

QR002:
  name: 表单验证
  statement: "提交包含非法输入的表单时，不应发出网络请求，应显示验证信息"
  severity: critical
  check: |
    在表单字段填入非法值（空/超长/特殊字符/类型错误）
    点击提交按钮
    检查：
    - 是否有 XHR/Fetch 发出
    - 是否有验证错误提示出现
    若发出请求且无提示 → 违反
  appliesTo: [form]

QR003:
  name: 状态一致性
  statement: "同一操作通过不同入口触发时，效果应一致"
  severity: major
  check: |
    对比两条路径执行后的页面关键状态
    (组件可见性、数据内容、URL)
    若存在不一致 → 违反
  appliesTo: [button, navigation]

QR004:
  name: 可恢复性
  statement: "错误发生后，用户应能恢复到可用状态"
  severity: major
  check: |
    触发错误后检查：
    - 是否存在关闭/返回/重试按钮
    - 页面是否仍可交互
    - 是否可以通过导航恢复
    若页面死锁或无法返回 → 违反
  appliesTo: [modal, form, toast]

QR005:
  name: 数据持久性
  statement: "保存成功后，刷新页面数据不应丢失"
  severity: critical
  check: |
    执行保存操作 → 确认成功反馈
    page.reload() → 对比关键数据
    若数据不一致 → 违反
  appliesTo: [form]

QR006:
  name: 无崩溃
  statement: "任何操作不应导致页面白屏、JS 未捕获异常或无限 loading"
  severity: critical
  check: |
    持续监控：
    - console.error (未捕获)
    - window.onerror
    - unhandledrejection
    - 页面 body 是否为空
    - 网络请求是否返回 5xx
    若任一触发 → 违反
  appliesTo: "*"
```

#### 学习到的质量规则（Layer 2）

Agent 在探索和测试中自动学习：

```typescript
interface InferredAxiom {
  id: string;
  tier: 'instance';
  statement: string;
  confidence: number;           // 0-1
  evidence: {
    positiveCount: number;      // 符合观察次数
    negativeCount: number;      // 违反观察次数
  };
  check: (ctx: AxiomContext) => Promise<AxiomResult>;
  learnedAt: number;
  lastValidatedAt: number;
}
```

推断流程：

```
Agent 观察到 12 次删除操作全部有确认框
       │
       ▼
LLM 归纳: "本应用中，所有删除操作都应先弹出确认框"
       │
       ▼
生成 InferredAxiom (confidence: 12/12 = 1.0)
       │
       ▼
后续测试中:
  - 第 13 次删除有确认框 → confidence 增至 13/13
  - 第 14 次删除无确认框 → 疑似 Bug (违反已学质量规则)
```

### 6.5 测试引擎

#### 测试阶段

```
Phase 2: Explore (广度优先)
  ├── 目标: 发现所有可达页面和组件
  ├── 方法: BFS 导航，每个页面停留，识别组件
  ├── 输出: 完整 UI Model
  └── 预估: 30-60 分钟（中等应用）

Phase 3: Component Test (深度优先)
  ├── 目标: 逐组件深度测试
  ├── 方法: 对每个组件生成测试用例并执行
  ├── 输入: UI Model + 质量规则 + 记忆中的已测项
  ├── 输出: 组件级测试结果
  └── 预估: 4-12 小时

Phase 4: Combination Test (n-wise)
  ├── 目标: 测试功能组合
  ├── 方法: 识别关联组件，pairwise 组合测试
  ├── 输入: UI Model 中的组件依赖关系
  ├── 输出: 组合测试结果
  └── 预估: 2-8 小时

Phase 5: Chaos Test (混沌)
  ├── 目标: 异常路径
  ├── 方法: 随机中断、返回键、多标签、断网重连
  ├── 输出: 异常场景测试结果
  └── 预估: 1-4 小时
```

#### 组件测试用例生成

根据组件类型自动生成测试矩阵：

```typescript
const componentTestMatrix: Record<ComponentType, TestCaseGenerator[]> = {
  input: [
    { name: '正常输入', input: 'valid-value' },
    { name: '空值', input: '' },
    { name: '边界值-最小', input: 'a' },
    { name: '边界值-最大长度', input: 'a'.repeat(maxLength) },
    { name: '超长输入', input: 'a'.repeat(10000) },
    { name: '特殊字符', input: '<script>alert(1)</script>' },
    { name: 'SQL注入', input: "'; DROP TABLE users; --" },
    { name: 'Unicode', input: '你好🌍🎉' },
    { name: '前后空格', input: '  value  ' },
  ],
  select: [
    { name: '选择第一项' },
    { name: '选择最后一项' },
    { name: '选择后取消' },
    { name: '快速连续切换' },
    { name: '选择后检查联动' },  // 检查依赖字段是否更新
  ],
  modal: [
    { name: '打开-关闭', expected: '背景恢复' },
    { name: '打开-Esc关闭', expected: '背景恢复' },
    { name: '打开-点击遮罩关闭', expected: '背景恢复' },
    { name: '打开-直接刷新', expected: '状态一致' },
    { name: '嵌套弹框', expected: '层级正确' },
    { name: '弹框内表单提交', expected: '验证生效' },
  ],
  accordion: [
    { name: '展开-收起' },
    { name: '展开所有' },
    { name: '互斥展开检查', expected: '如果手风琴互斥，展开B应收起A' },
    { name: '默认展开状态' },
  ],
  form: [
    { name: '全空提交' },
    { name: '必填项逐个缺失提交' },
    { name: '全合法提交' },
    { name: '部分合法部分非法' },
    { name: '提交后返回再提交' },
    { name: '双击提交' },  // 检查防重复
    { name: '提交中取消' },
  ],
  // ... 其他类型
};
```

#### 组合测试策略

```typescript
class CombinationTester {
  // 识别关联组件
  async findRelatedComponents(componentModel: ComponentModel): ComponentGroup[] {
    // 启发式规则：
    // 1. 同一 Form 内的字段
    // 2. 同一 Modal 内的控件
    // 3. 有 visibleWhen 条件的组件（联动）
    // 4. 记忆中发现的关联模式
  }

  // 生成 pairwise 组合
  generatePairs(group: ComponentGroup): Combination[] {
    // 使用 IPOG 算法生成 pairwise covering array
    // 如果组内组件 ≤ 5 个，可以做 3-wise
  }

  // 执行组合测试
  async executeCombination(combo: Combination): Promise<TestResult> {
    // 1. 重置到初始状态
    // 2. 按顺序执行各组件操作
    // 3. 校验所有质量规则
    // 4. 检查组合后的最终状态是否合理
  }
}
```

### 6.6 覆盖保证机制

穷尽不是靠 Agent 感觉"探索完了"，而是通过五层形式化机制保证可证明的覆盖率。

#### 覆盖维度定义

| 维度 | 含义 | 穷尽标准 |
|------|------|---------|
| 页面覆盖 | 所有可达页面被发现并访问 | Frontier Queue 空 |
| 组件覆盖 | 所有页面上的所有组件被识别 | 揭示策略执行完毕 + 无新增 |
| 交互覆盖 | 所有 (组件, 操作) 对被尝试 | Frontier Queue 空 |
| 输入覆盖 | 所有输入字段使用边界值测试 | 测试矩阵全执行 |
| 组合覆盖 | 关联字段的所有 n-wise 组合 | Covering Array 全执行 |
| 状态覆盖 | 同一页面在不同数据状态下测试 | 状态矩阵全执行 |
| 序列覆盖 | K 步操作路径覆盖 | 路径追踪达到配置深度 |

#### 6.6.1 Frontier Queue（探索穷尽）

Frontier Queue 是探索完成的形式化判定。每个 `(页面, 组件, 操作)` 三元组要么已执行，要么在队列中。队列空 = 探索穷尽。

```typescript
interface FrontierItem {
  pageId: string;
  componentId: string;
  action: ActionType;
  preconditions: Condition[];     // 执行此操作需要的条件
  priority: number;               // 越高越先探索
  discoveryMethod: string;        // 怎么发现这个交互的
}

class ExplorationFrontier {
  private queue: PriorityQueue<FrontierItem>;
  private visited: Set<string>;   // hash: `${pageId}:${componentId}:${action}`
  private blocked: Set<string>;   // 无法执行（权限/条件不满足）

  // 初始: 登录页所有组件的所有操作
  initialize(page: PageNode): void {
    for (const component of page.components) {
      for (const action of this.getApplicableActions(component)) {
        this.enqueue(page.id, component.id, action);
      }
    }
  }

  // 执行后: 检查是否发现了新页面或新组件
  async onActionComplete(result: ActionResult): Promise<void> {
    if (result.newPageDiscovered) {
      // 新页面 → 该页面所有组件加入队列
      this.initialize(result.newPage);
    }
    if (result.newComponentsDiscovered) {
      // 新组件 → 该组件的所有操作加入队列
      for (const component of result.newComponents) {
        for (const action of this.getApplicableActions(component)) {
          this.enqueue(result.pageId, component.id, action);
        }
      }
    }
    if (result.stateChanged) {
      // 页面状态变了 → 可能有新的条件满足的组件出现
      // 重新扫描当前页面，发现新出现的组件
      const newComponents = await this.rescanPage(result.pageId);
      for (const component of newComponents) {
        this.enqueue(result.pageId, component.id, 'click'); // 新状态下的交互
      }
    }
  }

  // 探索完成的判定
  isExhausted(): boolean {
    return this.queue.size === 0;
  }

  // 覆盖率
  getCoverage(): ExplorationCoverage {
    const total = this.visited.size + this.queue.size + this.blocked.size;
    return {
      visited: this.visited.size,
      pending: this.queue.size,
      blocked: this.blocked.size,
      percentage: (this.visited.size / total) * 100,
    };
  }
}
```

#### 6.6.2 组件揭示策略（隐藏组件发现）

复杂业务界面中大量组件是隐藏的（在手风琴内、弹框内、Tab 内、条件渲染）。扫描页面之前，必须先执行揭示策略：

```typescript
class ComponentRevealer {
  // 在扫描组件之前，系统性地展开所有可折叠/隐藏的容器
  async revealAll(page: Page): Promise<RevealResult> {
    const revealed: Component[] = [];
    const actions: RevealAction[] = [];

    // 1. 展开所有手风琴
    const accordions = await page.locator(
      '.ant-collapse-item, .accordion-item, [class*="collapse"] details'
    ).all();
    for (const accordion of accordions) {
      const isExpanded = await accordion.getAttribute('aria-expanded');
      if (isExpanded !== 'true') {
        await accordion.click();
        await page.waitForTimeout(500); // 等待展开动画
        actions.push({ type: 'expand-accordion', target: accordion });
      }
    }

    // 2. 切换所有 Tab，每个 Tab 都扫描
    const tabs = await page.locator('[role="tab"], .ant-tabs-tab, .nav-tabs li').all();
    for (const tab of tabs) {
      await tab.click();
      await page.waitForTimeout(500);
      const tabComponents = await this.scanComponents(page);
      revealed.push(...tabComponents);
      actions.push({ type: 'switch-tab', target: tab });
    }

    // 3. 打开所有弹框（扫描后关闭）
    const modalTriggers = await page.locator(
      'button:has-text("新增"), button:has-text("编辑"), button:has-text("添加"), [class*="modal-trigger"]'
    ).all();
    for (const trigger of modalTriggers) {
      await trigger.click();
      await page.waitForSelector('[role="dialog"], .ant-modal, [class*="modal"]', { timeout: 5000 });
      const modalComponents = await this.scanComponents(page);
      revealed.push(...modalComponents);
      // 扫描完关闭
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // 4. 悬停交互元素（检查 tooltip/菜单）
    const hoverTargets = await page.locator(
      '[data-tooltip], [title], .has-tooltip, [class*="popover"]'
    ).all();
    for (const target of hoverTargets) {
      await target.hover();
      await page.waitForTimeout(300);
      // 检查是否出现了新元素
      const tooltipContent = await page.locator('.tooltip, [role="tooltip"], .ant-tooltip').all();
      if (tooltipContent.length > 0) {
        revealed.push(...await this.scanComponents(page));
      }
    }

    // 5. 滚动到底部（触发懒加载）
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    // 6. 打开所有下拉菜单（记录选项）
    const dropdowns = await page.locator(
      '.ant-select, .el-select, [role="combobox"], [class*="dropdown"]'
    ).all();
    for (const dropdown of dropdowns) {
      await dropdown.click();
      await page.waitForTimeout(500);
      const options = await page.locator(
        '.ant-select-dropdown .ant-select-item, .el-select-dropdown .el-select-item'
      ).all();
      // 记录选项列表，用于后续测试
      actions.push({ type: 'scan-dropdown', target: dropdown, options: options.length });
      await page.keyboard.press('Escape');
    }

    return { revealed, actions };
  }
}
```

#### 6.6.3 数据状态管理（State Coverage）

同一页面在不同数据状态下呈现不同组件。Agent 需要主动管理数据状态：

```typescript
type DataState = 'empty' | 'single-item' | 'multiple-items' | 'paginated' | 'filtered' | 'error';

class StateCoverageManager {
  // 对每个列表页面，测试不同数据状态
  async testStates(page: PageNode): Promise<void> {
    // 1. 空数据状态
    await this.testEmptyState(page);

    // 2. 创建测试数据
    const testItems = await this.createTestData(page, 3); // 创建 3 条测试数据

    // 3. 单条数据状态
    await this.testSingleItemState(page, testItems[0]);

    // 4. 多条数据状态
    await this.testMultipleItemsState(page, testItems);

    // 5. 分页状态（如果数据足够多）
    if (this.needsPagination(page)) {
      await this.createMoreTestData(page, 20); // 创建更多数据触发分页
      await this.testPaginatedState(page);
    }

    // 6. 筛选/搜索状态
    await this.testFilteredState(page, testItems[0]);

    // 7. 记录所有创建的测试数据（用于清理）
    await this.trackCreatedData(page, testItems);
  }

  // 空状态下可能出现的特殊组件
  async testEmptyState(page: PageNode): Promise<void> {
    // 清空测试数据（或进入一个确认无数据的页面）
    // 检查:
    // - "暂无数据"提示是否显示
    // - "新增"按钮是否可用
    // - 搜索/筛选是否禁用或隐藏
    // - 空状态插画是否正确渲染
  }

  // 有数据后出现的新组件
  async testWithDataState(page: PageNode): Promise<void> {
    // 有数据时检查:
    // - 表格每行的"编辑"/"删除"按钮
    // - 分页组件
    // - 批量操作
    // - 行内展开
    // - 详情跳转
  }
}
```

#### 6.6.4 Covering Array（组合覆盖的数学保证）

"穷尽所有组合"在数学上不可能（组合爆炸），但可以数学证明特定深度的覆盖率：

```
表单有 8 个字段，每个字段 3 种取值:
  全组合:    3^8 = 6,561 种
  Pairwise: 用 IPOG 算法只需 ~12 条用例 → 覆盖所有字段对
  3-wise:   ~30 条用例 → 覆盖所有三元组
```

IPOG (In-Parameter-Order Generation) 算法生成的 covering array 是数学上可证明的最小集合。

```typescript
class CombinationCoverageTracker {
  // 为每个交互组生成最小 covering array
  generateCoveringArray(
    parameters: Parameter[],   // 每个字段的取值集合
    strength: number            // 2=pairwise, 3=3-wise
  ): TestCombination[] {
    // IPOG 算法实现
    // 1. 按参数取值数量排序（从多到少）
    // 2. 前两个参数的所有组合作为初始集合
    // 3. 逐个加入后续参数，扩展已有组合
    // 4. 用最少的行覆盖所有 t-way 组合
    return ipogGenerate(parameters, strength);
  }

  // 覆盖验证
  verifyCoverage(
    group: ComponentGroup,
    executedTests: TestCombination[],
    strength: number
  ): CoverageReport {
    // 计算理论上的 t-way 组合总数
    const totalCombinations = this.countCombinations(group, strength);
    // 计算已覆盖的组合数
    const coveredCombinations = this.countCovered(group, executedTests, strength);

    return {
      group: group.id,
      strength,
      totalCombinations,
      coveredCombinations,
      coveragePercentage: (coveredCombinations / totalCombinations) * 100,
      isComplete: coveredCombinations === totalCombinations,
    };
  }
}
```

覆盖配置：

```yaml
combination_coverage:
  default_strength: 2            # 默认 pairwise
  critical_groups_strength: 4    # 发现过 bug 的区域用 4-wise
  max_combinations_per_group: 500 # 单组最大组合数（防爆）
  timeout: 4h                    # 组合测试总时长限制
```

#### 6.6.5 路径覆盖（序列覆盖）

```typescript
class PathCoverageTracker {
  private testedPaths: Set<string>;  // hash: "A->B->C"
  private interactionGraph: Graph;

  // 生成长度为 K 的所有路径
  generatePaths(depth: number): Path[] {
    return this.interactionGraph.getAllPaths(depth);
  }

  // 追踪已测路径
  onSequenceComplete(sequence: ComponentAction[]): void {
    const pathHash = sequence.map(s => s.componentId).join('->');
    this.testedPaths.add(pathHash);
  }

  getCoverage(depth: number): PathCoverage {
    const allPaths = this.generatePaths(depth);
    const testedCount = allPaths.filter(p => this.testedPaths.has(p.hash)).length;
    return {
      depth,
      totalPaths: allPaths.length,
      testedPaths: testedCount,
      percentage: (testedCount / allPaths.length) * 100,
    };
  }
}
```

#### 6.6.6 覆盖率报告

```typescript
interface FullCoverageReport {
  exploration: {
    pagesDiscovered: number;
    pagesVisited: number;
    pagesBlocked: number;           // 权限不足
    frontierRemaining: number;      // 队列中未执行的
    percentage: number;
  };
  components: {
    totalIdentified: number;
    totalTested: number;
    hiddenComponentsRevealed: number;
    untestableComponents: number;  // 因数据/权限无法测试
    percentage: number;
  };
  interactions: {
    totalDiscovered: number;
    totalExecuted: number;
    blocked: number;
    percentage: number;
  };
  inputs: {
    fieldsTotal: number;
    boundaryTestsExecuted: number;
    validationTestsExecuted: number;
    coverage: number;
  };
  combinations: {
    groups: GroupCoverage[];        // 每组的覆盖详情
    defaultStrength: number;
    overallPercentage: number;
  };
  sequences: {
    maxDepth: number;
    pathsTested: number;
    pathsTotal: number;
    percentage: number;
  };
  states: {
    statesTested: StateResult[];     // 每个页面的状态覆盖
    dataCreated: number;
    dataCleaned: number;
  };
  limitations: string[];            // 明确说明什么没测到及原因
}
```

报告输出示例：

```
┌─────────────────────────────────────────────────────────┐
│ Coverage Report                                          │
├─────────────────────────────────────────────────────────┤
│ Pages:          45/47 discovered, 45/47 visited (95.7%)  │
│   Blocked:      2 (permission denied)                   │
│   Frontier:     0 remaining                             │
│                                                          │
│ Components:    312/312 identified, 298/312 tested (95.5%)│
│   Hidden:       67 revealed via reveal strategy          │
│   Untestable:   14 (requires unavailable data)           │
│                                                          │
│ Interactions:  1204/1204 discovered, 1187 tested (98.6%)│
│   Blocked:      17 (preconditions not met)               │
│                                                          │
│ Inputs:         89/89 fields tested (100%)               │
│   Boundary:     356/356 boundary tests (100%)            │
│   Validation:   89/89 validation tests (100%)            │
│                                                          │
│ Combinations:                                             │
│   Pairwise:     245/245 groups covered (100%)             │
│   3-wise:       18/25 groups covered (72%)                │
│   (7 groups skipped: exceeded max_combinations limit)    │
│                                                          │
│ Sequences:                                                │
│   2-step:       100% (342/342 paths)                     │
│   3-step:       67% (4231/6312 paths)                    │
│                                                          │
│ States:                                                   │
│   Empty:        45/45 pages (100%)                       │
│   Populated:   43/45 pages (95.6%)                      │
│   Error:        12/45 pages (26.7%)                      │
│   Test data:    23 records created, 23 cleaned           │
│                                                          │
│ Limitations:                                              │
│ - /admin/audit unreachable: 403 Forbidden                │
│ - 14 components require pre-existing data               │
│ - 7 combination groups exceeded 500 limit                 │
│ - Error states only tested where naturally triggered     │
└─────────────────────────────────────────────────────────┘
```

#### 覆盖保证总结

| 保证层级 | 机制 | 数学证明 |
|---------|------|---------|
| 所有页面/组件被发现 | Frontier Queue 空为充要条件 | 是 |
| 所有隐藏组件被揭示 | 揭示策略（手风琴/Tab/弹框/悬停/滚动/下拉） | 启发式，高覆盖 |
| 所有单组件功能被测 | 测试矩阵全执行 | 是 |
| 所有 pairwise 组合被覆盖 | IPOG Covering Array | 是（数学证明） |
| 关键区域 n-wise 覆盖 | 可配置深度 + Covering Array | 是 |
| K 步序列覆盖 | 路径覆盖追踪 | 是（在配置深度内） |
| 覆盖率可审计 | Coverage Report + limitations | 是 |
### 6.7 测试编译与加速

已测过的项目，下次不需要再调 LLM 逐步决策。Agent 自动将成功的测试路径编译为可复用的 Playwright 脚本。

#### 三层执行模式

```
第一次运行（探索模式，LLM 驱动）
  LLM 决策 → Playwright 执行 → 结果 → 质量规则校验
  速度: 慢（每个决策都调 LLM）
  产出: UI Model + 导航宏 + 编译用例

第二次运行（回归模式，编译执行）
  加载编译用例 → Playwright 直接执行 → 断言校验
  速度: 快 10-50 倍（不调 LLM）

变化时（混合模式）
  编译用例失败 → LLM 只重新分析变化的组件 → 更新用例
  速度: 只对变化部分调 LLM
```

#### 导航宏

```typescript
interface NavigationMacro {
  id: string;
  targetComponentId: string;      // 要到达的组件
  steps: MacroStep[];            // 精确的导航步骤
  url: string;                   // 直接可跳转的 URL（如果能）
  selector: string;              // 到达后的组件 selector
  cachedAt: number;
  valid: boolean;
}

interface MacroStep {
  action: 'goto' | 'click' | 'wait' | 'fill';
  target: string;                // selector 或 URL
  value?: string;                // fill 的值
  timeout: number;
}

// 示例: 到达"用户编辑弹框"
const macro: NavigationMacro = {
  id: 'nav-001',
  targetComponentId: 'modal-edit-user',
  steps: [
    { action: 'goto', target: 'https://app.example.com/users', timeout: 30000 },
    { action: 'wait', target: 'table[data-testid="user-table"]', timeout: 10000 },
    { action: 'click', target: 'button:has-text("编辑")', timeout: 5000 },
    { action: 'wait', target: '[role="dialog"]', timeout: 5000 },
  ],
  url: 'https://app.example.com/users',
  selector: '[role="dialog"] form',
  cachedAt: Date.now(),
  valid: true,
};
```

#### 编译用例

```typescript
interface CompiledTestCase {
  id: string;
  componentId: string;
  testType: string;              // 'empty-submit' | 'overflow-input' | ...
  navigationMacroId: string;     // 用哪个导航宏到达
  actions: CompiledAction[];     // 精确操作序列
  assertions: CompiledAssertion[]; // 断言
  timeout: number;
  lastPassedAt: number;
  executeCount: number;
}

interface CompiledAction {
  type: 'click' | 'fill' | 'select' | 'hover' | 'press';
  selector: string;
  value?: string;
  timeout: number;
}

interface CompiledAssertion {
  type: 'visible' | 'text' | 'url' | 'count' | 'attribute' | 'console';
  selector?: string;
  expected: any;
  timeout: number;
}

// 示例: "表单空提交应显示验证错误"的编译用例
const testCase: CompiledTestCase = {
  id: 'tc-form-123-empty-submit',
  componentId: 'form-123',
  testType: 'empty-submit',
  navigationMacroId: 'nav-001',
  actions: [
    { type: 'click', selector: 'button[type="submit"]', timeout: 5000 },
  ],
  assertions: [
    { type: 'visible', selector: '.error-message', expected: true, timeout: 3000 },
    { type: 'text', selector: '.error-message', expected: '必填', timeout: 3000 },
    { type: 'url', expected: '**/users', timeout: 3000 }, // URL 不应变化
  ],
  timeout: 30000,
  lastPassedAt: Date.now(),
  executeCount: 1,
};
```

#### 编译触发

```typescript
class TestCompiler {
  // 测试通过后自动编译
  async compileOnPass(result: TestResult): Promise<CompiledTestCase> {
    // 1. 从 result 中提取: 用了哪些 selector、输入了什么值
    // 2. 从 result 中提取: 断言了什么、期望值是什么
    // 3. 从执行日志中提取: 各步骤的实际耗时 → 设为 timeout
    // 4. 生成 CompiledTestCase 并持久化
    return compiledTestCase;
  }

  // 编译用例失败时，判断是"产品变了"还是"用例过期了"
  async onCompiledTestFail(failure: CompiledTestFailure): Promise<'re-analyze' | 'real-bug'> {
    // 1. 检查 selector 是否还能找到元素
    //    找不到 → UI 变了，需要 LLM 重新分析组件
    // 2. 检查断言失败的原因
    //    期望 visible 但不可见 → 可能是 bug
    //    期望 text 但文本不同 → 可能是产品更新了文案
    // 3. 拿不准的 → 调 LLM 分析截图 + DOM 判断
  }
}
```

#### 执行策略

```typescript
class RegressionRunner {
  async run(targetId: string): Promise<void> {
    const macros = await this.macroStore.getAll(targetId);
    const testCases = await this.testCaseStore.getAll(targetId);

    // 1. 验证导航宏是否仍有效（快速抽查，不调 LLM）
    for (const macro of macros) {
      const stillValid = await this.verifyMacro(macro); // 执行 steps，检查 selector
      macro.valid = stillValid;
      if (!stillValid) {
        await this.reExplorer.explore(macro.targetComponentId); // 只重新探索这个区域
      }
    }

    // 2. 执行编译用例（纯 Playwright，不调 LLM）
    for (const testCase of testCases.filter(t => t.navigation.valid)) {
      const result = await this.executeCompiled(testCase);
      if (!result.passed) {
        const verdict = await this.compiler.onCompiledTestFail(result);
        if (verdict === 're-analyze') {
          // UI 变了，重新分析这一个组件
          await this.reAnalyze(testCase.componentId);
        } else {
          // 真 bug
          await this.bugReporter.report(result);
        }
      }
    }
  }

  private async executeCompiled(tc: CompiledTestCase): Promise<TestResult> {
    const page = await this.browserManager.newPage();
    // 按步骤直接执行，无 LLM 调用
    for (const action of tc.actions) {
      switch (action.type) {
        case 'click':
          await page.click(action.selector, { timeout: action.timeout });
          break;
        case 'fill':
          await page.fill(action.selector, action.value!, { timeout: action.timeout });
          break;
        // ...
      }
    }
    // 执行断言
    for (const assertion of tc.assertions) {
      await this.checkAssertion(page, assertion);
    }
    await page.close();
    return { passed: true };
  }
}
```

#### 速度对比

| 模式 | LLM 调用 | 100 个组件耗时 | 适用场景 |
|------|---------|--------------|---------|
| 首次探索 | 每步都调 | 4-12 小时 | 从未测过 |
| 编译回归 | 0 次 | 15-30 分钟 | 同版本回归 |
| 编译+部分重分析 | 只有变化组件 | 1-2 小时 | UI 有部分更新 |
| expand 发散 | 新路径调 | 2-8 小时 | 需要更深覆盖 |

---

### 6.8 缺陷检测

#### 检测器管道

```typescript
class BugDetector {
  private detectors: Detector[] = [
    new AxiomViolationDetector(),   // 质量规则违反
    new NetworkErrorDetector(),     // HTTP 5xx / 网络失败
    new ConsoleErrorDetector(),     // JS 异常
    new VisualAnomalyDetector(),    // 布局异常（视觉模型）
    new StateInconsistencyDetector(), // 前后状态对比
    new PatternViolationDetector(),  // 违反已学模式
  ];

  async check(ctx: TestContext): Promise<BugReport[]> {
    const bugs: BugReport[] = [];
    for (const detector of this.detectors) {
      const findings = await detector.detect(ctx);
      bugs.push(...findings);
    }
    return this.deduplicate(bugs); // 去重（相同根因）
  }
}
```

#### Bug 报告格式

```typescript
interface BugReport {
  id: string;
  severity: 'critical' | 'major' | 'minor' | 'info';
  title: string;                  // 一句话描述
  description: string;            // 详细说明
  page: string;                   // 发现的页面
  component: string;              // 相关组件
  axiomViolated?: string;         // 违反的质量规则 ID
  reproduction: string[];         // 复现步骤
  expected: string;               // 预期行为
  actual: string;                 // 实际行为
  evidence: {
    screenshots: string[];        // base64 或文件路径
    networkLog?: NetworkEvent[];
    consoleLog?: string[];
    domDiff?: string;            // DOM 前后对比
  };
  detectedAt: number;
  sessionId: string;
  targetApp: string;
}
```

---

### 6.9 组件模型与质量规则自进化

组件模型和质量规则不是写死的，而是从测试经验中持续生长。

#### 组件模型进化

```
初始状态（内置 Layer 1）:
  组件类型: button, input, select, form, table, modal, accordion, tab...

测试过程中:
  ├── 发现新组件模式 → 记录为 ComponentSignature
  ├── 识别规则被验证/证伪 → 调整置信度
  └── 跨应用模式迁移 → App A 的经验帮助识别 App B

进化后:
  组件类型: button, input, ..., + DatePicker, ColorPicker, TreeSelect,
            + RichTextEditor, VirtualTable (从经验中学到)
```

```typescript
interface ComponentSignature {
  id: string;
  componentName: string;           // "DatePicker"
  domPattern: string;             // 'input[class*="date-picker"], .react-datepicker'
  a11yPattern: string;            // role="combobox" + aria-haspopup="dialog"
  visualPattern?: string;         // 截图中的特征（可选）
  confidence: number;
  source: 'builtin' | 'learned';
  observedIn: string[];           // 哪些 app 中见过
  usageCount: number;             // 被使用次数
  lastUsedAt: number;
}

class OntologyEvolver {
  // 测试过程中，持续收集识别样本
  async onComponentIdentified(component: Component, method: string): Promise<void> {
    // method: 'rule-match' | 'llm-identify' | 'signature-match'
    if (method === 'llm-identify') {
      // LLM 识别成功了一个新组件 → 记录签名
      await this.signatureStore.save({
        domPattern: extractDomPattern(component),
        a11yPattern: extractA11yPattern(component),
        componentName: component.type,
        confidence: 0.7,          // 初始置信度
        source: 'learned',
      });
    }
  }

  // 签名被重复验证 → 置信度提升
  async onSignatureValidated(signatureId: string): Promise<void> {
    const sig = await this.signatureStore.get(signatureId);
    sig.usageCount++;
    sig.confidence = Math.min(0.99, sig.confidence + 0.05);
    // confidence > 0.9 时，这个签名可以直接用于规则匹配，不再需要 LLM
  }

  // 跨应用迁移
  // 在 App B 中遇到无法识别的组件时，先查签名库
  // 如果 App A 学到的签名匹配 → 直接识别，跳过 LLM 调用
  async findMatch(component: UnknownComponent): Promise<ComponentSignature | null> {
    return this.signatureStore.findByPattern(component);
  }
}
```

#### 质量规则进化

```typescript
class AxiomEvolver {
  // 轴 1: 从实例推断（已在 6.4 设计）
  // 轴 2: 置信度动态调整
  // 轴 3: 跨应用晋升
  // 轴 4: 自动退休

  // 置信度调整
  async onAxiomResult(axiom: Axiom, result: AxiomResult): Promise<void> {
    if (result.passed) {
      axiom.confidence = Math.min(1.0, axiom.confidence + 0.02);
    } else {
      // 质量规则被违反了 → 检查是真 bug 还是误报
      const isRealBug = await this.verifyBug(result.violation);
      if (isRealBug) {
        axiom.confidence = Math.min(1.0, axiom.confidence + 0.05);  // 好质量规则
        await this.bugReporter.report(result.violation);
      } else {
        axiom.confidence = Math.max(0, axiom.confidence - 0.1);   // 误报
        if (axiom.confidence < 0.3) {
          await this.retireAxiom(axiom);  // 自动退休
        }
      }
    }
  }

  // 跨应用晋升: 实例质量规则在多个 app 中都成立 → 晋升为领域质量规则
  async promoteIfNeeded(): Promise<void> {
    const instanceAxioms = await this.axiomStore.getTier('instance');
    for (const axiom of instanceAxioms) {
      const appsConfirmedIn = axiom.evidence.apps.size;
      if (appsConfirmedIn >= 3 && axiom.confidence > 0.85) {
        // 在 3 个以上应用中都成立 → 晋升为跨应用通用规则
        await this.axiomStore.promote(axiom, 'domain');
      }
    }
  }

  // LLM 主动提议新质量规则（基于观察到的模式）
  async proposeFromPatterns(): Promise<Axiom[]> {
    const patterns = await this.memory.getRecentPatterns();
    const proposal = await this.llm.call('pattern_inference', {
      prompt: `
        基于以下观察到的 UI 行为模式，提议可能成立的测试质量规则。
        格式: { statement, checkLogic, confidence, rationale }
      `,
      data: patterns,
    });
    return proposal.map(p => this.createAxiom(p));
  }
}
```

#### 进化循环

```
每次测试会话结束
       │
       ▼
┌────────────────────────────────────┐
│ 1. 提取本次新发现的组件签名          │
│    → 更新 ComponentSignature 库     │
│    → 置信度 +0.05 (被验证)          │
├────────────────────────────────────┤
│ 2. 评估质量规则表现                     │
│    → 好质量规则（发现真 bug）: +confidence│
│    → 噪音质量规则（总是误报）: -confidence│
│    → confidence < 0.3: 自动退休       │
├────────────────────────────────────┤
│ 3. 实例质量规则晋升检查                 │
│    → 在 ≥3 个 app 中成立 → 升为跨应用通用规则 │
├────────────────────────────────────┤
│ 4. LLM 提议新质量规则                   │
│    → 基于观察到的模式归纳            │
│    → 下一轮验证                     │
├────────────────────────────────────┤
│ 5. 测试策略权重更新                 │
│    → 发现 bug 多的策略优先级提高      │
└────────────────────────────────────┘
```

---
### 6.10 关键辅助机制

#### 网络拦截测试

用 Playwright 的 `page.route()` 模拟网络异常，测试前端对后端异常的容错能力：

```typescript
class NetworkFaultInjector {
  async injectFaults(page: Page): Promise<void> {
    // 1. 模拟服务器 500
    await page.route('**/api/**', async route => {
      if (this.currentFault === 'server-error') {
        await route.fulfill({ status: 500, body: JSON.stringify({ error: 'Internal Server Error' }) });
      } else {
        await route.continue();
      }
    });

    // 2. 模拟网络断开
    await page.setOffline(true);
    await page.waitForTimeout(2000);
    await page.setOffline(false);

    // 3. 模拟慢响应（3 秒）
    await page.route('**/api/**', async route => {
      await new Promise(resolve => setTimeout(resolve, 3000));
      await route.continue();
    });

    // 4. 模拟超时（不响应）
    await page.route('**/api/**', async route => {
      await new Promise(resolve => setTimeout(resolve, 30000));
      // 超时后不响应
    });
  }

  // 检查前端对异常的处理
  async checkErrorHandling(page: Page): Promise<QualityCheckResult[]> {
    const results: QualityCheckResult[] = [];

    // 500 错误时:
    // - 是否显示了错误提示（不是白屏）？
    // - 是否可以重试？
    // - 是否可以返回上一页？

    // 断网时:
    // - 是否显示了离线提示？
    // - 恢复网络后是否能自动重连？

    // 慢响应时:
    // - 是否显示了 loading 状态？
    // - 是否可以取消？
    // - 是否有超时提示？

    return results;
  }
}
```

#### 认证过期处理

24 小时深度测试中，目标系统的 session 可能过期。Agent 需要自动检测并重新登录：

```typescript
class AuthSessionManager {
  private lastAuthCheck: number = 0;
  private readonly CHECK_INTERVAL = 5 * 60 * 1000; // 每 5 分钟检查一次

  async ensureAuthenticated(page: Page, credentials: Credentials): Promise<void> {
    // 定期检查认证状态
    if (Date.now() - this.lastAuthCheck < this.CHECK_INTERVAL) return;
    this.lastAuthCheck = Date.now();

    // 检测方式 1: 页面是否重定向到了登录页
    if (page.url().includes('/login') || page.url().includes('/signin')) {
      await this.reLogin(page, credentials);
      return;
    }

    // 检测方式 2: 检查是否有认证相关的 cookie/token
    const cookies = await page.context().cookies();
    const authCookie = cookies.find(c => c.name.includes('token') || c.name.includes('session'));
    if (!authCookie || authCookie.expires < Date.now() / 1000) {
      await this.reLogin(page, credentials);
      return;
    }

    // 检测方式 3: 试探性 API 调用（不推荐，可能有副作用）
    // 仅在前两种不确定时使用
  }

  // 保存登录后的状态用于快速恢复
  async saveAuthState(context: BrowserContext): Promise<void> {
    const state = await context.storageState();
    await this.storage.save('auth-state', state);
  }

  // 用保存的状态恢复（跳过登录流程）
  async restoreAuthState(context: BrowserContext): Promise<boolean> {
    const state = await this.storage.get('auth-state');
    if (!state) return false;
    await context.addCookies(state.cookies);
    return true;
  }
}
```

#### 测试数据生命周期

Agent 在测试中创建的数据（表单提交、新增记录）需要追踪和清理：

```typescript
class TestDataLifecycle {
  private createdRecords: CreatedRecord[] = [];

  // 记录创建的数据
  async trackCreated(
    page: string,
    entity: string,          // "用户" / "订单"
    identifier: string,      // 唯一标识（ID 或名称）
    cleanupAction: CleanupAction  // 怎么删除
  ): Promise<void> {
    this.createdRecords.push({ page, entity, identifier, cleanupAction, createdAt: Date.now() });
  }

  // 会话结束时清理
  async cleanupAll(page: Page): Promise<CleanupReport> {
    const results: CleanupResult[] = [];

    // 逆序清理（后创建的先删，避免外键依赖）
    for (const record of [...this.createdRecords].reverse()) {
      try {
        await record.cleanupAction.execute(page);
        results.push({ record, success: true });
      } catch (e) {
        results.push({ record, success: false, error: e.message });
      }
    }

    // 未清理成功的记录在报告中标注
    const failed = results.filter(r => !r.success);
    return {
      totalCreated: this.createdRecords.length,
      cleaned: results.length - failed.length,
      failed: failed.length,
      failedDetails: failed,
    };
  }
}
```

#### SPA 加载完成判断

SPA 没有明确的"页面加载完成"信号。Agent 需要综合判断：

```typescript
class PageLoadDetector {
  async waitForStable(page: Page, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 10000;

    await page.waitForLoadState('networkidle', { timeout: timeout / 2 })
      .catch(() => {/* 超时继续 */});

    // 等待 DOM 稳定（500ms 内无变化）
    await this.waitForDomStable(page, 500, timeout);

    // 等待无 loading 遮罩
    await this.waitForNoLoadingOverlay(page, timeout / 2);

    // 等待主要内容渲染
    await page.waitForSelector(
      'main, [role="main"], .ant-layout-content, #app, #root',
      { state: 'visible', timeout: timeout / 2 }
    ).catch(() => {/* 可能没有这些容器 */});
  }

  private async waitForDomStable(page: Page, stableMs: number, timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    let lastDomHash: string;
    let lastChangeTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const currentHash = await page.evaluate(() => document.body.innerHTML.length);
      if (currentHash !== lastDomHash) {
        lastDomHash = currentHash;
        lastChangeTime = Date.now();
      } else if (Date.now() - lastChangeTime >= stableMs) {
        return; // DOM 稳定
      }
      await page.waitForTimeout(100);
    }
  }

  private async waitForNoLoadingOverlay(page: Page, timeoutMs: number): Promise<void> {
    const loadingSelectors = [
      '.ant-spin', '.el-loading-mask', '.loading',
      '[class*="loading"][style*="display: block"]',
      '[class*="spinner"]',
    ].join(', ');

    await page.waitForSelector(loadingSelectors, { state: 'hidden', timeout: timeoutMs })
      .catch(() => {/* 可能没有 loading */ });
  }
}
```

#### 表单约束提取

从 HTML 属性和 LLM 推断中提取表单验证约束，用于生成精准的边界测试：

```typescript
class FormConstraintExtractor {
  async extract(page: Page): Promise<FormConstraints> {
    return page.evaluate(() => {
      const fields = [];
      document.querySelectorAll('input, select, textarea').forEach(el => {
        const label = document.querySelector(`label[for="${el.id}"]`)?.textContent
          || el.getAttribute('placeholder')
          || el.getAttribute('aria-label')
          || '';

        fields.push({
          name: el.name || el.id,
          label: label.trim(),

          // HTML 原生约束
          type: el.type,
          required: el.required || el.hasAttribute('required'),
          minLength: el.minLength >= 0 ? el.minLength : undefined,
          maxLength: el.maxLength > 0 ? el.maxLength : undefined,
          pattern: el.pattern || undefined,
          min: el.min || undefined,
          max: el.max || undefined,
          step: el.step || undefined,
          multiple: el.multiple || undefined,
          accept: el.accept || undefined,

          // 当前值和验证状态
          currentValue: el.value,
          validationMessage: el.validationMessage || undefined,
          isValid: el.checkValidity(),
        });
      });
      return { fields };
    });
  }

  // 结合 LLM 从 label 推断业务约束（HTML 属性拿不到的）
  async inferBusinessConstraints(fields: FormField[]): Promise<BusinessConstraint[]> {
    return this.llm.call('constraint_inference', {
      prompt: `
        根据表单字段信息，推断可能的业务验证约束。
        输出: { fieldName, constraint, testValues }
        例如: { fieldName: "phone", constraint: "中国手机号", testValues: ["13800138000", "12345", "abc", "138001380001234"] }
      `,
      data: fields,
    });
  }
}
```

---
### 6.11 自愈机制

Agent 在遇到自身故障时能自动恢复并继续测试，分三层实现。

#### 自愈层级

```
Layer 1: 测试级自愈（v1，已融入各模块）
  Selector 失效 → 重新分析组件 → 更新 selector → 重试
  导航路径失败 → 重新探索 → 生成新路径
  认证过期 → AuthSessionManager 自动重登录
  页面加载超时 → PageLoadDetector 等待更久 / 刷新重试
  编译用例失败 → 判断是 UI 变了还是真 bug → 分别处理

Layer 2: Agent 级自愈（v1，本节新增）
  LLM 输出畸形 → Zod 验证失败 → 换 prompt 重试
  Agent 死循环 → 循环检测 → 打断 → 换策略
  浏览器崩溃 → 重启 Browser → 从 checkpoint 恢复
  内存溢出 → 清理缓存 → 降低并行度 → 继续

Layer 3: 代码级自愈（v2，最激进）
  Agent 自身代码 bug → LLM 读源码 + 错误上下文
  → 生成热修复补丁 → 运行时策略替换 → 继续测试
```

#### Agent 级自愈实现

```typescript
class AgentSelfHealer {
  private loopDetector: LoopDetector;
  private errorBoundary: ErrorBoundary;
  private healthMonitor: HealthMonitor;

  // 错误边界: 捕获所有操作异常，分级处理
  async executeSafely<T>(
    operation: () => Promise<T>,
    context: OperationContext
  ): Promise<T | RecoveryResult> {
    try {
      return await operation();
    } catch (error) {
      return await this.errorBoundary.handle(error, context, operation);
    }
  }
}

// 错误分级处理
class ErrorBoundary {
  async handle(error: Error, ctx: OperationContext, retry: Function): Promise<any> {
    const classification = this.classify(error);

    switch (classification) {
      case 'retryable':
        // 网络超时、临时性失败 → 退避重试
        return await this.retryWithBackoff(retry, 3, [1000, 3000, 5000]);

      case 'workaround-able':
        // Selector 失效、组件结构变了 → 换策略
        // 例如: CSS selector 失败 → 试 text selector → 试 a11y selector
        return await this.tryAlternativeStrategy(ctx, retry);

      case 'llm-malformed':
        // LLM 输出不符合 schema → 修正 prompt 重试
        return await this.retryWithCorrectedPrompt(ctx, retry);

      case 'browser-crash':
        // 浏览器崩溃 → 重启 → 从 checkpoint 恢复
        await this.restartBrowser();
        await this.restoreCheckpoint(ctx.sessionId);
        return await retry();

      case 'fatal':
        // 无法恢复 → 保存状态 → 跳过 → 继续其他测试
        await this.saveCheckpoint(ctx.sessionId);
        this.logger.error(`Skipping ${ctx.operationName}: ${error.message}`);
        return { skipped: true, reason: error.message };

      default:
        return { skipped: true, reason: 'unknown' };
    }
  }

  private classify(error: Error): ErrorClass {
    if (error instanceof TimeoutError) return 'retryable';
    if (error instanceof LLMValidationError) return 'llm-malformed';
    if (error.message.includes('Target closed') || error.message.includes('Browser closed')) {
      return 'browser-crash';
    }
    if (error instanceof SelectorError) return 'workaround-able';
    return 'fatal';
  }
}

// 死循环检测
class LoopDetector {
  private recentActions: string[] = [];
  private readonly WINDOW_SIZE = 10;
  private readonly REPEAT_THRESHOLD = 6; // 10 步中 6 步相同 → 死循环

  onAction(action: ActionSummary): boolean {
    this.recentActions.push(this.hashAction(action));
    if (this.recentActions.length > this.WINDOW_SIZE) {
      this.recentActions.shift();
    }

    if (this.detectLoop()) {
      this.logger.warn('Loop detected, breaking pattern');
      this.recentActions = [];
      return true; // 通知 Agent 换策略
    }
    return false;
  }

  private detectLoop(): boolean {
    const counts = new Map<string, number>();
    for (const hash of this.recentActions) {
      counts.set(hash, (counts.get(hash) || 0) + 1);
    }
    for (const [, count] of counts) {
      if (count >= this.REPEAT_THRESHOLD) return true;
    }
    // 也检测 A→B→A→B 交替模式
    return this.detectAlternatingPattern();
  }
}

// Agent 健康监控
class HealthMonitor {
  async check(session: Session): Promise<HealthStatus> {
    return {
      memoryUsage: process.memoryUsage().heapUsed,
      browserAlive: await this.isBrowserAlive(session),
      errorRate: session.errorCount / session.totalOperations,
      loopDetected: session.loopDetector.hasLoop(),
      llmQuotaRemaining: await this.llmRouter.getRemainingQuota(),
    };
  }

  // 健康降级策略
  async degrade(session: Session, status: HealthStatus): Promise<void> {
    if (status.memoryUsage > 1.5 * 1024 * 1024 * 1024) {
      // 内存超过 1.5GB → 清理截图缓存 → GC
      await session.evidenceStore.cleanup();
      global.gc?.();
    }
    if (status.errorRate > 0.3) {
      // 错误率超过 30% → 降低并行度 → 增加重试间隔
      session.config.parallel = 1;
      session.config.retryInterval = 10000;
    }
    if (!status.browserAlive) {
      await session.browserManager.restart();
      await session.restoreCheckpoint();
    }
  }
}
```

#### 代码级自愈（v2 设计预留）

Agent 自身代码有 bug 时，LLM 读源码并生成热修复补丁：

```typescript
class CodeSelfHealer {
  private strategyRegistry: StrategyRegistry;
  private patchHistory: HotPatch[] = [];

  async onUnhandledError(error: Error, context: ErrorContext): Promise<boolean> {
    // 1. 读取出错的源码
    const sourceCode = await this.readSource(error.stack);
    if (!sourceCode) return false;

    // 2. LLM 分析根因并提议修复
    const diagnosis = await this.llm.call('code_diagnosis', {
      prompt: `
        以下代码在执行时抛出异常。
        分析根因，提议最小化修复。
        输出: { rootCause, patchedFunction, explanation }
      `,
      data: {
        sourceCode,
        stackTrace: error.stack,
        recentActions: context.recentActions,
        pageState: context.lastObservation,
      },
    });

    // 3. 验证补丁安全性
    if (!this.isSafePatch(diagnosis.patchedFunction)) {
      return false;
    }

    // 4. 运行时热替换（只影响当前会话，不改磁盘文件）
    this.strategyRegistry.replace(context.strategyName, diagnosis.patchedFunction);

    // 5. 记录热修复（供人工审核）
    this.patchHistory.push({
      timestamp: Date.now(),
      strategyName: context.strategyName,
      originalCode: sourceCode,
      patchedCode: diagnosis.patchedFunction,
      rootCause: diagnosis.rootCause,
      sessionId: context.sessionId,
    });

    return true;
  }

  // 安全约束
  private isSafePatch(patchedCode: string): boolean {
    // 不允许修改文件系统
    if (patchedCode.includes('fs.write') || patchedCode.includes('require("fs")')) return false;
    // 不允许网络请求（除了已有的 LLM 调用）
    if (patchedCode.includes('fetch(') || patchedCode.includes('http.request')) return false;
    // 不允许 eval
    if (patchedCode.includes('eval(')) return false;
    // 同一策略最多修复 3 次
    if (this.getPatchCount(patchedCode) >= 3) return false;
    return true;
  }
}

// 策略注册表: 所有核心模块通过此注册表调用，支持运行时替换
class StrategyRegistry {
  private strategies = new Map<string, Function>();
  private patchCounts = new Map<string, number>();

  register(name: string, fn: Function): void {
    this.strategies.set(name, fn);
  }

  replace(name: string, newFn: Function): void {
    const count = (this.patchCounts.get(name) || 0) + 1;
    this.patchCounts.set(name, count);
    this.strategies.set(name, newFn);
    this.logger.warn(`Strategy "${name}" hot-patched (attempt ${count})`);
  }

  async call<T>(name: string, ...args: any[]): Promise<T> {
    const fn = this.strategies.get(name);
    if (!fn) throw new Error(`Strategy not found: ${name}`);
    return fn(...args);
  }
}
```

#### 自愈安全约束

```
1. 热修复只影响当前会话内存，不修改磁盘源码
2. 每次热修复记录完整 before/after 代码对比
3. 同一策略最多热修复 3 次，超过则降级（跳过该功能）
4. 会话结束后输出 HotPatchReport，人工决定是否永久合入
5. 安全检查: 热修复代码不允许文件写入、网络请求、eval
```

---
## 7. 记忆系统

### 7.1 记忆分层

```
┌────────────────────────────────────────────────┐
│             Memory Store (SQLite)               │
├────────────────────────────────────────────────┤
│                                                │
│  ┌──────────────┐  应用记忆（per target）        │
│  │ AppMemory     │                              │
│  │               │  ├── UI Model               │
│  │               │  ├── Tested Items           │
│  │               │  ├── Historical Bugs         │
│  │               │  ├── Inferred Axioms         │
│  │               │  └── Compressed Sessions      │
│  └──────────────┘                              │
│                                                │
│  ┌──────────────┐  跨应用记忆（全局）           │
│  │ GlobalMemory  │                              │
│  │               │  ├── UI Patterns             │
│  │               │  ├── Effective Strategies     │
│  │               │  └── Component Signatures     │
│  └──────────────┘                              │
│                                                │
│  ┌──────────────┐  会话记忆（per session）      │
│  │ SessionMemory │                              │
│  │               │  ├── Action History          │
│  │               │  ├── Current Plan            │
│  │               │  └── Working Context         │
│  └──────────────┘                              │
│                                                │
└────────────────────────────────────────────────┘
```

### 7.2 应用记忆

```typescript
interface AppMemory {
  targetId: string;

  // UI 组件模型（探索后构建）
  componentModel: {
    pages: PageNode[];
    components: Component[];
    interactions: Interaction[];
    navigationGraph: NavigationEdge[];
    lastUpdatedAt: number;
  };

  // 已测项追踪
  testedItems: Map<string, TestedItem>; // key: componentId:testType

  // 历史 Bug（用于回归检测）
  historicalBugs: BugReport[];

  // 推断的质量规则（越测越多）
  inferredAxioms: InferredAxiom[];

  // 已压缩的历史会话摘要
  sessionSummaries: SessionSummary[];
}

interface TestedItem {
  key: string;               // "form-123:empty-submit"
  componentId: string;
  testType: string;
  status: 'passed' | 'failed' | 'skipped';
  lastTestedAt: number;
  testCount: number;
}

interface SessionSummary {
  sessionId: string;
  startedAt: number;
  duration: number;
  pagesExplored: number;
  componentsTested: number;
  bugsFound: number;
  keyFindings: string[];     // LLM 压缩后的关键发现
  strategyUsed: string;
}
```

### 7.3 记忆继承流程

根据运行模式，加载不同范围的记忆：

```
新测试启动
       │
       ▼
读取 --mode 参数 (continue | fresh | retest | expand | regression)
       │
       ▼
┌────────────────────────────────────────────────────┐
│ mode = fresh                                        │
│ → 不加载任何记忆，等同于首次测试                      │
│ → AppMemory 在本次结束后仍会保存                      │
└────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────┐
│ mode = continue | expand | regression | retest      │
│                                                    │
│ 1. UI Model 存在?                                  │
│    ├── 是 → 快速验证模型是否过期                      │
│    │        (抽查 20% 页面，结构变化 > 30% → 增量探索)│
│    └── 否 → 执行完整探索                             │
│                                                    │
│ 2. TestedItems (根据 mode 分支)                     │
│    ├── continue → 跳过 passed 且 < 7天 的项           │
│    ├── retest  → 全部重新测试                        │
│    ├── expand  → 跳过 passed，只做增量发散             │
│    └── regression → 只测 status=failed 的项          │
│                                                    │
│ 3. HistoricalBugs                                  │
│    ├── continue | retest | expand | regression     │
│    │   → 优先回归测试所有历史 Bug 对应场景             │
│    └── fresh → 不参考                               │
│                                                    │
│ 4. InferredAxioms                                   │
│    ├── continue | retest | expand | regression     │
│    │   → 加入质量规则管道 + 验证持续有效性                 │
│    └── fresh → 不加载                               │
│                                                    │
│ 5. SessionSummaries                                 │
│    ├── continue | expand                           │
│    │   → "上次组合测试发现下拉+联动有 3 个 bug"        │
│    │   → 提高相关区域优先级                           │
│    └── regression | retest → 用于确定回归范围         │
└────────────────────────────────────────────────────┘
```

### 7.3.1 expand 模式的测试计划生成

```typescript
async function generateExpandPlan(
  componentModel: ComponentModel,
  memory: AppMemory,
  history: SessionSummary[]
): Promise<TestPlan> {
  const plan = new TestPlan();

  // 1. 回归验证所有历史 Bug
  for (const bug of memory.historicalBugs) {
    if (bug.status === 'fixed') continue;
    plan.addRegression(bug);
  }

  // 2. 识别已测过的组合，生成更深组合
  const testedCombinations = extractTestedCombos(memory);
  for (const group of findRelatedComponents(componentModel)) {
    // 上次 pairwise → 这次 3-wise
    if (group.hasHistoricalBugs) {
      plan.addNwise(group, 4);   // 发现过 bug 的区域用 4-wise
    } else {
      plan.addNwise(group, 3);   // 其他区域 3-wise
    }
  }

  // 3. 从导航图寻找未尝试的路径
  const unexploredPaths = findUnexploredPaths(componentModel.navigationGraph, memory);
  plan.addSequenceTests(unexploredPaths);

  // 4. 生成极端输入（在已测边界之上）
  for (const component of componentModel.components.filter(c => c.type === 'input')) {
    const testedBoundaries = memory.getTestedBoundaries(component.id);
    if (testedBoundaries.maxLength < 10000) {
      plan.addBoundaryTest(component, {
        length: 10000,
        type: 'unicode-extreme',
      });
    }
  }

  // 5. 生成不规则交互序列
  plan.addChaosSequences(generateIrregularSequences(componentModel, memory));

  return plan;
}
```

### 7.4 会话压缩

```typescript
class SessionCompressor {
  async compress(session: SessionData): Promise<SessionSummary> {
    // 输入: 完整的会话数据（可能几百 MB）
    // 输出: 结构化摘要（几 KB）

    const summary = await this.llm.summarize({
      prompt: `
        压缩以下测试会话数据为结构化摘要。
        保留:
        1. 所有发现的 Bug（不可丢弃）
        2. 未覆盖的功能区域
        3. 测试策略的有效性观察
        4. 推断出的 UI 模式
        5. 建议下次测试重点
        丢弃:
        1. 具体点击序列
        2. 中间截图
        3. 通过的测试详情
        4. DOM 片段
      `,
      data: session.toCompressible(),
      schema: SessionSummarySchema,
    });

    return summary;
  }
}
```

### 7.5 跨应用记忆

从多个应用的测试经验中提炼通用规律：

```typescript
interface GlobalMemory {
  // UI 模式库（从多个应用学到的）
  uiPatterns: UIPattern[];

  // 有效的测试策略（按发现 bug 的效率排序）
  effectiveStrategies: StrategyStat[];

  // 组件签名（帮助快速识别新应用中的组件）
  componentSignatures: ComponentSignature[];
}

interface StrategyStat {
  strategyName: string;
  bugsFound: number;
  testsExecuted: number;
  efficiencyScore: number;    // bugs / tests
  contexts: string[];        // 在哪类应用中有效
}

interface UIPattern {
  id: string;
  pattern: string;            // "删除操作通常有确认框"
  observedIn: string[];       // 哪些应用中观察到
  reliability: number;         // 观察一致率
  lastSeenAt: number;
}
```

---

## 8. 模型路由

### 8.1 分阶段模型配置

```yaml
# config.yaml
models:
  # 每个功能路由可用不同模型
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
    ollama:
      baseUrl: http://localhost:11434

  routing:
    # 组件识别（大量调用，需要结构化输出）
    component_identify:
      provider: anthropic
      model: claude-sonnet-4
      temperature: 0
      maxTokens: 2000

    # 探索路径决策（大量调用，简单决策）
    exploration_decide:
      provider: openai
      model: gpt-4o-mini
      temperature: 0

    # 质量规则推理和缺陷判定（少量调用，需要强推理）
    axiom_reasoning:
      provider: openai
      model: o1
      temperature: 1
      maxTokens: 4000

    # 视觉分析（需要视觉模型）
    visual_analysis:
      provider: openai
      model: gpt-4o
      temperature: 0

    # 模式归纳和质量规则推断（少量，需要强推理）
    pattern_inference:
      provider: anthropic
      model: claude-sonnet-4
      temperature: 0.2

    # 记忆压缩（定期，中等需求）
    memory_compression:
      provider: anthropic
      model: claude-haiku-3-5
      temperature: 0

    # 报告生成（一次，需要好文笔）
    report_generation:
      provider: anthropic
      model: claude-sonnet-4
      temperature: 0.3
```

### 8.2 LLM Router 实现

```typescript
class LLMRouter {
  private providers: Map<string, LLMProvider>;

  async call(taskType: TaskType, messages: Message[], schema?: ZodSchema): Promise<any> {
    const config = this.routing[taskType];
    const provider = this.providers.get(config.provider);

    const response = await provider.chat({
      model: config.model,
      messages,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      tools: schema ? this.schemaToTools(schema) : undefined,
    });

    if (schema) {
      return schema.parse(response);  // 验证输出
    }
    return response;
  }
}
```

---

## 9. 插件系统

简化插件架构：只支持 Tool 插件和 MCP Client，不支持领域插件、感知器插件、插件市场。插件从本地 `plugins/` 目录自动加载。

### 9.1 插件协议

```typescript
interface WtaPlugin {
  name: string;
  version: string;
  description: string;

  // 只支持 Tool 插件
  provides: {
    tools: ToolDefinition[];
  };

  onInit(ctx: PluginContext): Promise<void>;
  onDestroy?(): Promise<void>;
}

interface ToolDefinition {
  name: string;                // 工具名，Agent 可调用
  description: string;         // 什么时候用这个工具
  parameters: ZodSchema;       // 参数 schema
  execute: (params: any, ctx: ToolContext) => Promise<any>;
}

interface PluginContext {
  logger: Logger;
  registerTool(tool: ToolDefinition): void;
}
```

### 9.2 本地插件加载

```typescript
class PluginLoader {
  // 扫描 plugins/ 目录，自动加载所有合法插件
  async loadAll(pluginDir: string): Promise<WtaPlugin[]> {
    const entries = await fs.readdir(pluginDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(pluginDir, entry.name, 'package.json');

      if (await fs.pathExists(manifestPath)) {
        const plugin = await this.load(manifestPath);
        await plugin.onInit(this.context);
      }
    }
  }
}
```

### 9.3 插件示例（API 调用工具）

```typescript
// plugins/api-tester/index.ts
import { z } from 'zod';

export default {
  name: 'api-tester',
  version: '1.0.0',
  description: '提供 API 调用能力，用于验证前端显示与后端数据一致性',

  provides: {
    tools: [
      {
        name: 'api_call',
        description: '调用目标系统的 API',
        parameters: z.object({
          method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
          url: z.string().url(),
          body: z.record(z.any()).optional(),
        }),
        execute: async (params, ctx) => {
          const response = await fetch(params.url, {
            method: params.method,
            headers: ctx.session.authHeaders,
            body: params.body ? JSON.stringify(params.body) : undefined,
          });
          return { status: response.status, data: await response.json() };
        },
      },
    ],
  },

  async onInit(ctx) {
    ctx.logger.info('API tester plugin loaded');
  },
};
```

### 9.4 MCP Client

Agent 可以连接外部 MCP Server，将其工具纳入 Agent 可用工具集：

```typescript
class MCPClient {
  async connect(serverUrl: string): Promise<ToolDefinition[]> {
    const mcpServer = await connect(serverUrl);
    const mcpTools = await mcpServer.listTools();

    // 转换为内部 ToolDefinition 格式
    return mcpTools.map(tool => ({
      name: `mcp:${tool.name}`,
      description: tool.description,
      parameters: this.convertSchema(tool.inputSchema),
      execute: async (params) => {
        return await mcpServer.callTool(tool.name, params);
      },
    }));
  }
}
```

不将 Agent 暴露为 MCP Server（个人工具，无外部调用需求）。

---
## 10. 数据模型

### 10.1 SQLite Schema

```sql
-- 测试目标
CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 测试会话
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id),
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  phase TEXT,
  progress_json TEXT,
  checkpoint_json TEXT,
  FOREIGN KEY (target_id) REFERENCES targets(id)
);

-- 页面节点
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  url_pattern TEXT NOT NULL,
  title TEXT,
  role TEXT,
  first_seen_at INTEGER,
  last_visited_at INTEGER,
  visit_count INTEGER DEFAULT 0,
  test_status TEXT DEFAULT 'untested',
  UNIQUE(target_id, url_pattern)
);

-- 组件
CREATE TABLE components (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  type TEXT NOT NULL,
  selector TEXT NOT NULL,
  label TEXT,
  state_json TEXT,
  constraints_json TEXT,
  parent_id TEXT REFERENCES components(id),
  confidence REAL,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 交互
CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(id),
  action_type TEXT NOT NULL,
  preconditions_json TEXT,
  expected_effects_json TEXT,
  side_effects_json TEXT
);

-- 导航边
CREATE TABLE navigation_edges (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  from_page_id TEXT NOT NULL REFERENCES pages(id),
  to_page_id TEXT NOT NULL REFERENCES pages(id),
  trigger_component_id TEXT REFERENCES components(id),
  method TEXT
);

-- 测试结果
CREATE TABLE test_results (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  component_id TEXT,
  test_type TEXT NOT NULL,
  status TEXT NOT NULL,
  axiom_id TEXT,
  input_json TEXT,
  output_json TEXT,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER
);

-- Bug 报告
CREATE TABLE bugs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  target_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  page_url TEXT,
  component_id TEXT,
  axiom_id TEXT,
  reproduction_json TEXT,
  expected TEXT,
  actual TEXT,
  evidence_json TEXT,
  detected_at INTEGER NOT NULL,
  status TEXT DEFAULT 'open'
);

-- 记忆：已测项
CREATE TABLE memory_tested_items (
  target_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  component_id TEXT NOT NULL,
  test_type TEXT NOT NULL,
  status TEXT NOT NULL,
  last_tested_at INTEGER NOT NULL,
  test_count INTEGER DEFAULT 1,
  PRIMARY KEY (target_id, item_key)
);

-- 记忆：推断质量规则
CREATE TABLE memory_axioms (
  id TEXT PRIMARY KEY,
  target_id TEXT,  -- NULL = 跨应用
  statement TEXT NOT NULL,
  confidence REAL NOT NULL,
  positive_count INTEGER DEFAULT 0,
  negative_count INTEGER DEFAULT 0,
  check_code TEXT,     -- 可序列化的检查逻辑
  learned_at INTEGER,
  last_validated_at INTEGER
);

-- 记忆：UI 模式
CREATE TABLE memory_patterns (
  id TEXT PRIMARY KEY,
  target_id TEXT,  -- NULL = 跨应用
  pattern TEXT NOT NULL,
  observed_in TEXT,
  reliability REAL,
  last_seen_at INTEGER
);

-- 记忆：会话摘要
CREATE TABLE memory_session_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 导航宏（编译的导航路径）
CREATE TABLE navigation_macros (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  url TEXT,
  selector TEXT,
  cached_at INTEGER NOT NULL,
  valid INTEGER DEFAULT 1
);

-- 编译用例（测试通过后自动生成）
CREATE TABLE compiled_test_cases (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  test_type TEXT NOT NULL,
  navigation_macro_id TEXT REFERENCES navigation_macros(id),
  actions_json TEXT NOT NULL,
  assertions_json TEXT NOT NULL,
  timeout INTEGER DEFAULT 30000,
  last_passed_at INTEGER,
  execute_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 组件签名库（组件模型进化）
CREATE TABLE component_signatures (
  id TEXT PRIMARY KEY,
  component_name TEXT NOT NULL,
  dom_pattern TEXT,
  a11y_pattern TEXT,
  visual_pattern TEXT,
  confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'learned',
  observed_in TEXT,          -- JSON array of app names
  usage_count INTEGER DEFAULT 0,
  last_used_at INTEGER
);

-- 截图和证据文件
CREATE TABLE evidence_files (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  bug_id TEXT,
  file_type TEXT NOT NULL,  -- 'screenshot' | 'video' | 'network' | 'dom'
  file_path TEXT NOT NULL,
  created_at INTEGER
);
```

---

## 11. 目录结构

```
webtest-agent/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docs/
│   └── DESIGN.md                 # 本文档
│
├── vendor/
│   └── browsers/                 # 构建时打包的浏览器（随项目分发）
│       ├── chromium/             # Chromium 固定版本
│       └── firefox/              # Firefox (可选)
│
├── packages/
│   ├── core/                     # Agent 核心逻辑
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── orchestrator/     # 调度器
│   │   │   │   ├── Orchestrator.ts
│   │   │   │   ├── Session.ts
│   │   │   │   ├── StateMachine.ts
│   │   │   │   └── Checkpoint.ts
│   │   │   ├── explorer/         # 探索引擎
│   │   │   │   ├── Explorer.ts
│   │   │   │   ├── BFSStrategy.ts
│   │   │   │   └── NavigationGraph.ts
│   │   │   ├── tester/           # 测试引擎
│   │   │   │   ├── ComponentTester.ts
│   │   │   │   ├── CombinationTester.ts
│   │   │   │   ├── ChaosTester.ts
│   │   │   │   └── TestCaseGenerator.ts
│   │   │   ├── perception/       # 感知层
│   │   │   │   ├── PerceptionRouter.ts
│   │   │   │   ├── DOMPerceiver.ts
│   │   │   │   ├── VisualPerceiver.ts
│   │   │   │   └── FusedPerceiver.ts
│   │   │   ├── cognition/        # 认知层
│   │   │   │   ├── ComponentModel.ts
│   │   │   │   ├── ComponentIdentifier.ts
│   │   │   │   ├── AxiomEngine.ts
│   │   │   │   └── PatternInference.ts
│   │   │   ├── detection/        # 检测层
│   │   │   │   ├── BugDetector.ts
│   │   │   │   ├── NetworkErrorDetector.ts
│   │   │   │   ├── ConsoleErrorDetector.ts
│   │   │   │   └── VisualAnomalyDetector.ts
│   │   │   ├── memory/           # 记忆系统
│   │   │   │   ├── MemoryStore.ts
│   │   │   │   ├── AppMemory.ts
│   │   │   │   ├── GlobalMemory.ts
│   │   │   │   ├── SessionCompressor.ts
│   │   │   │   └── MemoryInheritance.ts
│   │   │   ├── llm/              # 模型路由
│   │   │   │   ├── LLMRouter.ts
│   │   │   │   ├── providers/
│   │   │   │   │   ├── OpenAIProvider.ts
│   │   │   │   │   ├── AnthropicProvider.ts
│   │   │   │   │   └── OllamaProvider.ts
│   │   │   │   └── schemas/      # LLM 输出 Zod schema
│   │   │   ├── plugin/           # 插件系统
│   │   │   │   ├── PluginRegistry.ts
│   │   │   │   ├── PluginLoader.ts
│   │   │   │   └── types.ts
│   │   │   ├── reporter/         # 报告引擎
│   │   │   │   ├── Reporter.ts
│   │   │   │   ├── MarkdownFormatter.ts
│   │   │   │   └── JSONFormatter.ts
│   │   │   ├── compiler/         # 测试编译系统
│   │   │   │   ├── TestCompiler.ts
│   │   │   │   ├── NavigationMacroBuilder.ts
│   │   │   │   ├── CompiledRunner.ts
│   │   │   │   └── MacroValidator.ts
│   │   │   ├── evolution/        # 自进化系统
│   │   │   │   ├── ComponentModelEvolver.ts
│   │   │   │   ├── QualityRuleEvolver.ts
│   │   │   │   └── SignatureStore.ts
│   │   │   ├── healing/          # 自愈系统
│   │   │   │   ├── AgentSelfHealer.ts
│   │   │   │   ├── ErrorBoundary.ts
│   │   │   │   ├── LoopDetector.ts
│   │   │   │   ├── HealthMonitor.ts
│   │   │   │   └── CodeSelfHealer.ts   # v2 代码级热修复
│   │   │   ├── browser/          # Playwright 封装（指向 vendor/browsers）
│   │   │   │   ├── BrowserManager.ts
│   │   │   │   ├── AuthHandler.ts
│   │   │   │   └── NetworkMonitor.ts
│   │   │   └── db/               # 数据库
│   │   │       ├── Database.ts
│   │   │       ├── migrations/
│   │   │       └── repositories/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── cli/                      # CLI 入口
│   │   ├── src/
│   │   │   ├── index.ts          # 入口
│   │   │   ├── commands/
│   │   │   │   ├── init.ts
│   │   │   │   ├── target.ts
│   │   │   │   ├── run.ts
│   │   │   │   ├── attach.ts
│   │   │   │   ├── status.ts
│   │   │   │   ├── stop.ts
│   │   │   │   ├── report.ts
│   │   │   │   ├── memory.ts
│   │   │   │   ├── plugin.ts
│   │   │   │   ├── config.ts
│   │   │   │   ├── model.ts
│   │   │   │   └── gui.ts
│   │   │   ├── attach-ui/         # wta attach 终端界面
│   │   │   │   ├── AttachUI.ts
│   │   │   │   └── components/
│   │   │   └── utils/
│   │   │       ├── ipc.ts         # 与 Daemon 通信
│   │   │       ├── formatting.ts
│   │   │       └── prompt.ts
│   │   ├── bin/wta.js
│   │   └── package.json
│   │
│   └── gui/                      # GUI 前端和后端
│       ├── server/               # GUI 后端
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── routes/
│       │   │   │   ├── targets.ts
│       │   │   │   ├── sessions.ts
│       │   │   │   ├── reports.ts
│       │   │   │   ├── memory.ts
│       │   │   │   └── settings.ts
│       │   │   └── ws/
│       │   │       └── agent-events.ts
│       │   └── package.json
│       ├── web/                  # React 前端
│       │   ├── src/
│       │   │   ├── App.tsx
│       │   │   ├── pages/
│       │   │   │   ├── Dashboard.tsx
│       │   │   │   ├── Targets.tsx
│       │   │   │   ├── Monitor.tsx
│       │   │   │   ├── Reports.tsx
│       │   │   │   ├── Memory.tsx
│       │   │   │   └── Settings.tsx
│       │   │   ├── components/
│       │   │   └── hooks/
│       │   │       └── useAgentEvents.ts
│       │   └── package.json
│       └── package.json
│
├── plugins/                      # 内置插件
│   ├── form-validation/
│   ├── table-testing/
│   └── responsive-testing/
│
└── examples/
    └── sample-target.yaml
```

---

## 12. 实施计划

### Phase 1: 基础框架（v0.1）

**目标**: CLI 骨架 + 基础 Agent 循环跑通

- [ ] pnpm monorepo 初始化
- [ ] `packages/core` 基础结构
- [ ] `packages/cli` commander 骨架
- [ ] `wta init / install browsers / doctor` 可执行
- [ ] `wta target add / run --phase explore` 可执行
- [ ] Playwright 浏览器自动下载和启动（.wta/browsers）
- [ ] 登录流程
- [ ] headless / headed 模式切换
- [ ] ErrorBoundary + 循环检测基础框架
- [ ] DOM 感知器（A11y Tree 获取）
- [ ] LLM Router（OpenAI + Anthropic 双 Provider）
- [ ] 组件识别（Layer 1 规则匹配，不含 LLM）
- [ ] SQLite 数据库初始化和基础表
- [ ] 日志系统

### Phase 2: 探索与组件建模（v0.2）

**目标**: 完整 组件模型构建

- [ ] BFS 页面探索策略
- [ ] LLM 组件识别（不确定节点走 LLM）
- [ ] UI Model 完整构建和持久化
- [ ] 导航图生成
- [ ] `wta attach` 实时终端界面
- [ ] `wta status / stop`
- [ ] 断点保存和恢复

### Phase 3: 测试引擎与覆盖保证（v0.3）

**目标**: 能跑真实的组件测试 + 可证明的覆盖率

- [ ] 结构化感知器（自定义提取脚本 + a11y 树合并）
- [ ] 组件模型两层分类（内置规则 + 签名库匹配）
- [ ] 质量规则引擎（三层：内置规则 / 学习规则 / LLM 即时判断）
- [ ] 6 条内置质量规则实现
- [ ] Frontier Queue（探索穷尽的形式化判定）
- [ ] ComponentRevealer（手风琴/Tab/弹框/悬停/滚动/下拉揭示）
- [ ] StateCoverageManager（数据状态管理：空/单条/多条/分页/筛选）
- [ ] TestDataLifecycle（测试数据创建追踪与清理）
- [ ] 组件测试用例生成（含表单约束提取）
- [ ] 测试执行器
- [ ] Bug 检测器（规则违反 + 网络错误 + Console 错误）
- [ ] 截图采集
- [ ] Bug 报告数据结构
- [ ] 导航宏缓存（NavigationMacro）
- [ ] 编译用例生成（测试通过后自动编译）
- [ ] 编译用例直接执行（不调 LLM）
- [ ] 编译用例失败时的重分析逻辑
- [ ] PageLoadDetector（SPA 加载完成判断：网络空闲 + DOM 稳定 + 无 loading）
- [ ] AuthSessionManager（认证过期检测与自动重连）
- [ ] AgentSelfHealer 完整实现（错误分级、浏览器重启恢复、健康监控降级）
- [ ] HotPatchReport（会话结束输出热修复报告，v2 代码级自愈预留接口）

### Phase 4: 记忆与自进化（v0.4）

**目标**: 跨会话记忆 + 组件模型/质量规则自进化

- [ ] AppMemory 完整实现
- [ ] TestedItems 追踪
- [ ] 记忆继承（跳过已测、优先历史 Bug）
- [ ] 会话压缩（LLM）
- [ ] `wta memory` CLI 命令
- [ ] 质量规则学习（从观察归纳，置信度加权）
- [ ] 组件签名库（跨应用组件识别迁移）
- [ ] 质量规则进化：置信度调整 + 晋升 + 自动退休
- [ ] 跨应用记忆（UI Patterns、Strategy Stats）

### Phase 5: 报告系统（v0.5）

**目标**: 专业级报告输出

- [ ] Markdown 报告生成器
- [ ] JSON 机器可读报告
- [ ] CoverageReport（7 个维度的覆盖矩阵 + limitations 说明）
- [ ] Bug 去重
- [ ] `wta report` CLI 完整实现
- [ ] 退出码（CI/CD 集成）

### Phase 6: GUI（v0.6）

**目标**: Web 管理界面

- [ ] CLI 内嵌 API Server（同 CLI 命令调用同一 Core API）
- [ ] WebSocket 实时事件推送
- [ ] React 前端（Vite + TS）
- [ ] Dashboard 页面
- [ ] Monitor 实时监控页面（截图流 + 日志流 + Bug 列表）
- [ ] Targets 管理页面
- [ ] Reports 浏览页面
- [ ] Memory 浏览页面
- [ ] Settings 页面

### Phase 7: 插件系统（v0.7）

**目标**: 最小可用的工具扩展

- [ ] Tool 插件协议定义
- [ ] 本地 plugins/ 目录自动加载
- [ ] `wta plugin list/enable/disable` CLI 命令
- [ ] 内置示例插件（api-tester）

### Phase 8: 深度测试与并行（v0.8）

**目标**: 组合覆盖、发散测试、并行浏览器

- [ ] 关联组件发现（同 Form / 同 Modal / 联动字段 / 历史关联）
- [ ] IPOG Covering Array 算法（pairwise / n-wise 组合生成）
- [ ] CombinationCoverageTracker（覆盖验证与报告）
- [ ] PathCoverageTracker（K 步序列覆盖追踪）
- [ ] NetworkFaultInjector（网络拦截：500 / 断网 / 慢响应 / 超时）
- [ ] expand 模式（发散测试：组合加深、序列探索、状态扩散、边界推进）
- [ ] parallel 并行浏览器（按一级路由分区，多 Worker 同时测试）
- [ ] Linux headless 支持（无 Docker，直接 `wta install deps` + `wta run --headless`）

### Phase 9: MCP Client（v0.9）

**目标**: 外部工具生态接入

- [ ] MCP Client 实现（连接外部 MCP Server，工具注册）

### Phase 10: 打磨与发布（v1.0）

**目标**: 生产可用

- [ ] 24h 稳定性测试
- [ ] 完整文档和使用指南
- [ ] 错误恢复和边界处理
- [ ] 性能优化（并行 Worker 内存控制、截图文件清理）
- [ ] npm 发布准备

---
## 13. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 登录页有验证码/2FA | Agent 无法进入 | 支持 cookie 注入、手动登录后续接管 |
| SPA 路由变化 | 页面识别失败 | URL 模式化 + 组件指纹匹配 |
| 组合爆炸 | 测试时间不可控 | 优先级排序 + 时间预算 + 断点恢复 |
| LLM 输出不稳定 | 组件识别错误 | Zod schema 验证 + 重试 + 置信度阈值 |
| 测试覆盖不足 | 隐蔽 bug 逃逸 | 强制 100% 覆盖率 CI 门禁，未达标不允许合并 |
| 日志量过大 | 数据库膨胀 | 按天归档 + 压缩 + 会话结束后清理非关键日志 |
| 中文描述不一致 | 用户体验差 | 统一使用 i18n 模块管理所有中文文案 |
| 目标系统慢 | 超时频繁 | 自适应等待 + 可配置超时 |
| 记忆膨胀 | 数据库过大 | 会话压缩 + 定期归档 + 截图文件清理 |
| 误报 | 报告不可信 | 证据链要求 + 人工确认标记 + Bug 去重 |

---

## 附录 A: 术语表

| 术语 | 定义 |
|------|------|
| 组件模型 | 页面、组件、控件、交互的类型和关系，用于指导测试策略生成 |
| 质量规则 | 定义"正确行为"的可验证规则，用于判定操作是否产生缺陷 |
| 感知路由 | 根据任务类型决定使用结构化提取、截图视觉还是双通道混合分析 |
| 记忆继承 | 新测试会话自动加载历史记忆，跳过已测项，应用已学模式 |
| 学习到的质量规则 | Agent 在测试过程中归纳出的应用特定行为规律 |
| 编译用例 | 测试通过后自动生成的可复用 Playwright 脚本（含精确 selector 和断言） |
| Frontier Queue | 探索穷尽的形式化判定机制：(页面, 组件, 操作) 队列为空即穷尽 |
| Covering Array | 用 IPOG 算法生成的最小测试集合，数学保证 n-wise 组合全覆盖 |
| 揭示策略 | 在扫描组件前系统性地展开手风琴、切换 Tab、打开弹框等隐藏内容 |
| n-wise 测试 | 组合测试方法，确保任意 n 个参数的所有取值组合至少被测试一次 |
| MCP | Model Context Protocol，AI 工具的标准通信协议 |
