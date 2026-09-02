import { getLocale } from '../i18n/index.js';

export interface ExecutionPromptPolicyOptions {
  debug: boolean;
  changeRequest?: boolean;
  /**
   * A design Step executing normally, whose deliverable is the specification and the tests paired
   * with it.
   *
   * Those tests describe work no Step has implemented yet, so running them here fails by
   * construction. Without saying so, the Step reads its own paired gate as a defect and spends every
   * attempt repairing an implementation that is not due until a later Step.
   *
   * Never set in Debug mode: a Bug routed to a design Step was opened by its paired verification,
   * and repairing it is precisely what that attempt is for.
   */
  declarative?: boolean;
}

/**
 * Operational rules shared by every role and execution mode.
 *
 * Keep safety, path, evidence, dependency, fixture, and network policy here so
 * role prompts and skills only describe their specialized workflow.
 */
export function renderExecutionPromptPolicy(
  options: ExecutionPromptPolicyOptions,
): string {
  return getLocale() === 'zh'
    ? renderZhPolicy(options)
    : renderEnPolicy(options);
}

function renderEnPolicy({ debug, changeRequest, declarative }: ExecutionPromptPolicyOptions): string {
  return `

## Runtime execution policy
1. File paths: every file action must provide a concrete workspace-relative path from the current readable/writable scope. Never omit a required path or access outside the workspace.
2. Real fixes: repair the implementation, contract, dependency, fixture, or test that is actually wrong. Never weaken assertions, skip/delete failing tests, or add fake production fallbacks to make a gate pass.
3. Dependencies: use add_dependency for the real package selected by design. TypeScript accepts package@version and dev=true for test/build tooling. Do not emulate a missing dependency with fake modules, empty classes/functions, or ImportError fallbacks in product source.
4. Fixtures: change a fixture only when evidence shows it is missing, malformed, or itself fails parsing. Behavioural assertion failures require diagnosis of source, contract, or assertion semantics.
5. Network APIs: after a failed endpoint, perform at most two focused probes and reject empty/unusable 2xx responses. Compare the evidence with the accepted contract: fix and verify the integration when the contract remains viable, or emit a change-request finding when satisfying the expectation requires the accepted capability/contract to change. Never infer that choice from a status code alone. Live user-entrypoint verification belongs to the Phase delivery gate.
6. Tests: execute the real production function, module, orchestration, or entry boundary under test. Mock only external I/O collaborators through an existing injection seam; never mock the function or module under test. Never reproduce production loops, retries, fallback/error policy, parsing, aggregation, or rendering inside a test. If no usable seam exists, repair the product API with dependency injection while preserving its default behavior, then test the real implementation. Tests covering external HTTP/API/URL access must be deterministic by default: use controlled fixtures through dependency injection, a preload hook, a local stub, or a configured replay endpoint. Never make unit, integration, module, or functional gates repeatedly call live public services; a separately declared live probe does not replace deterministic acceptance.
7. Subprocess tests: invoke the workspace's already-installed runtime directly instead of resolving tools through a package manager. For TypeScript, spawn process.execPath with --import tsx (or use a declared npm script); for Python, use sys.executable. Do not use npx inside tests: package resolution, downloads, and helper IPC can fail before the product entrypoint runs and hide the real evidence. Failed child-process assertions must surface the captured stdout, stderr, exit status or signal, and timeout state; never reduce a child failure to an unexplained exit code.
8. Completion evidence: done=true requires all declared outputs plus successful mutation/verification evidence appropriate to this Step. A right-side V-model Step first inspects its paired baseline and performs risk analysis. It may add focused tests only under the Runtime-declared verification supplement root, then freezes and executes the complete baseline plus supplement set. It must never rewrite baseline tests or product source. Do not diagnose from historical failure text or write reports/documentation until the current frozen run_tests result is returned in a later round. Put each independent defect or shortfall in qualityAssessment.findings so Runtime can route one Ticket per finding. Give every finding a stable machine code: reuse the code when the same problem recurs and use a different code for an independent problem. Use product-defect when the accepted contract remains valid and its implementation is wrong; use change-request when satisfying the expectation requires an accepted requirement, capability, interface, dependency, data source, or design premise to change. A status code, timeout, exception, or empty result is evidence only and never selects between them. Include affectedArtifacts with the exact workspace paths that finding permits a correction to modify; dependency findings remain separate from product/test defects.${declarative
    ? '\nD. Design Step: your deliverable is the specification and the tests paired with it. Those tests describe behaviour a later Step implements, so they are expected to fail now and are executed by your paired verification Step, not here. Run them only to check that they load and parse; a failing assertion is not a defect to repair, and implementing the product code to make them pass is another Step\'s work. Do not record that deferral as a quality gap: a gap is work this Step owed and did not deliver, and the gate fails the Step for every gap you report.'
    : ''}${debug
    ? '\n9. DEBUG mode: before the first repair or verification action, provide bugResolutionPlan with the root-cause hypothesis, repair target, and validation command. Reuse that plan through the attempt, make the smallest scoped repair, and verify it. Read-only inspection alone is not completion. Finishing without further actions still needs evidence: done=true with actions=[] is rejected unless you also return a complete qualityAssessment for this Step. When the repair already landed in an earlier round, report the existing artifact or command evidence there rather than rewriting outputs to manufacture something to show.\n10. Evidence before mutation: reconcile every symbol, import, assertion, and call form against the supplied current-workspace snippets or an explicit read_file result. Never invent an export or API. Existing files are accepted baseline: use apply_patch/replace_in_file for a focused delta. write_file may rewrite an existing file only when Runtime explicitly lists that exact path as a direct failure-evidence rewrite target; otherwise it is only for a genuinely missing file. A permitted rewrite must preserve the artifact scope and must not replace a focused failing test with a broader suite.\n11. Contract reconciliation: treat accepted upstream specifications, tests, real implementations, and consumers as one contract set. If multiple call forms are semantically compatible, preserve them with one coherent implementation using optional parameters, overloads, or adapters. If they are genuinely incompatible, report the contract defect and route it upstream; never alternate between mutually exclusive rewrites.\n12. Paired-gate ownership: when the Debug context declares an inherited paired verification gate, use only its exact tests as this Bug completion gate. Do not absorb compiler/test failures owned by later V-model Steps; those remain visible and must be routed through their own Tickets when their Step runs.'
    : ''}${changeRequest
    ? `\n${debug ? 13 : 9}. CR mode: treat existing outputs as the accepted baseline. Apply only the active change request delta, preserve unrelated behavior, and produce focused change or verification evidence. Never regenerate the whole phase or project.`
    : ''}`;
}

