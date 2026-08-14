import type { Step } from '../../core/plan.js';
import { VALIDATION_CONTRACT_DEFECT_CODE } from '../../domain/tickets/ticket.js';
import { t } from '../../i18n/index.js';
import type { ExecutorRunInput } from '../executor.js';

export function renderExecutionUserPrompt(
  input: ExecutorRunInput,
  toolDocs: string,
  initialMissingOutputs: string[] = [],
): string {
  const role = input.executionRole ?? input.step.role;
  const compactContext = !!input.debugContext;
  const snippets = input.contextSnippets ?? [];
  const debugRepairSnippetCount = Math.max(
    1,
    snippets.filter((snippet) => isDebugRepairSnippet(snippet.path)).length,
  );
  const debugRepairBudgetChars = Math.floor(
    (input.ctx.contextWindowTokens ?? 128 * 1024) * 3 * 0.3,
  );
  const debugRepairSnippetLimit = Math.max(
    1_800,
    Math.min(6_000, Math.floor(debugRepairBudgetChars / debugRepairSnippetCount)),
  );
  const snippetLimit = compactContext ? 900 : 2200;
  const architectureLimit = compactContext ? 3000 : 8000;
  const failureLogLimit = compactContext ? 2200 : 4000;
  const contextBlock = snippets
    .map((snippet) =>
      `### ${snippet.path}\n\`\`\`\n${truncate(
        snippet.content,
        snippet.path === '.xcompiler/architecture-contract.json' ||
          snippet.path.startsWith('.xcompiler/objects/ticket/')
          ? architectureLimit
          : compactContext && isDebugRepairSnippet(snippet.path)
            ? debugRepairSnippetLimit
            : snippetLimit,
      )}\n\`\`\``,
    )
    .join('\n\n');
  const debugRepairPacket = compactContext && snippets.some((snippet) =>
    isDebugRepairSnippet(snippet.path)
  )
    ? [
        '## debug repair packet',
        'The source, test, manifest, and config snippets below were loaded from the current workspace for this attempt.',
        'Use any complete snippet directly for patch/write actions; do not spend another turn rereading it.',
        'Direct local imports of failure-related code are included when available. Reconcile test calls against those implementation exports before editing; a symbol absent from current snippets must not be invented.',
        'Only read a file again when its snippet explicitly ends with a truncation marker and the missing section is required for the repair.',
        '',
      ].join('\n')
    : '';
  const debugBlock = input.debugContext
    ? [
        input.debugContext.bugTicketId ? `## bug ticket\nid: ${input.debugContext.bugTicketId}\n` : '',
        input.debugContext.debugBrief ? `${input.debugContext.debugBrief}\n` : '',
        `## compact failure evidence\n\`\`\`\n${truncate(input.debugContext.failureLog, failureLogLimit)}\n\`\`\`\n`,
        input.debugContext.suggestions ? `\n${input.debugContext.suggestions}\n` : '',
      ].join('\n')
    : '';
  const verificationScope = input.debugContext?.verificationScope
    ? [
        '## inherited paired verification gate',
        `verification step: ${input.debugContext.verificationScope.stepId}`,
        `verification phase: ${input.debugContext.verificationScope.phase}`,
        'exact executable tests:',
        ...input.debugContext.verificationScope.testArgs.map((testPath) => `- ${testPath}`),
        'This Bug was routed back from the paired verification Step. Repair only the root cause exposed by these tests.',
        'Use run_tests without replacing the inherited selectors. Do not widen it to all-project tests owned by later V-model Steps; the CODE delivery gate may separately run its stage-specific compiler/static check.',
        'A defect outside this exact gate belongs to its own owning Step and Ticket; do not absorb it into the current Bug.',
        '',
      ].join('\n')
    : '';
  const deferredVerificationScope = input.debugContext?.deferredVerificationScope
    ? [
        '## paired verification deferred to change-request propagation',
        `verification step: ${input.debugContext.deferredVerificationScope.stepId}`,
        `verification phase: ${input.debugContext.deferredVerificationScope.phase}`,
        'This Bug was routed to an upstream source phase. Repair only the contract, design, and paired test artifacts owned by the current writable scope.',
        'Do not modify downstream product implementation from this phase and do not weaken or replace behavioral tests to make the old implementation pass.',
        'Do not repeatedly run the deferred paired gate after an unchanged downstream implementation has already produced conclusive failure evidence.',
        'If the current upstream repair is complete and the remaining failure belongs to downstream implementation, record that dependency in qualityAssessment.blockedBy and finish the current repair. Do not report a second validationDefect for the same downstream gap.',
        'If every current-phase output is already aligned, do not invent a file edit. A no-op handoff still requires the structured bugResolutionDisposition described below, including inspected downstream artifact paths; blockedBy text alone is insufficient.',
        'Record an explicit resolution plan and structured accepted delta. PM will propagate those exact affected artifacts through downstream Change Requests, then rerun the original verification gate.',
        '',
      ].join('\n')
    : '';
  const validationContractDefect =
    input.ticket?.type === 'bug' && input.ticket.failure.code === VALIDATION_CONTRACT_DEFECT_CODE
      ? [
          '## validation-contract defect ownership',
          'The discovering role proved that the failed validation contract, paired test, or source-stage specification is defective; this is not an unchanged downstream implementation blocker.',
          'The current paired source Step owns the correction. Patch or rewrite only its affected declared output(s), preserve valid product behavior and assertions, and record a real incremental changelist.',
          'A read-only review with actions=[] cannot resolve this Bug or hand the unchanged validation defect downstream.',
          '',
        ].join('\n')
      : '';
  const bugNoopHandoffContract = input.ticket?.type === 'bug'
    ? [
        '## Bug no-op handoff contract',
        'A Bug may leave this source Step without a mutation only when concrete current-workspace evidence proves that every remaining affected artifact belongs downstream.',
        'Such a completion must return this exact top-level object: bugResolutionDisposition={outcome:"deferred",reasonCategory:"downstream-owned"|"external-dependency",rationale:"...",affectedArtifacts:["path"],evidence:["fact"]}.',
        'Every affectedArtifacts path must be outside this Step outputs and must have been loaded from the current workspace. A blockedBy sentence or free-form bugResolutionPlan alone cannot transfer ownership.',
        'If the defective artifact is a paired test, plan, contract, or other output owned by this Step, repair it here and do not return a deferred disposition.',
        '',
      ].join('\n')
    : '';
  const missingOutputPriority = initialMissingOutputs.length > 0
    ? [
        '## highest-priority required-output gate',
        'The following exact required outputs are missing at this attempt start:',
        initialMissingOutputs.map((output) => `- ${output}`).join('\n'),
        'Create these exact paths before rewriting outputs that already exist. ' +
          'A write/progress round that does not reduce this list is not progress.',
        '',
      ].join('\n')
    : '';
  const changeRequestBlock = input.changeRequest
    ? [
        '## active change-request ticket',
        `id: ${input.changeRequest.id}`,
        `revision: ${input.changeRequest.revision}`,
        `state: ${input.changeRequest.state}`,
        `source ticket: ${input.changeRequest.sourceTicketId}`,
        `objective: ${input.changeRequest.description}`,
        `contract delta: ${input.changeRequest.contractDelta.summary}`,
        input.changeRequest.originFailure
          ? `original failed gate: ${input.changeRequest.originFailure.failedStepType} — ${input.changeRequest.originFailure.message}`
          : 'original failed gate: not recorded (dependency or quality CR)',
        'failing baseline / before:',
        truncate(input.changeRequest.contractDelta.before.join('\n'), 2600),
        'accepted outcome / after:',
        input.changeRequest.contractDelta.after.map((item) => `- ${item}`).join('\n'),
        'affected artifacts:',
        ...input.changeRequest.contractDelta.affectedArtifacts.map((path) => `- ${path}`),
        'This CR carries an accepted upstream contract change. It is not an enhancement finding.',
        'This is incremental CR execution against the existing project baseline.',
        'Apply only the affected contract and artifacts for this Step. Preserve unrelated files and accepted behavior.',
        'If an affected artifact is owned by this Step, file or symbol existence alone is not completion. Compare the failing invocation and expected behavior with the actual artifact behavior, then either apply the minimal semantic delta or submit an explicit not-applicable decision.',
        'Classify the CR result structurally. Use reasonCategory="contract-applied" only with outcome="applied". For outcome="not-applicable", use exactly one of: "already-aligned", "outside-step-scope", "downstream-owned", or "diagnosis-contradicted".',
        'Ownership constrains that classification: if this Step owns every declared affected artifact, "downstream-owned" is invalid; if it owns any affected artifact, "outside-step-scope" is invalid. For a CR with an immutable original failed gate, "already-aligned" cannot close owned work without a successful executable verification of that failure.',
        'Use "diagnosis-contradicted" when current files or executable evidence disprove the CR diagnosis or reveal that the original test/contract is defective. Runtime will make the discovering role create a Bug and PM will route it using the immutable original failed-gate snapshot. Never hide a disproved CR premise in blockedBy.',
        'Every CR completion must include this exact top-level shape: changeRequestDisposition={outcome:"applied"|"not-applicable",reasonCategory:"contract-applied"|"already-aligned"|"outside-step-scope"|"downstream-owned"|"diagnosis-contradicted",rationale:"...",inspectedArtifacts:["path"],evidence:["fact"]}. All five fields are required; inspectedArtifacts and evidence must be JSON string arrays, never a single string. A normal not-applicable decision must inspect every affected artifact owned by this Step, explain why the failure belongs elsewhere, and name that downstream work in qualityAssessment.blockedBy.',
        'If this Step owns none of the listed affected artifacts, inspect at least one declared affected artifact, then return an explicit not-applicable disposition with actions=[] and done=true. ' +
          `Use this concrete path first when available: ${input.changeRequest.contractDelta.affectedArtifacts[0] ?? '(no affected artifact was declared)'}. ` +
          'Do not substitute this Step\'s report or plan for that inspection. Do not rewrite this Step outputs or call unavailable verification tools merely to manufacture progress; PM will carry the CR to its next owning stage.',
        'Never add comments, whitespace, formatting, renames, or unrelated edits merely to manufacture mutation evidence. Such changes do not implement a CR.',
        'Do not regenerate the whole phase, project, design, or test suite.',
        '',
      ].join('\n')
    : '';
  const enhancementBlock = input.enhancement
    ? [
        '## active enhancement ticket',
        `id: ${input.enhancement.id}`,
        `kind: ${input.enhancement.enhancementKind}`,
        `finding: ${input.enhancement.finding}`,
        `affected artifacts: ${input.enhancement.affectedArtifacts.join(', ') || '(none declared)'}`,
        `verification step: ${input.enhancement.verificationStepId}`,
        'This finding is already registered and assigned. Implement it now; do not report the same finding again in qualityAssessment.findings.',
        'Completion requires a focused successful mutation of an artifact owned by this Step, followed by the gate evidence Runtime permits. ' +
          'If current workspace evidence proves the finding itself is invalid, return a concrete blocker instead of duplicating or silently closing it.',
        'Append or patch only the missing, incomplete, or below-threshold content in the affected artifacts listed above.',
        'Preserve accepted baseline behavior and artifacts. Do not regenerate the whole phase or project.',
        'For coverage gaps, use measured coverage evidence to add focused tests around uncovered production behavior. ' +
          'Do not rewrite accepted production code merely to inflate a metric.',
        'When this Enhancement is routed from a downstream verification Step, the current source Step only authors the focused test delta. ' +
          'After a real mutation, return completion/upstreamAlignment evidence with qualityAssessment.gaps=[].',
        input.baselineTestExecution === 'execute'
          ? 'Runtime will rerun this source Step\'s exact baseline suite. Do not replace its selectors or widen it to later verification-owned supplements.'
          : 'Executable baseline verification is deferred only because this correction still originates before CODE; record that precondition in blockedBy instead of inventing product code.',
        '',
      ].join('\n')
    : '';
  const workTicketBlock = input.ticket
    ? [
        '## active work ticket',
        `id: ${input.ticket.id}`,
        `type: ${input.ticket.type}`,
        `state: ${input.ticket.state}`,
        `parent: ${input.ticket.parentTicketId ?? 'none'}`,
        `acceptance: ${input.ticket.acceptance.join(' | ') || input.step.acceptance}`,
        'Complete only this ticket and its declared sub-tasks/artifacts.',
        '',
      ].join('\n')
    : '';
  const baselineGateBlock = (['REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN', 'CODE'] as const)
    .includes(input.step.phase as never)
    ? input.baselineTestExecution === 'defer'
      ? [
          '## development delivery gate',
          ...(input.step.deliveryGate?.checks ?? []).map((check) => `- ${check}`),
          'Validate all declared stage deliverables, upstream alignment, solution evidence, and paired baseline test assets.',
          input.baselineTestExecutionReason === 'pre-code-correction'
            ? 'This correction still occurs before S4 has established product code: update and statically validate the exact baseline tests, but defer their executable run.'
            : 'This is the initial pre-CODE pass: author and statically validate the baseline tests, but do not execute them because product code does not exist yet.',
          'Keep planned product imports, calls, and behavioral assertions executable in the test source. Do not comment them out, replace them with expect(true)/assert True, or duplicate the planned product behavior inside the test. Missing product files are an expected pre-CODE condition; an inert test is not.',
          'Only executable baseline execution is deferred; no deliverable, plan, contract, or test-asset check is skipped.',
          'Do not report unavailable paired-test metrics as measured values. If completion=1 and the only remaining condition is product code owned by S4, put it only in blockedBy with gaps=[]; duplicating it in gaps is a contradictory quality report and Runtime will reject it before PM intake.',
          '',
        ].join('\n')
      : [
          '## development delivery gate',
          ...(input.step.deliveryGate?.checks ?? []).map((check) => `- ${check}`),
          'Validate all declared stage deliverables, upstream alignment, solution evidence, and paired baseline test assets.',
          input.baselineTestExecutionReason === 'post-code-correction'
            ? 'This correction was triggered by S4 or a later Step. Product code exists, so execute the source Step\'s exact baseline selectors and require them to pass before redelivery.'
            : 'Product code exists for this gate. Execute the exact baseline test selectors supplied by Runtime and require them to pass before delivery.',
          '',
        ].join('\n')
    : '';

  return [
    `# Step ${input.step.id} — ${input.step.title}`,
    `phase: ${input.step.phase}`,
    `role: ${role}`,
    `acceptance: ${input.step.acceptance}`,
    '',
    missingOutputPriority,
    workTicketBlock,
    baselineGateBlock,
    enhancementBlock,
    changeRequestBlock,
    '## description',
    input.step.description,
    '',
    '## required outputs',
    input.step.outputs.map((output) => `- ${output}`).join('\n'),
    '',
    renderPhaseWriteBoundary(input.step),
    '',
    '## writable paths (tool allowlist)',
    input.ctx.allowedWrites.map((output) => `- ${output}`).join('\n'),
    '',
    '## active model operation window',
    `context_window_tokens: ${input.ctx.contextWindowTokens ?? '(runtime default)'}`,
    `response_token_budget: ${input.ctx.responseTokenBudget ?? '(runtime default)'}`,
    `read_file_chunk_bytes: ${input.ctx.readChunkBytes ?? '(runtime default)'}`,
    `write_content_chunk_bytes: ${input.ctx.writeChunkBytes ?? '(runtime default)'}`,
    `tool_feedback_chars: ${input.ctx.feedbackCharBudget ?? '(runtime default)'}`,
    '',
    input.step.subTasks && input.step.subTasks.length > 0
      ? `## step subtasks (execute inside this macro Step)\n${renderStepSubTasks(input.step.subTasks, 0)}\n`
      : '',
    '## available tools',
    toolDocs || '(none)',
    '',
    input.step.inputs.length > 0
      ? `## inputs (already produced):\n${input.step.inputs.map((item) => `- ${item}`).join('\n')}\n`
      : '',
    debugRepairPacket,
    verificationScope,
    deferredVerificationScope,
    validationContractDefect,
    bugNoopHandoffContract,
    contextBlock
      ? `## context\nTreat these existing files as the current project truth. Extend or refactor them in place; do not replace the project with a tiny parallel implementation.\n\n${contextBlock}\n`
      : '',
    debugBlock,
    t().prompts.executorUserPromptOutro,
  ].filter(Boolean).join('\n');
}

