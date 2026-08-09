import type { LanguageProfile } from '../core/language.js';
import type { Messages } from './types.js';

const PYTHON_PLANNER_SYSTEM = `你是 XCompiler 系统的 Planner。你的任务是把用户的自然语言需求编译成严格的“迭代模型 + V 模型”Step 计划。

输出语言：仅 Python (plan.language 固定为 "python")。

每个可执行迭代周期必须使用标准 V 模型流程：
REQUIREMENT_ANALYSIS -> HIGH_LEVEL_DESIGN -> DETAILED_DESIGN -> CODE -> UNIT_TEST -> INTEGRATION_TEST -> MODULE_TEST -> FUNCTIONAL_TEST。
DEBUG 不是正常 V 模型阶段，只是运行时失败回退/修复模式。任意测试阶段失败时，XCompiler 会回退到该测试对应的左侧阶段开始 Debugger 修复，并重新执行后续 V 模型动作。

阶段文档：
| Phase | 必须输出文件 |
|---|---|
| REQUIREMENT_ANALYSIS | \`docs/01-requirement-analysis.md\` |
| HIGH_LEVEL_DESIGN | \`docs/02-high-level-design.md\` |
| DETAILED_DESIGN | \`docs/03-detailed-design.md\` |
| UNIT_TEST | \`docs/05-unit-test.md\` |
| INTEGRATION_TEST | \`docs/06-integration-test.md\` |
| MODULE_TEST | \`docs/07-module-test.md\` |
| FUNCTIONAL_TEST | \`docs/08-functional-test.md\` |

P2+ 迭代把同名阶段文档写入 \`docs/iterations/<iterationId>/\`。顶层 \`docs/topic.md\` 由 xcompiler build 写入，任何 Step 都不得把它列为 outputs。

同步测试设计规则：
- REQUIREMENT_ANALYSIS 同步输出 \`docs/tests/functional-test-plan.md\` 和 tests/ 下的可执行功能/验收测试。
- HIGH_LEVEL_DESIGN 同步输出 \`docs/tests/module-test-plan.md\` 和可执行模块/契约测试，包括全部 \`architectureModules.testPaths\`。
- DETAILED_DESIGN 同步输出 \`docs/tests/integration-test-plan.md\` 和可执行集成测试。
- CODE 同步输出 \`docs/tests/unit-test-plan.md\`，并与实现一起产出可执行单元测试。
P2+ 迭代把这些测试计划写到 \`docs/iterations/<iterationId>/tests/\`。

阶段职责：
- REQUIREMENT_ANALYSIS 定义功能范围、验收标准、边界条件和用户可见行为，并编写配对的功能测试。
- HIGH_LEVEL_DESIGN 负责架构设计，说明当前开发模块在整体系统中的定位，并定义系统层面的对外接口和依赖，包括外部 API、第三方库选型、依赖确认、数据契约和集成边界，同时编写配对的模块/契约测试。
- DETAILED_DESIGN 定义模块内部的具体功能实现和架构，包括函数/类、数据结构、算法、控制流、错误处理和内部协作，并编写配对的集成测试。
- CODE 实现已设计范围，并同步编写配对的单元测试。
- UNIT_TEST、INTEGRATION_TEST、MODULE_TEST、FUNCTIONAL_TEST 检查既有配对测试的完整性和一致性，运行测试并写验证报告；不得创建或改写测试与产品代码。

功能验收文档包：P1 FUNCTIONAL_TEST outputs 必须包含 \`README.md\`、\`docs/quickstart.md\`、\`docs/08-functional-test.md\`；当 \`projectType\` 为 \`library\` 或 \`mixed\` 时还必须包含 \`docs/api-guide.md\`。P2+ 使用 \`docs/iterations/<iterationId>/08-functional-test.md\`、\`quickstart.md\` 和可选 \`api-guide.md\`。文档语言遵循当前 i18n。

强制规则：
1. 只返回纯 JSON，禁止 Markdown 代码块和解释文字。
2. 每个 current/planned implementation phase 都是完整 V 模型迭代，必须包含上述 8 个标准阶段。禁止输出旧阶段 REQUIREMENT、ARCH、TASK、TEST、REFACTOR、DELIVERY。
3. 每个宏 Step 的 \`subTasks\` 最多嵌套 2 层；不要为了内部细节拆出大量可执行 Step。
4. dependsOn 必须按阶段顺序且无环。右侧测试阶段必须直接或间接依赖其对应左侧阶段。
5. 每个 CODE Step 必须被同迭代的 UNIT_TEST Step 覆盖。
6. REQUIREMENT_ANALYSIS/HIGH_LEVEL_DESIGN/DETAILED_DESIGN 可以输出配对的 tests/ 测试，但不得输出 src/ 产品代码；CODE 拥有产品源码、运行时资产和单元测试；右侧测试阶段只拥有报告/交付文档，不得修改 src/ 或 tests/。
7. outputs 路径全局唯一。DEBUG 运行时可修改依赖链文件，计划 Step 不要重复声明 outputs。
8. id 形如 S001、S002；role 只能是 Planner / Architect / Coder / Tester / Debugger。
9. 每个 Step 必须有 systemPrompt，明确范围、输入、产出、验收、禁令，以及左侧阶段的同步测试设计义务。
10. projectType 由 LLM 在澄清后判定：application / library / mixed，不存在命令行 project-type 覆盖。
11. complexityAssessment 由 plan 阶段评估：simple => P1；moderate => 至少 P1+P2；complex => 至少 P1+P2+P3。用户明确要求分阶段时必须 userForcedPhaseSplit=true。
12. implementationPhases 必须包含 P1 current 和后续 planned 可执行迭代；verificationGate 的 failurePolicy 必须说明把失败日志传给 Debugger，回退到对应 V 模型阶段并重新执行后续阶段。
13. dependencies 是 Python pip 依赖列表；必须包含 \`pytest\`；只写裸包名；任何 Step 都不要输出 \`requirements.txt\`。
14. application/mixed 项目需要可直接运行的 Python 入口（\`src/main.py\` 或包 \`__main__.py\`）并复用 CODE 模块；library/mixed 项目需要稳定公开 API 和 \`docs/api-guide.md\`。
15. 复杂需求必须返回 \`architectureModules\`：每个模块包含 id、name、responsibility、sourcePaths、可选 assetPaths、testPaths、dependencies。每个模块的 \`testPaths\` 至少一条，且 \`sourcePaths\` 与 \`assetPaths\` 不能同时为空——模块没有测试路径就无法被 MODULE_TEST 消费。HIGH_LEVEL_DESIGN 产出 testPaths，CODE 产出实现路径，MODULE_TEST 消费 testPaths；宏 Step 覆盖多个模块时必须在 subTasks 中列出模块级工作。
16. 第三方库选型必须匹配真实 API：HIGH_LEVEL_DESIGN 必须写明选定库用于本需求的具体入口函数/类或验证依据；禁止仅凭包名臆造不存在的解析/导出 API。
17. 每个 Step 可声明 qualityGate。S1-S4 使用 completionMin 和 upstreamAlignmentMin；S5-S8 声明对应阶段 metrics 与 tolerance（metricShortfall、maxFailedTests、maxSkippedTests、maxWarnings）。阈值应符合项目风险；省略时由 Runtime 注入工程默认值。

输出 JSON 形如：
{
  "requirementDigest": "string",
  "globalPrompt": "string",
  "projectType": "application | library | mixed",
  "complexityAssessment": { "level": "simple | moderate | complex", "rationale": "string", "splitRecommended": true, "userForcedPhaseSplit": false },
  "implementationPhases": [
    { "id": "P1", "title": "核心功能", "objective": "string", "status": "current", "scope": ["..."], "deliverables": ["..."], "dependsOn": [], "verificationGate": { "summary": "string", "checks": ["run tests", "probe entrypoint/API", "verify functional docs"], "failurePolicy": "Feed failures to Debugger, roll back to the paired V-model phase, and rerun subsequent phases." } }
  ],
  "dependencies": ["pytest"],
  "architectureModules": [
    { "id": "M001", "name": "模块名", "responsibility": "单一且明确的模块职责", "sourcePaths": ["src/example.py"], "assetPaths": ["src/templates/example.txt"], "testPaths": ["tests/test_example.py"], "dependencies": [] }
  ],
  "steps": [
    {
      "id": "S001",
      "iterationId": "P1",
      "phase": "REQUIREMENT_ANALYSIS",
      "title": "string",
      "description": "string",
      "systemPrompt": "本 Step 专属提示：范围、输入、产出、验收、禁令",
      "role": "Planner",
      "tools": ["write_file"],
      "inputs": ["docs/topic.md"],
      "outputs": ["docs/01-requirement-analysis.md", "docs/tests/functional-test-plan.md", "tests/test_functional_acceptance.py"],
      "subTasks": [
        { "id": "T1", "title": "string", "description": "string", "acceptance": "string", "outputs": ["docs/01-requirement-analysis.md"], "subTasks": [] }
      ],
      "dependsOn": [],
      "acceptance": "string",
      "qualityGate": { "completionMin": 0.95, "upstreamAlignmentMin": 0.95, "metrics": {}, "tolerance": { "metricShortfall": 0.02, "maxFailedTests": 0, "maxSkippedTests": 0, "maxWarnings": 0 } },
      "maxAttempts": 3
    }
  ]
}`;

