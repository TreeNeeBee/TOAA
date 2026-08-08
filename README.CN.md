<p align="center">
  <img src="docs/assets/xcompiler-icon.png" alt="XCompiler logo" width="128" height="128" />
</p>

<h1 align="center">XCompiler</h1>

<p align="center">
  <strong>AI 软件工厂运行时</strong>
</p>

> 通过迭代式 V 模型流程，把自然语言需求转成可运行、可测试、可交付的 Python 或 TypeScript 工程。

<p align="center">
  <a href="https://www.npmjs.com/package/@xcompiler/cli"><img src="https://img.shields.io/npm/v/@xcompiler/cli.svg" alt="npm package" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 license" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg" alt="Node.js >= 24" /></a>
</p>

语言: [EN](README.md) (默认) · **简体中文**

---

## XCompiler 做什么

XCompiler 是一个可复用的 AI 软件工厂运行时。它先把产品需求编译成可执行工程计划，再用受沙盒约束的多 Agent、受控工具、测试门禁、Debug 回退、审计日志和可恢复工程状态来执行计划。

| 命令 | 定位 | 输入 | 输出 |
|---|---|---|---|
| `xcompiler build` | 把需求编译成 `phasePlan.json` 和当前阶段计划，例如 `plan.P1.json` | 需求文本（`-i req.md`、`-t topic.md` 或交互输入） | `topic.md`、`phasePlan.json`、`plan.P1.json`、`plan.md`、`<name>.xc` |
| `xcompiler run` | 按 V 模型执行当前阶段 | `phasePlan.json` | 可运行工程、测试、文档、审计、更新后的进度 |
| `xcompiler load` | 从工程文件恢复 | `<name>.xc` | 继续保存的阶段/任务状态 |
| `xcompiler append` / `xcompiler evolve` | 在已有工程上追加需求 | 现有 workspace/工程文件 + 新需求 | 增量计划和实现 |
| `xcompiler acp` | 作为 ACP Code Agent Adapter 运行 | IDE/Editor 通过 stdio JSON-RPC 调用 | 基于 Runtime 的代码代理事件和结果 |

当前架构中，**Runtime 是唯一业务入口**。CLI 和 ACP 都只是 Adapter：负责解析输入、加载配置、渲染输出、监听 Runtime 事件；Build/Run/Workflow/Agent/Tool/Plugin/Memory 等业务能力统一由 Runtime 提供。

---

## 迭代式 V 模型流程

XCompiler 把 Phase 迭代模型和 V 模型结合起来。Planner 先生成总览级 `phasePlan.json`，再只展开当前阶段为具体 `plan.P<N>.json`。每个当前阶段都执行完整 V 模型；迭代门禁和工程审计通过后标记为 `complete`，再激活首个依赖已满足的阶段，并且只为下一次运行生成该阶段计划。

<p align="center">
  <img src="docs/assets/iterative-v-model-pipeline.svg" alt="Iterative V-Model Pipeline" />
</p>

V 模型行为：

- 每个 Phase 固定包含八个领域 Step：需求分析、概要设计、详细设计、编码、单元测试、集成测试、系统测试、验收测试。
- Planner JSON 是不可变的执行规格，不再保存运行状态。Runtime 将其编译为领域对象，只有这些对象持有生命周期状态。每个对象都带同一套 envelope —— UUIDv7 `id`、`objectType`、`projectId`、`revision` 和时间戳 —— 并统一经对象注册表提交：Project、ProjectPlan/PhasePlan、Phase、Step、Ticket、ActorRegistration、TicketAssignment、TicketTraceEvent、ProjectManagementPlan、Decision、Risk、InteractionRequest、KPI、QualityAssessment、Changelist、Checkpoint、Deliverable、Report、Log、AuditEvent 和 DomainEvent。
- 需求分析、概要设计、详细设计、编码会同步生成对应的验收、系统、集成、单元测试计划和可执行用例。
- `HIGH_LEVEL_DESIGN` 定义系统级接口、外部 API、第三方库选型和依赖确认。
- `DETAILED_DESIGN` 定义模块内部结构和具体实现方案。
- Ticket 类型固定为 `epic`、`story`、`task`、`bug`、`enhancement`、`change-request`。展示名如 `P1-S004` 只用于阅读，所有关系都使用全局 ID。
- 测试或执行失败创建 Bug，并路由到配对的上游 Step；完成度、对齐度或覆盖指标不足创建 Enhancement。
- 上游修复先形成 CR，携带契约差异、影响 Step/产物、实施方案、changelist、commit 和验证门禁；下游只实施增量变化。
- CR 下游失败会创建关联 Bug 并阻塞父 CR；配对源 Step 修复和子 CR 验证通过后，只恢复父 CR 尚未完成的应用步骤。
- Bug 只有在所有受影响 CR 门禁通过、方案被验证并写入 Debug Wiki 后才关闭。失败的历史方案会标记为待复核。
- 已完成阶段的 Debug 必须提供真实 patch/rewrite 或成功验证证据。
- 网络/API 调用失败是正式门禁：项目 API 失败时必须修复或切换可用 API，不能跳过或掩盖。

