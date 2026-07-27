# XCompiler 功能自举设计

## 目标

功能自举指稳定版本 XCompiler-N 能读取自身工程，以完整 V 模型规划、实现并验证下一代
XCompiler-N+1；N+1 晋级后能够继续执行下一轮自举。自举不等同于进程内热更新，正在运行的
N 在本轮结束前始终是可信执行器。

## 信任与隔离边界

```text
宿主 checkout（XCompiler-N，必须 clean）
        │
        ├── base commit ──► 隔离 worktree / 候选分支
        │                         │
        │                         ├── intent=self 编译 V 模型计划
        │                         ├── 执行完整 V 模型与按需 Debug 修复
        │                         └── 确定性质量门
        │
        └── 人工晋级门 ──► git merge --ff-only ──► XCompiler-N+1
```

- Step 内的 `git add .`、快照提交和 `reset --hard` 只允许发生在候选 worktree。
- 默认 worktree 位于 `.xcompiler/bootstrap/worktrees/<run-id>`，该目录不进入版本控制。
- 候选分支使用 `xcompiler/bootstrap/<run-id>`，报告位于
  `.xcompiler/bootstrap/reports/<run-id>.md`。
- 自举开始时宿主必须 clean；晋级时再次验证宿主 HEAD 等于基线提交且仍为 clean。
- 质量门开始前记录候选 commit；门禁结束后候选 HEAD 必须未变化且 worktree 仍为 clean。
- 晋级合并已验证的精确 commit SHA，不按可能漂移的候选分支头合并。

## Self 计划约束

`self` 属于增量意图，加载已有 plan、项目记忆、源码/测试树、manifest，以及
`XCompiler_design.md`、本设计和插件 API。

Planner 必须遵守：

- 保留现有 `package.json`、`tsconfig`、bin、CLI 入口、模块布局和公共导出。
- 不得为了满足新建工程规则创建 `src/main.ts`。
- 未涉及依赖或脚本时，不得把 `package.json` / `tsconfig.json` 列为 Step 输出。
- 每个 V 模型 Step 只覆盖本次增量，并保留需求、设计、编码、测试之间的可追踪性。

## 质量门

候选版本执行完成后按顺序运行：

1. `npm run version:check`（必选；校验 package、lockfile 与运行时版本常量）
2. `npm run typecheck`（必选；缺少 script 也视为失败）
3. `npm test`（必选）
4. `npm run build`（必选）
5. `npm run lint`（必选；缺少 script 也视为失败）
6. 使用 `package.json.bin` 的首个入口执行 `node <entry> --help`（必选；缺少 bin 也视为失败）
7. 执行 `node <entry> bootstrap --help`，确认 N+1 仍暴露下一代自举入口（必选）
8. `npm pack --dry-run --json`（必选）

任一必选门失败，候选状态为 `qualification-failed`，禁止晋级。LLM 服务是否在线只影响
计划生成和 Step 执行，不改变确定性质量门的判定标准。

质量门当前优先运行在 subprocess 沙箱中：依赖使用锁文件执行 `npm ci --ignore-scripts`，
并使用独立 HOME、TMPDIR、npm cache 与最小环境变量，不继承 provider key、代理或其它
进程机密。subprocess 不能提供 Docker 级别的网络与资源硬隔离，因此候选 commit 完整性
检查仍是强制门禁。Docker 环境尚未完成实际环境验证，仅在显式传入
`--docker-qualification` 时实验启用；该模式把候选脚本置于 `--network none`、CPU / 内存 /
PID 限制和 `no-new-privileges` 下执行。

## CLI

```bash
# 默认：生成候选分支、保留 worktree、写报告，不修改当前分支
xcompiler bootstrap -r /path/to/XCompiler -i self_req.md --yes

# 全部门禁通过后，在同一次运行末尾显式快进晋级
xcompiler bootstrap -r /path/to/XCompiler -i self_req.md --yes --promote

# 写完报告后删除 worktree，候选分支仍保留
xcompiler bootstrap -r /path/to/XCompiler -i self_req.md --yes --cleanup

# 实验选项：显式使用尚未完成环境验证的 Docker 质量门
xcompiler bootstrap -r /path/to/XCompiler -i self_req.md --yes --docker-qualification
```

## 回滚与失败处理

- compile 取消、Step 失败或质量门失败：保留候选分支和 worktree供诊断，宿主不变。
- 晋级前失败：删除 worktree 和候选分支即可，不需要重置宿主仓库。
- 晋级后发现问题：通过新的修复提交或版本化 revert 处理，不复用执行期的硬重置。
- 自举报告记录 base/candidate commit、检查命令、耗时和变更文件，作为下一轮输入证据；
  报告中的手工晋级命令绑定 candidate commit SHA，而不是分支名。