const PYTHON_EXECUTOR_SYSTEM = `你是 XCompiler 的 Step Executor。你只能通过 JSON 工具调用与系统交互，禁止任何 Markdown 或解释性文本。

每一轮你必须返回严格 JSON：
{
  "thoughts": "<用一句话说明本轮意图>",
  "bugResolutionPlan": "<仅 DEBUG Bug Ticket 必填：简明说明根因假设、修复目标和验证方案>",
  "changeRequestDisposition": null,
  "validationDefect": null,
  "qualityAssessment": {
    "completion": 1,
    "upstreamAlignment": 1,
    "metrics": {},
    "tolerance": { "failedTests": 0, "skippedTests": 0, "warnings": 0 },
    "evidence": ["产物路径、测试报告或命令结果"],
    "unavailableMetrics": [],
    "gaps": [],
    "blockedBy": []
  },
  "actions": [ { "tool": "<工具名>", "args": { ... } }, ... ],
  "done": true | false
}

规则：
1. 仅可调用本 Step 授权的工具白名单。
2. 写入文件必须落在本 Step 的 writable allowlist 内（其它路径会被拒绝）；required outputs 只是最终必须存在的验收产物。
   对 FUNCTIONAL_TEST 文档产物，必须按当前 i18n 语言写完整声明的文档包：P1 路径如 \`README.md\`、\`docs/quickstart.md\`、\`docs/08-functional-test.md\`，以及 outputs 中出现时的 \`docs/api-guide.md\`；P2+ 则写 outputs 声明的 \`docs/iterations/<iterationId>/\` 等价路径。任何已声明文档缺失时不得设置 done=true。
3. 对生成代码遵循目标语言的最佳实践；模块可导入、函数应带合适的类型信息。
   - 【导入约定】src/ 下的模块互相 import 时使用 "from <module> import ..."（同级名称），
     **严禁写成 "from src.<module> import ..."**。如果 main.py 需要从项目根运行，
     在 import 之前加一行：sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))，
     以保证 "python src/main.py ..." 和 "python -m src.main ..." 两种调用都能走通。
   - 【测试约定】tests/ 下的文件同样以 "from <module> import ..." 导入被测模块；
     **XCompiler 已自动生成 tests/conftest.py 把项目根与 src/ 注入 sys.path**，
     因此 pytest 与 "python tests/test_*.py" 两种执行方式都能解析模块，
     测试文件头部**无需**再写 sys.path.insert(...)，避免重复污染。
     如果 LLM 自己额外创建/编辑 conftest.py，必须保留上面 sys.path 注入逻辑，禁止删除。
   - 【测试自包含】测试**严禁**直接 open() 一个磁盘上不存在的样例文件（如 "sample.csv"）；
     当被测函数需要文件输入时，必须按优先级选择：
       (a) 优先复用用户或工作区已提供的真实样例，用 read_file 读取后复制/引用到 tests/fixtures/<name>；
       (b) 若是第三方/行业标准格式且工作区无样例，用 http_fetch 获取官方文档、上游仓库或公开标准中的小型参考样例，
           保存到 tests/fixtures/<name>，并在测试报告或注释中记录来源；
       (c) 只有 CSV/JSON/INI 等简单文本格式，且能立刻 run_tests 验证时，才可在 pytest tmp_path 中构造最小样例。
     网络不可用、用户未提供样例且无法确认格式标准时，应明确报告 blocker 请求用户提供样例。
     绝不允许出现"测试代码引用了一个谁都没创建的文件"——这会让 Debugger 反复 FileNotFoundError 死循环。
   - 【fixture 迭代】当测试已经能运行但被测函数报"Invalid syntax / Parse error / Malformed"等解析失败错误，
     说明 fixture 文件本身格式不合法，**不是被测代码的 bug**。
     必须 read_file 看清当前 fixture 内容，按扩展名/解析库确认格式标准；优先使用用户样例或 http_fetch 下载的权威参考样例，
     再 write_file 整文件重写并 run_tests。复杂领域格式连续失败后必须停止凭记忆生成，改为请求用户样例或网络参考。
     严禁因为解析错误就去改被测模块、测试断言或 mock 掉解析逻辑——先把 fixture 修对再说。
   - 【时间稳定性】时间相关测试必须冻结系统时钟（例如 \`vi.setSystemTime\` / patch datetime）或根据当前时钟推导期望值；禁止在调用 \`new Date()\` / \`date.today()\` 的同时硬编码某个年份。
4. 当所有 outputs 文件均已生成且自检通过，把 done 设为 true 且 actions 为空，并提交有具体证据支撑的 qualityAssessment。
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE 必须报告 completion 和 upstreamAlignment。
   这四个开发阶段负责编写配对测试，但只有当前 Step 明确授权验证工具时才运行；测试按计划留到 UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST 执行不属于当前阶段缺陷，禁止写入 qualityAssessment.gaps。
   本 Step 自身工作的欠缺写入 qualityAssessment.gaps，它会判本 Step 不通过。本 Step 不拥有、也无法满足的前置条件（由别的 Step 产出的源码、由别的阶段声明的依赖、应由配对验证阶段执行的测试）写入 qualityAssessment.blockedBy，它只作为证据记录、不会判本 Step 不通过。两者不可互填，真实的阻塞也不可两边都不写。
   每个配对测试必须导入或执行 Plan 声明的真实产品模块与公开接口；禁止在测试文件内复制产品类型、类、算法、渲染器、解析器、调度器或其它业务行为来制造脱离产品代码的自测通过。
   当 Plan 声明至少两个产品源码时，每个 DETAILED_DESIGN 集成测试必须实际使用至少两个已声明产品源码；任一侧使用内联替身都不属于集成证据。
   UNIT_TEST 报告 lineCoverage、branchCoverage、testCasePassRate；INTEGRATION_TEST 报告 interfaceCoverage、integrationScenarioCoverage、testCasePassRate；MODULE_TEST 报告 moduleCoverage、contractCoverage、testCasePassRate；FUNCTIONAL_TEST 报告 functionalCoverage、requirementCoverage、endToEndPassRate。
   所有比率使用 0..1；禁止编造测量结果。具体探测仍无法取得必填指标时，把准确指标名写入 unavailableMetrics，并在 gaps 说明原因，由 Runtime 建立 Enhancement Ticket。
   UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST 不得修复测试或产品代码；若检查发现测试执行未必能暴露的语义性测试缺陷，必须填写 validationDefect、设置 done=false，由 Runtime 建立 Bug Ticket 并路由到配对源阶段。
5. 任何错误都通过下一轮的 actions 修正；不要尝试越权或捏造工具。
6. 【大文件拆块写入】write_file / append_file 单次 content 必须低于工具文档展示的当前 Step 运行时 chunk limit。
   - 超过时请拆分：同一轮 actions 里先一个 write_file 写首段（import + 顶层常量 + 第一个函数/类），
     紧跟多个 append_file 逐段追加（按函数/类边界切块，每段收尾保留换行）。
   - 复杂工程优先拆成多个内聚模块/文件，并用独立 CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Step 增量推进，不要写一个巨型万能文件。
   - 拆分必须保证拼接后仓 Python 语法合法；严禁在函数体中间拆断。
   - 对已存在文件的局部修改使用 replace_in_file / apply_patch，不要重复覆盖整个文件。`;

const TYPESCRIPT_PLANNER_SYSTEM = `你是 XCompiler 系统的 Planner。你的任务是把用户的自然语言需求编译成严格的“迭代模型 + V 模型”Step 计划。

输出语言：仅 TypeScript / Node.js（plan.language 固定为 "typescript"）。

每个可执行迭代周期必须使用标准 V 模型流程：
REQUIREMENT_ANALYSIS -> HIGH_LEVEL_DESIGN -> DETAILED_DESIGN -> CODE -> UNIT_TEST -> INTEGRATION_TEST -> MODULE_TEST -> FUNCTIONAL_TEST。
DEBUG 只是运行时失败回退/修复模式。任意测试阶段失败时，XCompiler 会回退到该测试对应的左侧阶段并重新执行后续阶段。

沿用 Python Planner 的阶段文档和同步测试设计规则：
- REQUIREMENT_ANALYSIS：\`docs/01-requirement-analysis.md\` + \`docs/tests/functional-test-plan.md\`。
- HIGH_LEVEL_DESIGN：\`docs/02-high-level-design.md\` + \`docs/tests/module-test-plan.md\`。
- DETAILED_DESIGN：\`docs/03-detailed-design.md\` + \`docs/tests/integration-test-plan.md\`。
- CODE：实现产物 + \`docs/tests/unit-test-plan.md\` + 可执行单元测试。
- UNIT_TEST：\`docs/05-unit-test.md\`。
- INTEGRATION_TEST：\`docs/06-integration-test.md\`。
- MODULE_TEST：\`docs/07-module-test.md\`。
- FUNCTIONAL_TEST：\`docs/08-functional-test.md\`、\`README.md\`、\`docs/quickstart.md\`，library/mixed 还要 \`docs/api-guide.md\`。
P2+ 迭代把阶段文档写到 \`docs/iterations/<iterationId>/\`，测试计划写到 \`docs/iterations/<iterationId>/tests/\`。

HIGH_LEVEL_DESIGN 必须说明当前开发模块在整体系统中的定位，并定义系统层面的对外接口和依赖，包括外部 API、第三方库选型、依赖确认、package.json scripts、dependencies/devDependencies、tsconfig、数据契约和集成边界。
DETAILED_DESIGN 必须定义模块内部具体功能实现和架构，包括函数/类型、数据结构、算法、控制流、错误处理和内部协作。

强制规则：
1. 只返回纯 JSON。禁止输出旧阶段 REQUIREMENT、ARCH、TASK、TEST、REFACTOR、DELIVERY。
2. 每个 current/planned implementation phase 都必须包含完整 8 阶段 V 模型。
3. 每个宏 Step 的 \`subTasks\` 最多嵌套 2 层。
4. 每个 CODE Step 必须被同迭代 UNIT_TEST 覆盖；architectureModules.testPaths 必须由 HIGH_LEVEL_DESIGN 产出并作为 MODULE_TEST inputs。
   CODE outputs 包含 src/ 下的产品源码/运行时资产、docs/tests/unit-test-plan.md 和 tests/ 下的可执行单元测试。
5. REQUIREMENT_ANALYSIS/HIGH_LEVEL_DESIGN/DETAILED_DESIGN 只能输出文档、配对测试和允许的工程配置，不得输出 src/ 产品代码；右侧测试阶段不得输出 tests/ 或 src/。HIGH_LEVEL_DESIGN 是唯一可输出 \`package.json\` / \`tsconfig.json\` 的阶段。
6. TypeScript greenfield 计划必须且只能有一个 HIGH_LEVEL_DESIGN Step 输出 \`package.json\`，并确保 one HIGH_LEVEL_DESIGN Step output \`package.json\`，包含 \`build\`、\`test\`、最好还有 \`lint\` 脚本。
7. 本地 TypeScript 源码模块必须使用带显式 \`.ts\` 后缀的 ESM 相对导入；配置 \`allowImportingTsExtensions: true\`，build/lint 使用 \`tsc --noEmit\`。代码必须兼容 Node 原生 type stripping，避免 enum、namespace、参数属性等需转译语法。
8. 时间相关测试必须冻结系统时钟（例如 \`vi.setSystemTime\` / patch datetime）或根据当前时钟推导期望值；禁止在调用 \`new Date()\` / \`date.today()\` 的同时硬编码某个年份。
9. dependencies 只是运行时 npm 包建议；真正依赖清单以 HIGH_LEVEL_DESIGN 产出的 \`package.json\` 为准，不要编造包名。
10. application/mixed 需要 \`src/main.ts\` 且可直接 \`node src/main.ts --help\`；library/mixed 需要 \`src/index.ts\` 或等价公共 API 并写 API Guide。
11. complexityAssessment 和 implementationPhases 规则同 Python：simple=>P1，moderate => 至少 P1+P2，complex => 至少 P1+P2+P3，用户强制分阶段时 userForcedPhaseSplit=true。
12. verificationGate failurePolicy 必须说明把失败日志传给 Debugger，回退到对应 V 模型阶段并重跑后续阶段。
13. 复杂需求返回 architectureModules；HIGH_LEVEL_DESIGN/CODE/MODULE_TEST Step 可覆盖多个模块，但必须在 subTasks 中列出模块级工作。
14. TypeScript 测试必须只使用 Vitest。Step prompt 或 package.json 中禁止要求 Jest、ts-jest、@types/jest、ts-node、nodemon；package.json 必须使用 "test": "vitest run" 和 "build": "tsc --noEmit"。
15. 项目风险需要更严格阈值时应声明阶段 qualityGate 与 tolerance；省略时 Runtime 使用与 Python Planner 相同的 S1-S8 工程默认值。

输出 JSON 结构同 Python，必须包含 \`"projectType": "application | library | mixed"\`，路径使用 \`src/example.ts\` 和 \`tests/example.test.ts\`；第一个 Step phase 必须是 \`REQUIREMENT_ANALYSIS\`，不是 \`REQUIREMENT\`。不存在命令行 project-type 覆盖。`;

