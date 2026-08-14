# XCompiler 文件树、工程布局与权限闭环重构计划

## 1. 文档状态

- 目标版本：XCompiler 0.3.x 架构收束
- 状态：实施完成，全部本地门禁通过
- 已确认选择：F1 + E1 + C1
- 兼容策略：不兼容旧工程布局；旧工程需要重新构建，不在运行时静默迁移

本计划解决三个相互关联的问题：

1. 项目控制文件与运行态文件错误落入 `worktrees/master`。
2. 文件树同时承担主线和临时 worktree 语义，权威边界不清晰。
3. 权限按单次工具调用重复询问，拒绝会进入 LLM retry，浪费 Token 并污染模型评分。

## 2. 核心决策

### 2.1 master 是唯一权威工程主线

`worktrees/master` 是最终工程内容的唯一权威来源，包括源代码、测试、依赖清单和交付文档。

- PM 只登记 `master` 主线对应的文件树。
- Ticket 和 Gate worktree 不创建、不持久化文件树。
- 所有最终测试、Phase 交付门禁、文件清单和工程发布都以 `master` 为准。
- 临时分支上的候选变更通过 Git diff、ChangeSet、Merge Request 和 Gate 展示，不冒充主线文件状态。

### 2.2 worktrees 只为并行开发准备

`worktrees/` 不是多个可交付工程，也不是多个项目副本的长期存储层。它只用于未来并行开发和隔离验证：

1. CODE Ticket 从当时的 `master` revision fork 出独立分支和 worktree。首次 S1-S3 仍直接在
   `master` 执行；若交付门禁拒绝其候选，Runtime 在回滚 `master` 前把 rejected commit 提升为
   临时纠正 ChangeSet/worktree。
2. Ticket 持久化当前 worktree 的相对路径、分支、revision 和追加式绑定历史；纠正 Ticket 继承问题发现位置，跨 Step 回退不切回 `master`。
3. Gate worktree 将候选分支与目标 `master` 组合，执行合并前门禁。
4. Gate 通过后，ChangeSet squash/merge 到 `master`。
5. 合并成功后重扫 master 文件树，下游 V 模型 Step 只读取更新后的 master。
6. 通过或基础设施失败的 Gate candidate 可在状态持久化后清理；产品门禁失败的 candidate 保留并提升为 ChangeSet 纠正树，直到修复重新门禁并合并。
7. Ticket/Gate worktree 不参与最终发布；完成合并后释放，最终状态始终以 `master` 为准。
8. rejected candidate 的 workspace binding 随 Bug、Enhancement 和 CR 因果链传递；Enhancement
   使用 finding 的结构化 `affectedArtifacts` 限制写入，CR 只能修改当前 Step 拥有的产物。

最终工程发布只使用 `worktrees/master`。工程根目录下的 `.xc` 和计划文件属于 XCompiler 控制面，不进入生成产品的发布包；`.xcompiler` 和其他 worktree 永远不进入发布包。

### 2.3 项目内部操作不请求外部授权

采用 E1：

- 项目容器内文件读写由工程自身的 Step outputs、Tool allowlist、EditGuard、Ticket 和 Gate 管理，不弹外部权限 QA。
- sandbox 内的程序执行和测试属于工程内部行为，不逐次请求外部授权。
- 项目容器外文件访问继续最高优先级硬拒绝，不提供 QA，也不能被 `auto` 绕过。
- 外部网络、依赖仓库、Docker/宿主服务以及已有用户仓库的受保护 Git 写入属于系统资源，按运行周期授权。

### 2.4 权限拒绝只允许一次受控适配

采用 C1：权限拒绝或超时完成当前工具判断闭环后，允许 LLM 进行一次新的动作规划以寻找不依赖该权限的替代方案。

这次适配：

- 不计入 provider retry。
- 不切换模型。
- 不降低模型评分。
- 不增加 Ticket attempt。
- 不产生 Bug 或 Enhance Ticket。
- 必须携带本运行周期已拒绝的 capability，禁止模型重复请求同一权限。

如果没有可行替代方案，当前工作以 `permission_blocked` 返回 PM，而不是伪装成代码错误。

## 3. 目标目录结构

