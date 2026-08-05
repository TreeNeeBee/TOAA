import { createObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { TicketSchema, type Ticket } from '../../domain/tickets/ticket.js';
import {
  TicketAssignmentSchema,
  reviseActor,
  type ActorRegistration,
  type TicketAssignment,
} from '../../domain/project_management/index.js';
import { RoleRegistry } from './role_registry.js';
import { TicketTraceService } from './ticket_trace_service.js';
import { createDomainEvent } from '../observability/domain_event_factory.js';
import type { PersistedDomainObject } from '../../domain/objects/persisted.js';
import { GovernanceService } from './governance_service.js';

export class TicketRegistrationService {
  private readonly roles: RoleRegistry;
  private readonly traces: TicketTraceService;
  private readonly governance: GovernanceService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.roles = new RoleRegistry(repository);
    this.traces = new TicketTraceService(repository);
    this.governance = new GovernanceService(repository);
  }

  async register(ticketId: ObjectId): Promise<Ticket> {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.registeredAt) return ticket;
    const creator = await this.roles.require(ticket.creatorActorId);
    this.assertCreationAuthority(ticket, creator);
    const now = new Date().toISOString();
    const built = await this.traces.build(ticket, [
      {
        eventType: 'created',
        initiatorActorId: creator.id,
        initiatorRole: creator.role,
        reasonCode: 'ticket.created_by_context_owner',
        reason: `${creator.role} created ${ticket.type} with source context.`,
        correlationId: ticket.source.correlationId,
        causationId: ticket.source.causationId,
        occurredAt: ticket.submittedAt,
      },
      {
        eventType: 'submitted',
        initiatorActorId: creator.id,
        initiatorRole: creator.role,
        reasonCode: 'ticket.submitted_to_pm',
        reason: 'Context owner submitted the Ticket to Project Manager routing.',
        correlationId: ticket.source.correlationId,
        causationId: ticket.id,
        occurredAt: ticket.submittedAt,
      },
      {
        eventType: 'registered',
        initiatorActorId: (await this.projectManager(ticket.projectId)).id,
        initiatorRole: 'project-manager',
        reasonCode: 'ticket.registration_validated',
        reason: 'Project Manager validated routing metadata without rewriting technical context.',
        correlationId: ticket.source.correlationId,
        causationId: ticket.id,
        occurredAt: now,
      },
    ]);
    const registered = TicketSchema.parse({ ...built.ticket, registeredAt: now });
    await this.repository.commit([
      ...built.events,
      registered,
      createDomainEvent({
        projectId: ticket.projectId,
        aggregate: { id: ticket.id, objectType: 'ticket' },
        eventType: 'ticket.registered',
        payload: { ticketType: ticket.type, creatorActorId: creator.id },
        phaseId: ticket.phaseId,
        stepId: ticket.stepId,
        ticketId: ticket.id,
        correlationId: ticket.source.correlationId,
        causationId: ticket.id,
        now,
      }),
    ]);
    return registered;
  }

  async registerProjectTickets(projectId: ObjectId): Promise<Ticket[]> {
    const objects = await this.repository.list({ objectType: 'ticket', projectId });
    const tickets = objects.filter((object): object is Ticket => object.objectType === 'ticket');
    const registered: Ticket[] = [];
    for (const ticket of tickets) registered.push(await this.register(ticket.id));
    return registered;
  }

  async routeAndAssign(
    ticketId: ObjectId,
    options: { inheritedFromTicketId?: ObjectId } = {},
  ): Promise<{ ticket: Ticket; assignment: TicketAssignment }> {
    let ticket = await this.register(ticketId);
    if (ticket.activeAssignmentId) {
      const existing = await this.repository.read(ticket.activeAssignmentId);
      if (existing.objectType !== 'ticket-assignment') {
        throw new Error(`Ticket ${ticket.name} active assignment is invalid`);
      }
      return { ticket, assignment: existing };
    }
    const stepObject = ticket.stepId ? await this.repository.read(ticket.stepId) : undefined;
    const step = stepObject?.objectType === 'step' ? stepObject : undefined;
    const parentAssignment = options.inheritedFromTicketId
      ? await this.assignmentForTicket(options.inheritedFromTicketId)
      : undefined;
    const assignee = parentAssignment
      ? await this.requireEligibleInheritedOwner(ticket, parentAssignment.assigneeActorId, step)
      : await this.roles.route(ticket, step);
    const pm = await this.projectManager(ticket.projectId);
    const now = new Date().toISOString();
    const assignment = TicketAssignmentSchema.parse({
      ...createObjectEnvelope({
        name: `${ticket.name}-ASSIGN-${ticket.assignmentIds.length + 1}`,
        objectType: 'ticket-assignment',
        projectId: ticket.projectId,
        now,
      }),
      ticketId: ticket.id,
      assigneeActorId: assignee.id,
      assignedByActorId: pm.id,
      previousAssignmentId: ticket.assignmentIds.at(-1),
      parentAssignmentId: parentAssignment?.id,
      capacityConsumed: !parentAssignment,
      state: 'accepted',
      requiredCapabilities: ticket.requiredCapabilities,
      reason: `Selected ${assignee.role} by capability, readiness, capacity, quality, and stable tie-break.`,
      proposedAt: now,
      acceptedAt: now,
    });
    const built = await this.traces.build(ticket, [
      {
        eventType: 'routed',
        initiatorActorId: pm.id,
        initiatorRole: pm.role,
        assignmentId: assignment.id,
        toOwnerActorId: assignee.id,
        reasonCode: 'pm.capability_route',
        reason: assignment.reason,
        correlationId: ticket.source.correlationId,
        causationId: ticket.id,
      },
      {
        eventType: 'assignment_proposed',
        initiatorActorId: pm.id,
        initiatorRole: pm.role,
        assignmentId: assignment.id,
        toOwnerActorId: assignee.id,
        toAssignmentState: 'proposed',
        reasonCode: 'pm.assignment_proposed',
        reason: `Project Manager proposed assignment to ${assignee.name}.`,
        correlationId: ticket.source.correlationId,
        causationId: assignment.id,
      },
      {
        eventType: 'accepted',
        initiatorActorId: assignee.id,
        initiatorRole: assignee.role,
        assignmentId: assignment.id,
        toOwnerActorId: assignee.id,
        fromAssignmentState: 'proposed',
        toAssignmentState: 'accepted',
        reasonCode: 'actor.assignment_accepted',
        reason: `${assignee.name} accepted Ticket ownership.`,
        correlationId: ticket.source.correlationId,
        causationId: assignment.id,
      },
    ]);
    ticket = TicketSchema.parse({
      ...built.ticket,
      assignmentIds: [...ticket.assignmentIds, assignment.id],
      activeAssignmentId: assignment.id,
    });
    const routingOptions = (await this.roles.actors(ticket.projectId))
      .filter((actor) => actor.state === 'active' && actor.supportedTicketTypes.includes(ticket.type))
      .map((actor) => actor.name);
    const routingDecision = await this.governance.prepareDecision({
      projectId: ticket.projectId,
      decisionType: 'routing',
      decidedByActorId: pm.id,
      authority: 'project-manager',
      options: routingOptions.length > 0 ? routingOptions : [assignee.name],
      selected: assignee.name,
      rationale: assignment.reason,
      confidence: 1,
      evidenceRefs: [ticket.id, assignment.id],
      correlationId: ticket.source.correlationId,
      causationId: ticket.id,
      now,
    });
    const objects: PersistedDomainObject[] = [
      ...built.events,
      assignment,
      routingDecision.decision,
      routingDecision.managementPlan,
    ];
    if (assignment.capacityConsumed) {
      objects.push(reviseActor(assignee, {
        activeAssignmentIds: [...assignee.activeAssignmentIds, assignment.id],
      }));
    }
    objects.push(ticket, createDomainEvent({
      projectId: ticket.projectId,
      aggregate: { id: ticket.id, objectType: 'ticket' },
      eventType: 'ticket.assigned',
      payload: {
        assignmentId: assignment.id,
        ownerActorId: assignee.id,
        inherited: !assignment.capacityConsumed,
      },
      phaseId: ticket.phaseId,
      stepId: ticket.stepId,
      ticketId: ticket.id,
      correlationId: ticket.source.correlationId,
      causationId: assignment.id,
      now,
    }));
    objects.push(createDomainEvent({
      projectId: ticket.projectId,
      aggregate: { id: routingDecision.decision.id, objectType: 'decision-record' },
      eventType: 'governance.decision_recorded',
      payload: {
        decisionType: routingDecision.decision.decisionType,
        selected: routingDecision.decision.selected,
      },
      phaseId: ticket.phaseId,
      stepId: ticket.stepId,
      ticketId: ticket.id,
      correlationId: ticket.source.correlationId,
      causationId: assignment.id,
      objectRevision: routingDecision.decision.revision,
      now,
    }));
    await this.repository.commit(objects);
    return { ticket, assignment };
  }

  async ownerActorId(ticketId: ObjectId): Promise<ObjectId> {
    return (await this.assignmentForTicket(ticketId)).assigneeActorId;
  }

  async ownerActorIdForStep(stepId: ObjectId): Promise<ObjectId> {
    const objects = await this.repository.list({ objectType: 'ticket' });
    const story = objects.find(
      (object): object is Ticket =>
        object.objectType === 'ticket' &&
        object.type === 'story' &&
        object.workKind === 'v-model-step' &&
        object.stepId === stepId,
    );
    if (!story) throw new Error(`Step ${stepId} has no V-model Story`);
    return this.ownerActorId(story.id);
  }

  async discovererActorIdForStep(stepId: ObjectId): Promise<ObjectId> {
    const object = await this.repository.read(stepId);
    if (object.objectType !== 'step') throw new Error(`Object ${stepId} is not a Step`);
    const actor = (await this.roles.actors(object.projectId)).find(
      (candidate) => candidate.role === object.role && candidate.state === 'active',
    );
    if (!actor) throw new Error(`Step ${object.name} has no active discovering actor`);
    return actor.id;
  }

  private async projectManager(projectId: ObjectId): Promise<ActorRegistration> {
    const actors = await this.roles.actors(projectId);
    const pm = actors.find((actor) => actor.role === 'project-manager' && actor.state === 'active');
    if (!pm) throw new Error(`Project ${projectId} has no active Project Manager`);
    return pm;
  }

  private assertCreationAuthority(ticket: Ticket, creator: ActorRegistration): void {
    const pmOwned = ticket.type === 'epic' || ticket.type === 'story';
    if (pmOwned && creator.role !== 'project-manager') {
      throw new Error(`${ticket.type} ${ticket.name} must be created by Project Manager`);
    }
    if (!pmOwned && creator.role === 'project-manager') {
      throw new Error(`${ticket.type} ${ticket.name} must be created by its context-owning source, not Project Manager`);
    }
    if (creator.projectId !== ticket.projectId) {
      throw new Error(`Ticket ${ticket.name} creator belongs to another Project`);
    }
  }

  private async assignmentForTicket(ticketId: ObjectId): Promise<TicketAssignment> {
    const ticket = await this.requireTicket(ticketId);
    if (!ticket.activeAssignmentId) throw new Error(`Ticket ${ticket.name} has no active assignment`);
    const object = await this.repository.read(ticket.activeAssignmentId);
    if (object.objectType !== 'ticket-assignment' || object.state !== 'accepted') {
      throw new Error(`Ticket ${ticket.name} does not have an accepted active assignment`);
    }
    return object;
  }

  private async requireEligibleInheritedOwner(
    ticket: Ticket,
    actorId: ObjectId,
    step: Parameters<RoleRegistry['eligible']>[1],
  ): Promise<ActorRegistration> {
    const actor = await this.roles.require(actorId);
    const required = new Set(ticket.requiredCapabilities);
    if (
      actor.state !== 'active' ||
      actor.role !== ticket.role ||
      !actor.supportedTicketTypes.includes(ticket.type) ||
      (step && actor.supportedStepTypes.length > 0 && !actor.supportedStepTypes.includes(step.type)) ||
      [...required].some((capability) => !actor.capabilities.includes(capability))
    ) {
      throw new Error(`Parent Ticket owner ${actor.name} cannot inherit ${ticket.name}`);
    }
    return actor;
  }

  private async requireTicket(ticketId: ObjectId): Promise<Ticket> {
    const object = await this.repository.read(ticketId);
    if (object.objectType !== 'ticket') throw new Error(`Object ${ticketId} is not a Ticket`);
    return object;
  }
}