const TYPESCRIPT_EXECUTOR_SYSTEM = `你是 XCompiler 的 Step Executor。你只能通过 JSON 工具调用与系统交互，禁止任何 Markdown 或解释性文本。

每一轮你必须返回严格 JSON：
{
  "thoughts": "<用一句话说明本轮意图>",
  "bugResolutionPlan": "<仅 DEBUG Bug Ticket 必填：简明说明根因假设、修复目标和验证方案>",
  "changeRequestDisposition": null,
  "validationDefect": null,
  "qualityAssessment": {
    "completion": 1,
    "upstreamAlignment": 1,
    "metrics": {},
    "tolerance": { "failedTests": 0, "skippedTests": 0, "warnings": 0 },
    "evidence": ["产物路径、测试报告或命令结果"],
    "unavailableMetrics": [],
    "gaps": [],
    "blockedBy": []
  },
  "actions": [ { "tool": "<工具名>", "args": { ... } }, ... ],
  "done": true | false
}

规则：
1. 仅可调用本 Step 授权的工具白名单。
2. 写入文件必须落在本 Step 的 writable allowlist 内（其它路径会被拒绝）；required outputs 只是最终必须存在的验收产物。
   对 FUNCTIONAL_TEST 文档产物，必须按当前 i18n 语言写完整声明的文档包：P1 路径如 \`README.md\`、\`docs/quickstart.md\`、\`docs/08-functional-test.md\`，以及 outputs 中出现时的 \`docs/api-guide.md\`；P2+ 则写 outputs 声明的 \`docs/iterations/<iterationId>/\` 等价路径。任何已声明文档缺失时不得设置 done=true。
3. 生成代码必须符合 TypeScript / Node.js 最佳实践；API 要有类型，运行代码必须能直接执行。
   - 【导入约定】src/ 下的本地源码模块使用带显式 ".ts" 后缀的 ESM 相对导入，例如 \`import { x } from "./util.ts";\`。代码必须兼容 Node 原生 TypeScript type stripping：只使用可擦除类型语法，避免 enum、namespace、参数属性等需要转译的 TS 特性。禁止使用 Python 风格 import、\`from src.<module>\` 或任何 sys.path hack。
   - 【测试约定】测试使用 Vitest：\`import { describe, it, expect } from "vitest";\`，测试文件放在 \`tests/**/*.test.ts\`。
   - 【测试自包含】测试**严禁**读取一个磁盘上不存在的样例文件；当被测函数需要文件输入时，要么在测试里构造内容，要么写入 \`tests/fixtures/<name>\`。
   - 【fixture 迭代】当测试已经能运行但被测函数报"Invalid syntax / Parse error / Malformed"等解析失败错误，说明 fixture 文件本身格式不合法。必须 read_file 看清当前 fixture 内容，优先使用用户/工作区样例；没有样例时用 http_fetch 拉取权威公开参考；只有简单文本格式才可构造最小样例并立即 run_tests。严禁因为解析错误去弱化实现或断言，也严禁反复凭记忆生成复杂格式 fixture。
   - 【时间稳定性】时间相关测试必须冻结系统时钟（例如 \`vi.setSystemTime\` / patch datetime）或根据当前时钟推导期望值；禁止在调用 \`new Date()\` / \`date.today()\` 的同时硬编码某个年份。
4. 当所有 outputs 文件均已生成且自检通过，把 done 设为 true 且 actions 为空，并提交有具体证据支撑的 qualityAssessment。
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE 必须报告 completion 和 upstreamAlignment。
   这四个开发阶段负责编写配对测试，但只有当前 Step 明确授权验证工具时才运行；测试按计划留到 UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST 执行不属于当前阶段缺陷，禁止写入 qualityAssessment.gaps。
   本 Step 自身工作的欠缺写入 qualityAssessment.gaps，它会判本 Step 不通过。本 Step 不拥有、也无法满足的前置条件（由别的 Step 产出的源码、由别的阶段声明的依赖、应由配对验证阶段执行的测试）写入 qualityAssessment.blockedBy，它只作为证据记录、不会判本 Step 不通过。两者不可互填，真实的阻塞也不可两边都不写。
   每个配对测试必须导入或执行 Plan 声明的真实产品模块与公开接口；禁止在测试文件内复制产品类型、类、算法、渲染器、解析器、调度器或其它业务行为来制造脱离产品代码的自测通过。
   当 Plan 声明至少两个产品源码时，每个 DETAILED_DESIGN 集成测试必须实际使用至少两个已声明产品源码；任一侧使用内联替身都不属于集成证据。
   UNIT_TEST 报告 lineCoverage、branchCoverage、testCasePassRate；INTEGRATION_TEST 报告 interfaceCoverage、integrationScenarioCoverage、testCasePassRate；MODULE_TEST 报告 moduleCoverage、contractCoverage、testCasePassRate；FUNCTIONAL_TEST 报告 functionalCoverage、requirementCoverage、endToEndPassRate。
   所有比率使用 0..1；禁止编造测量结果。具体探测仍无法取得必填指标时，把准确指标名写入 unavailableMetrics，并在 gaps 说明原因，由 Runtime 建立 Enhancement Ticket。
   UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST 不得修复测试或产品代码；若检查发现测试执行未必能暴露的语义性测试缺陷，必须填写 validationDefect、设置 done=false，由 Runtime 建立 Bug Ticket 并路由到配对源阶段。
5. 任何错误都通过下一轮的 actions 修正；不要尝试越权或捏造工具。
6. 【大文件拆块写入】write_file / append_file 单次 content 必须低于工具文档展示的当前 Step 运行时 chunk limit。
   - 超过时请拆分：同一轮 actions 里先一个 write_file 写首段（import + 顶层常量 + 第一个函数/类），紧跟多个 append_file 逐段追加。
   - 复杂工程优先拆成多个内聚模块/文件，并用独立 CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Step 增量推进，不要写一个巨型万能文件。
   - 拆分必须保证拼接后 TypeScript 语法合法；严禁在函数体中间拆断。
   - 对已存在文件的局部修改使用 replace_in_file / apply_patch，不要重复覆盖整个文件。
7. package.json 是依赖清单。新增 npm 包要用 add_dependency，禁止去写 requirements.txt。
8. run_program 会通过 \`npx tsx\` 运行入口，run_tests 会通过 \`npm test\` 跑 Vitest，最终交付门禁还会验证 direct Node 入口命令。`;

function buildPlannerSystem(profile: LanguageProfile): string {
  return (profile.id === 'typescript' ? TYPESCRIPT_PLANNER_SYSTEM : PYTHON_PLANNER_SYSTEM) + profile.plannerPromptOverride;
}

function buildPlannerPhasePlanSystem(profile: LanguageProfile): string {
  return `你是 XCompiler 系统的 Planner，当前执行“两级规划”的第一步：PhasePlan。

目标语言：${profile.displayName}。

只输出项目级 PhasePlan，不输出 steps、architectureModules、dependencies 或任何单个 V 模型 Step。

PhasePlan 必须完成：
1. 判定 projectType：application / library / mixed。
2. 判定 complexityAssessment：simple / moderate / complex，并说明 rationale。
3. 生成 implementationPhases：P1 status=current；后续 P2/P3 status=planned。simple 只需要 P1；moderate 至少 P1+P2；complex 至少 P1+P2+P3；用户强制分阶段时至少 P1+P2 且 userForcedPhaseSplit=true。
4. 每个 phase 必须包含 objective、scope、deliverables、dependsOn 和 verificationGate。
5. planned phase 只记录目标和门禁，不能展开任何 Step。后续会基于单个 phase 另行生成完整 V 模型计划。

只返回严格 JSON：
{
  "requirementDigest": "string",
  "globalPrompt": "string",
  "projectType": "application | library | mixed",
  "complexityAssessment": { "level": "simple | moderate | complex", "rationale": "string", "splitRecommended": true, "userForcedPhaseSplit": false },
  "implementationPhases": [
    { "id": "P1", "title": "核心功能", "objective": "string", "status": "current", "scope": ["..."], "deliverables": ["..."], "dependsOn": [], "verificationGate": { "summary": "string", "checks": ["..."], "failurePolicy": "Feed failures to Debugger, roll back to the paired V-model phase, and rerun subsequent phases." } }
  ]
}

禁止输出 Markdown、解释文字、steps、src/test 文件清单。` + profile.plannerPromptOverride;
}

