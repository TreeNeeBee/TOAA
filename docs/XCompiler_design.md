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
Workflow and Planning（Phase Planner + V-Model Engine + Ticket Workflow）
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

左侧四个阶段同步产出配对测试计划和可执行测试用例，并在交付门禁提交阶段完成度与上游功能/契约对齐度；右侧四个阶段只检查测试完整性与契约一致性、运行既有测试并记录结构化工程指标。Runtime 将计划注册为 `feature -> task -> sub-task` Ticket 图。真实执行或测试错误创建 `bug`；完成度、对齐度、覆盖率或 tolerance 不达标创建独立 `enhance`，再按责任阶段增量补齐。

### 3.1 完整 Ticket 驱动流程

1. **Build**：澄清需求、评估复杂度、拆分 Phase，并只生成当前 Phase 的 V 模型计划。
2. **登记**：Run 将计划迭代统一登记为 `feature`，将每个 V 模型 Step 登记为 `task`，将计划内最多两层子任务登记为相互关联的 `sub-task`。`enhance` 不作为计划根节点。
3. **实施**：S01-S04 按 Task 执行并同步生成配对测试资产，门禁检查 `completion` 和 `upstreamAlignment`；S05-S08 只检查测试完整性、执行既有测试并提交覆盖率、通过率、跳过数、失败数和 warning 等验证证据。
4. **质量分流**：执行异常、测试失败或结构化 `validationDefect` 创建 `bug`，进入 Debugger；阶段内容缺失、上游对齐不足、覆盖指标不足或 tolerance 超限（非 failed test）创建 `enhance`，由原角色按缺口增量补齐。两条路径不互相冒充。
5. **局部修复**：回退到非设计阶段时，Debugger 必须先提交 `bugResolutionPlan`，再生成 patch/rewrite 或有效验证证据；随后从修复点重跑受影响的下游 Task。
6. **设计变更**：回退到概要设计或详细设计、且形成已确认的上游契约差异时，Debugger 只完成根因修复与 `change-request` 编制。CR 由 Enhance 触发，并保留原始 Bug、契约差异、影响 Step/产物、实施方案和验证门禁；下游只应用增量变更，并逐站记录代码或验证提交。
7. **返工**：CR 下游失败时创建新的关联 Bug，并让原 CR 进入下一 revision；只有契约或范围实质扩大时才建立父子 CR。失败不会被跳过，也不会通过全量重做掩盖增量变更。
8. **关闭与交付**：所有受影响门禁通过后先关闭 CR；Bug 的修复方案和有效证据写入 debug-wiki 后进入 `resolved`、`closed`。直接质量 Enhance 在验证阶段通过后关闭。所有 Task、Enhance、CR 和 Bug 清零后，Runtime 汇总 `.xcompiler/quality/assessments.json`、Ticket、Phase 与项目审计结果，生成 `docs/project-development-report.md`。

Ticket 只持久化到 `.xcompiler/tickets/`。旧 Issue Journal、独立 CR Store 及其目录不再读取、转换或镜像，Runtime 内不存在兼容双轨。

### 3.2 Phase Engine 内部边界

`src/core/engine.ts` 只保留执行状态机的编排职责：选择可执行 Step、推进 Plan 状态、建立单次尝试的事务边界，以及按 V 模型执行回退和下游重跑。可复用规则与持久化流程位于 `src/core/engine/`：

