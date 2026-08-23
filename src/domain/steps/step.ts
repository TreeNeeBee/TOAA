import { z } from 'zod';
import { assertStateTransition, type StateTransitions } from '../../util/state_machine.js';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema, type ObjectId } from '../identity/object_id.js';
import { DomainRoleSchema, ExecutingRoleSchema } from '../workflow/role.js';
import { PendingReasonSchema } from '../workflow/pending_reason.js';
import {
  DeliveryGateSchema,
  baselineDeliveryGate,
  verificationDeliveryGate,
} from '../quality/delivery_gate.js';

export const V_MODEL_STEP_PAIRS = [
  ['REQUIREMENT_ANALYSIS', 'FUNCTIONAL_TEST'],
  ['HIGH_LEVEL_DESIGN', 'MODULE_TEST'],
  ['DETAILED_DESIGN', 'INTEGRATION_TEST'],
  ['CODE', 'UNIT_TEST'],
] as const;

export type DevelopmentStepType = (typeof V_MODEL_STEP_PAIRS)[number][0];
export type VerificationStepType = (typeof V_MODEL_STEP_PAIRS)[number][1];
export type StepType = DevelopmentStepType | VerificationStepType;

export const DEVELOPMENT_STEP_TYPES = V_MODEL_STEP_PAIRS.map(([type]) => type) as readonly DevelopmentStepType[];
export const VERIFICATION_STEP_TYPES = [...V_MODEL_STEP_PAIRS].reverse().map(([, type]) => type) as readonly VerificationStepType[];
export const STEP_TYPES = [
  ...DEVELOPMENT_STEP_TYPES,
  ...VERIFICATION_STEP_TYPES,
] as unknown as readonly [StepType, ...StepType[]];

export const STEP_TYPE_ORDER = Object.fromEntries(
  STEP_TYPES.map((type, index) => [type, index]),
) as Record<StepType, number>;

/**
 * The one phase that decides the project's dependency set.
 *
 * Stated once because two independent places act on it: `add_dependency` refuses everywhere else,
 * and the tool calibration decides who is handed the tool. They disagreed — the refusal routed a
 * Change Request to HIGH_LEVEL_DESIGN, and HIGH_LEVEL_DESIGN's tools did not include
 * `add_dependency`, so the flow ended at a Step that had been told to do something it had no way to
 * do. A CODE Debugger, which does carry the tool, was the only role that could reach it at all.
 */
export const DEPENDENCY_MANIFEST_OWNER: StepType = 'HIGH_LEVEL_DESIGN';

export const SOURCE_TO_VERIFICATION_STEP = Object.fromEntries(V_MODEL_STEP_PAIRS) as Record<DevelopmentStepType, VerificationStepType>;
export const VERIFICATION_TO_SOURCE_STEP = Object.fromEntries(
  V_MODEL_STEP_PAIRS.map(([source, verification]) => [verification, source]),
) as Record<VerificationStepType, DevelopmentStepType>;

export const STEP_STATES = [
  'created',
  'in_progress',
  'pending',
  'delivered',
  'reopened',
  'closed',
] as const;
export type StepState = (typeof STEP_STATES)[number];

const STEP_TRANSITIONS: StateTransitions<StepState> = {
  created: ['in_progress', 'pending'],
  in_progress: ['delivered', 'pending'],
  pending: ['in_progress'],
  delivered: ['closed', 'reopened'],
  reopened: ['in_progress'],
  /** A verified upstream Change Request may reopen an otherwise closed Step. */
  closed: ['reopened'],
};

export const StepToleranceSchema = z.object({
  metricShortfall: z.number().min(0).max(1).default(0),
  maxFailedTests: z.number().int().nonnegative().default(0),
  maxSkippedTests: z.number().int().nonnegative().default(0),
  maxWarnings: z.number().int().nonnegative().default(0),
}).strict();

export const StepSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('step'),
  phaseId: ObjectIdSchema,
  type: z.enum(STEP_TYPES),
  title: z.string().min(1),
  description: z.string().min(1),
  role: DomainRoleSchema,
  agent: ExecutingRoleSchema,
  state: z.enum(STEP_STATES),
  pendingReason: PendingReasonSchema.optional(),
  dependencyStepIds: z.array(ObjectIdSchema).default([]),
  pairedStepId: ObjectIdSchema.optional(),
  inputs: z.array(z.string().min(1)).default([]),
  outputs: z.array(z.string().min(1)).default([]),
  acceptance: z.array(z.string().min(1)).min(1),
  /** Canonical delivery contract for this V-model Step. */
  deliveryGate: DeliveryGateSchema.optional(),
  tolerance: StepToleranceSchema,
  kpiIds: z.array(ObjectIdSchema).default([]),
  qualityAssessmentId: ObjectIdSchema.optional(),
  deliverableIds: z.array(ObjectIdSchema).default([]),
  checkpointIds: z.array(ObjectIdSchema).default([]),
  reportIds: z.array(ObjectIdSchema).default([]),
  systemPrompt: z.string().min(1),
  tools: z.array(z.string().min(1)).default([]),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
}).strict();

export type Step = z.infer<typeof StepSchema>;

export function resolveStepDeliveryGate(
  step: Pick<Step, 'name' | 'type' | 'deliveryGate'>,
) {
  if (step.deliveryGate) return step.deliveryGate;
  return (DEVELOPMENT_STEP_TYPES as readonly string[]).includes(step.type)
    ? baselineDeliveryGate(step.name, step.type as DevelopmentStepType)
    : verificationDeliveryGate(step.name);
}

/** Whether a Step has gone far enough for the Steps that depend on it to become ready. */
export function stepSatisfiesDependency(step: Pick<Step, 'state'>): boolean {
  return step.state === 'delivered' || step.state === 'closed';
}

/**
 * Whether `step` can only run after `ancestorId` has run — following the same `dependencyStepIds`
 * edges the scheduler reads when it decides a Step is ready.
 *
 * This exists so that "downstream of" is decided once. A corrective hop aimed at a Step downstream
 * of the Step whose Story discovered the defect must not park that Story: the hop is waiting for
 * the Story to finish, so parking the Story makes each wait for the other and the Phase stops with
 * every actor idle. Keying that check on the V-model type order instead would be a second opinion
 * about the same fact, and the scheduler's opinion is the one that deadlocks.
 */
export function stepDependsOn(
  step: Step,
  ancestorId: ObjectId,
  byId: ReadonlyMap<ObjectId, Step>,
): boolean {
  const seen = new Set<ObjectId>([step.id]);
  const frontier = [...step.dependencyStepIds];
  while (frontier.length > 0) {
    const id = frontier.pop()!;
    if (id === ancestorId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const dependency = byId.get(id);
    if (dependency) frontier.push(...dependency.dependencyStepIds);
  }
  return false;
}

export function transitionStep(
  step: Step,
  next: StepState,
  options: { pendingReason?: z.infer<typeof PendingReasonSchema>; now?: string } = {},
): Step {
  if (!assertStateTransition('step', step.id, step.state, next, STEP_TRANSITIONS)) return step;
  if (next === 'pending' && !options.pendingReason) {
    throw new Error(`Step ${step.id} requires pendingReason when entering pending`);
  }
  const envelope = reviseObjectEnvelope(step, { now: options.now });
  return StepSchema.parse({
    ...step,
    ...envelope,
    state: next,
    pendingReason: next === 'pending' ? options.pendingReason : undefined,
  });
}
