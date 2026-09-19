# WebTestAgent

面向复杂业务 Web 界面的自主深度测试代理。给定 URL、测试账号和策略后，Agent 使用项目内置 Playwright 浏览器探索页面、提取组件、执行动作与组合测试、记录完整时间线，并输出中文 Markdown 与机器可读 JSON 报告。

## 已实现能力

- CLI 是核心入口；`wta gui` 提供同一常驻 Agent 的本地可视化控制台。
- 项目内置浏览器存放在 `vendor/browsers`，不依赖用户安装的 Chrome。Linux 无头模式使用对应 Linux Chromium 包，系统依赖可通过 `wta install deps` 安装。
- 自定义 DOM/CSS 结构化提取脚本识别按钮、表单、下拉、弹框、手风琴、标签页、表格等组件；截图作为按需视觉补充通道。
- BFS 页面探索、逐组件动作覆盖、n-wise 组合覆盖、路径覆盖与深度网络故障注入。不可见或禁用控件会记录为受阻覆盖，绝不浪费动作超时。
- `continue`、`fresh`、`retest`、`expand`、`regression` 重跑策略与跨会话记忆。
- 多浏览器上下文并行执行，最多 8 个 Worker。
- 登录状态复用、验证码/2FA 人工接管、插件与 MCP 客户端扩展、模型按任务路由。
- 每步脚本、模型、系统和用户操作均写入 SQLite 审计时间线；GUI 默认展示摘要，可展开请求、响应、参数、结果与截图。
- 受控自愈：浏览器崩溃自动重启；代码修复默认仅诊断和建议，自动补丁必须通过高风险审查、构建和测试验证，否则回滚。

## 快速开始

```bash
git clone https://github.com/ai-xinshijie/webtest-agent.git
cd webtest-agent
pnpm install
pnpm build

# 使用仓库内 CLI；发布为包后可直接使用 wta
node packages/cli/bin/wta.js init .
node packages/cli/bin/wta.js target add --name demo --url https://demoqa.com/text-box --username test --password test
node packages/cli/bin/wta.js run demo --mode fresh --headless
```

默认 `run` 会提交到常驻代理。常用操作：

```bash
wta gui                         # 启动 GUI 和常驻代理
wta status --all                # 查看会话，包括历史会话
wta attach <session-id>         # 在终端查看实时日志
wta stop <session-id>           # 停止一个会话
wta stop --all                  # 停止全部活动会话
wta run demo --foreground       # 前台运行，便于本地调试
```

## 重跑与发散

| 模式 | 命令 | 行为 |
|---|---|---|
| `continue` | `wta run demo` | 继承已测项和记忆，只执行未完成项目 |
| `fresh` | `wta run demo --mode fresh` | 清空目标记忆并重新探索、测试 |
| `retest` | `wta run demo --mode retest` | 保留模型与经验，但重做全部动作 |
| `expand` | `wta run demo --mode expand --phase combo` | 跳过已有成功动作，优先新增组合与路径 |
| `regression` | `wta run demo --mode regression` | 聚焦历史失败项与问题区域 |

组合空间无限大时不存在数学意义上的“绝对穷尽”。本项目对小空间执行全组合；大空间执行有界 t-way 覆盖、路径覆盖和预算化发散。报告会分别列出动作、组合、路径的已覆盖、受阻和待覆盖数，不能用单一百分比掩盖边界。

## 登录与认证

自动登录可处理普通用户名密码表单。检测到验证码或二次验证时，Agent 不会尝试绕过，改为要求人工取得合法状态：

```bash
wta auth capture demo
wta auth import demo ./storage-state.json
wta auth export demo -o ./demo-auth-state.json
```

认证状态保存在 `.wta/auth/<target>.json`；新会话优先加载该状态。

## 模型与扩展

模型按任务路由，文本推理和视觉分析可以配置不同模型：

```bash
wta model list
wta model set quality-reasoning --provider custom --model your-reasoner --base-url https://example.test/v1
wta model set visual-analysis --provider custom --model your-vision-model --base-url https://example.test/v1
wta plugin create api-tester
wta mcp list
```

“本体/公理”在实现中不是独立的复杂推理系统。可迁移的通用知识以组件签名、质量规则和记忆模式存储；目标系统的实际事实以页面、组件、交互与导航图存储。两者均可从观察和会话结果积累，但通用规则需要置信度与证据，不能由模型任意改写。

## 报告、日志与目录

每个完成或失败会话都会在 `.wta/reports` 生成：

- `report-<session>.md`：中文测试报告、问题清单、覆盖快照、代码自愈与时间线。
- `report-<session>.json`：中文键名的机器可读结构化报告。

运行数据位于 `.wta/`：目标配置、认证状态、会话、SQLite 数据库、报告、截图、视频和本地插件均只保留在本机。

## 验证

```bash
pnpm build
pnpm test
```

CI 对构建和四维覆盖率执行 100% 门禁。浏览器二进制由 Git LFS 管理，克隆时请启用 Git LFS。