```text
<project-root>/
├── <project-name>.xc
├── phasePlan.json
├── plan.P1.json
├── plan.P2.json
├── .xcompiler/
│   ├── objects/
│   ├── registry/
│   ├── audit/
│   │   ├── audit.jsonl
│   │   ├── process_log.md
│   │   ├── summary.md
│   │   └── edits/
│   ├── cache/
│   ├── debug-wiki/
│   ├── record-replay/
│   ├── sandboxes/
│   ├── drafts/
│   ├── history/
│   └── locks/
└── worktrees/
    ├── master/
    │   ├── src/
    │   ├── tests/
    │   ├── docs/
    │   ├── README.md
    │   └── package.json / requirements.txt
    ├── tickets/<ticket-id>/
    └── gates/<merge-request-id>/<gate-run-id>/
```

## 4. 文件归属规则

| 文件类别 | 目标位置 | 是否进入 master Git | 是否进入发布包 |
| --- | --- | --- | --- |
| `<name>.xc` | 工程根 | 否 | 否 |
| `phasePlan.json` | 工程根 | 否 | 否 |
| `plan.P<N>.json` | 工程根 | 否 | 否 |
| `docs/topic.md` | `worktrees/master/docs` | 是 | 按项目交付策略 |
| `docs/plan.md` | `worktrees/master/docs` | 是 | 按项目交付策略 |
| S1-S8 文档、README、QuickStart、API Guide | `worktrees/master` | 是 | 是 |
| PM 对象、Registry、Projection | 工程根 `.xcompiler` | 否 | 否 |
| 审计与 EditGuard 日志 | 工程根 `.xcompiler/audit` | 否 | 否 |
| Record/Replay fixtures | 工程根 `.xcompiler/record-replay` | 否 | 否 |
| Debug Wiki | 工程根 `.xcompiler/debug-wiki` | 否 | 否 |
| 草稿和历史归档 | 工程根 `.xcompiler/drafts`、`.xcompiler/history` | 否 | 否 |
| Ticket/Gate `.xcw` | 对应临时 worktree | 否 | 否 |

`docs/topic.md` 和 `docs/plan.md` 保留在 master，因为它们是版本化工程文档；机器可执行计划 JSON 和 `.xc` 是项目控制面文件，必须位于工程根。

### 4.1 审计保真与摘要索引

- `audit.jsonl` 是只追加的机器审计真源，保留完整事件字段和原始数据记录；不得为了控制体积删除历史、覆盖事件或裁剪有效载荷。凭据等敏感字段仍按安全策略脱敏。
- `process_log.md` 保留完整的人类可读过程记录，不以摘要替代，也不参与自动瘦身。
- `summary.md` 是从原始 JSONL 可重建的派生索引，只保存会话范围、事件统计、关键错误、状态跳转及门禁结果等高信号信息。
- 摘要中的会话、错误和关键事件必须链接到 `audit.jsonl` 的具体行号；存在独立对象记录路径时，同时链接对应对象文件，允许按需追溯完整数据。
- 摘要生成失败不得影响原始审计追加；后续运行应从完整 JSONL 重建摘要，不能以摘要反向覆盖原始记录。

## 5. ProjectContainer 边界

`ProjectContainer` 需要显式提供三个互不混用的地址空间：

- `control`：工程根，保存 `.xc`、PhasePlan 和 Phase plan JSON。
- `state`：工程根下 `.xcompiler`，保存运行态和治理数据。
- `canonical`：`worktrees/master`，保存最终工程内容。

建议新增统一路径对象，禁止调用方自行 `path.join` 推断归属：

```ts
interface ProjectPaths {
  root: string;
  control: Workspace;
  state: Workspace;
  canonical: Workspace;
  canonicalBranch: 'master';
}
```

需要移除“以 canonical workspace 推导控制文件路径”的现有模式：

- `defaultPhasePlanPath(ws.root)` 改为基于 `container.control`。
- `defaultPhasePlanStepPath(...)` 固定关联工程根的 PhasePlan。
- `updateProjectFile()` 在工程根发现和更新 `.xc`。
- `run` 默认从工程根读取 `phasePlan.json`。
- `.xc.workspace` 指向 `worktrees/master`，`.xc.container` 指向工程根，`.xc.planPath` 指向工程根 `phasePlan.json`。
- `PhaseProgressionService` 分别接收 control workspace 和 canonical workspace。

## 6. master 文件树模型

### 6.1 唯一性

每个 Project 只能存在一个持久化 `file-tree` 对象：

```ts
interface CanonicalFileTree {
  projectId: ObjectId;
  branch: 'master';
  entries: FileTreeEntry[];
  ignoredPrefixes: string[];
  dirty: boolean;
  scannedAt?: string;
  reconciledRevision?: string;
}
```

