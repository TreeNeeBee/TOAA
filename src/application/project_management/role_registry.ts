import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { Ticket } from '../../domain/tickets/ticket.js';
import type { Step } from '../../domain/steps/step.js';
import type { ActorRegistration } from '../../domain/project_management/index.js';

export interface RoutingCandidate {
  actor: ActorRegistration;
  availableCapacity: number;
  score: number;
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

  async eligible(ticket: Ticket, step?: Step): Promise<RoutingCandidate[]> {
    const required = new Set(ticket.requiredCapabilities);
    const candidates = (await this.actors(ticket.projectId)).filter((actor) => {
      if (actor.state !== 'active') return false;
      if (actor.role !== ticket.role) return false;
      if (!actor.supportedTicketTypes.includes(ticket.type)) return false;
      if (step && actor.supportedStepTypes.length > 0 && !actor.supportedStepTypes.includes(step.type)) return false;
      if (actor.activeAssignmentIds.length >= actor.capacity) return false;
      return [...required].every((capability) => actor.capabilities.includes(capability));
    });
    return candidates.map((actor) => {
      const availableCapacity = actor.capacity - actor.activeAssignmentIds.length;
      const quality = actor.qualityScore ?? 0.5;
      const reliability = actor.reliabilityScore ?? 0.5;
      return {
        actor,
        availableCapacity,
        score: availableCapacity * 100 + quality * 10 + reliability,
      };
    }).sort((left, right) => right.score - left.score || left.actor.id.localeCompare(right.actor.id));
  }

  async route(ticket: Ticket, step?: Step): Promise<ActorRegistration> {
    const candidates = await this.eligible(ticket, step);
    const selected = candidates[0]?.actor;
    if (!selected) {
      throw new Error(
        `No registered actor can process ${ticket.name}: role=${ticket.role}, ` +
        `capabilities=[${ticket.requiredCapabilities.join(', ')}]`,
      );
    }
    return selected;
  }
}
