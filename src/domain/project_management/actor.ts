import { z } from 'zod';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { DomainRoleSchema, ExecutionAgentSchema } from '../workflow/role.js';
import { STEP_TYPES } from '../steps/step.js';
import { TICKET_TYPES } from '../tickets/ticket.js';

export const ACTOR_STATES = ['active', 'paused', 'unavailable', 'retired'] as const;
export type ActorState = (typeof ACTOR_STATES)[number];

export const ActorRegistrationSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('actor-registration'),
  actorKind: z.enum(['human', 'llm-agent', 'runtime-service']),
  role: DomainRoleSchema,
  agent: ExecutionAgentSchema.optional(),
  capabilities: z.array(z.string().min(1)).min(1),
  supportedTicketTypes: z.array(z.enum(TICKET_TYPES)).default([]),
  supportedStepTypes: z.array(z.enum(STEP_TYPES)).default([]),
  state: z.enum(ACTOR_STATES),
  capacity: z.number().int().positive().max(255).default(1),
  activeAssignmentIds: z.array(ObjectIdSchema).default([]),
  qualityScore: z.number().min(0).max(1).optional(),
  reliabilityScore: z.number().min(0).max(1).optional(),
  registeredAt: z.string().datetime({ offset: true }),
  unavailableReason: z.string().min(1).optional(),
}).strict();

export type ActorRegistration = z.infer<typeof ActorRegistrationSchema>;

export function reviseActor(
  actor: ActorRegistration,
  changes: Partial<Omit<ActorRegistration, 'id' | 'objectType' | 'projectId' | 'createdAt' | 'revision'>>,
): ActorRegistration {
  return ActorRegistrationSchema.parse({
    ...actor,
    ...changes,
    ...reviseObjectEnvelope(actor),
  });
}