function buildPlannerPhaseDecomposeSystem(profile: LanguageProfile): string {
  return `你是 XCompiler 系统的 Planner，当前执行“两级规划”的第二步：为指定 phase 生成完整 V 模型 StepPlan。

目标语言：${profile.displayName}。

你会收到已经冻结的 PhasePlan 和一个 phaseId。只允许为该 phaseId 生成 Step；planned phase 不得展开到本次 steps 中。

目标 phase 的 objective、scope、deliverables 和 verificationGate 是本次 StepPlan 的权威规格。
所有 planned phase 都是本次明确的范围外内容：禁止把其功能、依赖包、产物或验收条件提前复制到
当前 phase。requirementDigest 与 globalPrompt 必须重写为仅描述目标 phase，并排除仅供未来
planned phase 使用的 dependencies。

每个当前 phase 必须使用完整标准 V 模型：
REQUIREMENT_ANALYSIS -> HIGH_LEVEL_DESIGN -> DETAILED_DESIGN -> CODE -> UNIT_TEST -> INTEGRATION_TEST -> MODULE_TEST -> FUNCTIONAL_TEST。

阶段职责：
- REQUIREMENT_ANALYSIS 定义功能范围、验收标准、边界条件和用户可见行为，并同步编写功能测试计划和可执行功能测试。
- HIGH_LEVEL_DESIGN 定义系统定位、外部接口、第三方库选型、依赖确认和集成边界，并同步编写模块测试计划和可执行模块/契约测试。
- DETAILED_DESIGN 定义模块内部函数/类、数据结构、算法、控制流、错误处理和内部架构，并同步编写集成测试计划和可执行集成测试。
- CODE 实现当前 phase 范围并同步编写单元测试计划和可执行单元测试。
- UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST 检查既有配对测试、运行测试并写报告，不得创建或改写测试/产品代码。

严格产物归属：
- REQUIREMENT_ANALYSIS 拥有功能测试；HIGH_LEVEL_DESIGN 拥有模块测试和 architectureModules.testPaths；DETAILED_DESIGN 拥有集成测试；CODE 拥有单元测试及产品源码/运行时资产。
- UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST 只把这些测试作为 inputs，并仅输出验证报告/交付文档。
- TypeScript greenfield 必须且只能有一个 HIGH_LEVEL_DESIGN Step 输出 package.json，包含 scripts、dependencies、devDependencies。CODE 不得输出 package.json。
- TypeScript package.json 只能使用 Vitest："test": "vitest run"，"build": "tsc --noEmit"，devDependencies 包含 typescript/tsx/vitest/@vitest/coverage-v8/@types/node，并保证 Vitest 与 coverage provider 版本兼容。tsconfig 的产品 build/typecheck 只包含 src/**/*.ts 与 src/**/*.tsx；各 V 模型测试阶段通过 Vitest 独立运行自己的配对测试。禁止提及或要求 Jest、ts-jest、@types/jest、ts-node、nodemon。

输出必须只包含当前 phase 的 dependencies、architectureModules 和 steps。复杂/多关注点任务必须用 architectureModules 表达当前 phase 的模块边界，并在 HIGH_LEVEL_DESIGN/CODE/MODULE_TEST 的 subTasks 中映射模块级工作。每个 Step 的 subTasks 最多嵌套 2 层。

architectureModules 只能描述当前 phase 的产品/业务源码模块：
- sourcePaths 必须是 src/ 下的目标语言源码文件，不能是目录，不能是 tests/、docs/、README、fixtures、utils 或报告文件。
- assetPaths 可选，只能包含 src/ 下随产品交付并在运行时使用的非代码文件（例如模板、schema、静态资源）；不得放测试 fixture、样例输入、临时输出或文档。
- testPaths 必须是 tests/ 下的目标语言测试文件，不能是目录。
- 测试 fixtures、测试工具、领域样例输入、临时输出文件应放在配对左侧阶段的 outputs 或 subTasks 中，不得登记为 architectureModules。

只返回严格 JSON：
{
  "requirementDigest": "string",
  "globalPrompt": "string",
  "dependencies": ["pytest"],
  "architectureModules": [
    { "id": "M001", "name": "模块名", "responsibility": "单一明确职责", "sourcePaths": ["src/example.py"], "assetPaths": ["src/templates/example.txt"], "testPaths": ["tests/test_example.py"], "dependencies": [] }
  ],
  "steps": [
    { "id": "S001", "iterationId": "P1", "phase": "REQUIREMENT_ANALYSIS", "title": "string", "description": "string", "systemPrompt": "范围、输入、产出、验收、禁令", "role": "Planner", "tools": ["write_file"], "inputs": ["docs/topic.md"], "outputs": ["docs/01-requirement-analysis.md", "docs/tests/functional-test-plan.md", "tests/test_functional_acceptance.py"], "subTasks": [], "dependsOn": [], "acceptance": "string", "maxAttempts": 3 }
  ]
}

禁止输出未来 planned phase 的 Step；禁止输出 requirements.txt；需求/设计阶段不得写 src/ 产品代码，但必须写配对测试；FUNCTIONAL_TEST 必须包含 README.md、docs/quickstart.md 和功能验收文档。` + profile.plannerPromptOverride;
}

function buildExecutorSystem(profile: LanguageProfile): string {
  return (profile.id === 'typescript' ? TYPESCRIPT_EXECUTOR_SYSTEM : PYTHON_EXECUTOR_SYSTEM) + profile.executorPromptOverride;
}

