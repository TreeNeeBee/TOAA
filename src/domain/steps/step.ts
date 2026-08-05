import { z } from 'zod';
import { assertStateTransition, type StateTransitions } from '../../util/state_machine.js';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { DomainRoleSchema, ExecutionAgentSchema } from '../workflow/role.js';
import { PendingReasonSchema } from '../workflow/pending_reason.js';

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
  agent: ExecutionAgentSchema,
  state: z.enum(STEP_STATES),
  pendingReason: PendingReasonSchema.optional(),
  dependencyStepIds: z.array(ObjectIdSchema).default([]),
  pairedStepId: ObjectIdSchema.optional(),
  inputs: z.array(z.string().min(1)).default([]),
  outputs: z.array(z.string().min(1)).default([]),
  acceptance: z.array(z.string().min(1)).min(1),
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