export function compactExecutionMessages<
  T extends { role: 'system' | 'user' | 'assistant'; content: string },
>(messages: T[], compact: boolean): T[] {
  if (!compact || messages.length <= 6) return messages;
  const system = messages[0];
  const initialUser = messages[1];
  if (!system || !initialUser) return messages;
  return [system, initialUser, ...messages.slice(-4)];
}

function isDebugRepairSnippet(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  return normalized.startsWith('src/') ||
    normalized.startsWith('tests/') ||
    /^(?:package\.json|tsconfig(?:\.[^/]+)?\.json|requirements(?:-[^/]+)?\.txt|pyproject\.toml)$/u.test(normalized) ||
    /^(?:config|src\/config)\/.+\.(?:json|toml|ya?ml)$/u.test(normalized);
}

function renderPhaseWriteBoundary(step: Step): string {
  if (!['REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN'].includes(step.phase)) return '';
  return [
    '## phase write boundary',
    'Only the paths listed under writable paths may be created or changed in this phase.',
    'REQUIREMENT_ANALYSIS, HIGH_LEVEL_DESIGN, and DETAILED_DESIGN own specifications and their paired executable tests; product implementation belongs to CODE.',
    'A paired test may import planned product source paths before those source files exist. Do not create src/** stubs, placeholder implementations, or production behavior merely to make those imports resolve in this phase.',
  ].join('\n');
}

function renderStepSubTasks(tasks: NonNullable<Step['subTasks']>, depth: number): string {
  const indent = '  '.repeat(depth);
  return tasks.flatMap((task) => {
    const outputs = task.outputs && task.outputs.length > 0 ? ` outputs=[${task.outputs.join(', ')}]` : '';
    const lines = [
      `${indent}- ${task.id}: ${task.title}${outputs}`,
      `${indent}  ${task.description}`,
    ];
    if (task.acceptance) lines.push(`${indent}  acceptance: ${task.acceptance}`);
    if (task.subTasks && task.subTasks.length > 0) lines.push(renderStepSubTasks(task.subTasks, depth + 1));
    return lines;
  }).join('\n');
}

function truncate(value: string, limit: number): string {
  return value.length > limit
    ? value.slice(0, limit) + `\n... [truncated ${value.length - limit} chars]`
    : value;
}
