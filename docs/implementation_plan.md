# XCompiler 实施计划（Implementation Plan）

> 本文件配套 [`XCompiler_design.md`](./XCompiler_design.md)，给出从 0 到 1 的落地步骤。
> 全部用 TypeScript + Node.js ≥ 20 实现；当前目标产物语言：Python、TypeScript。

---

## 当前开发进度（2026-07-05）

### 已提交基线

- 最新提交：`290f28c chore: rename TOAA to XCompiler`。
- 公共品牌、包名、命令、工程文件和运行时状态目录已经切换到 XCompiler / XC / `.xc` / `.xcompiler`。
- 旧 `.toaa` 工程文件与 `toaa.project` payload 仅作为负向兼容测试保留，确保旧格式不会被继续接受。

### 当前未提交增量

- 需求澄清阶段已扩展为“问题 + 2-5 个候选设定 + 用户最终回答”结构。
- 候选设定按优先级排序并从 A 连续标号；实际提示范围按选项数量动态显示 A-B、A-C、A-D 或 A-E。
- 用户输入已展示字母时解析为对应完整候选设定；输入其他内容时作为自定义回答保留。
- Planner 提示词已明确：不要固定每题 3 个选项，也不要把“其他 / 自定义 / 用户决定”作为候选项。

### 当前验证

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npx vitest run tests/clarify_choices.test.ts tests/prompt_language.test.ts tests/planner_clarify.test.ts`：3 个测试文件、22 个用例通过。
- 初版候选项机制完成后曾执行 `npm run test`：45 个测试文件、325 个用例通过；动态范围修复后尚未重复全量回归。

### 下一步建议

- 提交前执行一次全量 `npm run test`，确认动态提示范围修复没有影响其它 CLI / Planner 回归。
- 使用真实 `xcompiler build` 生成一个小型项目计划，观察 LLM 是否能自然输出 2/3/4/5 不同数量的选项，而不是继续偏向 3 个。

---

## 总体里程碑

| 里程碑 | 名称              | 范围                                              | 验收标准                                          |
| --- | --------------- | ----------------------------------------------- | --------------------------------------------- |
| M1  | 骨架 + `xcompiler_build` MVP | 项目脚手架、CLI、单 LLM、需求 → plan.json（含双确认门）            | 输入一段需求 → 落盘合法 `plan.json` + 规范化阶段文档 |
| M2  | `xcompiler_run` 顺序执行 | Phase Engine、原子 Tool、Sandbox(subprocess)、断点续跑   | 给定 M1 的 plan，可生成可运行 Python 工程并通过自带 `pytest`   |
| M3  | DEBUG 闭环 + Skill | Skill 集合、git 快照、`logs/edits-*.jsonl`、≤3 次重试    | 故意注入 bug 的 plan，能在 ≤3 次内自动修复并回归通过             |
| M4  | 多 LLM 角色 + Docker Sandbox | 按角色路由 provider；docker 模式；网络与资源限制                | 同一 plan 在 docker sandbox 内端到端跑通                |
| M5  | 完整 V 模型 + 交付    | TASK / REFACTOR / DELIVERY 阶段、`docs/history/` | 输出 `docs/05-delivery.md` 与可分发产物                  |
| M6  | 插件扩展 + 功能自举   | 生命周期 Hook、self 模式、worktree 隔离、质量门与晋级 | N 能安全构建并验证 N+1，宿主失败可回滚 |

---

## M1 — 骨架与 `xcompiler_build` MVP

### S1.1 项目脚手架

- 初始化 monorepo（单包亦可）：`pnpm init` + TypeScript（`tsconfig`）+ `tsup` 打包。
- 目录约定：

  ```text
  xcompiler/
  ├── src/
  │   ├── cli/           # xcompiler, xcompiler_build, xcompiler_run 入口
  │   ├── core/          # Plan、Step、Phase、Orchestrator
  │   ├── llm/           # LLMClient + providers
  │   ├── tools/         # 原子 Tool
  │   ├── skills/        # Skill 编排
  │   ├── sandbox/       # subprocess / docker
  │   ├── workspace/     # FS、git、docs
  │   └── config/        # config.yaml + .env 加载
  ├── tests/
  └── package.json
  ```

- 基础依赖：`commander`、`@inquirer/prompts`、`chalk`、`ora`、`zod`、`yaml`、`dotenv`、`simple-git`、`vitest`。
- 输出 bin：`xcompiler`、`xcompiler_build`、`xcompiler_run`（后两者为 `xcompiler build|run` 的薄封装）。

### S1.2 类型与 schema

- 在 `src/core/plan.ts` 实现 `Phase` / `StepStatus` / `Step` / `Plan` 的 TS 类型与对应 `zod` schema。
- 实现 `loadPlan(path)` / `savePlan(path, plan)` / `validatePlan(plan)`（含 Plan Lint 全部规则）。

### S1.3 LLM Gateway（最小）

- 定义 `LLMClient` 接口；先实现 `OllamaClient` 与 `OpenAIClient`。
- `LLMRouter`：按 `config.yaml` 的 `roles` 选择 provider。

### S1.4 `xcompiler_build` 流程

1. CLI 入口：`xcompiler build [-i <file>] [-o <plan.json>] [--yes]`。
2. Intake：读文件或 `readline` 多行输入。
3. Clarify：Planner LLM 反问 N 个问题，用户逐条回答。
4. 生成 `docs/.draft/topic.md` → 预览 → **确认门 1**，确认后写入 `docs/topic.md`。
5. Decompose：Planner LLM 输出 Step 数组；执行 Plan Lint。
6. 生成 `docs/.draft/plan.md` → 预览 → **确认门 2**。
7. 写入 `workspace/plan.json` + `docs/plan.md`，删除 `.draft/`。

### S1.5 ARCH Step 与依赖清单

- Python 依赖记录在 `plan.dependencies`，运行时校准后种入 `requirements.txt`；ARCH Step 不得直接输出该文件。
- TypeScript greenfield 的 ARCH Step 创建 `package.json`；增量与 self 模式默认复用既有 manifest。

### S1.6 验收

- 用例：「写一个 CLI 待办事项工具」→ `xcompiler_build` 落盘 `plan.json`，通过 `validatePlan`；Python 依赖保存在 Plan 顶层并由运行期生成 `requirements.txt`，CODE/TEST 分别产出源码与测试。

---

## M2 — `xcompiler_run` 顺序执行 + Sandbox(subprocess)

### S2.1 Workspace / Git 服务

- `WorkspaceService`：创建目录、读写文档；首次 `xcompiler_run` 自动 `git init`。
- `git_snapshot(stepId, retry)` / `git_revert(toRef)` 基于 `simple-git`。

### S2.2 原子 Tool

实现并注册：`read_file`、`write_file`、`apply_patch`（unified diff）、`code_search`（ripgrep / 内置）、`symbol_search`（轻量正则版）、`run_python`、`run_tests`、`pip_install`、`analyze_error`。

### S2.3 Sandbox(subprocess)

- `SubprocessSandbox.build({ requirementsTxt, devTxt })`：创建 `.sandbox/venv`，`pip install -r ...`，缓存哈希避免重建。
- `.exec(cmd, { timeout, cwd, env })`：捕获 stdout / stderr / exit code，强制超时。
- 资源限制（subprocess 模式仅做超时与子进程数限制；CPU/内存留给 docker 模式）。

### S2.4 Phase Engine

- `topoSort(steps)`、`depsSatisfied(step)`、`executeStep(step)`：
  - 加载 `step.inputs` 列出的产物作为上下文（Context 白名单加载）。
  - 调用对应角色 LLM，按 `step.tools` 过滤可用工具。
  - 校验 `step.outputs` 全部生成；运行 `verifyAcceptance`（针对 TEST Step 触发 Sandbox `pytest`）。
- 每次状态变更立即 `savePlan`。

### S2.5 CLI

- `xcompiler run <plan.json> [--from S00x] [--phase CODE] [--dry-run]`。
- `--dry-run` 仅打印拓扑顺序与每步 `outputs`。

### S2.6 验收

- 跑通 M1 的 plan：自动生成 `src/`、`tests/`，`pytest` 在 sandbox 内全绿；中断后 `xcompiler_run` 续跑可恢复。

---

## M3 — DEBUG 闭环 + Skill 系统

### S3.1 Skill 抽象

- `Skill` 是面向 LLM 的组合能力：`name`、`prompt`、`tools`；执行仍由受控原子 Tool 完成。
- 默认实现 `patcher`、`author`、`tester`、`dep_resolver`、`debugger`、`refactorer` 六个组合 Skill。
- `add_dependency` 属于受 EditGuard 约束的原子 Tool；完成后必须回写依赖清单并触发 sandbox 重建。

### S3.2 编辑约束守门

- `EditGuard`：拒绝 `outputs` 白名单外的写入；统计行数，默认按当前 Step 上下文自适应预算，显式配置数字时超限报错。
- `write_file` / `append_file`：单次 content 字节预算默认按活动 Provider 的 `context_window`、当前 prompt 占用和响应预留自适应；仅当单个逻辑文件超过活动窗口时才按模块 / 函数 / 类边界分块，避免单轮 JSON payload 失稳。
- `read_file`：按活动 Provider 的工具反馈窗口分块读取，使用 `nextOffset` 继续，不允许先载入完整大文件后再截断。
- 每次底层写 Tool 调用产生一条 `EditRecord` 追加到 `logs/edits-<step-id>.jsonl`；Skill 不另建可绕过 Tool 审计的执行通道。

### S3.3 Debugger 闭环

- `debugLoop(step, err)`：
  1. 解析 stderr / pytest json-report → `analyze_error`。
  2. Debugger LLM 选择 Skill + 参数。
  3. `git_snapshot` → 执行 Skill → sandbox 重跑失败子集 → 通过则全量回归。
  4. 失败 `retries++`；超限 → `revert_change` 到 Step 起点，标记 `FAILED`。

### S3.4 验收

- 内置三个故意 bug 的 fixture：缺包、断言失败、TypeError。各自能在 ≤3 次重试内修复并通过；`logs/edits-*.jsonl` 完整。

---

## M4 — 多 LLM 角色 + Docker Sandbox

### S4.1 Provider 扩展

- 新增 `ClaudeClient`、`OpenAICompatibleClient`；`LLMRouter` 支持失败回退（fallback chain）。
- 流式输出接入 `ora` 与 token 计数。

### S4.2 Docker Sandbox

- `DockerSandbox`：使用 `python:3.x-slim`，挂载 workspace 卷为读写、其它路径只读。
- 依赖镜像缓存键 = hash(`requirements.txt` + `requirements-dev.txt` + python 版本)。
- 网络策略：默认 `download-only`（允许任意出站下载但不发布入站端口）；`off` 完全断网，`full` 可显式发布端口。由于 Docker 原生网络无法可靠执行域名白名单，旧 `pypi-only` 配置会 fail-closed，而不会降级为任意出站。

### S4.3 资源限制

- 通过 `--cpus`、`--memory`、`--pids-limit` 实现 cgroup 限制。
- 单次 exec 强制 wall-clock 超时。

### S4.4 验收

- 同一 plan 在 `sandbox: docker` 下端到端通过；切换 provider 不需改 plan。

---

## M5 — 完整 V 模型 + 交付

### S5.1 TASK / REFACTOR / DELIVERY

- 模板化 prompt 让 Planner 在拆解时默认包含这三类 Step。
- REFACTOR Step：要求行为不变，必须先跑全量回归再写 `docs/04-refactor.md`。
- DELIVERY Step：汇总产出，生成 `docs/05-delivery.md`（含 README、入口命令、依赖列表、测试证据链接）。

### S5.2 文档历史归档

- 每次阶段产物写入前，把上一版本移动到 `docs/history/<phase>-<ts>.md`。

### S5.3 `xcompiler ls` / `xcompiler show`

- `ls`：扫描 workspace 列出所有 plan 状态摘要。
- `show <step-id>`：打印 Step 定义、状态、产物路径与最近一次审计记录。

### S5.4 验收

- 端到端跑通一个真实小项目（如 todo-cli），交付物含可执行 Python 包、测试报告、`delivery.md`。

---

## M6 — 插件扩展与功能自举

### S6.1 生命周期扩展

- 对 compile、LLM、run、Step、attempt 与 Tool 暴露类型化 Hook。
- 插件注册的 Tool 继续受白名单和 EditGuard 约束，失败策略可配置为 continue / fail。

### S6.2 自举工程模式

- `PlanIntent` 增加 `self`，作为增量模式加载既有源码、测试、清单和核心设计文档。
- Planner 保留既有入口、公共导出与 `package.json`，不得套用 greenfield 的 `src/main.ts` 约束。
- Plan Lint 允许增量 TypeScript 计划复用现有 manifest，仅在需求涉及依赖或脚本时修改。

### S6.3 代际执行与隔离

- `xcompiler bootstrap` 从稳定版本 N 创建 `xcompiler/bootstrap/<run-id>` 分支和隔离 worktree。
- N 仅在候选 worktree 中执行 compile / run；Step 快照与硬回滚不得作用于宿主 checkout。
- 宿主仓库非 clean 或自举期间 HEAD 变化时，禁止晋级。
- qualification 默认使用最小环境变量的 subprocess 沙箱；Docker 未完成环境验证前仅显式启用。

### S6.4 质量门与晋级

- 必选门：version check、typecheck、test、build、lint、CLI smoke、`bootstrap --help` smoke、`npm pack --dry-run`。
- 默认产出 `.xcompiler/bootstrap/reports/<run-id>.md` 和候选分支，不修改当前分支。
- 质量门前后必须保持候选 HEAD 不变且 worktree clean；报告与晋级绑定已验证 commit SHA。
- 只有显式 `--promote` 且全部必选门通过时，才允许按该 SHA `--ff-only` 晋级为 N+1。

### S6.5 验收

- N 能在隔离 worktree 中构建 N+1，失败不会改变宿主 HEAD 或未跟踪文件。
- N+1 通过全部确定性门禁并保留下一轮 `xcompiler bootstrap` 入口；真实 provider 驱动的连续两代演练仍需发布前人工验收，不能用 CLI smoke 冒充。
- 报告可追溯 base commit、candidate commit、候选分支、变更文件和各质量门结果。

---

## 横切事项

### 测试策略

- 单元测试（`vitest`）：types / Plan Lint / Tools / Skills / Sandbox 抽象。
- 契约测试：LLM provider 用录制的固定回放（`nock` / `msw`）以保证 CI 稳定。
- Engine 端到端测试使用固定 LLM 回放与 subprocess/FakeSandbox；真实 provider 与 Docker 环境验证作为发布前人工验收，不伪装成 CI 已覆盖能力。

### CI/CD

- GitHub Release：`version:check → typecheck → lint → test → pkg build`，上传 Linux / macOS / Windows 二进制与校验和。
- npm 包保留 `@xcompiler/cli` 元数据与 `npm pack` 质量门；当前没有自动 `npm publish`，不得在文档中声称已发布。

### 安全

- `.env` + 环境变量；CI 用 secrets。
- Sandbox 默认 `download-only`；需要执行期硬隔离时必须显式使用 `off`。旧 `pypi-only` 因无法兑现域名级隔离而被拒绝。
- Skill 调用全部审计；危险操作（`revert_change` / 跨白名单写）需要二次确认或 plan 中显式授权。

### 文档

- 仓库 `README.md` 含 quick start：`npm i -g @xcompiler/cli` → `xcompiler build` → `xcompiler run`。
- 设计文档：本目录 `XCompiler_design.md` + 本实施计划。

---

## 当前进度快照 — 2026-07-05 17:16 CST

### 已完成：迭代模型 + 每迭代 V 模型

- Planner 提示词和 draft 校验已从“只运行首个迭代、后续不可执行”改为“P1 current + P2/P3 planned executable iterations”。
- `implementationPhases` 中 `current` / `planned` 都被视为可执行迭代周期；每个可执行迭代都必须在 `steps` 中拥有完整 V 模型宏 Step：`REQUIREMENT -> ARCH -> TASK -> CODE -> TEST -> REFACTOR -> DELIVERY`，`DEBUG` 保持按需可选。
- 每个 Step 增加并保留 `iterationId`，Plan lint 按 iteration 分组校验阶段完整性、CODE→TEST 覆盖、REFACTOR→TEST 依赖、阶段文档和 DELIVERY 文档包。
- P1 继续使用顶层规范文档；P2+ 使用 `docs/iterations/<iterationId>/` 下的迭代文档，避免多个迭代抢写同一路径。
- `topoSort`、plan markdown 渲染和 `.xc` 进度文件均携带 iteration 维度，运行和审计时能看到层级归属。
- Calibration 不再丢失 `iterationId`；自动补 TEST 覆盖时按 iteration 分桶补齐，并只重连同迭代的 REFACTOR。

### 反遗漏 / 反规避检查

- 已搜索旧语义残留：旧版“首迭代独占执行、后续不可执行”的提示文本已清理；剩余 `deferred` 仅用于显式非执行 phase 的错误防护。
- Planner validate 会拒绝 planned iteration 缺少任一核心 V 模型阶段的 draft，不允许用“只做 P1、后续留待以后”的 plan 通过。
- Complex 测试 fixture 已改为真实 P1/P2/P3 多迭代计划，而不是把 P2/P3 标成 deferred 来绕过执行。

### 验证

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run test`：45 个测试文件、326 个用例全部通过。

