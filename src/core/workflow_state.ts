import { PHASE_ORDER, type Phase, type Step, type StepStatus } from './plan.js';
import { assertStateTransition, type StateTransitions } from '../util/state_machine.js';

export type StepTransitionReason =
  | 'attempt-started'
  | 'attempt-passed'
  | 'attempt-failed'
  | 'interrupted'
  | 'explicit-reset'
  | 'v-model-rollback'
  | 'downstream-rerun'
  | 'quality-enhancement'
  | 'quality-gate-failed'
  | 'cached-gate-passed'
  | 'cached-gate-failed';

const ALLOWED_STEP_TRANSITIONS: StateTransitions<StepStatus> = {
  // A persisted artifact may pass a cached gate after a rollback reset without
  // regenerating the Step, so PENDING -> DONE is an explicit validation path.
  PENDING: ['RUNNING', 'DONE', 'FAILED'],
  RUNNING: ['PENDING', 'DONE', 'FAILED'],
  FAILED: ['PENDING', 'RUNNING', 'DONE'],
  DONE: ['PENDING', 'RUNNING'],
};

const STEP_REASON_TARGETS: Record<StepTransitionReason, StepStatus> = {
  'attempt-started': 'RUNNING',
  'attempt-passed': 'DONE',
  'attempt-failed': 'FAILED',
  interrupted: 'PENDING',
  'explicit-reset': 'PENDING',
  'v-model-rollback': 'PENDING',
  'downstream-rerun': 'PENDING',
  'quality-enhancement': 'PENDING',
  'quality-gate-failed': 'FAILED',
  'cached-gate-passed': 'DONE',
  'cached-gate-failed': 'FAILED',
};

export class InvalidStepTransitionError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly from: StepStatus,
    public readonly to: StepStatus,
    public readonly reason: StepTransitionReason,
  ) {
    super(`Invalid step transition ${stepId}: ${from} -> ${to} (${reason})`);
    this.name = 'InvalidStepTransitionError';
  }
}

/**
 * The only supported mutation boundary for persisted Step state.
 *
 * Retries may start from FAILED/DONE, interrupted work returns to PENDING, and a
 * cached test gate may validate a previously FAILED step without regenerating it.
 */
export function transitionStep(
  step: Step,
  next: StepStatus,
  reason: StepTransitionReason,
): boolean {
  if (STEP_REASON_TARGETS[reason] !== next) {
    throw new InvalidStepTransitionError(step.id, step.status, next, reason);
  }
  const changed = assertStateTransition(
    'step',
    step.id,
    step.status,
    next,
    ALLOWED_STEP_TRANSITIONS,
    () => new InvalidStepTransitionError(step.id, step.status, next, reason),
  );
  if (!changed) return false;
  step.status = next;
  return true;
}

export function resetStepForRerun(
  step: Step,
  reason: Extract<
    StepTransitionReason,
    'explicit-reset' | 'v-model-rollback' | 'downstream-rerun' | 'quality-enhancement' | 'interrupted'
  >,
): boolean {
  const changed = transitionStep(step, 'PENDING', reason);
  step.retries = 0;
  return changed;
}

export function stepTransitivelyDependsOn(
  step: Step,
  targetId: string,
  byId: ReadonlyMap<string, Step>,
): boolean {
  const seen = new Set<string>();
  const stack = [...step.dependsOn];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const dependency = byId.get(current);
    if (dependency) stack.push(...dependency.dependsOn);
  }
  return false;
}

export function incompleteTransitiveDependencies(
  step: Step,
  byId: ReadonlyMap<string, Step>,
): Step[] {
  return [...byId.values()].filter(
    (candidate) =>
      candidate.status !== 'DONE' &&
      stepTransitivelyDependsOn(step, candidate.id, byId),
  );
}

export function downstreamStepsForRerun(
  steps: readonly Step[],
  source: Step,
): Step[] {
  const iterationId = source.iterationId ?? 'P1';
  const byId = new Map(steps.map((step) => [step.id, step] as const));
  return steps.filter(
    (candidate) =>
      (candidate.iterationId ?? 'P1') === iterationId &&
      candidate.id !== source.id &&
      (
        PHASE_ORDER[candidate.phase] > PHASE_ORDER[source.phase] ||
        stepTransitivelyDependsOn(candidate, source.id, byId)
      ),
  );
}

export type ExecutionSelection =
  | { ok: true; fromIndex: number; phase?: Phase }
  | {
      ok: false;
      failedStepId: string;
      reason: string;
      data: Record<string, unknown>;
    };

export function validateExecutionSelection(
  order: readonly Step[],
  options: { fromStepId?: string; onlyPhase?: string },
): ExecutionSelection {
  const fromIndex = options.fromStepId
    ? order.findIndex((step) => step.id === options.fromStepId)
    : 0;

  if (options.fromStepId && fromIndex < 0) {
    return {
      ok: false,
      failedStepId: options.fromStepId,
      reason: `cannot start from unknown step ${options.fromStepId}`,
      data: { fromStepId: options.fromStepId },
    };
  }

  if (options.fromStepId) {
    const incomplete = order.slice(0, fromIndex).filter((step) => step.status !== 'DONE');
    if (incomplete.length > 0) {
      return {
        ok: false,
        failedStepId: incomplete[0]!.id,
        reason:
          `cannot start from ${options.fromStepId}: earlier required steps are incomplete: ` +
          incomplete.map((step) => `${step.id}=${step.status}`).join(', '),
        data: {
          fromStepId: options.fromStepId,
          incompleteSteps: incomplete.map(stepStateSummary),
        },
      };
    }
  }

  const phase = options.onlyPhase as Phase | undefined;
  if (phase && !order.some((step) => step.phase === phase)) {
    return {
      ok: false,
      failedStepId: `PHASE_${options.onlyPhase}`,
      reason: `cannot run unknown or absent phase ${options.onlyPhase}`,
      data: { onlyPhase: options.onlyPhase },
    };
  }

  return { ok: true, fromIndex, phase };
}

export function stepStateSummary(step: Step): Pick<Step, 'id' | 'phase' | 'status'> {
  return { id: step.id, phase: step.phase, status: step.status };
}
