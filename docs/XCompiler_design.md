# XCompiler (Extensible Compiler) — AI Software Factory 设计

> 多 LLM 协同 + V 模型驱动 + 全流程自动化的 AI 软件开发流水线

---

## 目录

- [1. 目标与定位](#1-目标与定位)
- [2. 设计原则](#2-设计原则)
- [3. 整体架构](#3-整体架构)
- [4. 核心命令：`xcompiler build` 与 `xcompiler run`](#4-核心命令xcompiler-build-与-xcompiler-run)
- [5. V 模型阶段与产物](#5-v-模型阶段与产物)
- [6. LLM 与角色](#6-llm-与角色)
- [7. Tool 与 Skill](#7-tool-与-skill)
- [8. Runtime Sandbox](#8-runtime-sandbox)
- [9. Workspace 与文档](#9-workspace-与文档)
- [10. CLI 交互设计](#10-cli-交互设计)
- [11. 配置](#11-配置)
- [12. 风险与控制](#12-风险与控制)

---

## 1. 目标与定位

构建一套 **工程级 AI 开发流水线**：把"自然语言需求"作为输入，按 V 模型流程自动产出可运行、可测试、可交付的软件工程。

| 维度       | 说明                              |
| -------- | ------------------------------- |
| 流程       | 严格 V 模型，每阶段输入 / 输出明确             |
| 执行       | 产物可运行、可测试，全部在 Sandbox 内执行        |
| 输出       | 全流程 Markdown 文档 + 可交付源码          |
| 控制       | 状态机驱动，关键节点强制人工确认                 |
| 实现技术栈    | TypeScript + Node.js ≥ 24        |
| 目标产物语言   | **Python、TypeScript**；C/C++ 后续 |

---

## 2. 设计原则

- **工程优先**：可执行、可验证、可交付。
- **编译 / 执行分离**：`xcompiler build` 把需求"编译"为 `phasePlan.json` 和当前 `plan.P<N>.json`；`xcompiler run` 按阶段计划执行产出代码。计划是可审阅、可缓存、可恢复的中间产物。
- **交互纯度**：**所有普通需求澄清、确认都发生在 `xcompiler build` 阶段**；`xcompiler run` 默认自动执行，只在敏感操作授权等 Adapter 场景下暂停。
- **占位唯一**：`xcompiler build` 为每个 Step 生成一段**专属系统提示词 `systemPrompt`**，明确该 Step 的开发内容 / 输入 / 产出 / 验收，以防止 LLM 发散。
- **阶段纯度**：需求阶段与系统设计阶段产物中禁止出现实现代码，仅允许出现接口定义、数据结构、依赖声明。
- **可追溯**：全程 Markdown 文档 + Step 级审计日志。
- **可扩展**：LLM、Tool、Skill、语言均可插拔。

---

## 3. 整体架构

```text
CLI / ACP / Future Adapters
        │
        ▼
XCompiler Runtime（唯一业务入口）
        │
        ├── Build Service（澄清、复杂度评估、phasePlan、当前 plan）
        ├── Run Service（当前阶段 V 模型执行）
        ├── Event Stream（progress / warning / error / result）
        └── Permission Broker（敏感操作授权）
        │
        ▼
Workflow and Planning（Phase Planner + V-Model Engine + Issue Router）
        │
        ▼
Agents / Skills / Tool Guard / PluginHost / Project Memory
        │
        ▼
Workspace（phasePlan.json + plan.P<N>.json + src + docs + .xcompiler）
```

V 模型流程：

```text
需求分析 ─────────────►  功能测试
   │                       ▲
概要设计 ─────────────►  模块测试
   │                       ▲
详细设计 ─────────────►  集成测试
   │                       ▲
编码实现 ─────────────►  单元测试
```

---

## 4. 核心命令：`xcompiler build` 与 `xcompiler run`

| 命令 | 角色 | 输入 | 输出 |
| --- | --- | --- | --- |
| `xcompiler build` | 需求编译器 | 用户自然语言需求、`topic.md` 或增量需求 | `topic.md`、`phasePlan.json`、当前 `plan.P<N>.json`、`plan.md`、`<name>.xc` |
| `xcompiler run` | 执行器 | `phasePlan.json`（兼容旧 `plan.json`） | `src/`、`tests/`、`docs/`、审计日志、更新后的工程进度 |
| `xcompiler load` | 恢复入口 | `<name>.xc` | 载入 workspace/config/phase progress 并继续 |
| `xcompiler append` / `xcompiler evolve` | 增量入口 | 现有 workspace/工程文件 + 新需求 | 新一轮澄清、阶段计划与实现 |
| `xcompiler acp` | Code Agent Adapter | stdio JSON-RPC | Runtime-backed ACP 事件、授权请求和结果 |

Build 与 Run 通过 `phasePlan.json` 和当前 `plan.P<N>.json` 解耦：Build 负责澄清、复杂度评估、阶段拆分和计划确认；Run 按当前阶段计划执行，不再做普通聊天式追问。

### 4.1 `xcompiler build`：需求 → 阶段计划

处理流程：

```text
Intake → Clarify(LLM) → Complexity/PhasePlan(LLM) → Active Phase Plan(LLM) → Lint → Preview → Confirm(Human) → Persist
```

**两道强制确认门**（任一未通过则不写入可执行计划）：

1. 需求选题书确认（`docs/topic.md` 草案）
2. 阶段计划和当前阶段计划确认（`phasePlan.json`、`plan.P<N>.json`、`docs/plan.md` 草案）

Gate 1 确认后立即持久化 `docs/topic.md`，即使后续计划生成失败也可复用；计划在 Gate 2
确认前仍位于 `docs/.draft/`，确认后才写入 `workspace/phasePlan.json`、当前 `workspace/plan.P<N>.json` 与 `docs/plan.md`。

Step / Plan 数据结构：

```ts
export type Phase =
  | 'REQUIREMENT_ANALYSIS'
  | 'HIGH_LEVEL_DESIGN'
  | 'DETAILED_DESIGN'
  | 'CODE'
  | 'UNIT_TEST'
  | 'INTEGRATION_TEST'
  | 'MODULE_TEST'
  | 'FUNCTIONAL_TEST'
  | 'DEBUG';

export type StepStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';

export interface Step {
  id: string;                    // S001、S002 …
  phase: Phase;
  title: string;
  description: string;           // 喂给 LLM 的详细说明
  /**
   * 本 Step 专属的系统提示词，由 xcompiler build 生成。
   * 要求明确限定本 Step 的范围、入参、产出、禁止事项，
   * xcompiler run 会把它拼接到 Executor 的通用 system prompt 后，以防止 LLM 发散。
   */
  systemPrompt: string;
  role: 'Planner' | 'Architect' | 'Coder' | 'Tester' | 'Debugger';
  tools: string[];               // 允许调用的 Tool / Skill 白名单
  inputs: string[];              // 依赖的产物路径
  outputs: string[];             // 预期产出路径
  dependsOn: string[];           // 前置 Step id
  acceptance: string;            // 验收标准
  status: StepStatus;            // 由 xcompiler run 写回
  retries: number;
  maxRetries: number;            // 默认 3
}

export interface Plan {
  version: '1';
  language: 'python' | 'typescript';
  phaseId: 'P1' | 'P2' | string;
  requirementDigest: string;
  /** xcompiler build 沉淀出的全局开发约束（项目背景、全局约定、语言与依赖策略），所有 Step 共享。 */
  globalPrompt: string;
  /** 计划级依赖；Python 在运行前生成 requirements.txt，TS 由 HIGH_LEVEL_DESIGN 同步 package.json。 */
  dependencies: string[];
  createdAt: string;             // ISO 时间
  steps: Step[];
}
```

Plan Lint 规则：

- `dependsOn` 指向必须存在；不允许环。
- 同一 `outputs` 路径全局唯一。
- 阶段顺序：`REQUIREMENT_ANALYSIS < HIGH_LEVEL_DESIGN < DETAILED_DESIGN < CODE < UNIT_TEST < INTEGRATION_TEST < MODULE_TEST < FUNCTIONAL_TEST`；`DEBUG` 是失败后的修复模式。
- 每个 `CODE` Step 必须被 `UNIT_TEST` 覆盖，且每个执行阶段必须覆盖完整 V 模型核心阶段。
- **每个 Step 必须携带非空 `systemPrompt`**；`REQUIREMENT_ANALYSIS` / `HIGH_LEVEL_DESIGN` / `DETAILED_DESIGN` Step 的 outputs 不得包含实现源码或测试源码（阶段纯度）。
- Python 依赖由 Plan 顶层 `dependencies` 声明，`xcompiler run` 在执行前统一生成 `requirements.txt`；任何 Step 都不得把它声明为输出。TypeScript 的 `package.json` 由 `HIGH_LEVEL_DESIGN` 阶段维护。

### 4.2 `xcompiler run`：阶段计划 → 代码

> **非交互式守则**：`xcompiler run` 启动后不做普通聊天式需求追问。所有需求 / 架构 / 依赖决策都应在 `xcompiler build` 阶段完成，并随 `phasePlan.json` / `plan.P<N>.json` / `Step.systemPrompt` 传递。
>
> **提示词拼接**：每个 Step 执行时，Executor 的 system prompt = 通用协议提示 + `plan.globalPrompt` + `step.systemPrompt` + Skill hints。该 `step.systemPrompt` 在 Plan Lint 阶段已验证非空，是本 Step 唯一上下文源，以防止 LLM 跨 Step 发散。

```ts
async function xcompilerRun(phasePlanPath: string) {
  const target = await loadPlanTarget(phasePlanPath);
  const plan = target.plan; // current plan.P<N>.json
  for (const step of topoSort(plan.steps)) {
    if (step.status === 'DONE') continue;     // 断点续跑
    step.status = 'RUNNING'; await persist(plan);
    try {
      await executeStep(step);                // role LLM + Skill
      await verifyAcceptance(step);           // outputs / acceptance
      step.status = 'DONE';
    } catch (err) {
      step.status = (await debugLoop(step, err)) ? 'DONE' : 'FAILED';
      if (step.status === 'FAILED') { await persist(plan); throw err; }
    }
    await persist(plan);
  }
  await emitDelivery(plan);
}
```

行为约定：

- **断点续跑**：每次 Step 状态变更立即回写当前 `plan.P<N>.json` 和工程进度，中断后再次执行自动续跑。
- **DEBUG 闭环**：失败先记录 issue，再按失败阶段路由到匹配上游阶段生成 patch/rewrite；Debugger 处理 issue 时必须输出 `issueResolutionPlan`，正确修复后写回 issue 并沉淀到 debug-wiki。
- **Debug-wiki**：默认复制并加载 XCompiler 自身路径的 `.xcompiler/debug-wiki/`（设置 `XC_PATH` 时使用 `$XC_PATH`），也可通过 `--debug-wiki-path <dir>` 指定。存储和处理参考 LLM-wiki：`wiki/system/*.md` 是系统级策略，`wiki/agent/*.md` 是 agent/calibration 级规则，`wiki/external/*.md` 是真实生成项目的 issue 修复条目，`index.md` 是可读目录，`index.json` 是检索索引，`log.md` 是追加式操作日志，`wiki/external/feedback.jsonl` 是对内置层的运行反馈 overlay。检索输入使用压缩后的 `DebugBrief`，输出采用 problem / priorPlan / confirmedSolution / feedback 摘要；复用失败的条目标为 `needs_review`，后续成功修复会创建或纠正 external 条目。
- **审计日志**：`.xcompiler/audit.jsonl`、LLM trace、debug cache、debug-wiki 反馈与 `docs/process_log.md` 同步记录关键事件和错误上下文。

---

## 5. V 模型阶段与产物

### 5.0 阶段纯度（禁止越阶产出）

| 阶段 | 允许产出 | 明确禁止 |
| --- | --- | --- |
| REQUIREMENT_ANALYSIS | `docs/01-requirement-analysis.md`、验收场景、功能测试期望 | 实现代码、包含函数体的伪代码 |
| HIGH_LEVEL_DESIGN | `docs/02-high-level-design.md`、系统接口、外部 API、第三方库和依赖确认、模块测试期望 | 函数实现体、可执行脚本、测试源码 |
| DETAILED_DESIGN | `docs/03-detailed-design.md`、模块内部结构、集成测试期望 | 直接落地源码实现 |
| CODE | `src/**`、入口文件、单元测试期望 | 跳过接口签约、跳过依赖声明 |
| UNIT_TEST | `tests/**` 中的单元测试与执行结果 | 掩盖实现错误、无证据标记通过 |
| INTEGRATION_TEST | 集成测试、依赖/API 联调结果 | 访问失败后跳过外部 API 门禁 |
| MODULE_TEST | 模块级行为测试与契约验证 | 绕过 HIGH_LEVEL_DESIGN 中的模块契约 |
| FUNCTIONAL_TEST | 功能验收、README、QuickStart、库项目 API Guide | 未通过入口/API 验证却交付 |
| DEBUG | stage-aware issue、patch/rewrite、重跑验证证据 | 用空 patch、跳过错误或污染主工程规则来伪装修复 |

> Plan Lint 会检查越阶产出、V 模型阶段完整性、Step 子任务深度和输出路径冲突，并拒绝写入可执行计划。

| V 模型配对 | 测试期望生成时机 | 失败回退目标 |
| --- | --- | --- |
| REQUIREMENT_ANALYSIS -> FUNCTIONAL_TEST | 需求分析阶段同步生成验收口径 | 功能测试失败回退到需求分析 |
| HIGH_LEVEL_DESIGN -> MODULE_TEST | 概要设计阶段同步生成模块契约检查 | 模块测试失败回退到概要设计 |
| DETAILED_DESIGN -> INTEGRATION_TEST | 详细设计阶段同步生成集成检查 | 集成测试失败回退到详细设计 |
| CODE -> UNIT_TEST | 编码阶段同步生成单元测试要求 | 单元测试失败回退到编码 |

### 5.1 依赖清单约定

- Python 的 `plan.dependencies` 使用可由 pip 解析的裸包名，运行前由 XCompiler 统一校准并种入
  `requirements.txt`；Step 不得直接把该文件列为输出，新增依赖通过 `add_dependency`。
- TypeScript greenfield 由 `HIGH_LEVEL_DESIGN` 创建 `package.json`；feature / refactor / self 默认复用现有
  manifest，只有需求确实涉及依赖或脚本时才修改。
- DEBUG 阶段缺包时通过 `add_dependency` Skill 安装并**回写**到 `requirements.txt`，确保声明与运行一致。

---

## 6. LLM 与角色

统一接口：

```ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface LLMClient {
  chat(messages: ChatMessage[], model: string, options?: Record<string, unknown>): Promise<string>;
}
```

支持 Provider：Ollama（本地）、OpenAI、Claude、兼容 OpenAI API 的服务。

| 角色        | 职责        | 服务命令       |
| --------- | --------- | ---------- |
| Planner   | 需求澄清、复杂度评估、PhasePlan 和当前阶段计划生成 | `xcompiler build` |
| Architect | 概要设计、详细设计、依赖推导 | `xcompiler run` |
| Coder     | 代码生成和增量 patch | `xcompiler run` |
| Tester    | 单元/集成/模块/功能测试生成与执行 | `xcompiler run` |
| Debugger  | 错误分析、issue 路由、patch/rewrite 修复 | `xcompiler run` |

---

## 7. Tool 与 Skill

### 7.1 原子 Tool

| 类别       | 工具                                    |
| -------- | ------------------------------------- |
| 文件       | `read_file`、`write_file`、`append_file`、`apply_patch` |
| 代码       | `code_search`、`symbol_search`          |
| 执行       | `run_python`、`run_tests`（Sandbox 内）   |
| 包管理      | `pip_install`                          |
| 版本控制     | `git_snapshot`、`git_revert`            |
| Debug 辅助 | `analyze_error`                        |

每个 Step 的 `tools` 字段是白名单，越权调用直接拒绝。

### 7.2 Skill（Copilot / Code Agent 风格的高层编辑能力）

Skill 是若干 Tool 的命名编排，对 LLM 暴露更高层语义，Coder / Debugger 共享：

| Skill             | 组合                                          | 用途                       |
| ----------------- | ------------------------------------------- | ------------------------ |
| `read_code`       | `read_file` + `code_search` + `symbol_search` | 精准定位上下文                  |
| `apply_patch`     | unified diff                                | 最小化修改，保留行号               |
| `replace_in_file` | `read_file` + 范围替换（含锚点）                       | 短片段安全替换                  |
| `create_file`     | `write_file`                                | 新增模块 / 测试                |
| `rename_symbol`   | `symbol_search` + `apply_patch`             | 跨文件重命名                   |
| `add_dependency`  | `pip_install` + 回写 `requirements.txt`       | 补依赖并固化版本                 |
| `run_tests`       | Sandbox 内 `pytest`（可指定用例）                    | 局部 / 全量回归                |
| `run_python`      | Sandbox 内执行任意脚本                              | 复现 bug                   |
| `revert_change`   | `git_revert` 或 `apply_patch -R`             | 回滚到上一个 DONE 快照           |

约束：

- 改动只能落在当前 Step `outputs` 白名单（`add_dependency` 例外，可写 `requirements.txt`）。
- 单 Step 改动行数默认按当前 Step 上下文自适应预算；显式配置数字时作为固定硬上限。
- Runtime 使用统一 Operation Window：根据活动 Provider 的 `context_window`、实际 prompt 占用和安全预留，动态更新 response、`read_file`、write content 与 tool feedback 窗口；Provider fallback 切换时立即重算。
- `append_file` 是超过当前模型输出窗口时的可选增量能力；能够在单次 write window 内完整表达的文件不要求拆分。
- 每次 Skill 调用产出一条审计记录（who / why / diff / 测试结果）写入 `logs/edits-<step-id>.jsonl`。
- 每个 Step 开始前自动 `git commit` 快照，失败可 `revert_change`。

---

## 8. Runtime Sandbox

Sandbox 是所有"执行用户代码"与"自动改码 + 回归"的**唯一**载体。

### 8.1 实现

| 模式           | 实现                                | 适用              |
| ------------ | --------------------------------- | --------------- |
| `subprocess` | `child_process` + Python `venv`   | 默认，启动快          |
| `docker`     | `python:3.x-slim`，挂载 workspace 卷 | 推荐，强隔离 + 缓存依赖镜像 |
| `firejail`   | 轻量 Linux 沙盒                       | 预留方案   |

`subprocess` 默认使用 `inherit_env: false`，避免把宿主机 API key 等机密传给生成项目。该模式无法在宿主进程层可靠执行 `network: off`，配置此组合时 Runtime 会拒绝启动；需要硬网络隔离应使用 Docker。

### 8.2 生命周期

```text
build    → 读取 requirements.txt(+dev)，建 venv 或 build image
exec     → 跑 pytest / python，捕获 stdout/stderr/exit/json-report
edit     → Skill 修改挂载的 workspace 源码
snapshot → git commit step-<id>-<retry>
revert   → 失败时 git reset --hard 回上一快照
teardown → 保留缓存镜像，删除临时目录
```

### 8.3 Debug 闭环

```text
Sandbox 失败 → 记录 issue + DebugBrief
             → 检索 debug-wiki system/agent/external 的历史问题/方案/反馈摘要
             → Debugger LLM 输出 issueResolutionPlan
             → 选 Skill 修改源码 (apply_patch / replace_in_file / add_dependency …)
             → Sandbox 重跑失败子集 → 通过则写回 issue 并更新 debug-wiki
             → 失败则标记相关 wiki 条目 needs_review，并进入下一轮/终止
```

### 8.4 资源与安全限制（默认）

- CPU / 内存 / 单次墙钟按 `config.yaml -> agent.sandboxes.<language>.<local|docker>.limits` 配置。
- 默认网络策略为 `download-only`：允许出站下载，不开放入站端口；`off` 表示断网。
- 工具文件访问最高优先级门禁限制在项目目录内；项目外读写默认拒绝。
- Docker 模式通过 bind mount、用户权限和资源限制提供更强隔离。

---

## 9. Workspace 与文档

```text
workspace/
├── <name>.xc                 # 工程索引：workspace/config/plan/current progress/history
├── phasePlan.json             # 阶段总览：currentPhaseId + P1..Pn 目标 + planPath
├── plan.P1.json               # 当前阶段的 V 模型 Step 计划，xcompiler run 回写状态
├── requirements.txt | package.json
├── docs/
│   ├── topic.md
│   ├── plan.md                # phasePlan + 当前 plan 的人类可读视图
│   ├── 01-requirement-analysis.md
│   ├── 02-high-level-design.md
│   ├── 03-detailed-design.md
│   ├── 05-unit-test.md
│   ├── 06-integration-test.md
│   ├── 07-module-test.md
│   ├── 08-functional-test.md
│   ├── quickstart.md
│   ├── api-guide.md           # library / mixed 项目需要
│   ├── process_log.md
│   ├── iterations/P2/         # 后续阶段激活后的阶段文档
│   └── history/               # 阶段 + 时间戳归档
├── src/                       # Python / TypeScript 源码
├── tests/                     # pytest / Vitest
├── .xcompiler/                # 锁、审计、项目记忆、debug cache、自举报告；debug-wiki 默认在 XCompiler 自身路径的分层目录
├── .sandbox/                  # venv / docker 缓存（gitignore）
└── node_modules/              # TypeScript subprocess sandbox（按需）
```

文档规范：全部 Markdown，每阶段独立文件，禁止覆盖式重写，历史版本归档至 `docs/history/`。

---

## 10. CLI 交互设计

参考 `ollama` 的对话式 REPL，单一入口 `xcompiler`，下设 `xcompiler build` / `xcompiler run`（同时提供别名 `xcompiler_build` / `xcompiler_run`）。

### 10.1 Node.js 技术栈

| 关注点       | 选型                                                     |
| --------- | ------------------------------------------------------ |
| 命令解析      | `commander`                                            |
| 交互 Prompt | `@inquirer/prompts`（confirm / select / editor）         |
| REPL 输入   | Node 内建 `readline/promises`                            |
| 流式 / 颜色   | `chalk` + `ora`                                        |
| 表格 / 进度   | `cli-table3`、`listr2`                                  |
| 打包        | `tsup`（npm 包），可选 `pkg` 输出独立二进制                          |

### 10.2 `xcompiler build` 交互（含强制确认）

```text
$ xcompiler build
[Phase: REQUIREMENT_ANALYSIS]
? 请描述你的需求（多行，Ctrl+D 结束）:
> 命令行待办事项管理工具，CRUD + JSON 持久化

⠋ Planner 正在澄清…
Q1 是否需要优先级 / 截止日期？        > 仅优先级
Q2 数据文件路径是否可配置？            > 默认 ~/.todo.json，--file 覆盖
Q3 是否需要 TUI？                    > 否

✔ docs/topic.md 草案已生成
? 需求是否符合预期?  ❯ confirm | edit | cancel

⠙ 评估复杂度并拆分 Phase…
✔ phasePlan.json：P1 current，P2..Pn planned
✔ plan.P1.json：REQUIREMENT_ANALYSIS → FUNCTIONAL_TEST
? 是否确认该计划（最终确认，确认后写入 phasePlan.json）?  ❯ yes | edit | cancel
✔ 已写入 workspace/phasePlan.json
```

### 10.3 `xcompiler run` 交互

```text
$ xcompiler run workspace/phasePlan.json
[S001 REQUIREMENT_ANALYSIS] ✔ DONE  (0.4s)
[S002 HIGH_LEVEL_DESIGN  ] ✔ DONE  (3.1s)   → docs/02-high-level-design.md
[S004 CODE               ] ✖ FAILED → DEBUG (1/3)
   ↳ pytest: AssertionError tests/test_store.py::test_add
   ↳ Debugger: apply_patch (12 lines)
[S004 CODE               ] ✔ DONE  (retry 1)
[S008 FUNCTIONAL_TEST    ] ✔ DONE
✔ 入口: python -m todo_cli --help
✔ P1 complete；P2 已激活并生成 plan.P2.json（留待下一次 run）
```

`xcompiler run` 保持非聊天式执行：不做普通需求追问，也不提供 `p`/`s` 运行时快捷键。可使用 `Ctrl+C` 发送进程中断信号；恢复时依据已持久化的 Step 状态继续执行。

### 10.4 全局命令

```text
xcompiler build | compile       交互式编译需求 → phasePlan.json + plan.P<N>.json
xcompiler evolve                在现有工程中编译并执行增量计划
xcompiler load <xxx.xc>         加载工程文件并继续当前 plan
xcompiler append <xxx.xc>     在已有工程基础上追加需求，重新走澄清与 V 模型
xcompiler bootstrap             在隔离 worktree 中构建并验证下一代 XCompiler
xcompiler run <phasePlan.json>  执行当前阶段计划
xcompiler ls                    列出 workspace 中的 plan/phasePlan
xcompiler show <step-id>        查看 Step 定义与产物

-w, --workspace <dir>      指定 workspace（默认 cwd）
-c, --config <file>        指定 config.yaml
--no-color   --json        CI 友好输出
--yes                      非交互模式（仅在需求来源为文件时生效）
```

### 10.5 功能自举

XCompiler 采用代际自举，不允许正在运行的进程热替换自身。稳定版本 N 在独立 Git worktree
中生成候选版本 N+1，完整执行 V 模型，再通过 typecheck、测试、构建、CLI smoke 与
打包预检。默认只保留候选分支和自举报告；只有显式 `--promote` 才允许在宿主仓库
仍然干净且 HEAD 未变化时执行快进合并。完整协议见 [self_bootstrap.md](self_bootstrap.md)。

---

## 11. 配置

`config.yaml`：

```yaml
llm:
  providers:
    openrouter_free:
      type: openai
      api_key: ${OPENROUTER_API_KEY}
      base_url: ${OPENROUTER_BASE_URL}
      model: ${OPENROUTER_MODEL}
      context_window: 128K
    local_ollama:
      type: ollama
      base_url: ${OLLAMA_BASE_URL}
      model: ${OLLAMA_CODE_MODEL}
      context_window: 128K
  roles:
    Planner:   [openrouter_free]
    Architect: [openrouter_free]
    Coder:     [openrouter_free]
    Tester:    [openrouter_free]
    Debugger:  [openrouter_free]

agent:
  max_steps: 50
  max_debug_retries: 3
  sandboxes:
    python:
      mode: subprocess          # subprocess | docker | firejail
      local:
        limits:
          cpu: 1
          memory_mb: 1024
          wall_seconds: 60
          network: download-only
      docker:
        image: python:3.11-slim
        limits:
          cpu: 1
          memory_mb: 1024
          wall_seconds: 60
          network: download-only
    typescript:
      mode: subprocess
      local:
        limits:
          cpu: 1
          memory_mb: 1024
          wall_seconds: 60
          network: download-only
      docker:
        image: node:24-slim
        limits:
          cpu: 1
          memory_mb: 1024
          wall_seconds: 60
          network: download-only
```

密钥通过 `.env` 注入，禁止硬编码。

---

## 12. 风险与控制

| 风险          | 控制策略                                       |
| ----------- | ------------------------------------------ |
| LLM 输出不稳定   | Plan Lint + Skill 行为约束 + 验收校验               |
| Debug 循环失控  | `max_debug_retries=3`，超限停机请求人工             |
| Context 爆炸  | 仅按 Step `inputs` 白名单加载产物；函数级代码切片            |
| 计划与实现漂移     | 每步回写当前 `plan.P<N>.json` 与工程进度；Skill 审计日志 + git 快照可回放    |
| 沙盒越权 / 污染宿主 | 所有执行 / 改码均在 Sandbox；workspace 之外只读；网络默认 PyPI only |
