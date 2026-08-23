import { z } from 'zod';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { DomainRoleSchema, RoleSchema } from '../workflow/role.js';

export const ACTOR_STATES = ['active', 'paused', 'unavailable', 'retired'] as const;
export type ActorState = (typeof ACTOR_STATES)[number];

export const ActorRegistrationSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('actor-registration'),
  actorKind: z.enum(['human', 'llm-agent', 'runtime-service']),
  role: DomainRoleSchema,
  /**
   * The definition this actor instantiates, and the sole source of what it can do: capabilities,
   * supported Ticket types, and supported Step types are read through this reference rather than
   * copied here, so an actor cannot drift from the role it claims to be.
   *
   * One definition, many actors: that split is what lets two actors of the same role carry
   * different model bindings and run concurrently.
   */
  roleDefinitionId: ObjectIdSchema,
  // Any role, not only the executing ones: PM registers through this same flow and speaks as
  // itself rather than borrowing a planner's voice.
  agent: RoleSchema.optional(),
  /**
   * Which models this actor may use, in order.
   *
   * Bound to the actor rather than looked up from a global agent-keyed pool, so two actors of the
   * same role can differ — the precondition for assigning a stronger model to one of several
   * parallel developers.
   */
  llmBinding: z.object({
    providerPool: z.array(z.string().min(1)).min(1),
    temperature: z.number().min(0).max(2).optional(),
  }).strict().optional(),
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
