import { RECORDED_FIXTURE_DIR } from '../../core/external_dependency_contract.js';
import { isTestFilePath, normalizeGitPath } from './v_model_policy.js';
import type { LanguageProfile } from '../../core/language.js';
import type { Ticket } from '../../domain/tickets/ticket.js';
import {
  PHASE_ORDER,
  V_MODEL_TEST_PHASES,
  type Plan,
  type Step,
} from '../../core/plan.js';
import { hasTypeScriptConfigOutput } from './v_model_policy.js';

export function buildDownstreamContextSnippet(plan: Plan, step: Step): string {
  const byId = new Map(plan.steps.map((candidate) => [candidate.id, candidate]));
  const consumers = plan.steps
    .filter((candidate) => candidate.id !== step.id)
    .filter((candidate) =>
      transitivelyDependsOn(candidate, step.id, byId) ||
      candidate.inputs.some((input) => step.outputs.includes(input)),
    )
    .sort((left, right) =>
      PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase] || left.id.localeCompare(right.id),
    );
  if (consumers.length === 0) return '';
  return [
    `# Downstream consumers of ${step.id}`,
    'Design this change so the following accepted downstream contracts remain consumable.',
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
  if (isVerification(step)) return [...new Set(step.outputs)];
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
  const outputs = new Set(step.outputs);
  for (const id of seen) {
    const dependency = byId.get(id);
    if (!dependency) continue;
    if (dependency.phase !== 'CODE' && !isVerification(dependency)) {
      if (hasTypeScriptConfigOutput(dependency.outputs, profile.id)) outputs.add('tsconfig.json');
      continue;
    }
    for (const output of dependency.outputs) {
      if (output !== profile.manifestFile) outputs.add(output);
    }
  }
  return [...outputs];
}

/**
 * Resolves the mutation scope for corrective work without granting every upstream deliverable.
 *
 * Enhancements carry the gate's exact affected artifacts. A CR carries the accepted upstream delta
 * for inspection, so it writes only matching target artifacts when they exist and otherwise stays
 * within the current Step's declared outputs. Bugs retain the broader debug scope because their
 * failure evidence, not a quality finding, determines the root cause.
 */
export function computeIncrementalAllowedWrites(
  plan: Plan,
  step: Step,
  profile: LanguageProfile,
  ticket: Ticket,
): string[] {
  if (ticket.type === 'enhancement' && ticket.affectedArtifacts.length > 0) {
    // Same floor the Change Request branch below already applies: an artifact list that names
    // nothing this Step owns narrows the allowlist to nothing, and a Step that may write no file
    // cannot act on any instruction it is given — it spends its whole round budget reporting that.
    // A live Enhancement found at UNIT_TEST carried that Step's own documents and was routed to
    // CODE, which owns none of them.
    const owned = ownedAffectedArtifacts(step, ticket.affectedArtifacts);
    return owned.length > 0 ? owned : computeStepAllowedWrites(step);
  }
  if (ticket.type === 'change-request') {
    const owned = ownedAffectedArtifacts(step, ticket.contractDelta.affectedArtifacts);
    return owned.length > 0 ? owned : computeStepAllowedWrites(step);
  }
  return computeDebugAllowedWrites(plan, step, profile);
}

export function computeStepAllowedWrites(step: Step): string[] {
  const outputs = [...new Set(step.outputs)];
  // A Step that owns paired tests may also write the responses those tests replay. The rule that
  // UNIT/INTEGRATION/MODULE must verify against data captured from the real dependency is useless
  // without somewhere to put it: no plan declares this directory, so the Step would be told to
  // record a fixture and then denied the write — a refusal it cannot act on.
  return outputs.some((output) => isTestFilePath(normalizeGitPath(output)))
    ? [...outputs, `${RECORDED_FIXTURE_DIR}/`]
    : outputs;
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

function transitivelyDependsOn(
  step: Step,
  targetId: string,
  byId: ReadonlyMap<string, Step>,
): boolean {
  const seen = new Set<string>();
  const stack = [...step.dependsOn];
  while (stack.length > 0) {
    const dependencyId = stack.pop()!;
    if (dependencyId === targetId) return true;
    if (seen.has(dependencyId)) continue;
    seen.add(dependencyId);
    stack.push(...(byId.get(dependencyId)?.dependsOn ?? []));
  }
  return false;
}

function isVerification(step: Step): boolean {
  return (V_MODEL_TEST_PHASES as readonly string[]).includes(step.phase);
}

function ownedAffectedArtifacts(step: Step, artifacts: readonly string[]): string[] {
  return [...new Set(artifacts.map(normalizeGitPath))].filter((artifact) =>
    step.outputs.some((output) => pathsOverlap(output, artifact))
  );
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeGitPath(left);
  const b = normalizeGitPath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
