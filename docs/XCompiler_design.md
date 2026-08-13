# XCompiler 领域与运行时设计

> XCompiler 是以 Runtime 为唯一业务入口、以领域对象和 Ticket 驱动迭代式 V 模型的软件工厂。

## 1. 设计目标

- `build` 负责需求澄清、复杂度判断、Phase 总计划和当前 Phase 详细计划。
- `run` 负责无普通聊天交互的自动执行，只在敏感操作时请求授权。
- CLI、ACP 和未来的 REST/GUI/SDK 都只能调用 Runtime。
- Planner 输出是可审阅的执行规格，领域对象才是生命周期、恢复和审计真相。
- 每次迭代都是完整 V 模型；错误不能跳过门禁，必须形成 Ticket 并按配对关系回退。
- 所有持久化对象使用全局唯一 UUIDv7；`name` 仅作为可读标签。

## 2. 分层架构

```text
CLI / ACP / future adapters
             |
             v
XCompiler Runtime
  Build Service | Run Service | Events | Permissions
             |
             v
Application execution
  ProjectOrchestrator(PM) | WorkScheduler | CorrectiveWorkflow
  DomainAttemptRunner | Quality | Record/Replay | Projection
             |
             v
Domain
  Project | Phase | Step | Ticket | Assignment | Decision | Risk | Evidence
             |
             v
Infrastructure
  DomainObjectRepository | ObjectRegistry | Workspace | Git | Sandbox
             |
             v
Agents | Skills | Tools | Plugins | LLM Router | Debug Wiki
```

Adapter 只负责参数或协议、配置、交互、输出和退出码。它不得直接调用 Planner、Agent、Tool、Plugin、Memory、文件系统或命令执行实现。

## 3. 统一对象模型

每个持久化对象都包含统一 envelope：

```ts
interface ObjectEnvelope {
  id: ObjectId;          // UUIDv7，全局唯一且不可变
  name: string;          // P1-S004 等展示名，不参与关联
  objectType: ObjectType;
  projectId: ObjectId;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

对象类型：

| 对象 | 责任 |
| --- | --- |
| Project | 项目主题、Phase 集合、当前 Phase、项目交付和报告 |
| ProjectPlan | 复杂度、PhasePlan 列表、当前 Phase 与规划来源摘要 |
| Phase | 一次迭代目标、依赖、Epic、八个 Step 和阶段门禁 |
| PhasePlan | 单个 Phase 的范围、Step 列表、验证门禁和物化状态 |
| Step | V 模型阶段、输入输出、依赖、配对、KPI、尝试次数和状态 |
| Ticket | 工作、缺陷、增强和变更传导的唯一工作载体 |
| KPI / QualityAssessment | 可量化门槛、观测值、容差、证据和判定 |
| Changelist | Ticket 在某个 Step 的增量修改、commit 和验证证据 |
| Checkpoint | 不可变的对象快照引用和事件序号 |
| Deliverable / Report | 交付路径、验收条件和阶段/项目报告 |
| Log / AuditEvent | Ticket 日志及带 correlation/causation 的领域审计 |
| ActorRegistration / Assignment | 角色能力注册、Ticket 所有权和容量 |
| ProjectManagementPlan | PM 范围基线、状态、风险、决策和交互索引 |
| Decision / Risk / InteractionRequest | PM 决策、风险控制和用户授权证据 |
| TicketTraceEvent | 只追加、哈希链保护的 Ticket 流转调用链 |
| DomainEvent | 与对象修改同一 UnitOfWork 提交的 outbox 事件 |

关系只保存 ID 或 `{ id, objectType }`。父 ID 是权威关系；子列表和反向依赖是可校验投影。

## 4. Planner 与领域边界

`phasePlan.json` 和 `plan.P<N>.json` 是 Planner 规格：

- `phasePlan.json` 先描述一个或多个 Phase 的目标、范围、依赖和交付门禁。
- 只为当前 Phase 生成 `plan.P<N>.json`，后续 Phase 到达时才物化。
- Planner Step 使用 `S001` 等局部标签，包含 prompt、工具、输入、输出和最多两层子任务。
- Planner 文件不包含运行状态、重试状态或恢复游标。

Build 通过 Planning Compiler 一次性创建当前领域图，并由 PM 立即注册全部 Ticket、记录活动 Phase 选择、导入澄清记录并刷新项目状态投影：

```text
Project
  ProjectPlan
  Phase P1 -> Epic P1
    Step P1-S001 -> Story -> Task -> Task
    ...
    Step P1-S008 -> Story
    Delivery Story
  Phase P2 (skeletal, not materialized)
