# XCompiler ProjectManager 模型角色重构计划

## 1. 文档状态

**已实施（方案 B）。** 不保留向前兼容，不提供迁移脚本。本文记录新增 `ProjectManager` 模型角色的
决策依据与实际改动，不改变 PM 作为领域 Actor 的既有职责。

## 2. 为什么需要它

PM 在领域层早已存在（`role_profile.ts` 的 `project-manager`，能力为 `project-management`、
`phase-control`、`ticket-routing`、`delivery-control`），但**在模型层不存在**。`ROLES` 只有五个：
Planner / Architect / Coder / Tester / Debugger。

后果是：任何需要「以 PM 的立场做判断」的地方，都只能借用一个执行角色。当前已有一处这样的借用 ——
Phase 交付门禁的场景结果判定（`scenario_outcome_judge.ts`），它产出的 finding 走 PM 的
problem-intake 边界，判定本身却由 `Planner` 做出。常量 `SCENARIO_JUDGE_ROLE` 标记了这个位置。

判定与路由归属不一致本身不致命，但它掩盖了一个真实需求：**PM 的判断和执行者的判断，关心的东西不
同**。执行者关心「我这一步做对了吗」，PM 关心「这件事对项目意味着什么、该由谁承接」。把两者压在
同一个角色上，等于让实现者给自己的工作做交付判定。

## 3. 阻塞性约束（实施前必须先解决）

`src/config/config.ts:196` 对 `ROLES` **逐个强制校验**：

```ts
for (const role of ROLES) {
  if (explicit.length === 0 && pool.length === 0) ctx.addIssue({ ... });
}
```

因此把 `ProjectManager` 加进 `ROLES` 会让**所有现存 config.yaml 在加载期直接校验失败** ——
不是运行到门禁才报错，而是任何命令都起不来。这是本计划最重要的一条：**新增角色是破坏性变更**。

`src/config/config.ts` 的 `roles` 与 `role_fallbacks` 均为 `.strict()`，也就是说旧配置里
没有 `ProjectManager` 键 → 缺失校验触发；新配置若被旧版本 XCompiler 读到 → 多余键触发 strict 拒绝。
两个方向都不兼容。

## 4. 迁移策略：三选一

### 方案 A：可选角色 + 显式回退链（推荐）

`ProjectManager` 加入 `ROLES`，但从 `config.ts` 的全覆盖校验中豁免；未配置时按声明顺序回退到
`Planner`。

- **优点**：旧配置零改动即可运行；新配置可以选择性地为 PM 指定更强的模型（PM 判定是低频高价值调用，
  值得单独配置）。
- **代价**：`ROLES` 内部出现「必配」与「可选」两类，校验逻辑不再统一。需要一个显式的
  `OPTIONAL_ROLES` 集合，并让 doctor / preflight 对可选角色报告「未配置，将回退到 X」而非报错。
- **落点**：`core/plan.ts`（ROLES + OPTIONAL_ROLES）、`config/config.ts`（豁免）、
  `llm/router.ts`（`resolveChain` 增加声明式回退）、`core/doctor.ts`（区分缺失与未配置）。

### 方案 B：强制角色 + 配置迁移

`ProjectManager` 与其他角色同等对待，同时提供 `xcompiler config migrate` 或在加载期自动补全
（缺失时写回 `Planner` 的 provider 池并提示）。

- **优点**：`ROLES` 语义保持统一，没有两类角色。
- **代价**：破坏性。所有既有工作区的 config 必须迁移；自动补全等于替用户做配置决定，与 AGENTS.md
  「行为选择放进受校验的配置，不要隐式代选」相冲突。

### 方案 C：不加模型角色，改为角色能力标签

不动 `ROLES`，而是让调用方声明**需要什么能力**（如 `delivery-judgement`），由路由器映射到已配置
的角色。

- **优点**：完全兼容；能力与角色解耦，未来新增判定场景不必再加角色。
- **代价**：引入第二套角色词汇，与领域层 `role_profile.ts` 的能力概念重叠但不同源 ——
  「同一概念两个判定点」，这是本仓库反复付出代价的形状。

**已选 B。** 优先保证功能完整性：PM 是一等角色，不做可选降级，因此不存在「静默借用其他角色」这种
中间状态。代价是所有既有 config.yaml 必须补上 `ProjectManager` 键，这是明确接受的破坏性变更。

## 5. 已实施的内容（方案 B）

1. **契约**：`ROLES` 改为由 `EXECUTION_AGENTS` 派生 —— `[...EXECUTION_AGENTS, 'ProjectManager']`。
   两份平行列表是「Step 的 role 只能取执行角色」这条约束失效的地方，所以只保留一处定义。
2. **执行边界**：`StepSchema.role` 由 `z.enum(ROLES)` 收紧为 `ExecutionAgentSchema`。类型检查当场
   抓出了这处松弛 —— PM 若能被指派为 Step 执行者，就等于让判定者去做它随后要评判的工作。
3. **接入**：`SCENARIO_JUDGE_ROLE` 改为 `'ProjectManager'`，判定与 finding 路由自此指向同一所有者。
4. **配置**：`config.yaml` 与 `config.example.yaml` 均补上 `ProjectManager`。
5. **回归**：`ROLES` 含 PM、`StepSchema` 拒绝 PM，两条各自证伪有效；doctor 中写死的角色数量断言
   改为从 `ROLES.length` 推导 —— 该测试的意图是「不可达 provider 对每个角色都报告」，与角色个数无关。

### 关于「完整 PM 功能」的实测结论

PM 的四项领域能力里，**只有 `delivery-control` 需要模型**。另外三项是刻意确定性的：
`ticket-routing` 按 `role_profile.ts` 的能力表匹配，`phase-control` 是状态机，problem-intake 按
`report.category` / `report.target` 的**结构化字段**分流。给这三项引入模型判断，等于用猜测替换正在
正常工作的结构化逻辑，与本仓库「按类型化通道分支，不按推测」的规则直接冲突。

因此本次重构没有为 PM 增加新的判定点 —— 完整性体现在**判定与归属终于一致**，而不是把模型塞进更多
位置。

## 6. 不在本计划范围内

- PM 领域 Actor 的职责、容量、路由规则不变。
- 不为 PM 增加新的 Step 类型或 V-model 阶段。
- 不改变 finding 经 problem-intake 进入 PM 的既有路径 —— 那部分已经正确。

## 7. 验收

- 缺少 `ProjectManager` 键的 config.yaml **必须**在加载期被拒绝。方案 B 不提供降级，一个没有配置
  判定者的项目不应该悄悄以为自己有。
- `StepSchema` 拒绝把 `ProjectManager` 指派为 Step 的执行角色。
- `npm run test:core` / `typecheck` / `lint` / `build` 全绿。

已跑：`lint`、`typecheck`、`test:core`（954）、`build`。未跑：`test:integration`、`test:e2e`。
