import type { Workspace } from '../../workspace/workspace.js';
import { pairedTestAssetPaths } from '../test_assets.js';
import type { LanguageProfile } from '../language.js';
import {
  PHASE_ORDER,
  V_MODEL_TEST_PHASES,
  type Plan,
  type Step,
} from '../plan.js';
import {
  PROJECT_MEMORY_PATH,
  selectMemoryContractsForStep,
  selectMemorySnippetsForStep,
  type ProjectMemory,
} from '../project_memory.js';
import type {
  ChangeRequestTicket,
  EnhanceTicket,
  TicketStore,
} from '../ticket.js';
import { stepTransitivelyDependsOn } from '../workflow_state.js';
import {
  extractFailedTestPaths,
  hasTypeScriptConfigOutput,
  normalizeGitPath,
} from './v_model_policy.js';

export interface ContextDebugInput {
  contextPaths?: string[];
  contextMode?: 'audit-repair' | 'iteration-gate' | 'test-rollback';
}

export async function buildContextSnippets(input: {
  workspace: Workspace;
  plan: Plan;
  step: Step;
  debug?: ContextDebugInput;
  changeRequest?: ChangeRequestTicket;
  enhancement?: EnhanceTicket;
  tickets: TicketStore;
  projectMemory: ProjectMemory | null;
  profile: LanguageProfile;
  contextWindowTokens: number;
}): Promise<Array<{ path: string; content: string }>> {
  const out = new Map<string, string>();
  const workTicket = input.tickets.featureForStep(
    input.step.id,
    input.step.iterationId ?? 'P1',
  );
  if (workTicket) {
    out.set(
      `.xcompiler/tickets/${workTicket.id}.json`,
      JSON.stringify(workTicket, null, 2),
    );
  }
  if (input.changeRequest) {
    out.set(
      `.xcompiler/tickets/${input.changeRequest.id}.json`,
      JSON.stringify(input.changeRequest, null, 2),
    );
  }
  if (input.enhancement) {
    out.set(
      `.xcompiler/tickets/${input.enhancement.id}.json`,
      JSON.stringify(input.enhancement, null, 2),
    );
  }
  if ((input.plan.architectureModules?.length ?? 0) > 0) {
    out.set(
      '.xcompiler/architecture-contract.json',
      JSON.stringify({ architectureModules: input.plan.architectureModules }, null, 2),
    );
  }

  const interesting = input.debug?.contextPaths ??
    (
      input.debug || input.changeRequest || input.enhancement
        ? [...input.step.inputs, ...input.step.outputs]
        : input.step.inputs
    );
  for (const rel of interesting) {
    await pushWorkspaceSnippet(input.workspace, out, rel);
  }
  for (const rel of testSubjectContextPaths({
    plan: input.plan,
    step: input.step,
    debug: input.debug,
    profile: input.profile,
    contextWindowTokens: input.contextWindowTokens,
  })) {
    await pushWorkspaceSnippet(input.workspace, out, rel);
  }

  const sharedDocs = input.debug
    ? [
        'docs/topic.md',
        'docs/03-detailed-design.md',
        'docs/tests/unit-test-plan.md',
        'docs/tests/integration-test-plan.md',
      ]
    : [
        'docs/topic.md',
        'docs/01-requirement-analysis.md',
        'docs/02-high-level-design.md',
        'docs/03-detailed-design.md',
        'docs/tests/functional-test-plan.md',
        'docs/tests/integration-test-plan.md',
        'docs/tests/module-test-plan.md',
        'docs/tests/unit-test-plan.md',
      ];
  for (const rel of sharedDocs) {
    await pushWorkspaceSnippet(input.workspace, out, rel);
  }

  if (input.projectMemory?.summary && input.debug?.contextMode !== 'audit-repair') {
    if (!input.debug) {
      out.set(`${PROJECT_MEMORY_PATH}#summary`, input.projectMemory.summary);
    }
    for (const snippet of selectMemorySnippetsForStep(
      input.projectMemory,
      input.step,
      input.debug ? 2 : 4,
    )) {
      if (!out.has(snippet.path)) out.set(snippet.path, snippet.content);
    }
    const contracts = selectMemoryContractsForStep(
      input.projectMemory,
      input.step,
      input.debug ? 4 : 5,
    );
    if (contracts.length > 0) {
      out.set(
        `${PROJECT_MEMORY_PATH}#contracts`,
        [
          'Relevant project contracts:',
          ...contracts.map((contract) =>
            `- [${contract.kind}] ${contract.subject}` +
            `${contract.path ? ` (${contract.path})` : ''}: ${contract.detail}`
          ),
        ].join('\n'),
      );
    }
  }

  const downstream = buildDownstreamContextSnippet(input.plan, input.step);
  if (downstream) {
    out.set(`.xcompiler/downstream/${input.step.id}.md`, downstream);
  }
  return [...out.entries()].map(([path, content]) => ({ path, content }));
}

