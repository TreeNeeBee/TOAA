import type { Step } from '../../core/plan.js';
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
        'Use run_tests without replacing the inherited selectors. Do not run broad compiler or all-project test commands that include tests owned by later V-model Steps.',
        'A defect outside this exact gate belongs to its own owning Step and Ticket; do not absorb it into the current Bug.',
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
        'This CR carries an accepted upstream contract change. It is not an enhancement finding.',
        'This is incremental CR execution against the existing project baseline.',
        'Apply only the affected contract and artifacts for this Step. Preserve unrelated files and accepted behavior.',
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
        `verification step: ${input.enhancement.verificationStepId}`,
        'Append or patch only the missing, incomplete, or below-threshold content.',
        'Preserve accepted baseline behavior and artifacts. Do not regenerate the whole phase or project.',
        'For coverage gaps, use measured coverage evidence to add focused tests around uncovered production behavior. ' +
          'Do not rewrite accepted production code merely to inflate a metric.',
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

  return [
    `# Step ${input.step.id} — ${input.step.title}`,
    `phase: ${input.step.phase}`,
    `role: ${role}`,
    `acceptance: ${input.step.acceptance}`,
    '',
    missingOutputPriority,
    workTicketBlock,
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
