import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { Ticket } from '../../domain/tickets/ticket.js';
import type { Step } from '../../domain/steps/step.js';
import type { DomainRole } from '../../domain/workflow/role.js';
import { capabilitiesForStep } from '../../domain/workflow/role_profile.js';
import type { RoleDefinition } from '../../domain/workflow/role_definition.js';
import type { ActorRegistration } from '../../domain/project_management/index.js';

/**
 * An actor together with the definition it instantiates.
 *
 * Eligibility is a question about both — the actor supplies availability and load, the definition
 * supplies what the role can do — so the two travel together rather than the caller resolving one
 * and forgetting the other.
 */
export interface RoutingActor {
  actor: ActorRegistration;
  definition: RoleDefinition;
}

export interface RoutingCandidate extends RoutingActor {
  availableCapacity: number;
  score: number;
}

/**
 * What an actor must satisfy to take a Ticket. It is normally the Ticket's own role and
 * capabilities, but a Change Request propagates across Steps owned by different roles, so PM routes
 * each application against the role of the Step being applied.
 */
export interface RoutingRequirement {
  role: DomainRole;
  capabilities: readonly string[];
}

export function routingRequirement(ticket: Ticket, step?: Step): RoutingRequirement {
  if (ticket.type === 'change-request' && step) {
    return { role: step.role, capabilities: capabilitiesForStep(step.type, 'change-request') };
  }
  return { role: ticket.role, capabilities: ticket.requiredCapabilities };
}

export class RoleRegistry {
  constructor(private readonly repository: DomainObjectRepositoryPort) {}

  async actors(projectId: ObjectId): Promise<ActorRegistration[]> {
    const objects = await this.repository.list({ objectType: 'actor-registration', projectId });
    return objects.filter(
      (object): object is ActorRegistration => object.objectType === 'actor-registration',
    );
  }

  async require(actorId: ObjectId): Promise<ActorRegistration> {
    const object = await this.repository.read(actorId);
    if (object.objectType !== 'actor-registration') throw new Error(`Object ${actorId} is not an Actor`);
    return object;
  }

  async definitionFor(actor: ActorRegistration): Promise<RoleDefinition> {
    const object = await this.repository.read(actor.roleDefinitionId);
    if (object.objectType !== 'role-definition') {
      throw new Error(`Actor ${actor.name} references ${actor.roleDefinitionId}, which is not a Role Definition`);
    }
    if (object.role !== actor.role) {
      throw new Error(`Actor ${actor.name} claims role ${actor.role} but its definition is ${object.role}`);
    }
    return object;
  }

  async resolve(actorId: ObjectId): Promise<RoutingActor> {
    const actor = await this.require(actorId);
    return { actor, definition: await this.definitionFor(actor) };
  }

  /** Every registered actor of a Project, paired with its definition. */
  async routingActors(projectId: ObjectId): Promise<RoutingActor[]> {
    const actors = await this.actors(projectId);
    const definitions = new Map<ObjectId, RoleDefinition>();
    const resolved: RoutingActor[] = [];
    for (const actor of actors) {
      let definition = definitions.get(actor.roleDefinitionId);
      if (!definition) {
        definition = await this.definitionFor(actor);
        definitions.set(actor.roleDefinitionId, definition);
      }
      resolved.push({ actor, definition });
    }
    return resolved;
  }

  /** Returns the first eligibility rule an actor fails, or undefined when the actor qualifies. */
  ineligibility(
    candidate: RoutingActor,
    ticket: Ticket,
    step?: Step,
    options: { ignoreAssignmentId?: ObjectId; ignoreCapacity?: boolean } = {},
  ): string | undefined {
    const { actor, definition } = candidate;
    const required = routingRequirement(ticket, step);
    if (actor.state !== 'active') return `state=${actor.state}`;
    if (actor.role !== required.role) return `role=${actor.role}`;
    if (!definition.supportedTicketTypes.includes(ticket.type)) {
      return `does not support ticket type ${ticket.type}`;
    }
    if (step && definition.supportedStepTypes.length > 0 && !definition.supportedStepTypes.includes(step.type)) {
      return `does not support step type ${step.type}`;
    }
    // Work this actor already holds for the Ticket being routed must not count against it.
    const load = actor.activeAssignmentIds.filter((id) => id !== options.ignoreAssignmentId).length;
    // An administrative assignment reserves nothing, so a full actor is still the right owner for
    // it. Refusing on capacity would strand a Story whose Step is already closed.
    if (!options.ignoreCapacity && load >= actor.capacity) {
      return `at capacity ${load}/${actor.capacity}`;
    }
    const missing = required.capabilities.filter(
      (capability) => !definition.capabilities.includes(capability),
    );
    return missing.length > 0 ? `missing capabilities [${missing.join(', ')}]` : undefined;
  }

  async eligible(
    ticket: Ticket,
    step?: Step,
    options: { ignoreCapacity?: boolean } = {},
  ): Promise<RoutingCandidate[]> {
    const resolved = await this.routingActors(ticket.projectId);
    return resolved.filter(
      (candidate) => !this.ineligibility(candidate, ticket, step, options),
    ).map((candidate) => {
      const { actor } = candidate;
      const availableCapacity = actor.capacity - actor.activeAssignmentIds.length;
      const quality = actor.qualityScore ?? 0.5;
      const reliability = actor.reliabilityScore ?? 0.5;
      return {
        ...candidate,
        availableCapacity,
        score: availableCapacity * 100 + quality * 10 + reliability,
      };
    }).sort((left, right) => right.score - left.score || left.actor.id.localeCompare(right.actor.id));
  }

  async route(
    ticket: Ticket,
    step?: Step,
    options: { ignoreCapacity?: boolean } = {},
  ): Promise<ActorRegistration> {
    const candidates = await this.eligible(ticket, step, options);
    const selected = candidates[0]?.actor;
    if (!selected) {
      const rejected = (await this.routingActors(ticket.projectId))
        .map((candidate) => `${candidate.actor.name} (${this.ineligibility(candidate, ticket, step)})`)
        .join('; ');
      throw new Error(
        `No registered actor can process ${ticket.name}: role=${ticket.role}, ` +
        `capabilities=[${ticket.requiredCapabilities.join(', ')}]. ` +
        `Rejected: ${rejected || 'no actors registered'}`,
      );
    }
    return selected;
  }
}
