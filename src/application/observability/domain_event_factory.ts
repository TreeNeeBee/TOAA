import { createObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectRef } from '../../domain/objects/object_ref.js';
import { DomainEventSchema, type DomainEvent } from '../../domain/observability/domain_event.js';
import type { ObjectId } from '../../domain/identity/object_id.js';

export function createDomainEvent(input: {
  projectId: ObjectId;
  aggregate: ObjectRef;
  eventType: string;
  payload?: Record<string, unknown>;
  phaseId?: ObjectId;
  stepId?: ObjectId;
  ticketId?: ObjectId;
  correlationId: ObjectId;
  causationId?: ObjectId;
  objectRevision?: number;
  now?: string;
}): DomainEvent {
  const now = input.now ?? new Date().toISOString();
  return DomainEventSchema.parse({
    ...createObjectEnvelope({
      name: `EVENT-${input.eventType}-${now}`,
      objectType: 'domain-event',
      projectId: input.projectId,
      now,
    }),
    eventVersion: 1,
    aggregate: input.aggregate,
    eventType: input.eventType,
    payload: input.payload ?? {},
    phaseId: input.phaseId ?? (input.aggregate.objectType === 'phase' ? input.aggregate.id : undefined),
    stepId: input.stepId ?? (input.aggregate.objectType === 'step' ? input.aggregate.id : undefined),
    ticketId: input.ticketId ?? (input.aggregate.objectType === 'ticket' ? input.aggregate.id : undefined),
    correlationId: input.correlationId,
    causationId: input.causationId,
    objectRevision: input.objectRevision,
    status: 'pending',
    occurredAt: now,
  });
}
