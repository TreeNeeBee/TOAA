# XCompiler 用户样例（--fixture）设计

## 1. 文档状态

**已定方案，未实施。** 实施时机：当前 dbc2excel P1 跑完、用真实 `vehicle.dbc` 量出「自造数据通过 /
真实数据失败」的实际差距之后。

## 2. 要解决的问题

提示词里已经有消费者，没有生产者。

`src/i18n/zh.ts:135` 要求执行角色「优先复用用户或工作区已提供的真实样例」，但没有任何通道告诉它
用户样例存在、叫什么、在哪。`path_guard.ts` 对工作区外路径硬拒，所以不是 agent 没想到，是它够不着。

实测后果（dbc2excel，2026-08-17）：用户提供的 `vehicle.dbc` 留在 `/tmp/dbc1/`，工作区里一个 `.dbc`
都没有；Planner 于是自己编了一个 `test_data/sample.dbc` 写进交付门禁的
`scenarios[0].execution.args`。**工程写数据、工程写断言、门禁拿工程写的数据验工程** —— 被验的东西
和定义「什么算对」的东西同一个作者。

上一轮加内容级断言解决的是「断言只查形状」。这一轮是同一个洞的另一半：数据也是自己编的。

### 2.1 实测升级：它连自造数据都造不出来

第二次 dbc1 运行给出了比预期更强的证据 —— **工程没能走到交付，因为它造不出自己的样例。**

S002 需要 DBC 样例来跑模块契约测试，于是：`list_dir tests/fixtures` → ENOENT（用户样例够不着）→ 造
四个 `tests/fixtures/*.dbc` → **`write denied`** → `run_tests` exit=1 → 回到第一步。同一失败重复三次，
BUG-P1-002 在六次尝试后被不收敛检测停掉，整个 run 中断在 9/8。

原因是一个独立缺陷（已修）：提示词让 Step 写 `tests/fixtures/<name>`，写权限只授予
`tests/fixtures/network`。**提示词和权限对同一件事给出相反答案**，而拒绝信息点的正是 Step 被告知要用
的那个路径 —— 它无处可试。修复见 `execution_context.ts` 的 `withTestFixtureAccess`。

这条实测把 `--fixture` 的价值从「省一次手工验证」抬到「消除一整类死锁」：真实样例在
`examples/dbc2excel/vehicle.dbc`（217 消息 / 462 信号，正落在 KPI 中量级区间）；若它在工作区内，
S002 第一次 `list_dir` 就命中，上述循环根本不会开始。

### 2.2 自造样例与真实样例的实测对照

权限修好后重跑（dbc2），S001 立刻造出了 `tests/fixtures/sample.dbc`。它语法正确、写得不差 ——
但在需求关心的每个维度上都与真实文件相反：

| | 自造 `sample.dbc` | 真实 `vehicle.dbc` |
|---|---|---|
| 消息 / 信号 | 4 / 9 | 217 / 462 |
| ECU 节点 | `ECU1 ECU2 ECU3`（具名） | 全部 `Vector__XXX` |
| 多路复用信号 | 4 | 0 |

后果逐条对应到已澄清的需求：

- **Q1 ECU 过滤**：自造文件里 `--ecu ECU1` 筛得出信号，测试变绿；真实文件里任何 ECU 参数的正确结果
  都是空表 —— 「筛出零行」这个必须处理的形态从未被测到。
- **Q8 Multiplex ID 列**：自造文件填满该列；真实文件该列全空，同样从未被测到。
- **Q6 性能 KPI（100-500 消息 / 500-2000 信号）**：用来验证该指标的数据是 4 / 9，比区间下限小 25 倍。

### 2.3 第三轮的反驳与修正（dbc3）

dbc3 走了不同路子：不写 `tests/fixtures/`，改为在测试里内联 DBC 文本、运行时写入临时目录。而且它的
测试设计比 §2.2 的推论更周密 —— 造了多路复用信号、造了畸形文件走 PARSE_ERROR 路径，还专门测了
`test_ecu_filter_nonexistent_returns_empty`（空过滤结果），正是 §2.2 预测会漏掉的形态之一。

**所以「自造样例必然回避不便的形态」这个说法是错的，就此修正。**

真实的失败模式更糟。用 cantools（S002 自己选定的库）实测两份文件：

| | 结果 |
|---|---|
| 自造 `VALID_DBC` | **解析失败** — `Invalid syntax at line 3, column 5` |
| 真实 `vehicle.dbc` | 解析成功 — 217 消息 / 462 信号 |

那个名为 `VALID_DBC` 的常量不是合法 DBC：`NS_` 段格式错，`SG_` 行缺 `:`、缺
`起始|长度@字节序±`、缺 `(因子,偏移)`、缺 `[最小|最大]`。模块契约测试把一个 cantools 解析不了的
文件喂给 cantools。

后果只有两条路，第二条才致命：

1. 测试失败 → 修复回路，可能耗尽尝试预算
2. **实现被改成接受这个假格式** → 交付一个只解析「自造 DBC 方言」的解析器：测试全绿、门禁通过、
   真实文件上完全不可用

### 2.4 修正后的论点

不是「自造数据回避不便的形态」，而是：

