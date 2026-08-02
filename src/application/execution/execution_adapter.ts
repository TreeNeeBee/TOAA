import type { Plan, Step as ExecutionStep } from '../../core/plan.js';
import type { Phase } from '../../domain/phases/phase.js';
import type { Step, StepType } from '../../domain/steps/step.js';

const DOMAIN_TO_EXECUTION_PHASE = {
  REQUIREMENT_ANALYSIS: 'REQUIREMENT_ANALYSIS',
  HIGH_LEVEL_DESIGN: 'HIGH_LEVEL_DESIGN',
  DETAILED_DESIGN: 'DETAILED_DESIGN',
  CODING: 'CODE',
  UNIT_TEST: 'UNIT_TEST',
  INTEGRATION_TEST: 'INTEGRATION_TEST',
  SYSTEM_TEST: 'MODULE_TEST',
  ACCEPTANCE_TEST: 'FUNCTIONAL_TEST',
} as const satisfies Record<StepType, ExecutionStep['phase']>;

export interface ExecutionProjection {
  plan: Plan;
  byDomainStepId: Map<string, ExecutionStep>;
}

/**
 * Planner JSON is an immutable execution specification. Domain IDs replace its
 * display IDs before an attempt so tools, audit events, and permissions all use
 * the canonical globally unique identity.
 */
export function projectExecutionPlan(
  draft: Plan,
  phase: Phase,
  domainSteps: readonly Step[],
): ExecutionProjection {
  const byType = new Map(domainSteps.map((step) => [step.type, step]));
  const oldToDomain = new Map<string, Step>();
  for (const planned of draft.steps) {
    const domain = byType.get(executionPhaseToDomain(planned.phase));
    if (!domain) throw new Error(`Domain Step missing for Planner phase ${planned.phase}`);
    oldToDomain.set(planned.id, domain);
  }
  const projectedSteps = draft.steps.map((planned): ExecutionStep => {
    const domain = oldToDomain.get(planned.id)!;
    return {
      ...planned,
      id: domain.id,
      iterationId: phase.name,
      phase: DOMAIN_TO_EXECUTION_PHASE[domain.type],
      title: domain.title,
      description: domain.description,
      systemPrompt: domain.systemPrompt,
      role: domain.agent,
      tools: domain.tools,
      inputs: domain.inputs,
      outputs: domain.outputs,
      dependsOn: planned.dependsOn.map((id) => oldToDomain.get(id)?.id ?? id),
      acceptance: domain.acceptance.join('\n'),
      maxAttempts: domain.maxAttempts,
    };
  });
  return {
    plan: { ...draft, phaseId: phase.name, steps: projectedSteps },
    byDomainStepId: new Map(projectedSteps.map((step) => [step.id, step])),
  };
}

export function executionPhaseFor(type: StepType): ExecutionStep['phase'] {
  return DOMAIN_TO_EXECUTION_PHASE[type];
}

function executionPhaseToDomain(phase: ExecutionStep['phase']): StepType {
  switch (phase) {
    case 'CODE': return 'CODING';
    case 'MODULE_TEST': return 'SYSTEM_TEST';
    case 'FUNCTIONAL_TEST': return 'ACCEPTANCE_TEST';
    default: return phase;
  }
}