PM 的 `fileTree` 只保存 master 的所有权引用：

```ts
interface FileTreePolicy {
  fileTreeId: ObjectId;
  branch: 'master';
  publishManifestOnDelivery: boolean;
}
```

绝对 workspace path 不作为文件树身份。真实路径由 `ProjectContainer.canonical()` 解析，避免 `/tmp` 与 `/private/tmp` 别名产生重复树。

### 6.2 更新时机

1. Runtime 冷启动：解析或创建 master 文件树并执行一次 rescan。
2. master 内部工具写入：增量更新文件及其新建父目录。
3. Ticket worktree 写入：不更新 master 文件树。
4. squash/merge 成功：在 domain merge 状态落盘后立即 rescan master。
5. Phase 交付前：强制 rescan，并校验 Git HEAD 与 `reconciledRevision` 一致。
6. 索引更新失败：保留磁盘写入结果，但设置 `dirty=true`、写审计并安排重扫，禁止静默漂移。

### 6.3 路径和扫描安全

- 文件树路径必须是严格的 workspace-relative POSIX path。
- 拒绝绝对路径、盘符、NUL、`.` 空路径和任何 `..` segment。
- 项目外路径在进入文件树服务之前即硬拒绝。
- `ENOENT` 可作为扫描中的并发删除处理；`EACCES`、`EIO` 等错误必须上抛。
- 首次创建使用 project-scoped single-flight/lock，避免并发 worker 创建重复对象。
- `file-tree` Registry parent 固定为 Project ID。

### 6.4 交付文件清单

交付清单从最终 rescan 的 master 文件树生成。承载清单的交付文档属于自引用文件，其行只展示 path/type，并把 size/mtime 标为 generated，避免“写入清单后自身 metadata 再变化”的递归不一致。

## 7. 权限模型

### 7.1 配置

```yaml
permissions:
  mode: request       # request | auto | deny
  timeout_ms: 0       # 0 = 永不超时
  grant_scope: resource
```

- `request`：首次访问外部 capability 时请求用户授权。
- `auto`：对策略允许请求的外部 capability 静默批准并审计。
- `deny`：对外部 capability 静默拒绝并审计。
- `auto` 不能绕过项目外文件硬拒绝、Tool allowlist、Step outputs、sandbox policy 或 Git Gate。
- `--permission-mode` 可覆盖本次运行配置；`--yes` 只处理 Build 计划确认，不再兼任权限开关。

### 7.2 资源分类

| 操作 | 分类 | 外部 QA |
| --- | --- | --- |
| 项目容器内读写 | 工程内部 | 否 |
| Ticket/Gate worktree 内读写 | 工程内部 | 否 |
| sandbox 内 run/test | 工程内部 | 否 |
| 项目容器外文件读写 | 禁止 | 不询问，硬拒绝 |
| HTTP/API 外部访问 | 系统资源 | 按 origin 首次请求 |
| dependency registry 下载 | 系统资源 | 按 registry 首次请求 |
| Docker daemon/宿主服务 | 系统资源 | 按服务首次请求 |
| XCompiler 创建仓库的 master merge | 工程内部治理 | 不额外请求，仍需 Gate |
| 已有用户仓库的受保护 Git 写入 | 系统资源 | 按 repository/branch 请求 |
| LLM provider 请求 | Runtime 基础设施 | 配置 provider 即授权，不走项目工具 QA |

### 7.3 运行周期共享缓存

权限 Broker 生命周期覆盖一次完整 Runtime task：CLI `run`、`evolve`、`append`，或 ACP Code Agent 的 Build + Run task。

缓存 key 使用：

```text
projectId + runId + operationType + normalizedResourceScope
```

例如网络按 URL origin，共享给当前工程的全部 Phase、Step、Ticket、角色和 Agent。批准与拒绝都缓存；并发相同请求通过 single-flight 共用同一个 QA。

PM/治理层只为首次授权决策创建 Interaction 和 Decision。后续命中缓存只追加引用原决策的审计事件，不重复创建权限对象。

### 7.4 完整状态机

