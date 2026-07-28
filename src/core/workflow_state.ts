import { PHASE_ORDER, type Phase, type Step } from './plan.js';

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
  options: {
    fromStepId?: string;
    onlyPhase?: string;
    isComplete: (step: Step) => boolean;
  },
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
    const incomplete = order.slice(0, fromIndex).filter(
      (step) => !options.isComplete(step),
    );
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