| 模块 | 单一职责 |
| --- | --- |
| `attempt_types.ts` | Attempt、Debug 上下文和结果的内部契约 |
| `attempt_environment.ts` | 解析 Skill/Tool、计算动态窗口、应用 EditGuard 并构建 Executor 上下文 |
| `attempt_policy.ts` | 判断修复动作、验证证据、失败工具和 Patch 结果 |
| `v_model_policy.ts` | V 模型配对、测试范围、代码校验和回退提示等无状态规则 |
| `context.ts` | 构建 Agent 上下文并计算 Step/Debug 写入边界 |
| `audit_repair.ts` | 将最终项目审计失败映射到负责修复的 Step |
| `debug_prompt.ts` | 压缩 Debug 证据、合并 Ticket/Enhance 信息并检索 Debug Wiki |
| `debug_wiki_feedback.ts` | 隔离 Debug Wiki 的加载、检索及正负反馈持久化 |
| `failure_presenter.ts` | 渲染 CLI 终态失败、指标和校准建议，不参与状态跳转 |
| `work_ticket_lifecycle.ts` | Feature、Task、Sub-task 的注册、执行同步和父子关闭 |
| `bug_lifecycle.ts` | Bug Ticket 的创建、路由、修复验证和关闭 |
| `enhancement_lifecycle.ts` | Enhance Ticket 的质量缺口、模型归因和关闭 |
| `change_request_opening.ts` | 从设计修复或质量缺口建立增量 CR |
| `change_request_lifecycle.ts` | CR 返工、逐站应用、验证关闭和父子 CR 收敛 |
| `lifecycle_registry.ts` | 编译期保证每种 Ticket 类型都有唯一 lifecycle owner |
| `test_phase_validator.ts` | 检查配对测试资产并复验已有测试与功能入口 |
| `repair_artifact.ts` | 生成 Debug Patch/摘要并验证已完成阶段的修复证据 |

六种 Ticket 的 lifecycle owner 固定为：`feature/task/sub-task -> WorkTicketLifecycle`、`bug -> BugLifecycle`、`enhance -> EnhancementLifecycle`、`change-request -> ChangeRequestLifecycle`。三个 Work Ticket 共享生命周期，是因为它们组成同一棵计划工作树，而不是三个互相独立的状态机。

模块化边界遵循两条约束：只有 Phase Engine 推进 `Step.status`；Ticket lifecycle 只推进 Ticket 图。`TicketStore` 仅保留创建、查询、通用状态转换、关联和持久化原语，不承载某一种 Ticket 的专属流程。测试应直接验证对应模块的公开函数或服务，不依赖 Phase Engine 的私有方法。

---

## 4. 核心命令：`xcompiler build` 与 `xcompiler run`

| 命令 | 角色 | 输入 | 输出 |
| --- | --- | --- | --- |
| `xcompiler build` | 需求编译器 | 用户自然语言需求、`topic.md` 或增量需求 | `topic.md`、`phasePlan.json`、当前 `plan.P<N>.json`、`plan.md`、`<name>.xc` |
| `xcompiler run` | 执行器 | `phasePlan.json` | `src/`、`tests/`、`docs/`、审计日志、更新后的工程进度 |
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
  | 'FUNCTIONAL_TEST';