```

`append/evolve` 保留现有 Project 和 ProjectPlan ID，把新需求重编号为后续 Phase。首个新增 Phase/Epic 依赖原末尾 Phase/Epic，不会替换或孤立已有 Ticket、报告和审计。

## 5. 迭代式 V 模型

每个 Phase 固定八个 Step：

```text
REQUIREMENT_ANALYSIS ---------------------- FUNCTIONAL_TEST
       HIGH_LEVEL_DESIGN --------------- MODULE_TEST
              DETAILED_DESIGN ------- INTEGRATION_TEST
                         CODE --- UNIT_TEST
```

配对关系：

| 产出阶段 | 验证阶段 | 同步生成内容 |
| --- | --- | --- |
| REQUIREMENT_ANALYSIS | FUNCTIONAL_TEST | 功能验收基线计划和可执行用例 |
| HIGH_LEVEL_DESIGN | MODULE_TEST | 系统、模块和接口契约测试 |
| DETAILED_DESIGN | INTEGRATION_TEST | 集成场景和测试 |
| CODE | UNIT_TEST | 单元测试计划和用例 |

门禁包含三类验证：交付物/方案校验、配对基线测试、风险驱动的追加功能测试。S1-S4 产出阶段交付物和配对基线测试，其门禁由“阶段特有的交付物/方案校验 + 基线测试资产校验与执行”组成。首次正向执行 S1-S3 时产品代码尚不存在，只显式跳过基线的可执行运行；交付物、方案、追溯关系以及基线测试资产仍必须通过校验。S4 始终执行单元基线。任何由 S4-S8 发现的问题回退到 S1-S3 后，代码基线已经存在，回退阶段必须执行其精确配对基线后才能重新交付。

| Step 场景 | 本阶段产生 | 交付门禁 | 基线执行策略 |
| --- | --- | --- | --- |
| S1-S3 首次正向执行 | 阶段交付物、阶段特有校验依据、配对基线测试 | 交付物/方案校验 + 基线测试资产校验 | 仅跳过可执行运行，并记录 `initial-pre-code` |
| S1-S3 纠正执行，因果链起点在 S1-S3 | 对本阶段交付物和基线的增量修正 | 交付物/方案校验 + 基线测试资产校验 | 仍无代码基线时跳过，并记录 `pre-code-correction` |
| S1-S3 纠正执行，因果链起点在 S4-S8 | 对本阶段交付物和基线的增量修正 | 交付物/方案校验 + 精确配对基线 | 必须执行；Bug、Enhancement、父/子 CR 的多层传递不得丢失原始回退阶段 |
| S4 | 代码交付物、单元基线测试 | 交付物/方案校验 + 单元基线 | 必须执行 |
| S5-S8 | 独立风险分析和验证阶段拥有的追加功能测试 | 冻结后的配对基线 + 追加功能测试 | 必须完整执行 |

该规则由领域对象直接承载：`DeliveryGate.validationTypes` 保存 `deliverable-validation`、`baseline-test`、`supplemental-functional-test` 的组合，`baselineExecutionPolicy` 保存 `defer-until-code`、`required`、`freeze-then-required` 或 Phase 聚合策略。状态机依据这些字段执行，LLM 不能通过自定义 Step 文本改写门禁类别。

S5-S8 不修改左侧基线：它们独立复核基线并做风险分析，只能在各自的验证命名空间追加聚焦的功能测试；随后冻结“基线 + 追加测试”集合并完整执行。测试自身缺陷、产品缺陷、完整度/质量短板分别建票，依赖问题走独立路由。八个 Step 都不拥有绕过 Record/Replay 的真实网络特权。

## 6. Ticket 模型

Ticket 类型固定为：

- `epic`：一个可交付 Phase。
- `story`：八个 Step 工作项和最终 Delivery 工作项。
- `task`：Story 下的计划工作，最多再嵌套一层 Task。
- `bug`：错误行为、命令失败、测试失败或异常，进入 Debug 流程。
- `enhancement`：功能缺口、测试不完备或质量指标不足。
- `change-request`：承接已接受上游变更，向受影响下游 Step 传导增量。

Ticket 通用字段包含角色、Agent、0-255 优先级、父/根 Ticket、依赖、阻塞项、关联项、检查点、日志、changelist、solution 和 source。source 保存 correlation ID、causation ID 及外部来源。

Ticket 状态机：

```text
created -> in_progress | pending | cancelled
pending -> in_progress | cancelled
in_progress -> pending | resolved | cancelled
resolved -> closed | reopened
reopened -> in_progress | cancelled
cancelled -> reopened | closed
```

Bug、Enhancement、CR 没有 `verified` solution 时不能进入 `resolved`。

## 7. Step、Phase 与 Project 状态

Step：

```text
created -> in_progress | pending
pending -> in_progress
in_progress -> delivered | pending
delivered -> closed | reopened
reopened -> in_progress
closed -> reopened   # 已验证上游 CR 可重新打开
```

每个 Step 都包含结构化 `deliveryGate`：

- S1 额外校验需求产物对 topic 的追溯、可观测验收条件、范围、约束和未决项，并校验功能基线设计。
- S2 额外校验系统定位、模块边界、外部接口/API、依赖和所有权，验证架构可行性及模块测试追溯。
- S3 额外校验内部数据/控制流、异常处理、实现契约和上游架构对齐，验证实现方案及集成测试追溯。
- S4 额外校验代码对详细设计、源码所有权和公开契约的对齐，并执行构建/静态检查与单元基线。
- S1-S3 首轮只将基线执行记录为 `skipped-initial-pre-code`；由 S4-S8 触发的回退不得使用该跳过理由。
- S5-S8 是 `verification-acceptance` 门禁，检查基线独立评审、追加功能测试归属、冻结后的完整执行、KPI 与 tolerance。

Phase 也包含 `deliveryGate`，覆盖完整交付物、集成构建/测试及真实用户场景 case。Runtime 在关闭 Replay 的真实环境运行每个 case，并保存操作、命令、环境、时间、退出状态、超时和输出尾部。Phase 在八个 Step 和所有纠正 Ticket 关闭且 Phase QualityAssessment 通过后执行 Delivery Story，随后 `delivered -> closed`。Project 根据 Phase 依赖选择下一个可运行 Phase；所有 Phase 关闭后才 `delivered -> closed`。

## 8. 调度规则

Application 层的 PM Orchestrator 是唯一项目推进者；它通过 `WorkScheduler` 选择工作，通过领域状态策略验证每次跳转：

1. 优先恢复唯一的 `in_progress` Step/Ticket。
2. 否则按 Step 依赖选择首个就绪项。
3. 同一 Step 优先执行未阻塞的 CR，其次 Bug、Enhancement，最后普通 Story。
4. CR 已记录 application 的 Step 不得重复调度。
5. Step 尝试前递增 `attempts`；达到 `maxAttempts` 时明确失败。
6. 没有可运行项时，执行 Phase `deliveryGate`；只有所有 Step、Story、纠正 Ticket、完整交付物和真实场景验收通过才允许关闭 Phase。
7. 调度不使用固定的全局跳转次数。`ProjectProgressGuard` 比较 Phase、Step、Ticket、
   ChangeSet、Merge Request 和 Gate 的语义快照；只有连续三次调度后状态完全没有推进才停止，
   因而复杂项目不会因规模大被误杀，真实循环也不会无限消耗模型额度。

数组顺序不构成依赖，显示名不构成身份，Planner 状态不参与裁决。

Ticket 只在 Phase 内产生和消费。Phase 内的 Task、Bug、Enhancement、CR 由掌握技术上下文的发现角色创建；Phase 外部只能向 PM 提交问题、数据和现场，不能构造 Ticket。PM 的统一 intake 校验结构化报告后创建 Phase 内 Ticket，再按能力、状态、容量和稳定排序路由。该入口保留 `external-usage` 来源，用于后续交付后问题重启 V 流程，本版本不开放 Project 自动重激活。所有权由已接受 Assignment 表示；每次提交、注册、路由、接受、转交和关闭都追加不可变 TicketTraceEvent。

## 9. 错误、Enhancement 与 CR

普通 Step 失败：

```text
failure -> Bug -> paired source Step Debug
        -> proposed solution + CR
        -> affected downstream Steps apply delta
        -> every quality gate passes
        -> CR closed -> Bug verified/closed -> Debug Wiki
