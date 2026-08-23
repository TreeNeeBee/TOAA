import type { ObjectId } from '../../domain/identity/object_id.js';
import type { PersistedDomainObject } from '../../domain/objects/persisted.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  TicketSchema,
  transitionTicketPath,
  type Ticket,
  type TicketState,
} from '../../domain/tickets/ticket.js';
import type { PendingReason } from '../../domain/workflow/pending_reason.js';
import {
  reviseActor,
  transitionAssignment,
  type ActorRegistration,
  type TicketAssignment,
  type TicketTraceEventType,
} from '../../domain/project_management/index.js';
import { RoleRegistry } from './role_registry.js';
import { TicketTraceService } from './ticket_trace_service.js';
import { TicketDistillationService } from '../context/ticket_distillation_service.js';
import type { TicketTraceAppendInput } from './ticket_trace_service.js';
import { createDomainEvent } from '../observability/domain_event_factory.js';

export interface TicketTransitionInput {
  initiatorActorId?: ObjectId;
  pendingReason?: PendingReason;
  reasonCode?: string;
  reason?: string;
  evidenceRefs?: string[];
  beforeTrace?: TicketTraceAppendInput[];
}

export interface PreparedTicketTransition {
  ticket: Ticket;
  objects: PersistedDomainObject[];
}

export class TicketLifecycleService {
  private readonly roles: RoleRegistry;
  private readonly traces: TicketTraceService;
  private readonly distillation: TicketDistillationService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.roles = new RoleRegistry(repository);
    this.traces = new TicketTraceService(repository);
    this.distillation = new TicketDistillationService(repository);
  }

  async transition(
    ticketOrId: Ticket | ObjectId,
    next: TicketState,
    input: TicketTransitionInput = {},
  ): Promise<Ticket> {
    return this.transitionPath(ticketOrId, [next], input);
  }

  async transitionPath(
    ticketOrId: Ticket | ObjectId,
    path: readonly TicketState[],
    input: TicketTransitionInput = {},
  ): Promise<Ticket> {
    const prepared = await this.prepareTransitionPath(ticketOrId, path, input);
    // Distilled before the closure commits, not after: if the Step Context write fails, nothing has
    // moved and the caller can retry. Distilling afterwards would leave a closed Ticket whose
    // knowledge was lost with no transition left to re-run.
    if (prepared.ticket.state === 'closed') await this.distillation.distil(prepared.ticket);
    await this.repository.commit(prepared.objects);
    return prepared.ticket;
  }

  async prepareTransition(
    ticketOrId: Ticket | ObjectId,
    next: TicketState,
    input: TicketTransitionInput = {},
  ): Promise<PreparedTicketTransition> {
    return this.prepareTransitionPath(ticketOrId, [next], input);
  }

  async prepareTransitionPath(
    ticketOrId: Ticket | ObjectId,
    path: readonly TicketState[],
    input: TicketTransitionInput = {},
  ): Promise<PreparedTicketTransition> {
    if (path.length === 0) throw new Error('Ticket transition path cannot be empty');
    const ticket = typeof ticketOrId === 'string'
      ? await this.requireTicket(ticketOrId)
      : await this.requireTicket(ticketOrId.id);
    if (!ticket.registeredAt) {
      throw new Error(`Ticket ${ticket.name} must be registered by Project Manager before lifecycle processing`);
    }
    const assignment = ticket.activeAssignmentId
      ? await this.requireAssignment(ticket.activeAssignmentId)
      : undefined;
    // Execution ownership is the invariant: no role may work a Ticket PM has not assigned to it.
    // Administrative transitions PM itself performs — parking, closing, or cancelling work that was
    // resolved through another Ticket — are not execution and must not require an assignee.
    if (path.includes('in_progress') && (!assignment || assignment.state !== 'accepted')) {
      throw new Error(`Ticket ${ticket.name} must have an accepted owner assignment before execution`);
    }
    const initiatorId = input.initiatorActorId ?? assignment?.assigneeActorId ?? ticket.creatorActorId;
    const initiator = await this.roles.require(initiatorId);
    const now = new Date().toISOString();
    const transitioned = transitionTicketPath(ticket, path, {
      pendingReason: input.pendingReason,
      now,
    });
    const finalState = path.at(-1)!;
    const assignmentNext = assignmentStateForTicket(finalState, assignment);
    let fromState = ticket.state;
    const transitionTraces = path.map((toState, index): TicketTraceAppendInput => {
      const isFinal = index === path.length - 1;
      const trace: TicketTraceAppendInput = {
        eventType: traceEventForTransition(fromState, toState),
        initiatorActorId: initiator.id,
        initiatorRole: initiator.role,
        assignmentId: assignment?.id,
        fromOwnerActorId: assignment?.assigneeActorId,
        toOwnerActorId: isFinal && assignmentNext ? undefined : assignment?.assigneeActorId,
        fromTicketState: fromState,
        toTicketState: toState,
        fromAssignmentState: assignment?.state,
        toAssignmentState: isFinal ? assignmentNext : undefined,
        reasonCode: isFinal && input.reasonCode
          ? input.reasonCode
          : `ticket.${fromState}_to_${toState}`,
        reason: isFinal && input.reason
          ? input.reason
          : `Ticket ${ticket.name} transitioned from ${fromState} to ${toState}.`,
        evidenceRefs: input.evidenceRefs,
        correlationId: ticket.source.correlationId,
        causationId: ticket.id,
        occurredAt: now,
      };
      fromState = toState;
      return trace;
    });
    const built = await this.traces.build(ticket, [...(input.beforeTrace ?? []), ...transitionTraces]);
    const updatedTicket = TicketSchema.parse({
      ...transitioned,
      traceFirstEventId: built.ticket.traceFirstEventId,
      traceLastEventId: built.ticket.traceLastEventId,
      traceEventCount: built.ticket.traceEventCount,
      traceChainHash: built.ticket.traceChainHash,
      activeAssignmentId: assignmentNext ? undefined : transitioned.activeAssignmentId,
    });
    const objects: PersistedDomainObject[] = [...built.events];
    if (assignment && assignmentNext) {
      objects.push(transitionAssignment(assignment, assignmentNext, now));
    }
    if (assignment?.capacityConsumed) {
      const owner = await this.roles.require(assignment.assigneeActorId);
      const reconciled = reconcileActorCapacity(owner, assignment.id, finalState);
      if (reconciled) objects.push(reconciled);
    }
    objects.push(updatedTicket, createDomainEvent({
      projectId: ticket.projectId,
      aggregate: { id: ticket.id, objectType: 'ticket' },
      eventType: `ticket.${finalState}`,
      payload: {
        ticketType: ticket.type,
        fromState: ticket.state,
        toState: finalState,
        transitionPath: path,
        ownerActorId: assignment?.assigneeActorId,
        reasonCode: input.reasonCode,
      },
      phaseId: ticket.phaseId,
      stepId: ticket.stepId,
      ticketId: ticket.id,
      correlationId: ticket.source.correlationId,
      causationId: ticket.id,
      objectRevision: updatedTicket.revision,
      now,
    }));
    return { ticket: updatedTicket, objects };
  }

  private async requireTicket(id: ObjectId): Promise<Ticket> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'ticket') throw new Error(`Object ${id} is not a Ticket`);
    return object;
  }

  private async requireAssignment(id: ObjectId): Promise<TicketAssignment> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'ticket-assignment') throw new Error(`Object ${id} is not a Ticket Assignment`);
    return object;
  }
}

