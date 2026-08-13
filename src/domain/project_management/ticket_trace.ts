import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ObjectEnvelopeSchema } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { DomainRoleSchema } from '../workflow/role.js';
import { TICKET_STATES } from '../tickets/ticket.js';
import { ASSIGNMENT_STATES } from './assignment.js';

export const TICKET_TRACE_EVENT_TYPES = [
  'created',
  'submitted',
  'registration_rejected',
  'registered',
  'queued',
  'routed',
  'assignment_proposed',
  'accepted',
  'declined',
  'started',
  'pending',
  'resumed',
  'handed_off',
  'reassigned',
  'escalated',
  'resolution_proposed',
  'verified',
  'resolved',
  'closed',
  'reopened',
  'cancelled',
  'correction',
] as const;
export type TicketTraceEventType = (typeof TICKET_TRACE_EVENT_TYPES)[number];

const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const TicketTraceEventSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('ticket-trace-event'),
  ticketId: ObjectIdSchema,
  phaseId: ObjectIdSchema,
  stepId: ObjectIdSchema.optional(),
  assignmentId: ObjectIdSchema.optional(),
  sequence: z.number().int().positive(),
  eventType: z.enum(TICKET_TRACE_EVENT_TYPES),
  initiatorActorId: ObjectIdSchema,
  initiatorRole: DomainRoleSchema,
  fromOwnerActorId: ObjectIdSchema.optional(),
  toOwnerActorId: ObjectIdSchema.optional(),
  fromTicketState: z.enum(TICKET_STATES).optional(),
  toTicketState: z.enum(TICKET_STATES).optional(),
  fromAssignmentState: z.enum(ASSIGNMENT_STATES).optional(),
  toAssignmentState: z.enum(ASSIGNMENT_STATES).optional(),
  reasonCode: z.string().min(1),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  correlationId: ObjectIdSchema,
  causationId: ObjectIdSchema.optional(),
  correctionOfEventId: ObjectIdSchema.optional(),
  previousEventId: ObjectIdSchema.optional(),
  previousEventHash: HashSchema.optional(),
  eventHash: HashSchema,
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export type TicketTraceEvent = z.infer<typeof TicketTraceEventSchema>;

export type TicketTraceEventHashInput = Omit<TicketTraceEvent, 'eventHash'>;

export function hashTicketTraceEvent(event: TicketTraceEventHashInput): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`;
}

export function verifyTicketTrace(events: readonly TicketTraceEvent[]): void {
  let previous: TicketTraceEvent | undefined;
  for (const event of events) {
    const expectedSequence = (previous?.sequence ?? 0) + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(`Ticket ${event.ticketId} trace sequence expected ${expectedSequence}, got ${event.sequence}`);
    }
    if (event.previousEventId !== previous?.id || event.previousEventHash !== previous?.eventHash) {
      throw new Error(`Ticket ${event.ticketId} trace chain is broken at sequence ${event.sequence}`);
    }
    const { eventHash, ...hashInput } = event;
    if (eventHash !== hashTicketTraceEvent(hashInput)) {
      throw new Error(`Ticket ${event.ticketId} trace hash is invalid at sequence ${event.sequence}`);
    }
    previous = event;
  }
}