```text
LLM_GENERATE
  -> ACTION_VALIDATE
  -> RESOURCE_CLASSIFY
       -> INTERNAL_ALLOWED -> TOOL_EXECUTE
       -> HARD_DENIED      -> TOOL_PERMISSION_DENIED
       -> EXTERNAL         -> PERMISSION_CACHE
            -> GRANTED     -> TOOL_EXECUTE
            -> DENIED      -> TOOL_PERMISSION_DENIED
            -> MISS        -> PERMISSION_WAIT
                 -> APPROVED -> CACHE_GRANTED -> TOOL_EXECUTE
                 -> REJECTED -> CACHE_DENIED  -> TOOL_PERMISSION_DENIED
                 -> TIMEOUT  -> CACHE_DENIED  -> TOOL_PERMISSION_TIMEOUT
  -> TOOL_RESULT_COMPLETE
  -> NEXT_AGENT_DECISION
```

`PERMISSION_WAIT` 期间：

- 不启动新的 LLM 请求。
- 暂停 Agent round/watchdog。
- 不触发 provider fallback。
- 不更新模型评分。
- 不增加 Step/Ticket attempt。

拒绝或超时后只允许一次 C1 适配轮次；重复请求同一 denied capability 由 Action Policy 本地拦截，不再 QA。无法继续时返回 `permission_blocked` 给 PM。

## 8. Adapter 调整

### CLI

- 所有执行入口统一支持 `--permission-mode request|auto|deny`。
- `--yes` 仅代表 Build 澄清/计划门禁使用默认确认，不再隐式允许敏感操作。
- CLI prompt 展示 resource scope、风险和“本次运行共享”含义。
- 默认 `timeout_ms=0`，保持无限等待。

### ACP

- Runtime Broker 持有缓存，ACP Adapter 只转换首次 MISS 请求。
- 权限 UI 使用“Allow for this run”和“Deny for this run”语义。
- Task 状态在 `waiting_for_permission` 期间保持原 Agent/Tool 调用上下文。
- 取消或配置超时必须完成原 pending tool call，并返回 typed outcome；不得让模型在后台重试。

## 9. 实施阶段

### Phase A：目录和路径边界

1. 引入 control/state/canonical 三类 workspace。
2. 移动 `.xc`、PhasePlan、Phase plan JSON 到工程根。
3. 移动审计、EditGuard、Record/Replay、draft/history 到根 `.xcompiler`；保留完整原始审计并额外生成带原始记录链接的 `audit/summary.md`。
4. 更新 build/run/load/append/evolve/inspect/project-memory 的路径解析。

### Phase B：master 唯一文件树

1. 将 FileTree schema 改为 canonical branch 单例。
2. 移除 per-worktree resolver 和临时树持久化。
3. 修复父目录、路径校验、扫描错误、dirty/reconcile 和 Registry parent。
4. 在成功 merge 与 Phase 交付前重扫 master。

### Phase C：权限 Broker

1. 新增 Runtime task-scoped PermissionBroker。
2. 实现 resource key、single-flight、grant/deny cache 和 timeout。
3. 将项目内部操作从外部 permission policy 中移除。
4. 将拒绝/超时改为 typed control outcome，移除 permission denial retry guard。
5. 统一 CLI、ACP 和程序化 Runtime 入口。

### Phase D：回归和真实工程验证

1. 单元测试目录分类、文件树唯一性和路径边界。
2. 并发测试：多个 CODE worker 不能创建多个 master 树或重复 QA。
3. 集成测试：Ticket fork -> Gate -> merge -> master rescan。
4. 权限测试：request/auto/deny、无限等待、可配置超时和 C1 适配。
5. 真实工程验证最终发布内容只来自 `worktrees/master`。

## 10. 验收门禁

- 工程根只有控制面文件和 `.xcompiler` 状态，不混入产品发布内容。
- master Git 不再跟踪 `.xc`、`phasePlan.json` 或 `plan.P<N>.json`。
- PM 只引用一个 `branch=master` 的文件树。
- Ticket/Gate worktree 没有持久化 file-tree 对象。
- merge 后 master 文件树与 Git HEAD 一致。
- 项目内部文件写入、测试和 sandbox 程序执行不弹外部权限 QA。
- 项目外文件访问始终硬拒绝，`auto` 无法绕过。
- 同一外部资源在一次运行周期内最多产生一次权限 QA。
- 权限等待和拒绝不计 retry、不切模型、不降分、不创建缺陷 Ticket。
- 发布/打包输入严格为 `worktrees/master`，不包含工程根控制文件、`.xcompiler` 或临时 worktree。
- 原始审计只追加且完整保留；摘要可从 JSONL 重建，并能链接到对应原始记录。
