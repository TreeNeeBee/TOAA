import path from 'node:path';
import { z } from 'zod';
import {
  ComplexityAssessmentSchema,
  ImplementationPhaseSchema,
  LANGUAGES,
  PLAN_INTENTS,
  PROJECT_TYPES,
  type Plan,
} from './plan.js';
import { assertStateTransition, type StateTransitions } from '../util/state_machine.js';

export const PHASE_PLAN_KIND = 'xcompiler.phasePlan';
export const PHASE_PLAN_VERSION = '1';
export const DEFAULT_PHASE_PLAN_FILE = 'phasePlan.json';

export const PhasePlanPhaseSchema = ImplementationPhaseSchema.extend({
  /** Path to this phase's materialized plan file, relative to phasePlan.json when possible. */
  planPath: z.string().min(1).optional(),
});

export const PhasePlanSchema = z.object({
  kind: z.literal(PHASE_PLAN_KIND),
  version: z.literal(PHASE_PLAN_VERSION),
  language: z.enum(LANGUAGES).default('python'),
  intent: z.enum(PLAN_INTENTS).default('greenfield'),
  projectType: z.enum(PROJECT_TYPES).default('application'),
  requirementDigest: z.string().min(1),
  complexityAssessment: ComplexityAssessmentSchema,
  currentPhaseId: z.string().regex(/^P\d{1,3}$/u, 'currentPhaseId must look like P1').default('P1'),
  globalPrompt: z.string().default(''),
  baselineSummary: z.string().default(''),
  userAddenda: z.string().default(''),
  phases: z.array(PhasePlanPhaseSchema).min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

export type PhasePlan = z.infer<typeof PhasePlanSchema>;
export type PhasePlanPhase = z.infer<typeof PhasePlanPhaseSchema>;

const IMPLEMENTATION_PHASE_TRANSITIONS: StateTransitions<PhasePlanPhase['status']> = {
  deferred: ['planned'],
  planned: ['current', 'deferred'],
  current: ['complete'],
  complete: [],
};

export interface PhasePlanAdvanceResult {
  phasePlan: PhasePlan;
  completedPhaseId: string;
  nextPhase?: PhasePlanPhase;
}

export function defaultPhasePlanPath(workspace: string): string {
  return path.join(path.resolve(workspace), DEFAULT_PHASE_PLAN_FILE);
}

export function phasePlanFileName(phaseId: string): string {
  return `plan.${phaseId}.json`;
}

export function defaultPhasePlanStepPath(workspace: string, phaseId: string): string {
  return path.join(path.resolve(workspace), phasePlanFileName(phaseId));
}

export function buildPhasePlanFromCurrentPlan(args: {
  plan: Plan;
  phasePlanPath: string;
  currentPlanPath: string;
  existing?: PhasePlan;
}): PhasePlan {
  const now = new Date().toISOString();
  const base = path.dirname(path.resolve(args.phasePlanPath));
  const currentPhaseId = args.plan.phaseId ?? 'P1';
  const existingById = new Map((args.existing?.phases ?? []).map((phase) => [phase.id, phase]));
  const phases = (args.plan.implementationPhases ?? []).map((phase) => {
    const existing = existingById.get(phase.id);
    const planPath =
      phase.id === currentPhaseId
        ? relativeFrom(base, path.resolve(args.currentPlanPath))
        : existing?.planPath ?? phasePlanFileName(phase.id);
    return {
      ...phase,
      planPath,
    };
  });
  return {
    kind: PHASE_PLAN_KIND,
    version: PHASE_PLAN_VERSION,
    language: args.plan.language,
    intent: args.plan.intent,
    projectType: args.plan.projectType,
    requirementDigest: args.plan.requirementDigest,
    complexityAssessment: args.plan.complexityAssessment,
    currentPhaseId,
    globalPrompt: args.plan.globalPrompt ?? '',
    baselineSummary: args.plan.baselineSummary ?? '',
    userAddenda: args.plan.userAddenda ?? '',
    phases,
    createdAt: args.existing?.createdAt ?? args.plan.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * Complete the current iteration and activate the first dependency-ready planned iteration.
 * The caller materializes `nextPhase.planPath` before persisting the returned PhasePlan.
 */
export function advancePhasePlan(input: PhasePlan): PhasePlanAdvanceResult {
  const phases = input.phases.map((phase) => ({ ...phase }));
  const current = phases.find((phase) => phase.id === input.currentPhaseId);
  if (!current) {
    throw new Error(`phasePlan current phase ${input.currentPhaseId} does not exist`);
  }
  if (current.status !== 'current' && current.status !== 'complete') {
    throw new Error(`phasePlan current phase ${current.id} has invalid status ${current.status}`);
  }
  transitionImplementationPhase(current, 'complete');

  const completeIds = new Set(phases.filter((phase) => phase.status === 'complete').map((phase) => phase.id));
  const planned = phases.filter((phase) => phase.status === 'planned');
  const next = planned.find((phase) => phase.dependsOn.every((dependency) => completeIds.has(dependency)));
  if (!next && planned.length > 0) {
    const blocked = planned
      .map((phase) => `${phase.id} depends on [${phase.dependsOn.join(', ')}]`)
      .join('; ');
    throw new Error(`no planned phase is dependency-ready after ${current.id}: ${blocked}`);
  }
  if (next) transitionImplementationPhase(next, 'current');

  const phasePlan: PhasePlan = {
    ...input,
    currentPhaseId: next?.id ?? current.id,
    phases,
    updatedAt: new Date().toISOString(),
  };
  return {
    phasePlan,
    completedPhaseId: current.id,
    nextPhase: next,
  };
}

function transitionImplementationPhase(
  phase: PhasePlanPhase,
  next: PhasePlanPhase['status'],
): void {
  const changed = assertStateTransition(
    'implementation phase',
    phase.id,
    phase.status,
    next,
    IMPLEMENTATION_PHASE_TRANSITIONS,
  );
  if (!changed) return;
  phase.status = next;
}

function relativeFrom(base: string, target: string): string {
  const rel = path.relative(base, target).replace(/\\/g, '/');
  if (!rel) return '.';
  return rel.startsWith('..') ? target : rel;
}
