import { z } from 'zod';
import { assertStateTransition, type StateTransitions } from '../../util/state_machine.js';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';

export const ASSIGNMENT_STATES = [
  'proposed',
  'accepted',
  'declined',
  'released',
  'completed',
  'cancelled',
] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

const ASSIGNMENT_TRANSITIONS: StateTransitions<AssignmentState> = {
  proposed: ['accepted', 'declined', 'cancelled'],
  accepted: ['released', 'completed', 'cancelled'],
  declined: [],
  released: [],
  completed: [],
  cancelled: [],
};

export const TicketAssignmentSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('ticket-assignment'),
  ticketId: ObjectIdSchema,
  assigneeActorId: ObjectIdSchema,
  assignedByActorId: ObjectIdSchema,
  previousAssignmentId: ObjectIdSchema.optional(),
  parentAssignmentId: ObjectIdSchema.optional(),
  capacityConsumed: z.boolean().default(true),
  state: z.enum(ASSIGNMENT_STATES),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  reason: z.string().min(1),
  proposedAt: z.string().datetime({ offset: true }),
  acceptedAt: z.string().datetime({ offset: true }).optional(),
  completedAt: z.string().datetime({ offset: true }).optional(),
  releasedAt: z.string().datetime({ offset: true }).optional(),
  declinedAt: z.string().datetime({ offset: true }).optional(),
  cancelledAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type TicketAssignment = z.infer<typeof TicketAssignmentSchema>;

export function transitionAssignment(
  assignment: TicketAssignment,
  next: AssignmentState,
  now = new Date().toISOString(),
): TicketAssignment {
  if (!assertStateTransition('ticket-assignment', assignment.id, assignment.state, next, ASSIGNMENT_TRANSITIONS)) {
    return assignment;
  }
  return TicketAssignmentSchema.parse({
    ...assignment,
    ...reviseObjectEnvelope(assignment, { now }),
    state: next,
    acceptedAt: next === 'accepted' ? now : assignment.acceptedAt,
    completedAt: next === 'completed' ? now : assignment.completedAt,
    releasedAt: next === 'released' ? now : assignment.releasedAt,
    declinedAt: next === 'declined' ? now : assignment.declinedAt,
    cancelledAt: next === 'cancelled' ? now : assignment.cancelledAt,
  });
}