> **自造数据无法验证格式本身。** 工程可以设计出周密的用例，却造不出一份自己没有权威参照的合法样本
> —— 它对格式的理解**就是**它对格式的实现，两者同源，因此永不冲突。

外部样例带来的不是更多用例，而是**唯一一个工程没有权威解释的事实**。这也说明 `--fixture` 不能只是
「把文件放进工作区」：R3 那条「`execution.args` 必须命中用户样例」正是为了保证那个事实真的被读到。

`externalDataPolicy`（controlled / record-replay / live）管的是网络与实时外部交互，不是本地用户样例。
拿它兼管会造出「同一概念两个判定点」——本仓库反复付代价的形状。

## 3. 词汇对齐

「用户测试用例」= `DeliveryGateScenario`。规则 3 点名的 `execution.args` 正是它的字段，所以
「结构化检查并补全完整的测试用例格式」= 补齐 `DeliveryGateScenarioSchema` 的必填项：

```
name, description, operation, environment, expected, execution{command, args}
```

不引入第二套测试用例词汇。

## 4. 规则

### R1 · --fixture 不触发重新规划

- plan 已生成 → **只追加测试用例，不重新生成 plan**
- plan 未生成 → 先生成 plan，再追加测试用例

**实测约束：**

- `buildPhasePlanSourceDigest` 只哈希 `{topic, language, intent, baselineSummary, userAddenda}`。
  fixture **不得**进入该 digest，否则每加一个样例都会让 phasePlan checkpoint 失效并重新规划。
  这半条免费。
- `build.ts:534` 的 `planner.decomposePhase(...)` **无条件执行** —— 即使 phasePlan 复用了 checkpoint，
  `plan.P<N>.json` 仍会重新调模型生成。「不重新生成 plan」需要一个新的早退分支，不是现成的。

### R2 · 追加失败不影响 build

- 追加前做结构化检查，缺字段补全到完整格式。
- 测试用例生成**不影响 plan 生成的结果**。
- **允许生成出错**：打印信息，build 继续，退出码不变。

这条决定了失败隔离边界必须显式：样例派生走的是模型调用，模型可能产不出合法 scenario。一个样例没接上
不该让整个 build 失败 —— 但也不该静默，用户必须看到哪个样例没接上、为什么。

### R3 · 门禁结构性检查，对删除宽容

- `scenarios[].execution.args` 必须命中用户样例。
- **但样例文件已被用户删除时，命中失败可接受。**

判定基于**样例当前是否还在磁盘上**，而不是 phasePlan 里是否记过：phasePlan 记的是当初提供了什么，
门禁查的是现在还剩什么。用户删掉样例是用户的决定，不是产品缺陷。

纯结构比较 —— 不猜测、不读模型、跨工程类型通用，失败信息能直接指出「主场景跑在自造数据上」。

## 5. 不在范围内

- 读取追踪（真的验证进程打开过那个文件）。最强，但要按平台实现两套（subprocess / docker），
  且 macOS 上 strace 类工具受限。R3 的结构性检查是便宜且可证伪的版本。
- 不改 `externalDataPolicy` 的语义。
- 不为样例新增 Step 类型或 V-model 阶段。

## 6. 验收

- 带 `--fixture` 重跑一个已有 plan 的工作区，**不产生 decompose 模型调用**。
- 样例派生失败时 build 退出码不变，且 stderr/日志里指名是哪个样例。
- 追加的 scenario 通过 `DeliveryGateScenarioSchema.parse`。
- 样例仍在磁盘 → `execution.args` 不引用它时门禁失败；样例被删除 → 门禁通过。
  两个方向各自证伪有效。

## 7. 相邻缺口：run_tests 对尚未撰写的声明输出

不属于 `--fixture`，但同属「拒绝要说得出下一步」这条线，记在这里以免丢失。

Runtime 用 Step 声明的测试输出构造 pytest selector。一个尚未撰写这些文件的 Step 因此拿到一个**不可能
成功**的调用：pytest exit=4，报 `file or directory not found` —— 听起来像环境问题，且与 Runtime 同时
发出的准确指令（`outputs 仍缺失: …`）争夺注意力。

实测（dbc3，2026-08-18）：S004 写完 `src/*.py` 后，把全部 10 轮花在重跑这条不可能成功的命令上，期间被
**69 次**准确告知还欠哪五个文件（`docs/tests/unit-test-plan.md` 与四个单元测试）。不收敛检测在 11/8
停止运行。

**如果 `run_tests` 在声明的测试输出尚不存在时直接拒绝、并说「先撰写这些文件」，10 轮浪费会变成 1 次
可执行的拒绝。**

注意这与前三处缺陷性质不同：那三处是 Runtime 的消息本身无法执行（fixture 目录、conftest.py 所有权、
编造的 `postToolEvidence` 字段）；这一处 Runtime 的消息是对的，问题在于它旁边还摆着一个必然失败、且
失败信息更像环境故障的工具调用。修法因此不是改措辞，而是**不让那次调用发生**。

落点见 `src/tools/sandbox.ts` 的 `TODO(unwritten-selectors)`。放在 gate-selector 契约而非工具内部，
因为它改变的是「Step 何时可以调用 run_tests」。
