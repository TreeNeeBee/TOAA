import { z } from 'zod';
import { assertStateTransition, type StateTransitions } from '../../util/state_machine.js';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { PendingReasonSchema } from '../workflow/pending_reason.js';
import { DeliveryGateSchema, phaseDeliveryGate } from '../quality/delivery_gate.js';

export const PHASE_STATES = [
  'created',
  'in_progress',
  'pending',
  'delivered',
  'reopened',
  'closed',
] as const;
export type PhaseState = (typeof PHASE_STATES)[number];

const PHASE_TRANSITIONS: StateTransitions<PhaseState> = {
  created: ['in_progress', 'pending'],
  in_progress: ['delivered', 'pending'],
  pending: ['in_progress'],
  delivered: ['closed', 'reopened'],
  reopened: ['in_progress'],
  closed: [],
};

export const PhaseSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('phase'),
  objective: z.string().min(1),
  description: z.string().min(1),
  state: z.enum(PHASE_STATES),
  pendingReason: PendingReasonSchema.optional(),
  priority: z.number().int().min(0).max(255),
  dependencyPhaseIds: z.array(ObjectIdSchema).default([]),
  /** Planned Phases remain skeletal until their own detailed plan is compiled. */
  stepIds: z.array(ObjectIdSchema).default([]),
  epicTicketId: ObjectIdSchema,
  planId: ObjectIdSchema,
  kpiIds: z.array(ObjectIdSchema).default([]),
  qualityAssessmentId: ObjectIdSchema.optional(),
  deliverableIds: z.array(ObjectIdSchema).default([]),
  checkpointIds: z.array(ObjectIdSchema).default([]),
  reportIds: z.array(ObjectIdSchema).default([]),
  scope: z.array(z.string().min(1)).default([]),
  verificationGate: z.array(z.string().min(1)).min(1),
  /** Phase-level integrated delivery and live-scenario acceptance contract. */
  deliveryGate: DeliveryGateSchema.optional(),
}).strict().superRefine((phase, ctx) => {
  if (['in_progress', 'delivered', 'reopened', 'closed'].includes(phase.state) && phase.stepIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stepIds'],
      message: `Phase ${phase.name} must be materialized before entering ${phase.state}`,
    });
  }
});

export type Phase = z.infer<typeof PhaseSchema>;

export function resolvePhaseDeliveryGate(
  phase: Pick<Phase, 'name' | 'verificationGate' | 'deliveryGate'>,
) {
  return phase.deliveryGate ?? phaseDeliveryGate(phase.name, phase.verificationGate);
}

export function transitionPhase(
  phase: Phase,
  next: PhaseState,
  options: { pendingReason?: z.infer<typeof PendingReasonSchema>; now?: string } = {},
): Phase {
  if (!assertStateTransition('phase', phase.id, phase.state, next, PHASE_TRANSITIONS)) return phase;
  if (next === 'pending' && !options.pendingReason) {
    throw new Error(`Phase ${phase.id} requires pendingReason when entering pending`);
  }
  const envelope = reviseObjectEnvelope(phase, { now: options.now });
  return PhaseSchema.parse({
    ...phase,
    ...envelope,
    state: next,
    pendingReason: next === 'pending' ? options.pendingReason : undefined,
  });
}