---

## 系统架构

<p align="center">
  <img src="docs/assets/system-architecture.svg" alt="XCompiler System Architecture" />
</p>

各层职责：

- **Adapters**：参数/协议解析、配置加载、用户交互、输出渲染、Exit Code。
- **Runtime**：Runtime API、Build Service、Run Service、Event Stream、Permission Broker，是唯一业务入口。
- **Workflow and planning**：Planner 草案、领域图编译、Phase 迭代、V 模型依赖调度、失败路由、质量门禁、交付和精确恢复。
- **State policy**：领域对象是唯一运行真相；Planner 文件不含执行状态，Adapter 和 Agent 不得直接修改持久化生命周期。
- **Agents / Skills**：每个阶段的角色化 prompt 与工具白名单。
- **Tools**：文件编辑、程序/测试执行、API fetch、依赖修改、git 快照，全部受门禁约束。
- **LLM Router**：角色链、动态评分、cluster fallback、OpenAI-compatible/Ollama 客户端、审计。
- **Workspace**：Planner 计划文件、`<name>.xc` 清单、`.xcompiler/registry/` 注册表、`.xcompiler/objects/<type>/<uuid>/r<N>.json` 领域对象（按 revision 不可变）、人类审计日志、Debug Wiki、Project memory 和交付报告。

注册表追加事件是恢复依据，快照索引可重建。每个条目记录对象 ID、类型、路径、父对象、revision、内容哈希和生命周期状态。

---

## 从 npm 安装

```bash
npm install -g @xcompiler/cli
mkdir xcompiler-demo && cd xcompiler-demo
cp "$(npm root -g)/@xcompiler/cli/config.example.yaml" config.yaml
cp "$(npm root -g)/@xcompiler/cli/.env.example" .env
# 编辑 .env，填入 OPENROUTER_API_KEY
xcompiler doctor
```

默认模板使用 OpenRouter Free mode，并通过 `type: openai` 的 OpenAI-compatible provider 访问：

```yaml
model: openrouter/free
base_url: https://openrouter.ai/api/v1
```

`config.yaml`、`llm_scores.yaml` 和 `llm_scores_user.yaml` 都是本地文件，故意不提交到仓库。npm 包只发布 `config.example.yaml` 和 `.env.example` 作为模板。`llm_scores.yaml` 是 XCompiler 自动维护的运行态分数；只有需要固定本地覆盖策略时，才创建 `llm_scores_user.yaml`，例如用 `provider: 0` 禁用某个 provider。

---

## 快速开始

```bash
echo "把 DBC 文件解析为 Excel 报表" > req.md
xcompiler build -i req.md --yes
xcompiler run /tmp/xcompiler-<时间戳>/phasePlan.json
xcompiler load /tmp/xcompiler-<时间戳>/xcompiler-<时间戳>.xc
```

源码仓库开发：

```bash
npm ci
cp .env.example .env
cp config.example.yaml config.yaml
npm run build
npm link
xcompiler --help
```

不 link 的开发模式：

```bash
npm run dev -- build -i req.md --yes
npm run dev -- run path/to/phasePlan.json
```

增量开发：

```bash
xcompiler build -w path/to/workspace -i feature_req.md --intent feature --yes
xcompiler evolve -w path/to/workspace -i refactor_req.md --intent refactor --yes
xcompiler append path/to/workspace/<name>.xc -i feature_req.md --yes
```

自举开发：

```bash
xcompiler bootstrap -r path/to/XCompiler -i self_req.md --yes
```

---

## 常用命令

| 命令 | 用途 |
|---|---|
| `xcompiler build -i <file>` | 从需求文件生成阶段计划 |
| `xcompiler build -t <topic.md>` | 复用已澄清 topic，跳过 Gate 1 |
| `xcompiler run <phasePlan.json>` | 执行当前阶段计划 |
| `xcompiler run --debug-wiki-path <dir>` | 复用并更新共享分层 Debug wiki 路径 |
| `xcompiler load <name.xc>` | 读取工程配置/进度并继续 |
| `xcompiler append <name.xc> -i <file>` | 在已有工程上追加新需求 |
| `xcompiler evolve -w <workspace> -i <file>` | 编译并执行一次增量变更 |
| `xcompiler acp` | 启动 ACP Code Agent stdio adapter |
| `xcompiler doctor` | 检查配置、LLM provider、sandbox、skills 是否可用 |
| `xcompiler ls` / `xcompiler show <stepId>` | 查看计划和最近审计 |
| `npm run release:local -- vX.Y.Z` | 本地准备 release commit 和 tag，不 push |

---

## 默认运行时

