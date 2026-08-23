import { TEST_FIXTURE_DIR } from '../../core/external_dependency_contract.js';
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
  if (isVerification(step)) return withTestFixtureAccess(step.outputs);
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
  return withTestFixtureAccess([...outputs]);
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
    return owned.length > 0 ? withTestFixtureAccess(owned) : computeStepAllowedWrites(step);
  }
  if (ticket.type === 'change-request') {
    const owned = ownedAffectedArtifacts(step, ticket.contractDelta.affectedArtifacts);
    return owned.length > 0 ? withTestFixtureAccess(owned) : computeStepAllowedWrites(step);
  }
  return computeDebugAllowedWrites(plan, step, profile);
}

/**
 * Adds the fixture directory to any write scope that owns a test.
 *
 * One function because a Step and the Debugger repairing that same Step must be able to write the
 * same files. They could not: the Step's own scope granted the fixture directory and the corrective
 * scope did not, so a test the Step was allowed to create could not be repaired — and a Bug routed
 * there spent six attempts rewriting four DBC samples into the identical denial before the
 * non-convergence guard stopped the run.
 *
 * The whole directory, not only the recorded-response corner of it: what a test must read is decided
 * by what it verifies, and a parser test needs a malformed sample as surely as a client test needs a
 * captured response.
 */
function withTestFixtureAccess(scope: readonly string[]): string[] {
  const paths = [...new Set(scope)];
  if (!paths.some((path) => isTestFilePath(normalizeGitPath(path)))) return paths;
  const grant = `${TEST_FIXTURE_DIR}/`;
  return paths.includes(grant) ? paths : [...paths, grant];
}

export function computeStepAllowedWrites(step: Step): string[] {
  // No plan declares the fixture directory and the instructions name it, so withholding it tells a
  // Step to write a fixture and then refuses the one path it was told to use.
  return withTestFixtureAccess(step.outputs);
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
