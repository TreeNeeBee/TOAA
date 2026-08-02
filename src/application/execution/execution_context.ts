import type { LanguageProfile } from '../../core/language.js';
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

export function computeStepAllowedWrites(step: Step): string[] {
  return [...new Set(step.outputs)];
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