```

质量门禁不足：

```text
quality gap -> Enhancement -> owning source Step incremental completion
            -> CR -> affected verification -> close
```

CR 下游失败：

```text
parent CR failure -> linked Bug (parent CR pending/blocked)
                  -> paired source Debug
                  -> child CR verifies repair
                  -> child CR and Bug close
                  -> parent CR resumes remaining unapplied Steps
```

失败尝试在 Git 快照事务中执行；未通过门禁时回滚工作区。通过的尝试记录 QualityAssessment、Changelist、commit 和证据。失败日志抽取核心原因并挂到 Ticket 的领域 Log，完整过程仍保留在人类审计文件中。

## 10. 质量门禁

- S1-S4：`completion`、`upstreamAlignment`。
- S5：line/branch coverage、test-case pass rate。
- S6：interface coverage、integration-scenario coverage、pass rate。
- S7：module coverage、contract coverage、pass rate。
- S8：functional coverage、requirement coverage、end-to-end pass rate。
- tolerance：最大失败、跳过、warning 和指标短差。

指标不足创建 Enhancement；实际测试或执行失败创建 Bug。QualityAssessment 是不可替换的领域证据，不使用单独的旧质量状态文件。

门禁结果保留多个独立 `findings`，不得拼成一段错误后只建一张票：

- `test-defect`：验证阶段自己补充的测试有误，Bug 回到当前验证 Step；基线测试契约有误则指向配对源 Step。
- `product-defect`：Bug 指向产品/契约所有 Step，并按 V 模型通过 CR 向下游传播。
- `test-incomplete`、`quality-shortfall`、`deliverable-defect`：分别形成 Enhancement，追加缺失工作。
- `dependency`：不混入 Bug/Enhancement，保持独立 Dependency CR 路由。

一次 Step 或 Phase 门禁可产生多条 finding。发现角色逐条创建 Ticket 并提交 PM；PM 只负责注册、路由、阻塞关系和重启受影响的 V 模型路径。为避免多条纠正链同时关闭同一后续 Step，PM 按最上游受影响 Step 到最下游建立批次调度依赖，依赖类 Ticket 保持独立 CR 路由并排在该批次末尾。任一修复完成后通过 CR 增量传导，并重新执行后续 Step 与 Phase 门禁。

## 11. Debug Wiki

Debug Wiki 按 LLM-wiki 方式组织：

- `system`：系统规则和通用失败模式，随包发布。
- `agent`：Agent 校准和工具使用经验，随包发布。
- `external`：真实生成工程中经完整 CR 链验证的解决方案。

Bug Debug 前检索压缩后的 `DebugBrief`。复用失败会给候选条目写负反馈并标记 `needs_review`；源 Step 修好但下游 CR 未完成时只把候选 ID 和 proposed solution 保存到 Bug，不写 external。全部受影响门禁通过后才新增或修正条目。中断后 Runtime 会补偿同步已关闭但尚未入库的 Bug。

## 12. 持久化与恢复

```text
<name>.xc                              Project manifest
phasePlan.json                         Planner Phase outline
plan.P<N>.json                         current Planner execution spec
.xcompiler/registry/events.jsonl       append-only registry events
.xcompiler/registry/index.json         rebuildable registry snapshot
.xcompiler/objects/<type>/<uuid>/r<N>.json  canonical domain objects, immutable per revision
.xcompiler/cache/pm/project-status.json    rebuildable PM status projection
.xcompiler/record-replay/              redacted external-interaction fixtures
.xcompiler/audit.jsonl                 detailed operational audit
docs/process_log.md                    human-readable process log
docs/project-development-report.md     delivery projection
```

`.xc` 只保存 workspace、配置、当前计划引用和 canonical `projectId`，不复制 Project 状态。恢复时先加载注册表，再通过 Project 的 `currentPhaseId` 和 PM WorkScheduler 恢复精确 Ticket/Step；不存在 `--from`、`--phase` 或 `--reset` 跳过门禁的入口。

注册表每次更新校验对象类型、父关系、Project 归属、revision 和内容哈希。事件流可重放并重建 index；对象损坏、孤儿引用或跨 Project 父关系必须明确报错。

Git 合并使用可恢复的领域事务：门禁通过后先把 Merge Request 持久化为 `mergeable`，再执行带
`[xcompiler:<changeSetId>]` 标记的 squash commit，最后提交 ChangeSet/Merge Request 的
`merged` 状态。若进程在 Git 提交和领域提交之间中断，下次 Run 会核对目标提交的父提交、消息
标记和最近一次通过的 Gate；证据一致时补交领域状态并清理 worktree，证据不一致时明确阻塞，
不会重复合并或伪造完成。

## 13. Record/Replay

HTTP、LLM 和 subprocess 外部交互通过统一端口记录；测试逻辑不内嵌特定 API 的 fixture 规则。S1-S4 可为基线测试使用 `record`/`refresh`，S5-S8 的外部数据补充与冻结执行使用 Record/Replay；只有 Phase 交付门禁声明的真实用户场景强制 `off`。缺失、歧义、哈希链损坏或未脱敏 fixture 都明确失败；`refresh` 追加 supersession 关系，不覆盖历史证据。

## 14. Runtime 事件与权限

Runtime 通过事件暴露 `project_planned`、`phase_started`、`ticket_started`、`step_started`、`ticket_routed`、`step_delivered`、`phase_delivered` 和 `project_delivered`。每个事件都有 `eventId`、`eventVersion`、`occurredAt`，并携带稳定的 Project/Phase/Step/Ticket ID、correlation ID 和 causation ID，同步写入事务 outbox 与领域审计。

Run 中 shell、文件修改、删除、依赖安装、配置修改、Git、网络、测试、构建和工作区外访问都必须通过权限接口。拒绝不能静默：Runtime 要么采用明确替代路径，要么返回失败并写入最终报告。

RuntimeIO 明确声明 `request`、`allow` 或 `deny` 权限策略。CLI 和 ACP Run 使用 `request` 并把
每个敏感操作交给用户；只有嵌入方显式选择 `allow` 才可无交互批准。静默 Runtime 和缺失授权
回调默认 `deny`。任何拒绝会终止当前推进并保持可恢复状态，不能继续执行下游 Step。

ACP 取消把同一 AbortSignal 传入 Build、Run、Planner、Executor 和 OpenAI-compatible 网络请求。权限等待立即取消；无法中断的本地操作以 best-effort 完成后停止，不会静默报告成功。

## 15. 项目交付报告

迭代报告只评估当前 Phase；最终项目报告必须扫描 Project 下的全部 Phase、八阶段 Step、
QualityAssessment、Epic、Delivery、纠正 Ticket 和 PM 状态。只有每个 Phase 都完成完整 V 模型、
所有质量证据通过、全部交付与纠正 Ticket 关闭且 Project 已关闭时，报告才标记 `READY`。
报告中的质量表包含 Iteration 列，关联对象覆盖所有纳入判定的 Phase、Step 和 Ticket，避免后续
Phase 未完成时因当前 Phase 通过而误报项目已交付。

## 16. 不变量

- Runtime 是唯一业务入口。
- 一个 workspace 只能有一个未 tombstone 的 Project。
- 全部持久化引用使用 UUIDv7 ID；`name` 不作为键。
- 一个 Phase 只有一个 Epic、八个配对 Step 和一个 Delivery Story。
- 所有 Ticket 先由 PM 注册；Epic/Story 只能由 PM 创建，其他 Ticket 不能由 PM 代写技术上下文。
- Ticket Trace 只能追加且必须通过哈希链校验，Assignment 是唯一所有权来源。
- 每个 Step 最多有一个进行中的执行 Ticket。
- 任何通过的 Step 必须引用同 Step 的 passing QualityAssessment。
- CR 每个受影响 Step 必须有唯一 verified application 才能关闭。
- Bug 的 Debug Wiki 方案必须晚于完整 CR 验证。
- 失败不能直接跳到后续 Step，也不能通过修改 Planner 文件伪造完成。
- 外部 API 失败是正式错误，必须修复、替换接口或明确失败。