export function testSubjectContextPaths(input: {
  plan: Plan;
  step: Step;
  debug?: ContextDebugInput;
  profile: LanguageProfile;
  contextWindowTokens: number;
}): string[] {
  if (!isVModelTestPhase(input.step.phase)) return [];
  const iterationId = input.step.iterationId ?? 'P1';
  const declaredRuntimePaths = (input.plan.architectureModules ?? []).flatMap((module) => [
    ...module.sourcePaths,
    ...(module.assetPaths ?? []),
  ]);
  const codeOutputs = input.plan.steps
    .filter((candidate) =>
      (candidate.iterationId ?? 'P1') === iterationId &&
      candidate.phase === 'CODE')
    .flatMap((candidate) => candidate.outputs)
    .filter((output) =>
      input.profile.codeExtensions.some((extension) => output.endsWith(extension)) ||
      declaredRuntimePaths.includes(output));
  const candidates = dedup([...declaredRuntimePaths, ...codeOutputs])
    .filter((candidate) => candidate && !candidate.endsWith('/'));
  const renderedCharsPerSnippet = input.debug ? 900 : 2200;
  const sourceContextBudgetChars = Math.max(
    renderedCharsPerSnippet * 4,
    Math.floor(input.contextWindowTokens * 3 * 0.2),
  );
  const maxFiles = Math.min(
    64,
    Math.max(4, Math.floor(sourceContextBudgetChars / renderedCharsPerSnippet)),
  );
  return candidates.slice(0, maxFiles);
}

export function findOwningTestStepForFailure(
  plan: Plan,
  currentStep: Step,
  failureText: string,
): Step | undefined {
  const failedPaths = extractFailedTestPaths(failureText);
  if (failedPaths.length === 0) return undefined;
  const iterationId = currentStep.iterationId ?? 'P1';
  const testSteps = plan.steps.filter((step) =>
    (step.iterationId ?? 'P1') === iterationId &&
    isVModelTestPhase(step.phase));
  for (const failedPath of failedPaths) {
    const owner = testSteps.find((step) =>
      pairedTestAssetPaths(plan.steps, step, plan.language)
        .map((testPath) => normalizeGitPath(testPath))
        .includes(failedPath));
    if (owner) return owner;
  }
  return undefined;
}

export function buildDownstreamContextSnippet(plan: Plan, step: Step): string {
  const byId = new Map(plan.steps.map((candidate) => [candidate.id, candidate]));
  const consumers = plan.steps
    .filter((candidate) => candidate.id !== step.id)
    .filter(
      (candidate) =>
        stepTransitivelyDependsOn(candidate, step.id, byId) ||
        candidate.inputs.some((input) => step.outputs.includes(input)),
    )
    .sort((left, right) => {
      const phaseDelta = PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase];
      return phaseDelta !== 0 ? phaseDelta : left.id.localeCompare(right.id);
    });
  if (consumers.length === 0) return '';
  return [
    `# Downstream consumers of ${step.id}`,
    'Design the current step so these later steps can consume its outputs directly.',
    '',
    ...consumers.slice(0, 8).flatMap((consumer) => [
      `## ${consumer.id} ${consumer.phase} - ${consumer.title}`,
      `- description: ${consumer.description}`,
      `- acceptance: ${consumer.acceptance}`,
      `- inputs: ${consumer.inputs.join(', ') || '-'}`,
      `- outputs: ${consumer.outputs.join(', ') || '-'}`,
      `- dependsOn: ${consumer.dependsOn.join(', ') || '-'}`,
      '',
    ]),
  ].join('\n').trim();
}

export function computeDebugAllowedWrites(
  plan: Plan,
  step: Step,
  profile: LanguageProfile,
): string[] {
  if (isVModelTestPhase(step.phase)) {
    return [...new Set(step.outputs)];
  }
  const byId = new Map(plan.steps.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const stack = [...step.dependsOn];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const dependency = byId.get(id);
    if (dependency) stack.push(...dependency.dependsOn);
  }
  const outputs = new Set<string>(step.outputs);
  for (const id of seen) {
    const dependency = byId.get(id);
    if (!dependency) continue;
    if (dependency.phase !== 'CODE' && !isVModelTestPhase(dependency.phase)) {
      if (hasTypeScriptConfigOutput(dependency.outputs, profile.id)) {
        outputs.add('tsconfig.json');
      }
      continue;
    }
    for (const output of dependency.outputs) {
      if (output !== profile.manifestFile) outputs.add(output);
    }
  }
  return [...outputs];
}

export function computeStepAllowedWrites(step: Step): string[] {
  return [...new Set(step.outputs)];
}

export function isRefactorWritablePath(rel: string, profile: LanguageProfile): boolean {
  const normalized = rel.replace(/\\/g, '/');
  if (!profile.codeExtensions.some((extension) => normalized.endsWith(extension))) {
    return false;
  }
  return normalized.startsWith('src/') || normalized.startsWith('tests/');
}

export function stepContextChars(plan: Plan, step: Step): number {
  return [
    plan.requirementDigest,
    plan.globalPrompt,
    plan.baselineSummary,
    plan.userAddenda,
    step.title,
    step.description,
    step.systemPrompt,
    step.acceptance,
    step.inputs.join('\n'),
    step.outputs.join('\n'),
  ].join('\n').length;
}

async function pushWorkspaceSnippet(
  workspace: Workspace,
  target: Map<string, string>,
  rel: string,
): Promise<void> {
  if (!rel || rel.endsWith('/') || target.has(rel)) return;
  try {
    target.set(rel, await workspace.readFile(rel));
  } catch {
    // Optional context files may not exist yet.
  }
}

function isVModelTestPhase(
  phase: Step['phase'],
): phase is (typeof V_MODEL_TEST_PHASES)[number] {
  return (V_MODEL_TEST_PHASES as readonly string[]).includes(phase);
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