function renderZhPolicy({ debug, changeRequest, declarative }: ExecutionPromptPolicyOptions): string {
  return `

## Runtime 通用执行规则
1. 文件路径：每个文件操作都必须提供当前读写范围内、明确的 workspace 相对路径；不得省略必填路径或访问工程外部。
2. 真实修复：修正真正错误的实现、契约、依赖、fixture 或测试；禁止削弱断言、跳过/删除失败测试，或在生产代码中增加伪造 fallback 来绕过门禁。
3. 依赖：使用 add_dependency 添加设计选定的真实包；TypeScript 支持 package@version，测试/构建工具需设置 dev=true；禁止用假 module、空 class/function 或 ImportError fallback 模拟缺失依赖。
4. Fixture：只有证据明确表明 fixture 缺失、格式错误或自身解析失败时才修改；行为断言失败应检查源码、契约和断言语义。
5. 网络 API：接口失败后最多进行两次有目标的探测；HTTP 2xx 但内容为空或不可用不算成功。将证据与已接受契约对照：契约仍可行时修复并验证真实集成，满足预期必须调整已接受能力或契约时提交 change-request finding；禁止仅根据状态码选择处理方式。真实用户入口验证只属于 Phase 交付门禁。
6. 测试：必须执行真实的被测产品函数、模块、编排或入口边界，只能通过已有依赖注入点 mock 外部 I/O 协作者；禁止 mock 被测函数或被测模块。禁止在测试内重写生产代码的循环、重试、fallback/错误策略、解析、聚合或渲染；如果产品没有可用测试接缝，应在保留默认行为的前提下为产品 API 增加依赖注入，再测试真实实现。涉及外部 HTTP/API/URL 的测试默认必须可确定性离线执行：通过依赖注入、preload hook、本地 stub 或已配置 replay endpoint 提供受控 fixture。单元、集成、模块和功能门禁禁止反复访问实时公共服务；单独声明的 live probe 不能替代确定性验收门禁。
7. 子进程测试：直接调用工作区已经安装的本地运行时，不得经包管理器临时解析工具。TypeScript 使用 process.execPath 配合 --import tsx（或调用已声明的 npm script）；Python 使用 sys.executable。禁止在测试内使用 npx，避免包解析、下载或辅助 IPC 在产品入口运行前失败并掩盖真实证据。子进程断言失败时必须暴露捕获的 stdout、stderr、退出状态或 signal 以及 timeout 状态；禁止只保留一个无法诊断的退出码。
8. 完成证据：done=true 前必须完成全部声明产物，并取得与当前 Step 匹配的成功修改或验证证据。V 模型右侧 Step 先独立检查配对基线并做风险分析，只能在 Runtime 声明的 verification supplement root 下追加聚焦测试，随后冻结并执行完整的“基线 + 补充”集合；禁止改写基线测试或产品源码。在下一轮收到当前冻结集合的 run_tests 结果前，禁止依据历史失败文本诊断，也禁止写入报告/文档。每个独立缺陷或短板必须分别写入 qualityAssessment.findings，由 Runtime 逐项建票。每个 finding 必须提供稳定的机器 code：同一问题重现时复用，独立问题使用不同 code。已接受契约仍有效但实现错误时使用 product-defect；满足预期必须调整已接受的需求、能力、接口、依赖、数据源或设计前提时使用 change-request。状态码、超时、异常和空结果只作为证据，不能直接决定二者。affectedArtifacts 必须填写该 finding 允许修复的精确工作区路径；依赖 finding 继续独立于产品/测试缺陷路由。${declarative
    ? '\nD. 设计类 Step：交付物是规格说明及其配对测试。这些测试描述的是后续 Step 才会实现的行为，因此现在必然失败，并且由配对的验证 Step 执行，而不是在这里执行。只能用于检查测试能否加载和解析；断言失败不是需要修复的缺陷，为了让它们通过而实现产品代码属于其它 Step 的职责。不要把这种延后执行写成质量缺口：缺口指的是本 Step 应交付而未交付的工作，而门禁会因为你报告的每一条缺口判定本 Step 失败。'
    : ''}${debug
    ? '\n9. DEBUG 模式：首次执行修复或验证动作之前，必须输出 bugResolutionPlan，包含根因假设、修复目标和验证命令；同一次尝试持续复用该方案，执行最小范围修复并验证。仅只读检查不能算完成。收尾同样需要证据：done=true 且 actions=[] 时，必须同时返回本 Step 完整的 qualityAssessment，否则响应会被拒绝。若修复已在更早的轮次落地，直接引用当时的产物或命令证据，不要为了凑证据而重写产物。\n10. 修改前证据：每个符号、import、断言和调用形式必须与已提供的当前工作区 snippet 或明确的 read_file 结果核对；禁止虚构 export 或 API。已有文件属于已验收基线，应使用 apply_patch/replace_in_file 提交聚焦增量。只有 Runtime 将某一准确路径明确列为“故障证据 rewrite 目标”时，write_file 才能完整重写该已有文件；其它情况下 write_file 仅用于确实缺失的文件。获准的 rewrite 仍须保持原产物范围，禁止用更大的测试套件替换一个聚焦失败测试。\n11. 契约协调：将已验收的上游规范、测试、真实实现和调用方视为同一组契约。多种调用形式语义兼容时，应以可选参数、重载或适配器形成一个统一实现并全部保留；确实不可兼容时，报告契约缺陷并回退上游，禁止在互斥实现之间反复覆盖。\n12. 配对门禁归属：Debug 上下文声明继承的配对验证门禁时，当前 Bug 只能以其中的精确测试作为完成门禁；不得吸收后续 V 模型 Step 所属的编译或测试失败，这些错误必须保留，并在对应 Step 执行时通过独立 Ticket 路由。'
    : ''}${changeRequest
    ? `\n${debug ? 13 : 9}. CR 模式：已有产物是已验收基线，只实施当前变更请求的增量差异，保留无关行为，并提供聚焦的变更或验证证据；禁止重新生成整个阶段或工程。`
    : ''}`;
}