function traceEventForTransition(from: TicketState, to: TicketState): TicketTraceEventType {
  if (to === 'in_progress') return from === 'pending' || from === 'reopened' ? 'resumed' : 'started';
  if (to === 'pending') return 'pending';
  if (to === 'resolved') return 'resolved';
  if (to === 'closed') return 'closed';
  if (to === 'reopened') return 'reopened';
  if (to === 'cancelled') return 'cancelled';
  return 'correction';
}

/**
 * Actor capacity models work the assignee is carrying, not lifetime ownership.
 *
 * Capacity is reserved when an assignment is accepted (see TicketRegistrationService) and released
 * as soon as the work leaves `in_progress`. It is deliberately *not* held for `resolved`,
 * `reopened`, or `pending`: a source-Step Story stays open until its paired verification closes it.
 * A resolved Story blocked by corrective work remains resolved; the Bug or Enhancement owns the
 * repair and must not turn that Story back into schedulable normal work. Holding capacity there
 * would let one V-model Phase exhaust a single-capacity role and deadlock the corrective Ticket.
 * Assignment ownership is unaffected: `activeAssignmentId` survives the release, so resumed work
 * returns to the same actor.
 *
 * Routing reserves capacity at assignment time, while the Ticket is still `created`, so that a
 * single-capacity actor cannot be double-booked before its work starts. Blocking such a Ticket
 * records a blocker without a state transition, so `releaseCapacityFor` below is what reconciles
 * the reservation in that case; a resumed Ticket re-reserves on its `in_progress` transition, and
 * cannot overcommit because routing re-checked capacity excluding its own assignment.
 */
function holdsCapacity(state: TicketState): boolean {
  return state === 'in_progress';
}

/**
 * Releases the reservation of a Ticket parked without a state transition.
 *
 * Returns the revised actor, or undefined when there is nothing to release — no assignment, an
 * inherited assignment that consumed no capacity, or a reservation already gone.
 */
export async function releaseCapacityFor(
  repository: DomainObjectRepositoryPort,
  ticket: Ticket,
): Promise<ActorRegistration | undefined> {
  if (!ticket.activeAssignmentId) return undefined;
  const assignment = await repository.read(ticket.activeAssignmentId);
  if (assignment.objectType !== 'ticket-assignment' || !assignment.capacityConsumed) return undefined;
  const owner = await repository.read(assignment.assigneeActorId);
  if (owner.objectType !== 'actor-registration') return undefined;
  return reconcileActorCapacity(owner, assignment.id, ticket.state);
}

function reconcileActorCapacity(
  owner: ActorRegistration,
  assignmentId: ObjectId,
  ticketState: TicketState,
): ActorRegistration | undefined {
  const held = owner.activeAssignmentIds.includes(assignmentId);
  const shouldHold = holdsCapacity(ticketState);
  if (held === shouldHold) return undefined;
  return reviseActor(owner, {
    activeAssignmentIds: shouldHold
      ? [...owner.activeAssignmentIds, assignmentId]
      : owner.activeAssignmentIds.filter((id) => id !== assignmentId),
  });
}

function assignmentStateForTicket(
  next: TicketState,
  assignment: TicketAssignment | undefined,
): 'completed' | 'cancelled' | undefined {
  if (!assignment || assignment.state !== 'accepted') return undefined;
  if (next === 'closed') return 'completed';
  if (next === 'cancelled') return 'cancelled';
  return undefined;
}