export type StepStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
export type ExecutionMode = 'NORMAL' | 'DEBUG';

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
- 阶段顺序：`REQUIREMENT_ANALYSIS < HIGH_LEVEL_DESIGN < DETAILED_DESIGN < CODE < UNIT_TEST < INTEGRATION_TEST < MODULE_TEST < FUNCTIONAL_TEST`；`DEBUG` 是运行期执行模式，不得写入 PhasePlan。
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
  const tickets = await registerPlanTickets(plan);
  for (const step of topoSort(plan.steps)) {
    if (step.status === 'DONE') continue;     // 断点续跑
    const task = tickets.taskForStep(step.id);
    await startTicket(task);
    transitionStep(step, 'RUNNING', 'attempt-started');
    await persist(plan);
    try {
      await executeStep(step, task);          // role LLM + Skill + Ticket
      await verifyAcceptance(step);           // outputs / acceptance
      transitionStep(step, 'DONE', 'attempt-passed');
      await closeTicket(task);
    } catch (err) {
      transitionStep(step, 'FAILED', 'attempt-failed');
      const route = classifyDebugFailure(step, err);
      const bug = await createAndRouteBugTicket(task, route, err);
      if (!(await repairThroughVModel(bug))) { await persist(plan); throw err; }
    }
    await persist(plan);
  }
  await emitDelivery(plan);
}
```

行为约定：

- **Ticket 分类**：`feature` 表示计划迭代，`task` 表示 V 模型宏 Step，`sub-task` 映射最多两层子任务；`bug` 表示需要 Debugger 处理的具体失败；`enhance` 表示已经识别的缺陷、功能欠缺或测试不完备；`change-request` 只表示已确认上游变化向下游的增量传导。
- **Ticket 关系**：每个 Ticket 保存 `parentTicketId`、`rootTicketId`、`relatedTicketIds` 和 `blockedByTicketIds`。真实失败链为 `Task -> Bug -> Debug`；质量不足链为 `Task -> Enhance -> incremental remediation`。两者在上游契约变化时都可汇入 `Enhance -> CR`；CR 的 `triggerTicketId/sourceEnhanceTicketId` 必须指向 Enhance，`originBugTicketId` 仅在 Bug 起源时存在。
- **Ticket 状态**：统一使用 `open -> triaged -> in_progress -> in_review|verification -> resolved -> closed` 主链，另有 `blocked`、`failed`、`cancelled`。恢复和返工可将 `closed|failed` 显式转回 `in_progress`，所有迁移经过同一守卫。
- **断点续跑**：每次 Step 与 Ticket 状态变更立即回写当前 `plan.P<N>.json`、`.xcompiler/tickets/` 和工程进度，中断后再次执行自动续跑。
- **DEBUG 闭环**：失败创建 Bug Ticket，按失败阶段路由到匹配上游阶段；Debugger 必须输出 `bugResolutionPlan` 并生成 patch/rewrite 或有效验证证据。Bug 只在门禁通过、方案与证据写入 debug-wiki 后进入 `closed`。
- **Debug 决策**：基础设施/Provider 故障立即停止；测试执行失败回退到配对源阶段；测试产物或当前阶段质量问题留在本阶段修复。修复后从回退点重跑全部下游阶段，不得跳过中间门禁。
- **Enhance 识别**：完成度、上游对齐度、覆盖率、跳过测试、warning 或测试资产完整度不达标时，按结构化证据分类为 `defect`、`functional-gap` 或 `test-incomplete`。Enhance 保存责任阶段、验证阶段、缺口、测量值与证据，但不冒充 Debug Bug。
- **质量指标**：默认 S1-S4 完成度 95%，S1 上游对齐 95%、S2-S4 为 90%；S5 行覆盖 80%、分支覆盖 70%；S6 接口/集成场景覆盖 85%；S7 模块/契约覆盖 90%；S8 功能/需求/端到端覆盖 95%。默认指标短缺 tolerance 为 2%，计划可通过 `qualityGate` 覆盖。
- **质量持久化与报告**：每次门禁测量写入 `.xcompiler/quality/assessments.json`。最终项目审计通过后生成 `docs/project-development-report.md`，汇总 Phase、S1-S8 指标、tolerance、Ticket、模型影响与项目审计结论。
- **CR 增量传导**：只有概要/详细设计修复形成上游契约差异时才创建 `change-request` Ticket；下游 Task 只实施 `contractChange`、`affectedSteps` 和 `affectedArtifacts` 声明的增量，每站记录 commit、changed files 和验收摘要。
- **CR 重做与子 CR**：普通下游失败创建关联 Bug 和 Enhance，将同一 change-request revision 加一后继续；只有契约或范围扩大时才创建带 `parentTicketId` 的子 change-request。全部受影响门禁通过后 CR 先关闭，再解除原始 Bug 的阻塞并完成 Bug 验证、debug-wiki 沉淀和 Enhance 关闭。
- **提示词策略**：工作区路径、真实修复、依赖真实性、fixture、外部 API 和完成证据由共享 Prompt Policy 注入；角色 Skill 只补充当前职责，避免重复规则在不同 prompt 中漂移。
- **Debug-wiki**：默认复制并加载 XCompiler 自身路径的 `.xcompiler/debug-wiki/`（设置 `XC_PATH` 时使用 `$XC_PATH`），也可通过 `--debug-wiki-path <dir>` 指定。存储和处理参考 LLM-wiki：`wiki/system/*.md` 是系统级策略，`wiki/agent/*.md` 是 agent/calibration 级规则，`wiki/external/*.md` 是已关闭 Bug Ticket 的修复知识，`index.md` 是可读目录，`index.json` 是检索索引，`log.md` 是追加式操作日志，`wiki/external/feedback.jsonl` 是运行反馈 overlay。
- **统计与评分**：`.xcompiler/tickets/summary.json` 分开统计 Enhance 类别、CR 数量/revision、状态和 provider 影响。Enhance 对被归因的作者模型产生质量扣分；缺口被最终验证后奖励发现它的验证模型；Bug 修复或 CR 实施只有通过对应门禁后才产生加分；单纯创建 CR 不修改评分。
- **审计日志**：`.xcompiler/audit.jsonl` 使用独立的 `ticket.enhance.*`、`ticket.change-request.*` 和 `ticket.bug.*` 事件，LLM trace、debug cache、debug-wiki 反馈与 `docs/process_log.md` 同步记录关键事件和错误上下文。

---

## 5. V 模型阶段与产物

### 5.0 阶段纯度（禁止越阶产出）

| 阶段 | 允许产出 | 明确禁止 |
| --- | --- | --- |
| REQUIREMENT_ANALYSIS | `docs/01-requirement-analysis.md`、功能测试计划、可执行功能/验收测试 | 产品实现代码、把测试编写推迟到 FUNCTIONAL_TEST |
| HIGH_LEVEL_DESIGN | `docs/02-high-level-design.md`、系统接口、外部 API、依赖确认、可执行模块/契约测试 | 产品实现代码、把测试编写推迟到 MODULE_TEST |
| DETAILED_DESIGN | `docs/03-detailed-design.md`、模块内部设计、可执行集成测试 | 产品实现代码、把测试编写推迟到 INTEGRATION_TEST |
| CODE | `src/**`、运行资产、单元测试计划、可执行单元测试 | 跳过设计契约、把测试编写推迟到 UNIT_TEST |
| UNIT_TEST | 既有单元测试的完整性检查、执行证据和验证报告 | 创建或修改 `src/**`、`tests/**` |
| INTEGRATION_TEST | 既有集成测试的完整性检查、依赖/API 联调证据和验证报告 | 创建或修改 `src/**`、`tests/**`，访问失败后跳过门禁 |
| MODULE_TEST | 既有模块/契约测试的完整性检查、执行证据和验证报告 | 创建或修改 `src/**`、`tests/**`，绕过模块契约 |
| FUNCTIONAL_TEST | 既有功能测试的完整性检查、功能验收、README、QuickStart、库项目 API Guide | 创建或修改 `src/**`、`tests/**`，未通过入口/API 验证却交付 |

> Plan Lint 会检查越阶产出、V 模型阶段完整性、Step 子任务深度和输出路径冲突，并拒绝写入可执行计划。
>
> DEBUG 不属于计划阶段。它是 Bug Ticket 专属修复模式，产物为 stage-aware DebugBrief、
> `bugResolutionPlan`、patch/rewrite 与重跑验证证据；空 patch、跳过错误或弱化测试均不能关闭 Ticket。

| V 模型配对 | 测试计划与用例生成时机 | 验证阶段职责与失败回退 |
| --- | --- | --- |
| REQUIREMENT_ANALYSIS -> FUNCTIONAL_TEST | 需求分析同步生成验收计划和可执行功能测试 | 检查并运行既有测试；失败回退到需求分析 |
| HIGH_LEVEL_DESIGN -> MODULE_TEST | 概要设计同步生成模块测试计划和可执行契约测试 | 检查并运行既有测试；失败回退到概要设计 |
| DETAILED_DESIGN -> INTEGRATION_TEST | 详细设计同步生成集成测试计划和可执行集成测试 | 检查并运行既有测试；失败回退到详细设计 |
| CODE -> UNIT_TEST | 编码同步生成单元测试计划和可执行单元测试 | 检查并运行既有测试；失败回退到编码 |

### 5.1 依赖清单约定

- Python 的 `plan.dependencies` 使用可由 pip 解析的裸包名，运行前由 XCompiler 统一校准并种入
  `requirements.txt`；Step 不得直接把该文件列为输出，新增依赖通过 `add_dependency`。
- TypeScript greenfield 由 `HIGH_LEVEL_DESIGN` 创建 `package.json`；feature / refactor / self 默认复用现有
  manifest，只有需求确实涉及依赖或脚本时才修改。
- DEBUG 模式缺包时通过 `add_dependency` Skill 安装并**回写**到依赖清单，确保声明与运行一致。

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
| Debugger  | Bug Ticket 分析与路由、patch/rewrite 修复、debug-wiki 沉淀 | `xcompiler run` |

---

## 7. Tool 与 Skill

### 7.1 原子 Tool

| 类别       | 工具                                    |
| -------- | ------------------------------------- |
| 文件       | `read_file`、`write_file`、`append_file`、`apply_patch` |
| 代码       | `code_search`、`symbol_search`          |
| 执行       | `run_program`、`run_tests`（Sandbox 内）  |
| 包管理      | `install_deps`                        |
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
| `add_dependency`  | 更新依赖清单 + `install_deps`                       | 补依赖并固化声明                 |
| `run_tests`       | Sandbox 内执行语言对应测试命令                       | 局部 / 全量回归                 |
| `run_program`     | Sandbox 内执行 Python 或 TypeScript 程序             | 复现 bug、验证入口              |
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
质量门禁不足 → 创建 Enhance Ticket
             → S1-S4 completion/alignment：原阶段按缺口增量补齐
             → S5-S8 coverage/tolerance：回退配对源阶段增量补齐
             → HLD / DD 契约变化：创建 change-request 向下游传导
             → 原验证阶段通过且相关 CR 关闭：Enhance = closed

Sandbox / 测试失败 → 创建 Bug Ticket + DebugBrief
             → 检索 debug-wiki system/agent/external 的历史问题/方案/反馈摘要
             → Debugger LLM 输出 bugResolutionPlan
             → 选 Skill 修改源码 (apply_patch / replace_in_file / add_dependency …)
             → CODE 等局部修复：Bug = verification → 重跑对应门禁
                → 通过：写入 debug-wiki → Bug = resolved → closed
             → HLD / DD 设计修复：创建 change-request Ticket，Bug = blocked
                → 下游 Task 按 CR 增量实施并记录 change / verification commit
                → 门禁失败：创建关联 Bug，同一 CR revision + 1
                → 契约/范围实质扩大：创建 parent-linked child change-request
                → 全部受影响门禁通过：CR = closed
                → 解除 Bug 阻塞 → 写入 debug-wiki → Bug = resolved → closed
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
├── .xcompiler/                # 锁、审计、项目记忆、debug cache、自举报告
│   └── tickets/
│       ├── index.json         # feature/task/sub-task/bug/enhance/change-request 当前快照
│       ├── summary.json       # Enhance/CR/状态/provider 影响统计
│       ├── events.jsonl       # 追加式 Ticket 创建、关联、阻塞、验证与关闭事件
│       ├── <TICKET-ID>.json   # 强类型机器可读快照
│       ├── <TICKET-ID>.md     # 人类可读摘要
│       └── <BUG-ID>/          # 原始错误、repair patch、修复摘要
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