### 2026-07-05 17:37 CST 补充：迭代结束门禁闭环

- 复检发现：结构层已支持多 iteration V 模型，但运行层此前只在全部 Step 完成后运行最终 project audit，缺少“每个 iteration 结束立即验证”的门禁闭环。
- 已补齐 `ImplementationPhase.verificationGate`，Planner prompt 要求 LLM 在计划阶段随每个 iteration 目标同步生成门禁目标、检查项和失败策略。
- 已新增 iteration-scoped quality gate：每个 iteration 的 DELIVERY 完成且该 iteration 所有 Step 为 DONE 后，Engine 立即运行门禁。
- 门禁检查包括：当前 iteration 交付文档、测试套件、入口/API 探测、TypeScript build/lint（如配置），并继续沿用网络 API 失败 fail-closed 检测。
- 门禁失败时，Engine 会把完整 gate failure log 传给 Debugger，并限定在同一 iteration 的 V 模型实现/测试/重构/交付链路中选择修复 Step；修复后会重新运行同一 iteration gate，仍失败则停止，不进入下一迭代。
- 已补充测试覆盖 P2 iteration 文档门禁，以及 P1 gate 失败后回退到 Debugger 修复并重新通过的执行闭环。

验证：

- `npm run typecheck`：通过。
- `npm run build`：通过。
- 定向回归：7 个测试文件、80/80 用例通过。
- `npm run test`：45 个测试文件、328/328 用例通过。
