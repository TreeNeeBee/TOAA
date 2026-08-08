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
5. Network APIs: after a failed endpoint, perform at most two focused probes, reject empty/unusable 2xx responses, patch the selected integration, then verify the real entrypoint and tests.
6. Completion evidence: done=true requires all declared outputs plus successful mutation/verification evidence appropriate to this Step.${declarative
    ? '\nD. Design Step: your deliverable is the specification and the tests paired with it. Those tests describe behaviour a later Step implements, so they are expected to fail now and are executed by your paired verification Step, not here. Run them only to check that they load and parse; a failing assertion is not a defect to repair, and implementing the product code to make them pass is another Step\'s work. Do not record that deferral as a quality gap: a gap is work this Step owed and did not deliver, and the gate fails the Step for every gap you report.'
    : ''}${debug
    ? '\n7. DEBUG mode: before the first repair or verification action, provide bugResolutionPlan with the root-cause hypothesis, repair target, and validation command. Reuse that plan through the attempt, make the smallest scoped repair, and verify it. Read-only inspection alone is not completion.\n8. Contract reconciliation: treat accepted upstream specifications, tests, and real consumers as one contract set. If multiple call forms are semantically compatible, preserve them with one coherent implementation using optional parameters, overloads, or adapters. If they are genuinely incompatible, report the contract defect and route it upstream; never alternate between mutually exclusive rewrites.\n9. Paired-gate ownership: when the Debug context declares an inherited paired verification gate, use only its exact tests as this Bug completion gate. Do not absorb compiler/test failures owned by later V-model Steps; those remain visible and must be routed through their own Tickets when their Step runs.'
    : ''}${changeRequest
    ? `\n${debug ? 10 : 7}. CR mode: treat existing outputs as the accepted baseline. Apply only the active change request delta, preserve unrelated behavior, and produce focused change or verification evidence. Never regenerate the whole phase or project.`
    : ''}`;
}

function renderZhPolicy({ debug, changeRequest, declarative }: ExecutionPromptPolicyOptions): string {
  return `

## Runtime 通用执行规则
1. 文件路径：每个文件操作都必须提供当前读写范围内、明确的 workspace 相对路径；不得省略必填路径或访问工程外部。
2. 真实修复：修正真正错误的实现、契约、依赖、fixture 或测试；禁止削弱断言、跳过/删除失败测试，或在生产代码中增加伪造 fallback 来绕过门禁。
3. 依赖：使用 add_dependency 添加设计选定的真实包；TypeScript 支持 package@version，测试/构建工具需设置 dev=true；禁止用假 module、空 class/function 或 ImportError fallback 模拟缺失依赖。
4. Fixture：只有证据明确表明 fixture 缺失、格式错误或自身解析失败时才修改；行为断言失败应检查源码、契约和断言语义。
5. 网络 API：接口失败后最多进行两次有目标的探测；HTTP 2xx 但内容为空或不可用不算成功；选定接口后必须修改真实集成，并验证实际入口和测试。
6. 完成证据：done=true 前必须完成全部声明产物，并取得与当前 Step 匹配的成功修改或验证证据。${declarative
    ? '\nD. 设计类 Step：交付物是规格说明及其配对测试。这些测试描述的是后续 Step 才会实现的行为，因此现在必然失败，并且由配对的验证 Step 执行，而不是在这里执行。只能用于检查测试能否加载和解析；断言失败不是需要修复的缺陷，为了让它们通过而实现产品代码属于其它 Step 的职责。不要把这种延后执行写成质量缺口：缺口指的是本 Step 应交付而未交付的工作，而门禁会因为你报告的每一条缺口判定本 Step 失败。'
    : ''}${debug
    ? '\n7. DEBUG 模式：首次执行修复或验证动作之前，必须输出 bugResolutionPlan，包含根因假设、修复目标和验证命令；同一次尝试持续复用该方案，执行最小范围修复并验证。仅只读检查不能算完成。\n8. 契约协调：将已验收的上游规范、测试和真实调用方视为同一组契约。多种调用形式语义兼容时，应以可选参数、重载或适配器形成一个统一实现并全部保留；确实不可兼容时，报告契约缺陷并回退上游，禁止在互斥实现之间反复覆盖。\n9. 配对门禁归属：Debug 上下文声明继承的配对验证门禁时，当前 Bug 只能以其中的精确测试作为完成门禁；不得吸收后续 V 模型 Step 所属的编译或测试失败，这些错误必须保留，并在对应 Step 执行时通过独立 Ticket 路由。'
    : ''}${changeRequest
    ? `\n${debug ? 10 : 7}. CR 模式：已有产物是已验收基线，只实施当前变更请求的增量差异，保留无关行为，并提供聚焦的变更或验证证据；禁止重新生成整个阶段或工程。`
    : ''}`;
}