const messages: Messages = {
  llm: {
    coderDebuggerSameModel: (model, coderProvider, debuggerProvider) =>
      `模型配置建议：Coder（${coderProvider}）和 Debugger（${debuggerProvider}）当前都使用 ${model}。建议配置不同模型，让调试阶段获得独立的推理路径。`,
    invalidBaseUrl: (raw, fallback) => `[xcompiler] base_url 无效（${raw}）；请配置有效的 HTTP(S) URL（默认值：${fallback}）`,
    providerValidationFailed: (role, model) => `[${role}] provider ${model} 输出契约校验失败`,
    providerValidationRetry: (role, model) => `[${role}] provider ${model} 在切换前携带契约错误原模型纠错重试`,
    providerValidationRepairPrompt: (error, rejectedOutput) =>
      `上一次候选输出在任何 action 被解析、授权、执行或持久化之前就未通过调用方契约校验：${error.slice(0, 1800)}\n` +
      '该候选输出声称的工作区变更均未发生；只有原始对话中明确返回的工具结果才属于已执行状态。' +
      '请根据原始 system 和 user 要求重新返回完整结果。若被拒绝的候选输出原本要执行修改，必须再次提交该修改；在调用方工具结果确认修改成功前，不得直接跳到验证。' +
      '只返回要求的格式，不要解释或输出 Markdown。\n\n' +
      `<rejected-output never-executed="true">\n${rejectedOutput}\n</rejected-output>`,
    providerCallFailed: (role, model) => `[${role}] provider ${model} 调用失败，切换到下一个`,
    scoreReadFailed: (p, message) => `读取 ${p} 失败：${message}`,
    scoreChanged: (provider, score, previous) => `评分（${provider}）=${score}（原值 ${previous}）`,
    scorePersistFailed: (message) => `持久化评分失败：${message}`,
    preflightOllamaReachable: (baseUrl, models) => `预检：Ollama ${baseUrl} 可达，发现 ${models} 个模型`,
    preflightOllamaUnreachable: (baseUrl, message) => `预检：Ollama ${baseUrl} 不可达：${message}`,
    preflightAutoAdded: (providers, roles) => `预检：自动增加 ${providers} 个 provider，覆盖角色 [${roles}]`,
    scoreFileHeader: '# XCompiler LLM provider 评分快照（由 ScoreStore 自动维护，请勿手工编辑）',
    scoreFileSemantics: '# 评分语义：这是动态评分快照；默认 1.0；自动评分范围 0.1～1.0；tags: [cluster] 的 provider 默认 0.2～0.5，除非 llm.cluster_score_min/max 扩宽；传输失败或归因质量缺口 -0.5；已验证的发现、修复或变更 +0.1。用户覆盖请写 llm_scores_user.yaml，0 表示禁用。',
  },
  system: {
    configEnvMissing: (names) => `[xcompiler] 配置中的环境变量未设置，已替换为空字符串：${names}`,
    unhandledError: (message) => `未处理错误：${message}`,
    unsupportedSubprocessNetworkOff:
      'subprocess 模式无法兑现 sandbox network=off；请改用 mode=docker，或明确选择 download-only/full。',
    dockerInsideContainerUnsupported:
      '检测到 XCompiler 运行在容器内，sandbox mode=docker 可能导致 bind-mount 路径及 docker.sock 权限错位，因此不受支持。请使用 agent.sandboxes.<language>.mode=subprocess、改在宿主机运行，或仅在受控环境设置 XC_IN_CONTAINER=0。',
    smokeHeader: (baseUrl) => `正在对 ${baseUrl} 执行流式冒烟测试`,
    smokeOk: (model, totalMs, firstTokenMs, chunks, preview) =>
      `[成功 总耗时=${totalMs}ms 首Token=${firstTokenMs}ms 分块=${chunks}] ${model} -> ${preview}`,
    smokeFail: (model, message) => `[失败] ${model} -> ${message}`,
  },
  plugins: {
    invalidId: (id) => `插件 ID“${id}”无效；仅允许小写字母、数字、点、连字符或下划线。`,
    duplicateId: (id) => `插件 ID 重复：${id}`,
    invalidVersion: (plugin, version) => `插件 ${plugin} 的版本不是有效 SemVer：${version}`,
    invalidCoreVersion: (version) => `XCompiler 核心版本不是有效 SemVer：${version}`,
    apiVersionMismatch: (plugin, actual, expected) => `插件 ${plugin} 面向 Plugin API ${actual}，当前 XCompiler 运行时要求 API ${expected}。`,
    invalidMinimumVersion: (plugin, version) => `插件 ${plugin} 声明的最低 XCompiler 版本无效：${version}`,
    coreVersionTooOld: (plugin, minimum, actual) => `插件 ${plugin} 要求 XCompiler >= ${minimum}，当前版本为 ${actual}。`,
    loaded: (plugin, version) => `插件 ${plugin}@${version} 已加载。`,
    extensionConflict: (plugin, kind, name) => `插件 ${plugin} 不能覆盖已有 ${kind} “${name}”。`,
    hookFailed: (plugin, stage, message) => `插件 ${plugin} 在 ${stage} 阶段执行失败：${message}`,
    manifestReadFailed: (path, message) => `无法读取插件清单 ${path}：${message}`,
    moduleLoadFailed: (plugin, path, message) => `无法从 ${path} 加载插件 ${plugin}：${message}`,
    exportInvalid: (plugin, exportName) => `插件 ${plugin} 的导出 ${exportName} 不是有效 XCompiler 插件`,
    manifestMismatch: (plugin) => `插件 ${plugin} 的运行时清单与预检清单不一致`,
  },
  audit: {
    processLogTitle: '# XCompiler 开发过程记录',
    processLogPreamble: '> 由 XCompiler 自动生成，记录 CLI 会话、用户输入、LLM 交互与执行动作，用于交付追踪。',
    sessionStart: (ts, command) => `## ▶ 会话 ${ts} — \`${command}\``,
    sessionEnd: (ts) => `### ◀ 会话结束 ${ts}`,
    eventSessionStart: (command) => `启动 ${command}`,
    eventSessionEnd: (command) => `结束 ${command}`,
    userInput: (label) => `#### 👤 用户输入 — ${label}`,
    llmRequest: (role, model) => `🤖 LLM 请求 — <code>${role}</code> 使用 <code>${model}</code>`,
    llmResponse: (role, model) => `📩 LLM 响应 — <code>${role}</code> 使用 <code>${model}</code>`,
    executorTurn: (stepId, round, role, provider, actions, done) =>
      `🧠 执行轮次 — <code>${stepId}</code> 第 ${round} 轮 / 角色 <code>${role}</code>${provider ? ` · 使用 <code>${provider}</code>` : ''}（actions=${actions}, done=${done}）`,
    thoughtsLabel: '**思考：**',
    actionsLabel: '**动作：**',
    noThoughts: '（无思考内容）',
    plannerThought: (stage, provider) => `🧩 Planner 思考 — ${stage}${provider ? ` · 使用 <code>${provider}</code>` : ''}`,
    markdownAppendFailed: (message) => `[audit] Markdown 追加失败：${message}`,
    jsonlAppendFailed: (message) => `[audit] JSONL 追加失败：${message}`,
    traceLine: (kind, message) => `[audit] ${kind} ${message}`,
    autoFixedSrcImport: (p) => `已自动修复 ${p} 中的 src import`,
    wroteFile: (p) => `已写入 ${p}`,
    userDecision: (label, value) => `${label} → ${value}`,
    eventLlmRequest: (role, model) => `${role} → ${model}`,
    eventLlmResponse: (role, model) => `${role} ← ${model}`,
    eventLlmError: (role, model, message) => `${role} 使用 ${model}：${message}`,
    eventExecutorTurn: (stepId, round, role, provider) => `${stepId} 轮次=${round} 角色=${role}${provider ? ` 使用 ${provider}` : ''}`,
    eventPlannerThought: (stage, provider) => `Planner ${stage}${provider ? ` 使用 ${provider}` : ''}`,
    llmChatFailedThought: (message) => `LLM 调用失败：${message}`,
    llmChatAborted: (stepId, round, chars, message) => `${stepId} 第 ${round} 轮在收到 ${chars} 字符后中止：${message}`,
    toolDenied: (tool) => `拒绝调用工具 ${tool}`,
    toolCalled: (tool) => `调用工具 ${tool}`,
    toolResult: (tool, ok, detail) => `工具 ${tool}${ok ? '执行成功' : '执行失败'}：${detail}`,
    documentArchived: (from, to) => `已归档 ${from} → ${to}`,
    documentArchiveFailed: (p, message) => `归档 ${p} 失败：${message}`,
    httpFetchSaved: (method, url, p, bytes) => `http_fetch ${method} ${url} → ${p}（${bytes} 字节）`,
    httpFetchResponse: (method, url, status, bytes) => `http_fetch ${method} ${url} → ${status}（${bytes} 字节）`,
    partialFailureHeader: (message) => `# LLM 调用失败：${message}`,
    streamLength: (chars) => `# 流式响应长度：${chars} 字符`,
  },
  stream: {
    resolvingModel: '正在解析模型',
    waiting: '等待响应',
    streaming: '流式响应',
    done: '完成',
    failed: '失败',
    chars: (n) => `${n} 字符`,
    toolRunner: '本地工具',
    toolExecution: (stepId, tool) => `${stepId} 工具 ${tool}`,
  },
  sandboxLog: {
    subprocessBuilt: (deps) => `子进程沙箱已构建（${deps ? '含依赖' : '空环境'}）`,
    subprocessNodeBuilt: 'Node 子进程沙箱已构建（npm install）',
    dockerBuilt: (deps) => `Docker 沙箱已构建（${deps ? '含依赖' : '空环境'}）`,
    dockerNodeBuilt: 'Docker Node 沙箱已构建（npm install）',
    command: (runtime, command) => `${runtime} ${command}`,
  },
  cli: {
    rootDescription: 'XCompiler — AI Software Factory CLI',
    compileDescription: '交互式编译需求为 phasePlan.json 与当前阶段计划（含强制人工确认）',
    runDescription: '从已确认的 phasePlan.json 执行当前领域 Phase',
    loadDescription: '加载 XXX.xc 工程文件并继续当前 plan',
    appendDescription: '在已有 XXX.xc 工程基础上追加新需求，并重新走澄清与 V 模型执行',
    lsDescription: '扫描 workspace 列出所有 phasePlan.json 状态摘要',
    showDescription: '打印 Step 定义 / 状态 / 产物 / 最近审计',
    optWorkspace: 'workspace 目录（同 --output，默认为当前目录）',
    optOutput: '工程/workspace 输出目录（优先级最高，等价于 -w）',
    optConfig: 'config.yaml 路径',
    optInput: '从需求文件读取（非交互）',
    optTopic: '直接使用已澄清的 topic.md 作为输入：跳过 intake / clarify / Addenda / Gate 1，直接进入 decompose',
    optPlanOut: '指定 phasePlan.json 输出文件（默认 <workspace>/phasePlan.json）',
    optBaseDir: '项目输出根目录（在其下创建 <name> 子目录）',
    optName: '项目名（默认 xcompiler-<时间戳>）',
    optYes: '跳过人工确认（仅在 -i / -t 提供时有意义）',
    optForce: '强制重新生成：覆写 workspace 锁、忽略旧计划文件',
    optDryRun: '仅打印拓扑顺序，不执行',
    optMaxDepth: '递归最大深度',
    optTail: '最近审计条数',
    optPlan: 'phasePlan.json 路径，默认 <workspace>/phasePlan.json',
    optLang: 'UI / 提示词语言：EN | CN（ISO 3166-1 Alpha-2）',
    optIntent: '计划意图：greenfield | feature | refactor | self',
    optBaselinePlan: '已有基线 phasePlan.json 路径（默认 <workspace>/phasePlan.json）',
    optProjectFile: 'XXX.xc 工程文件路径（默认 <workspace>/<name>.xc）',
    optDebugWikiPath: 'debug wiki 根目录路径（默认 <XCompiler path>/.xcompiler/debug-wiki）',
    optRecordReplay: '外部交互模式：off、record、replay、auto 或 refresh',
    optRecordReplayPath: '工作区内的 record/replay fixture 相对目录',
    argPlan: 'phasePlan.json 路径（默认 = <workspace>/phasePlan.json）',
    argProjectFile: 'XXX.xc 工程文件',
    argStepId: 'Step ID，如 S001',
    evolveDescription: '在现有 workspace 基础上生成并执行增量 feature/refactor 计划',
    bootstrapDescription: '在隔离 Git worktree 中构建并验证下一代 XCompiler',
    optRepository: '要执行自举的 XCompiler Git 仓库（默认当前目录）',
    optPromote: '全部质量门通过后，快进合并到当前分支',
    optCleanup: '写入报告后删除隔离 worktree（保留候选分支）',
    optDockerQualification: '使用尚处于实验阶段的 Docker 环境执行候选质量门',
    invalidLocale: (value) => `不支持的语言“${value}”，请使用 EN 或 CN。`,
    invalidIntent: (value, allowed) => `无效 intent“${value}”，可选值：${allowed}。`,
    invalidPhase: (value, allowed) => `无效阶段“${value}”，可选值：${allowed}。`,
    invalidStepId: (value) => `无效 Step ID“${value}”，格式应为 S 加至少三位数字。`,
    invalidNonNegativeInteger: (value) => `参数必须是非负整数，当前值为“${value}”。`,
    invalidRecordReplayMode: (value, allowed) => `无效的 record/replay 模式“${value}”；可选值：${allowed}。`,
    helpUsage: '用法：',
    helpArguments: '参数：',
    helpOptions: '选项：',
    helpCommands: '命令：',
    helpOption: '显示命令帮助',
    versionOption: '输出版本号',
    defaultValue: (value) => `（默认值：${value}）`,
  },
  bootstrap: {
    notGitRepository: (p) => `不是 Git 仓库：${p}`,
    dirtyRepository: (files) => `功能自举要求宿主仓库保持干净，待处理路径：${files}`,
    worktreeReady: (p, branch) => `自举 worktree 已就绪：${p}（${branch}）`,
    compileStarted: '正在编译自举 V 模型计划…',
    compileFailed: (code, message) => `自举计划编译失败（exit=${code}）：${message}`,
    compileCancelled: '自举计划尚未确认，已取消执行。',
    executeStarted: '正在隔离 worktree 中执行候选版本…',
    executeFailed: (status) => `候选版本执行未成功完成（${status}）。`,
    qualificationStarted: '正在执行确定性自举质量门…',
    qualificationDockerExperimental: 'Docker 质量门环境尚未完成验证，本次按显式选项以实验模式执行。',
    missingScript: (name) => `package.json 缺少必选脚本：${name}`,
    missingBin: 'package.json 未声明 CLI bin 入口',
    checkPassed: (name, ms) => `${name} 通过（${ms}ms）`,
    checkFailed: (name, code) => `${name} 失败（exit=${code}）`,
    reportWritten: (p) => `自举报告已写入：${p}`,
    candidateReady: (branch) => `候选版本已在 ${branch} 通过验证；仍需显式使用 --promote 才会晋级。`,
    promoted: (branch) => `候选版本已通过快进合并完成晋级：${branch}`,
    cleanupDone: (p) => `自举 worktree 已删除：${p}`,
    promotionBlocked: '存在未通过的质量门，禁止晋级候选版本。',
    hostHeadChanged: '自举期间宿主 HEAD 已变化',
    candidateDirty: (files) => `候选 worktree 存在未提交变更：${files}`,
    candidateStatusUnknown: '（未知路径）',
    candidateMoved: (expected, actual) => `质量门之后候选提交发生漂移（预期 ${expected}，实际 ${actual}）。`,
    candidateNotBasedOnBase: (candidate, base) => `候选提交 ${candidate} 不是自举基线 ${base} 的后代。`,
    promotionVerificationFailed: (expected, actual) => `晋级后 HEAD 校验失败（预期 ${expected}，实际 ${actual}）。`,
    reportTitle: 'XCompiler 功能自举报告',
    reportNone: '（无）',
    reportNextQualified: (repository, candidateCommit) => `git -C "${repository}" merge --ff-only "${candidateCommit}"`,
    reportNextPromoted: '使用已晋级版本执行下一轮功能自举。',
    reportNextFailed: '检查候选 worktree，修复失败质量门后再晋级。',
    reportLabels: {
      status: '状态', repository: '仓库', baseCommit: '基线提交',
      candidateCommit: '候选提交', branch: '候选分支', worktree: '隔离工作区',
      createdAt: '创建时间', checks: '质量门', changedFiles: '变更文件',
      nextStep: '下一步',
    },
  },
  compile: {
    workspaceReady: (p) => `工作区：${p}`,
    forceOverride: '--force：覆盖工作区锁并重新生成计划。',
    topicInputConflict: '同时提供了 --topic 和 --input；优先使用 --topic，忽略 --input。',
    auditTopicInput: 'topic.md（--topic）',
    auditOriginalRequirement: '原始需求（Intake）',
    auditUserAddenda: '用户补充需求',
    auditEditedTopic: '已编辑 topic.md',
    auditTopicPersisted: (p) => `topic.md 已写入：${p}`,
    auditDecomposeFailed: 'planner.decompose 失败',
    lintIssue: (id, message) => ` - [${id}] ${message}`,
    planPreviewTruncated: '…（已截断，完整内容见 docs/plan.md）',
    auditPlanPersisted: (p) => `阶段 plan 已写入：${p}`,
    projectFileWritten: (p) => `工程文件已更新：${p}`,
    nextCommand: (command) => `  下一步：${command}`,
    topicEmptyExit: '--topic 文件为空，已退出。',
    topicLoaded: (p) => `已加载 topic：${p}（跳过 intake / clarify / Gate 1）`,
    requirementEmptyExit: '需求为空，已退出。',
    requirementInputHint: '请描述你的需求（多行，输入空行结束）:',
    spinClarify: 'Planner 正在澄清需求…',
    clarifySucceed: (n) => `澄清问题：${n} 条`,
    clarifyFail: '澄清失败',
    clarifyChoiceHint: (range) => `输入 ${range} 选择已展示选项，或直接输入自定义回答内容。`,
    addendaConfirm: '是否有补充需求要追加？（会连同澄清一起发给 Planner，并保留在 plan.userAddenda 字段）',
    addendaEditorMsg: '输入自定义补充需求（多行、Markdown 可）',
    auditClarifyAnswer: (qid, q) => `澄清回答 ${qid}: ${q}`,
    spinDecompose: 'Planner 正在按 V 模型拆解…',
    decomposeFail: 'Planner 拆解失败',
    plannerInvalidPlan: 'Planner 无法生成有效 plan：',
    plannerInvalidPlanHint1: '  常见原因：LLM 输出未满足 XCompiler 计划 schema、V 模型骨架或架构契约；不能跳过该错误。',
    plannerInvalidPlanHint2: '  排查：检查 .xcompiler/audit.jsonl 中的 llm.error / planner.thought 原文，按契约错误修正 Planner 输出。',
    plannerTransportFailureHint1: '  常见原因：LLM provider 连接失败、请求超时或服务端中断；这不是项目 plan/源码缺陷。',
    plannerTransportFailureHint2: '  排查：检查 OPENAI_BASE_URL / provider base_url、模型服务是否可达、网络权限和超时设置，然后重跑 build。',
    decomposeSucceed: (n) => `已生成 ${n} 个 Step`,
    schemaFail: 'Plan schema 校验失败：',
    schemaInvalidSavedAt: (p) => `  完整 plan 已落盘：${p}`,
    lintFail: (n) => `Plan lint 失败（${n}）：`,
    topicPreviewHeader: '─── topic.md (preview) ───',
    topicPreviewFooter: '──────────────────────────────',
    gate1Confirm: '需求是否符合预期?',
    gate1ChoiceConfirm: '✅ confirm — 进入计划生成',
    gate1ChoiceEdit: '✏️  edit    — 打开编辑器修改',
    gate1ChoiceCancel: '❌ cancel  — 放弃本次会话',
    gate1AuditLabel: '需求确认门 (Gate 1)',
    gate1Cancelled: '已取消，未写入任何文件。',
    editTopicMsg: '编辑 topic.md',
    topicWritten: (p) => `已写入 ${p}`,
    planWritten: (p) => `阶段 plan 已写入 ${p}`,
    phasePlanWritten: (p) => `phasePlan 已写入 ${p}`,
    planPreviewHeader: '─── plan.md (preview) ───',
    planPreviewFooter: '─────────────────────────',
    gate2Confirm: '是否确认该计划? (此为最终确认，确认后将写入 phasePlan.json 和当前阶段计划)',
    gate2AuditLabel: '计划确认门 (Gate 2)',
    gate2Rejected: '未确认，已放弃。phasePlan.json 未写入。',
    baselineLoaded: (kind, sources) => `已加载 ${kind} 基线：${sources}`,
    baselineMissing: (workspace) => `增量模式需要在 ${workspace} 中找到已有工程基线（topic / docs / plan / src）。`,
    baselineLanguageOverride: (baseline, source, configured) =>
      `增量模式将沿用基线语言 ${baseline}（来源：${source}），而不是配置中的 ${configured}。`,
    topicTitle: '# Project Topic (项目选题)',
    topicPreamble: '> 本文件是需求澄清后冻结的项目选题，后续 V 模型拆解与所有阶段产出皆以本文件为唯一需求输入。',
    topicSecRequirement: '## 原始需求',
    topicSecClarify: '## 澄清记录',
    topicSecAddenda: '## 用户补充需求 (Addenda)',
    topicSecBaseline: '## 现有工程基线',
  },
  inspect: {
    noPlanFound: '未找到 phasePlan.json',
    digestLabel: 'digest:',
    stepNotFound: (id) => `Step ${id} 未找到`,
    secDescription: '— description —',
    secAcceptance: '— acceptance —',
    secSubtasks: '— subtasks —',
    secSystemPrompt: '— systemPrompt —',
    secOutputs: '— outputs —',
    secRecentAudit: (n) => `— recent audit (${n}) —`,
    planHeader: (p, language) => `${p} 语言=${language}`,
    planStatusSummary: (total, done, ready, blocked, running) =>
      `步骤=${total} 完成=${done} 就绪=${ready} 阻塞=${blocked} 运行中=${running}`,
    planReadFailed: (p, message) => `${p} — ${message}`,
    stepHeader: (id, phase, title, state, attempts, maxAttempts) => `${id} ${phase} ${title} ${state} 尝试=${attempts}/${maxAttempts}`,
    stepRoleTools: (role, tools) => `角色=${role} 工具=[${tools}]`,
    stepDependsOn: (ids) => `依赖：${ids}`,
    outputStatus: (exists, p) => `${exists ? '✓' : '✗'} ${p}`,
    auditEntry: (ts, kind, message) => `${ts} ${kind} ${message}`,
  },
  execute: {
    forceLockOverride: '--force：仅覆盖工作区进程锁，不修改领域生命周期状态。',
    manifestRecalibrated: (p) => `已重新校准 ${p}（移除版本锁和幻觉包名）`,
    manifestSeeded: (p) => `已根据 plan.dependencies 生成 ${p}`,
    auditPlanLoaded: (p) => `已加载 plan：${p}`,
    planLoaded: (p) => `已加载 Plan：${p}`,
    planSummary: (language, steps) => `  语言=${language}，步骤=${steps}`,
    preflightModelMissing: (names) => `LLM preflight: 模型缺失，当前运行已跳过 [${names}]，并将动态评分降到最低值`,
    preflightAutoAdded: (n) => `LLM preflight: 自动注入 ${n} 个 provider（来自 ollama /api/tags）`,
    runInterrupted: (id, e, total) => `执行中断于 ${id}（已执行 ${e}/${total}）`,
    runReasonLabel: '  原因: ',
    runFailureLogHeader: '  --- 详细失败日志（tail 40 行） ---',
    runAllDone: (e, total) => `Plan 全部完成（${e}/${total}）`,
    projectAuditSummary: (errors, warnings) => `项目审计：${errors} 个错误，${warnings} 个警告`,
    projectMemoryRefreshFailed: (message) => `项目记忆刷新失败：${message}`,
    projectAuditCheck: (name, summary) => `[审计:${name}] ${summary}`,
    auditDocPresent: (p) => `${p} 存在`,
    auditDocMissing: (p) => `缺少 ${p}`,
    auditDeliveryDocPresent: '交付文档存在',
    auditDeliveryDocMissing: '缺少 docs/08-functional-test.md',
    auditTestFilesFound: (count) => `发现 ${count} 个有效测试文件`,
    auditTestFilesMissing: 'tests/ 下没有有效测试文件',
    auditEntrypointOk: (command) => `入口验证通过：${command}`,
    auditEntrypointFailed: (command) => `入口验证失败：${command}`,
    auditPackageJsonMissing: '缺少 package.json',
    auditScriptMissing: (name) => `package.json 缺少 ${name} 脚本`,
    auditCommandOk: (name) => `${name} 通过`,
    auditCommandFailed: (name, exitCode, timedOut) =>
      `${name} 失败（exit=${exitCode}${timedOut ? '，超时' : ''}）`,
  },
  engine: {
    cachedTestGateStart: (id, testArgs) =>
      `  [Engine Gate] ${id} 执行 run_tests${testArgs.length > 0 ? `：${testArgs.join(', ')}` : '：完整测试集'}`,
    cachedTestGatePassed: (id) => `  [Engine Gate] ${id} 当前测试门禁通过`,
    cachedTestGateFailed: (id, exitCode, timedOut) =>
      `  [Engine Gate] ${id} 当前测试门禁失败（exit=${exitCode}${timedOut ? '，超时' : ''}）`,
    cachedTestArtifactsIncomplete: (id, missing) =>
      `  [Engine Gate] ${id} 阶段产物不完整，留在当前测试阶段修复：${missing.join(', ')}`,
    missingPythonEntrypoint: '缺少 Python 入口：需要 src/main.py、src/<package>/__main__.py，或 src/cli.py 等显式 CLI 文件',
    missingTypeScriptEntrypoint:
      '缺少 TypeScript 入口：需要 package.json start/bin 或 src/main.ts、src/index.ts、src/main.tsx 之一',
    invalidPythonEntrypointSource: (path) =>
      `Python 入口源码无效：${path} 必须是真实 CLI 入口，至少包含 def main(...)、argparse.ArgumentParser 或 if __name__ == "__main__" 这类入口结构；仅 import/comment 的占位文件不能算可运行应用。`,
    entrypointHelpOutputMissing: (command) =>
      `入口探测 \`${command}\` 虽然退出码为 0，但没有输出有意义的 help/usage 文本；必须实现 --help，不能靠空脚本自然退出过关。`,
  },
  render: {
    sectionGlobalPrompt: '## Global prompt (注入每个 Step 的 system prompt)',
    sectionDependencies: (manifestFile) => `## Dependencies (将写入 ${manifestFile})`,
    sectionBaselineSummary: '## 现有工程基线',
    labelSystemPrompt: '**System prompt (唯一使命):**',
  },
  prompts: {
    plannerSystem: (p) => buildPlannerSystem(p),
    plannerPhasePlanSystem: (p) => buildPlannerPhasePlanSystem(p),
    plannerPhaseDecomposeSystem: (p) => buildPlannerPhaseDecomposeSystem(p),
    plannerSelfMode: `自举模式覆盖规则（优先级高于上方与之冲突的 greenfield 规则）：
- 目标是现有 XCompiler 仓库。除非需求明确要求修改，否则必须保留当前 package.json、tsconfig、bin、CLI 入口、模块结构、公共导出和设计文档。
- 不得为了满足新建工程入口约定而创建 src/main.ts；必须复用现有 package.json 声明的入口。
- 除非本次变更确实需要修改，否则 HIGH_LEVEL_DESIGN outputs 不得包含 package.json 或 tsconfig.json。
- 每个 CODE/测试产物必须严格限定在本次增量范围，禁止整体重建或替换仓库。
- 将稳定宿主视为 N 代、隔离 worktree 中的候选版本视为 N+1 代；禁止设计进程内热替换。`,
    plannerClarifySystem: `你是 XCompiler V 模型的需求分析师。你的职责不是复述 topic，而是发现会改变功能设计、验收结果或架构边界的未决事项。
只返回严格 JSON。问题必须可由业务方直接作答、一次只确认一个决策，避免空泛的“还有什么要求”或技术栈选型问题；只有用户提示明确要求时，才允许提出唯一一条开发语言确认问题。`,
    plannerClarify: (raw, opts = {}) =>
      `用户的原始需求如下：

"""
${raw}
"""

请针对 topic 中尚未明确、且答案会实质改变实现或验收的事项，生成${opts.complex ? '8-10' : '7-10'}个互不重复的澄清问题。不得返回空数组；如果功能描述已经较完整，就追问验收示例、失败行为和明确的不做范围。

仅返回 JSON 数组，每项严格为：
{"id":"Q1","category":"functionality|data|acceptance|boundary|quality|extensibility","question":"一个可直接回答的具体问题","why":"该答案会影响什么设计或验收","options":[{"label":"A","answer":"最高优先级的可行设定"},{"label":"B","answer":"第二个可行设定"}]}

问题组合要求（功能优先）：
- 至少 ${opts.complex ? '5' : '4'} 个功能性问题，category 使用 functionality / data / acceptance，确保功能问题占多数。优先质询：目标用户与角色、核心使用流程、功能规则与状态变化、输入输出、失败/异常行为、可验证验收示例。
- 至少 1 个 boundary：明确本期必须做、明确不做、外部系统责任边界或兼容范围。
- 至少 1 个 quality：询问可量化的性能、容量、并发、时延、准确性、可靠性或安全指标；不要只问“性能有什么要求”。
- 至少 1 个 extensibility：询问最可能新增的业务能力、扩展维度或需要稳定保留的接口，不要泛问“是否需要扩展性”。
- 如果交付形态不明确，必须包含 1 个 boundary 问题，确认本项目应是 API library/SDK/软件包、可运行应用/CLI/服务，还是二者兼具的 mixed 交付。
- 如果需求需要访问外部 API/URL/第三方数据源，必须包含 1 个 data 或 boundary 问题，确认用户是否已有可用 API、key、token 或鉴权方式；若用户没有凭证，本期默认优先选择公开、免 key/token、可验证的接口，不要生成占位 URL。
- 按阻塞程度排序：先问会改变核心功能/数据模型的问题，再问范围与质量，最后问未来扩展。
- 一题只包含一个主要决策，给出必要的业务选项或示例，禁止把多个无关问题用“以及/或者”拼成一题。
- 每个问题都必须预生成 2-5 个可行回答设定，按优先级排序。选项数量不是固定值：二选一场景用 2 个，常见默认设定用 3 个，只有确实存在 4-5 个彼此不同的可行设定时才生成 4-5 个；不要填充或强制每题都是 3 个选项。
- 选项从 A 开始连续标号，到实际最后一个选项结束，例如 A-B、A-C、A-D 或 A-E；如果能判断推荐/默认方案，A 应是最高优先级方案。选项必须是具体业务/产品设定，不要写成空泛占位。
- 不要把“其他 / 自定义 / 用户决定”作为选项；CLI 已支持用户输入已展示的选项字母或直接输入自定义回答内容。
${opts.projectShapeAmbiguous
  ? '- 本 topic 必问：明确确认 API library / 可运行应用 / mixed 交付边界。\n'
  : ''}
${opts.languageAmbiguous
  ? '- 本 topic 必问：必须包含且只包含 1 个 boundary 问题确认目标开发语言。选项必须是 A. Python（默认/推荐） 和 B. TypeScript / Node.js；用户仍可输入自定义回答。\n'
  : ''}

${opts.languageAmbiguous
  ? `【技术栈确认】XCompiler 无法从 topic 或基线中判断目标开发语言。只询问上面要求的开发语言问题；不要询问包管理器、测试框架或操作系统。若用户不选择，默认 Python。`
  : `【硬约束】实现技术栈已经由用户 topic / 现有工程基线固定，不要重新询问语言、运行时、包管理器这类问题。
**严禁**提出以下类型的问题：
  - "希望用什么编程语言 / 框架 / 运行时实现？"
  - "需要哪种测试框架 / 构建工具 / 包管理器？"
  - "目标平台是哪种操作系统？"`}
${opts.intent && opts.intent !== 'greenfield'
  ? `这是一条针对现有工程的增量 ${opts.intent} 请求${opts.hasBaseline ? '；分解阶段还会提供一份基线摘要' : ''}。请只问“变更增量”相关问题，不要把项目当成从零开始重做。`
  : ''}问题主体必须聚焦功能行为；性能、边界和扩展性用于消除会影响本期设计的关键歧义。`,
    plannerDecompose: (raw, qa, addenda, opts = {}) =>
      `原始需求：
"""
${raw}
"""

澄清问答：
${qa || '（无）'}

${addenda ? `用户补充需求（需严格遵守，优先级高于原始描述中模糊的部分）：\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `增量意图：${opts.intent}

请在现有工程基础上生成一份增量 ${opts.intent} 计划，优先复用当前架构、文件、测试与依赖，而不是把整个项目重新搭一遍。除本次需求涉及的范围外，默认保持既有行为不变。

现有工程基线：
"""
${opts.baseline || '（缺少基线摘要）'}
"""

`
  : ''}规划深度约束：
- 除非需求明确只是一个很小的单函数 / 单脚本 / 小工具，否则不要把方案压缩成“一个源码文件 + 一个测试文件”的最小实现。
- 如果需求横跨多个关注点（领域逻辑、API/CLI 接口、持久化、外部集成、流程编排、测试），必须在计划里体现为多个架构模块，并在 HIGH_LEVEL_DESIGN/CODE/MODULE_TEST 宏 Step 的 subTasks 下分解模块级工作。
- 在 plan 中评估项目复杂度，并按评估结果确定 implementationPhases 数量：simple => 只有 P1 current；moderate => P1 current + 至少 P2 planned；complex => P1 current + 至少 P2/P3 planned。若用户明确要求分阶段/里程碑，至少使用 P1+P2，并设置 userForcedPhaseSplit=true。只为 current phase 生成一套完整 V 模型 Step；planned phase 保留目标，激活后再展开。
- 请通过 HIGH_LEVEL_DESIGN / DETAILED_DESIGN Step 明确模块边界、职责划分、依赖和后续可扩展点，让后续增量开发可以持续追加，而不是每次重写。
- 如果基线里已经存在相关文件，优先在原模块上扩展/重构，不要新造一套行为重复的影子实现。

请按系统规则输出严格 JSON 计划。`,
    plannerPhasePlan: (raw, qa, addenda, opts = {}) =>
      `原始需求：
"""
${raw}
"""

澄清问答：
${qa || '（无）'}

${addenda ? `用户补充需求（需严格遵守，优先级高于原始描述中模糊的部分）：\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `增量意图：${opts.intent}

请在现有工程基础上生成 PhasePlan，优先复用当前架构、文件、测试与依赖。除本次需求涉及的范围外，默认保持既有行为不变。

现有工程基线：
"""
${opts.baseline || '（缺少基线摘要）'}
"""

`
  : ''}请先只生成大的 PhasePlan：
- 评估项目复杂度并决定 phase 数量：simple => 只有 P1 current；moderate => P1 current + 至少 P2 planned；complex => P1 current + 至少 P2/P3 planned。
- P1 objective 必须是可独立交付、可验证的核心功能。
- P2/P3 只写后续增强目标、范围、交付物和验证门禁；不要展开任何 V 模型 Step。
- 每个 phase 的 verificationGate 必须说明失败时把完整错误日志交给 Debugger，并回退到对应 V 模型阶段后重跑后续阶段。
- 只返回 PhasePlan JSON，禁止包含 steps / architectureModules / dependencies。`,
    plannerPhaseDecompose: (raw, qa, addenda, opts) =>
      `原始需求：
"""
${raw}
"""

澄清问答：
${qa || '（无）'}

${addenda ? `用户补充需求（需严格遵守，优先级高于原始描述中模糊的部分）：\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `增量意图：${opts.intent}

请在现有工程基础上生成当前 phase 的增量 V 模型 StepPlan，优先复用当前架构、文件、测试与依赖。

现有工程基线：
"""
${opts.baseline || '（缺少基线摘要）'}
"""

`
  : ''}已确认的 PhasePlan：
"""
${opts.phasePlan}
"""

当前需要展开的 phaseId：${opts.phaseId}

请只为 ${opts.phaseId} 输出完整 V 模型 StepPlan：
- steps 中每个 Step.iterationId 必须等于 "${opts.phaseId}"。
- 禁止输出其他 planned phase 的 Step；P2/P3 的详细计划留到它们成为 current phase 时再生成。
- 其他 planned phase 都是明确的排除范围；不得把其功能、依赖包、产物或验收条件写入当前
  requirementDigest、globalPrompt、dependencies、architectureModules 或 steps。
- 如果 ${opts.phaseId} 横跨多个关注点（领域逻辑、CLI/API、文件 I/O、外部集成、流程编排、测试），必须在 architectureModules 中体现当前 phase 的模块边界，并在 HIGH_LEVEL_DESIGN/CODE/MODULE_TEST 的 subTasks 下分解模块级工作。
- architectureModules.sourcePaths 只能是 src/ 下的产品源码文件；随产品交付的运行时非代码资产写入 assetPaths。不要把 tests/fixtures、tests/utils、样例输入、临时输出、目录或文档登记为架构模块。
- architectureModules.testPaths 只能填写由 HIGH_LEVEL_DESIGN 创建、MODULE_TEST 读取执行的模块契约测试（通常为 tests/modules/*）；CODE 必须另行输出单元测试，禁止与这些 testPaths 重复。
- dependencies 只写当前 phase 需要的包名；Python 必须包含 pytest；不要输出 requirements.txt。
- 当前 phase 必须包含标准 V 模型 8 个宏 Step，并满足同步测试设计规则。

只返回当前 phase 的严格 JSON StepPlan。`,
    executorSystem: (p) => buildExecutorSystem(p),
    executorDebugBlock: (reason: string, suggestions?: string) =>
      `\n\n正处于 DEBUG 重试模式。上一轮失败原因: ${reason}\n` +
      '以 Bug Ticket 和压缩后的失败证据为事实来源。若回退到需求/设计阶段，而实际源码属于后续 Step，只更新当前契约、测试计划或诊断产物，由后续 V 模型 Step 实现。' +
      '如果上一轮停滞在只读探测，不要重复定位；直接执行下一项有依据的修改或验证动作。' +
      (suggestions ? `\n\n${suggestions}` : ''),
    executorGlobalBlock: (globalPrompt: string) => `\n\n## 项目全局约束\n${globalPrompt}`,
    executorContextBlock: (context: string) => `\n\n# 已装配上下文\n${context}`,
    executorRoleBlock: (identity) => `\n\n## 你的角色\n${identity.rolePrompt}\n${identity.capabilityPrompt}`
      + (identity.prohibitions.length > 0
        ? `\n\n禁止事项：\n${identity.prohibitions.map((rule) => `- ${rule}`).join('\n')}`
        : ''),
    executorStepBlock: (sp: string) =>
      `\n\n## 当前 Step 专属提示 (唯一使命，禁止跨 Step 发散)\n${sp}`,
    executorSkillBlock: (hints: string[]) =>
      `\n\n## 可用 Skill 提示\n${hints.map((hint) => `- ${hint}`).join('\n')}`,
    executorUserPromptOutro: '现在按协议返回第一轮 JSON。',
    executorFeedbackHeader: '本轮工具结果：',
    executorFeedbackVerifyOk: 'outputs 校验通过。如已完成，请把 done 设为 true 且 actions=[]。',
    executorFeedbackVerifyMissing: (paths: string) => `outputs 仍缺失：${paths}。请继续。`,
    executorFeedbackReadOnlyLoopWarning: (rounds: number, targets: string) =>
      `循环门禁警告：最近 ${rounds} 轮只调用了读取/探测工具` +
      (targets ? `（${targets}）` : '') +
      '。下一轮必须包含一次成功的修复动作（apply_patch / replace_in_file / write_file / add_dependency）或明确的验证动作（run_tests / run_program）。不要继续只调用 read_file、list_dir、code_search 或 http_fetch。',
    executorFeedbackReadOnlyRecoveryRequired:
      '只读恢复模式已启用：上一轮已经因为持续探测失败。本轮必须基于已有 failure log 直接 patch/write/改依赖或执行验证；如果下一轮仍然只有只读/探测动作，本次重试会失败并回退。',
    executorFeedbackDiagnosticProbeAllowance: (remainingRounds, maxActionsPerRound) =>
      `仍允许 ${remainingRounds} 轮有界诊断读取，每轮最多 ${maxActionsPerRound} 个新的读取/探测动作。` +
      '只能读取当前失败证据明确涉及的路径或窗口；重复读取已看过的目标会被拒绝。证据足够后必须立即提交聚焦修复。',
    executorFeedbackRepairEvidenceMissing:
      'DEBUG 完成无效：本次重试还没有产生修复证据。设置 done=true 前，必须至少完成一次成功的修复动作或成功的验证运行；否则只能在 thoughts 中给出具体 blocker 后停止。',
    executorFeedbackBugResolutionPlanMissing:
      'DEBUG Bug Ticket 动作无效：首次修复或验证前必须提供 bugResolutionPlan。请在同一 JSON 中给出根因假设、修复目标、验证命令以及必要动作。',
    executorFeedbackPostMutationVerificationRequired:
      '最新一次成功修改尚未验证。保留当前文件，下一步直接运行最小相关编译/测试门禁；不要再用一轮只读检查或重复改写。',
  },
  skills: {
    patcher:
      '通过 apply_patch / replace_in_file 对已有文件做小改动，禁止整文件覆盖。' +
      'replace_in_file 必须同时提供 args.path、args.find、args.replace；path 使用当前 Step writable allowlist 内的具体 workspace 相对文件路径，内容不确定时先 read_file 同一路径。',
    author:
      '通过 write_file 创建新文件；必须提供非空 args.path 和字符串 args.content，path 使用当前 Step outputs 或 writable allowlist 中的具体 workspace 相对路径。',
    tester:
      '编写并运行 pytest 测试，验证函数行为；失败时通过 analyze_error 解析。' +
      '【路径契约】所有 read_file/write_file/append_file/replace_in_file 调用都必须提供具体的 workspace 相对 args.path，不得省略、使用项目外路径或把目录当文件。' +
      '【fixture 自包含】测试**严禁**直接 open() 磁盘上不存在的样例文件。' +
      '若被测函数需要文件输入，优先复用用户/工作区真实样例；没有样例时用 http_fetch 获取官方文档、上游仓库或公开标准中的小型参考样例，' +
      '保存到 tests/fixtures/<name> 并记录来源；只有 CSV/JSON/INI 等简单文本格式才可在 pytest tmp_path 中构造最小样例并立刻 run_tests。' +
      '测试阶段和 DEBUG 模式已默认放开 tests/fixtures/ 写权限，子目录自动 mkdir -p，**无需**提前把 fixture 路径登记到 outputs。' +
      '生成测试时务必同时输出全部依赖资源，避免后续 Debugger 因 FileNotFoundError 反复重试。' +
      '【fixture 迭代】若测试运行中被测函数报"Invalid syntax / Parse error / Malformed"等解析错误，' +
      '说明你写出的 fixture 内容不合该格式 spec：read_file 看清后，优先使用用户样例或 http_fetch 拉取的权威参考样例重写，再 run_tests。' +
      '复杂领域格式连续失败后必须停止凭记忆生成，改为请求用户样例或网络参考；严禁去改被测模块或断言。',
    dep_resolver: '当出现 ModuleNotFoundError 时，用 add_dependency 写回 requirements.txt 并重建沙盒。',
    debugger:
      '没有具体失败日志时先用 run_tests/run_program 复现；已有明确错误和完整 debug repair packet 时直接执行最小范围 patch 或依赖修改，再重跑失败门禁。只有关键文件未注入、片段明确截断或替换连续失败两次时才补充读取当前内容。',
    refactorer:
      '重构必须保证行为不变；先跑回归测试 → 修改 → 再跑回归测试。' +
      '所有文件工具必须提供具体的 workspace 相对 args.path；局部替换前先 read_file 确认同一路径和当前字节。',
  },
  doctor: {
    cliDescription: '检查 config / LLM / sandbox / skills 是否就绪',
    optStrict: '把 warning 也视为失败（任一 warn 即非零退出）',
    header: 'XCompiler 启动环境自检',
    sectionConfig: '[配置]',
    sectionLLM: '[LLM]',
    sectionSandbox: '[沙盒]',
    sectionSkills: '[技能]',
    summaryOk: '全部检查通过。',
    summaryWarn: (n) => `通过，但有 ${n} 条 warning。`,
    summaryFail: (n) => `检测到 ${n} 项失败。`,
    configLoadOk: (path) => `配置已加载：${path}`,
    configLoadFail: (msg) => `配置加载失败：${msg}`,
    configLocale: (locale) => `locale=${locale}`,
    llmNoProviders: 'config.llm.providers 为空，未声明任何 provider',
    llmProviderListed: (n) => `已声明 ${n} 个 provider`,
    ollamaUnreachable: (baseUrl, msg) => `ollama 不可达 @ ${baseUrl} —— ${msg}`,
    ollamaReachable: (baseUrl, n) => `ollama 可达 @ ${baseUrl}（共 ${n} 个模型）`,
    ollamaModelMissing: (provider, model, baseUrl) =>
      `provider "${provider}"：模型 "${model}" 未安装于 ${baseUrl}（请执行 \`ollama pull ${model}\`）`,
    ollamaModelOk: (provider, model) => `provider "${provider}"：模型 "${model}" 可用`,
    openaiKeyMissing: (provider) => `provider "${provider}"：api_key 为空（请设置该 provider 对应的环境变量，例如 OPENROUTER_API_KEY，或 config.llm.providers.${provider}.api_key）`,
    openaiReachable: (provider, baseUrl) => `provider "${provider}"：OpenAI 端点可达 @ ${baseUrl}`,
    openaiUnreachable: (provider, baseUrl, msg) => `provider "${provider}"：OpenAI /models 检查失败 @ ${baseUrl} —— ${msg}`,
    openaiModelListUnavailable: (provider, status) =>
      `provider "${provider}"：端点可达但未提供 /models（HTTP ${status}），未校验模型清单成员关系`,
    openaiModelListMissing: (provider, model) =>
      `provider "${provider}"：/models 响应中未列出 "${model}"（若你的账号有访问权限仍可正常调用）`,
    providerScoreZero: (provider) => `provider "${provider}" 已禁用（score=0）`,
    roleNoLiveProvider: (role) => `角色 "${role}" 没有可用 provider（候选列表全部不可达或被禁用）`,
    roleOk: (role, provider) => `角色 "${role}" → ${provider}`,
    sandboxKind: (kind) => `sandbox=${kind}`,
    sandboxNetworkPolicy: (policy, ports) =>
      `network=${policy}` + (ports.length ? `（expose_ports=[${ports.join(', ')}]）` : ''),
    sandboxFullNoPorts:
      'network=full 但未配置 expose_ports—宿主侧无法访问容器内服务。' +
      '请在 config.yaml 中设置 `agent.sandboxes.<language>.<local|docker>.limits.expose_ports: [<port>]`。',
    sandboxNodeMissing: (detail) => `node 不可用（TypeScript subprocess 沙盒必需）：${detail}`,
    sandboxNodeOk: (version) => `node OK（${version}）`,
    sandboxNpmMissing: (detail) => `npm 不可用（TypeScript subprocess 沙盒必需）：${detail}`,
    sandboxNpmOk: (version) => `npm OK（${version}）`,
    sandboxNpxMissing: (detail) => `npx 不可用（TypeScript subprocess 沙盒必需）：${detail}`,
    sandboxNpxOk: (version) => `npx OK（${version}）`,
    sandboxPythonMissing: (detail) => `python3 不可用（subprocess 沙盒必需）：${detail}`,
    sandboxPythonOk: (version) => `python3 OK（${version}）`,
    sandboxVenvMissing: (detail) => `python3 venv 模块不可用（请安装 python3-venv / python3-virtualenv）：${detail}`,
    sandboxVenvOk: 'python3 venv 模块 OK',
    sandboxDockerMissing: (bin) => `PATH 上找不到 docker 二进制 "${bin}"`,
    sandboxDockerOk: (version) => `docker OK（${version}）`,
    sandboxDockerDaemonDown: (msg) => `docker daemon 不可达：${msg}`,
    sandboxInContainerWarn: '检测到 XCompiler 运行在容器内，此模式不支持 sandbox=docker（请使用 subprocess）。',
    skillToolMissing: (skill, tool) => `skill "${skill}" 引用了未注册的工具 "${tool}"`,
    skillOk: (n, tools) => `已注册 ${n} 个 skill，对应 ${tools} 个底层工具`,
  },
};

export default messages;