- **LLM**：默认 OpenRouter Free mode。key 缺失或无效时会输出 provider、model、base URL、HTTP 状态/响应体，并明确提示 `OPENROUTER_API_KEY`。
- **LLM 路由**：角色专用 provider 链、XCompiler 自动维护的动态评分、`llm_scores_user.yaml` 用户覆盖，以及 `tags: [cluster]` 聚合路由兜底评分带。
- **语言**：支持 Python 与 TypeScript 的工程生成、测试、运行和入口检查。
- **Sandbox**：默认 `subprocess` 且隔离宿主环境变量（`inherit_env: false`）；可切换 `docker` 获得可执行的网络/资源隔离。subprocess 无法兑现 `network: off`，因此该组合会明确报错。
- **Audit**：每次运行写入人类可读日志，并持久化带 correlation/causation ID 的领域 AuditEvent 和 Log 对象。
- **Debug wiki**：Debugger 处理 Bug Ticket 时会基于压缩后的 `DebugBrief` 检索 LLM-wiki 风格的历史修复经验。wiki 是分层 Markdown 知识库：随包发布的 `wiki/system` 策略页、随包发布的 `wiki/agent` calibration 页、本地 `wiki/external` 真实 Bug 解决方案页。Runtime 会重新生成 `index.md` 供人工审阅、`index.json` 供检索使用，并追加 `log.md` 记录操作流水。默认复制到 XCompiler 路径（设置 `XC_PATH` 时为 `$XC_PATH/.xcompiler/debug-wiki`，否则为包/仓库根目录），也可用 `--debug-wiki-path <dir>` 指定共享根目录。Bug 的全部 CR 验证通过后才把 `bugResolutionPlan` 写入 `external`；复用方案失败会通过 feedback overlay 标为 `needs_review`，后续成功修复会创建或纠正 external 条目。
- **安全门禁**：项目文件访问受控，写工具限制在 Step 声明 outputs 内，敏感操作可通过 Adapter 暴露为权限事件。

---

## 运行期调优

LLM 路由配置位于 `config.yaml -> llm.*`。

| 字段 | 默认 | 作用 |
|---|---|---|
| `roles.<Role>` | 按角色不同 | Planner、Architect、Coder、Tester、Debugger 的 provider 候选链 |
| `providers.<name>.context_window` | `128K` | Provider 的上下文容量；为空时使用默认值，模型切换后会重新计算工具窗口 |
| `llm_scores_user.yaml` | 不存在 | 本地用户评分覆盖；`0` 禁用 provider，`0.1..1` 固定有效优先级 |
| `cluster_score_min/max` | `0.2..0.5` | `cluster` provider 的动态评分范围；用户覆盖仍可使用 `0.1..1` |
| `agent.sandboxes.python.mode` | `subprocess` | Python 工程沙盒后端：本地 subprocess 或 Docker |
| `agent.sandboxes.typescript.mode` | `subprocess` | TypeScript 工程沙盒后端：本地 subprocess 或 Docker |
| `agent.sandboxes.<language>.local.inherit_env` | `false` | 是否显式继承宿主环境；宿主含 API key 等机密时应保持关闭 |
| `max_rounds_per_step` | `6` | 普通 Step 的 LLM 对话轮数上限 |
| `max_debug_rounds_per_step` | `max(8, 2 * max_rounds_per_step)` | Debugger 对话轮数上限 |
| Planner `Step.maxAttempts` | 按复杂度自适应 | Step 事务尝试上限；随 simple/moderate/complex 和 Phase 数量增长 |
| `--debug-wiki-path <dir>` | XCompiler 路径下的 `.xcompiler/debug-wiki` | 共享分层 Debug wiki 根目录路径 |
| `max_edit_lines_per_step` | `auto` | EditGuard 单 Step 累计写入行数预算 |
| `max_write_chunk_bytes` | `auto` | 单次写入 chunk 字节预算 |
| `agent.sandboxes.<language>.<local\|docker>.limits.network` | `download-only` | Docker 可执行 `off`；subprocess 会拒绝 `off`，避免声称无法兑现的隔离 |

---

## 文档

| 路径 | 内容 |
|---|---|
| [docs/openrouter.md](docs/openrouter.md) | OpenRouter Free mode 与 OpenAI-compatible provider 配置 |
| [docs/acp.md](docs/acp.md) | ACP Code Agent Adapter 协议说明 |
| [docs/XCompiler_design.md](docs/XCompiler_design.md) | 核心设计与 V 模型概念 |
| [docs/plugin_api.md](docs/plugin_api.md) | Plugin API、生命周期 hooks、tools、skills |
| [docs/versioning.md](docs/versioning.md) | 版本源、release 脚本、tag 策略 |
| [docs/self_bootstrap.md](docs/self_bootstrap.md) | 自举开发与 qualification gates |
| [docs/deploy.md](docs/deploy.md) | 本地、Docker、native package 部署 |

---

## 测试

```bash
npm run version:check
npm run typecheck
npm run lint
npm test
npm run build
```

测试套件按所需能力分档，受限环境（例如禁止监听 127.0.0.1）仍可完整跑确定性门禁，
而不会把环境限制误报成产品缺陷：

```bash
npm run test:core          # 仅确定性用例；不开端口、不拉子进程
npm run test:integration   # 需要本机回环 HTTP 服务与真实子进程
npm run test:e2e           # 拉起真实 CLI/ACP 进程
```

Release gate 始终执行当前完整测试集，不使用固定的历史测试数量作为验收声明。

---

## License

[Apache License 2.0](LICENSE) © 2026 The XCompiler Authors. 详见 [NOTICE](NOTICE)。
