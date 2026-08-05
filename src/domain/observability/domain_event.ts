import { z } from 'zod';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { ObjectRefSchema } from '../objects/object_ref.js';

export const DomainEventSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('domain-event'),
  eventVersion: z.literal(1),
  aggregate: ObjectRefSchema,
  eventType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  phaseId: ObjectIdSchema.optional(),
  stepId: ObjectIdSchema.optional(),
  ticketId: ObjectIdSchema.optional(),
  correlationId: ObjectIdSchema,
  causationId: ObjectIdSchema.optional(),
  objectRevision: z.number().int().nonnegative().optional(),
  status: z.enum(['pending', 'published']),
  occurredAt: z.string().datetime({ offset: true }),
  publishedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type DomainEvent = z.infer<typeof DomainEventSchema>;

export function markDomainEventPublished(
  event: DomainEvent,
  now = new Date().toISOString(),
): DomainEvent {
  if (event.status === 'published') return event;
  return DomainEventSchema.parse({
    ...event,
    ...reviseObjectEnvelope(event, { now }),
    status: 'published',
    publishedAt: now,
  });
}
