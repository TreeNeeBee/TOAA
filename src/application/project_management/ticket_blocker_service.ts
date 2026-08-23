import type { ObjectId } from '../../domain/identity/object_id.js';
import type { PersistedDomainObject } from '../../domain/objects/persisted.js';
import { reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { ActorRegistration } from '../../domain/project_management/actor.js';
import { TicketSchema, type Ticket, type WorkTicket } from '../../domain/tickets/ticket.js';
import { createDomainEvent } from '../observability/domain_event_factory.js';
import { TicketCatalog } from './ticket_catalog.js';
import { TicketLifecycleService, releaseCapacityFor } from './ticket_lifecycle_service.js';
import { TicketTraceService } from './ticket_trace_service.js';

type BlockReason = 'defect' | 'quality-gap' | 'dependency';

/** Owns blocker edges, pending transitions, capacity release, and deterministic unblocking. */
export class TicketBlockerService {
  private readonly catalog: TicketCatalog;
  private readonly lifecycle: TicketLifecycleService;
  private readonly traces: TicketTraceService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.catalog = new TicketCatalog(repository);
    this.lifecycle = new TicketLifecycleService(repository);
    this.traces = new TicketTraceService(repository);
  }

  /**
   * Blocks canonical Step work only while that work is still live.
   *
   * A corrective Ticket opened while a Change Request is traversing the V-model can target a Step
   * whose original Story is already closed. That Story is immutable delivery history; the active
   * parent Change Request is the work that must be parked. Corrective Tickets still use `prepare`
   * directly so an invalid attempt to block a terminal Bug, Enhancement, or CR remains an error.
   */
  async prepareWorkIfLive(
    work: WorkTicket,
    blockerId: ObjectId,
    pendingReason: BlockReason,
  ): Promise<PersistedDomainObject[]> {
    if (work.state === 'closed' || work.state === 'cancelled') return [];
    return this.prepare(work, blockerId, pendingReason);
  }

  async prepare(work: Ticket, blockerId: ObjectId, pendingReason: BlockReason): Promise<PersistedDomainObject[]> {
    if (work.state === 'closed' || work.state === 'cancelled') {
      throw new Error(`Cannot block terminal Ticket ${work.name}`);
    }
    const actor = await this.processingActor(work);
    const marker = {
      eventType: 'escalated' as const,
      initiatorActorId: actor.id,
      initiatorRole: actor.role,
      assignmentId: work.activeAssignmentId,
      fromOwnerActorId: actor.id,
      toOwnerActorId: actor.id,
      reasonCode: `ticket.blocked_by_${pendingReason}`,
      reason: `${work.name} is blocked by corrective Ticket ${blockerId}.`,
      evidenceRefs: [blockerId],
      correlationId: work.source.correlationId,
      causationId: blockerId,
    };
    // A resolved Story is delivered source work waiting for its paired verification Step. The
    // corrective Ticket owns the repair, so blocking that Story must not make it executable normal
    // work again. Only work that is actively executing needs a state transition to park it.
    const next = work.state === 'in_progress' ? 'pending' as const : undefined;
    if (next) {
      const prepared = await this.lifecycle.prepareTransition(work, next, {
        pendingReason: next === 'pending' ? pendingReason : undefined,
        beforeTrace: [marker],
      });
      const updated = TicketSchema.parse({
        ...prepared.ticket,
        blockedByTicketIds: [...new Set([...prepared.ticket.blockedByTicketIds, blockerId])],
      });
      return replaceTicket(prepared.objects, updated);
    }
    const built = await this.traces.build(work, [marker]);
    const updated = TicketSchema.parse({
      ...built.ticket,
      blockedByTicketIds: [...new Set([...built.ticket.blockedByTicketIds, blockerId])],
    });
    const released = await releaseCapacityFor(this.repository, work);
    return [
      ...built.events,
      ...(released ? [released] : []),
      updated,
      createDomainEvent({
        projectId: work.projectId,
        aggregate: { id: work.id, objectType: 'ticket' },
        eventType: 'ticket.blocker_added',
        payload: { blockerId, pendingReason },
        phaseId: work.phaseId,
        stepId: work.stepId,
        ticketId: work.id,
        correlationId: work.source.correlationId,
        causationId: blockerId,
        objectRevision: updated.revision,
      }),
    ];
  }

  async release(blocker: Ticket): Promise<void> {
    const blocked = (await this.catalog.list()).filter((ticket) =>
      ticket.blockedByTicketIds.includes(blocker.id));
    for (const ticket of blocked) await this.unblock(ticket, blocker.id);
  }

  /** Drops one blocker from one Ticket, for a blocker that is still open but must not hold it. */
  async releaseFrom(blocked: Ticket, blockerId: ObjectId): Promise<void> {
    if (!blocked.blockedByTicketIds.includes(blockerId)) return;
    await this.unblock(blocked, blockerId);
  }

  private async unblock(blocked: Ticket, blockerId: ObjectId): Promise<void> {
    const blockers = blocked.blockedByTicketIds.filter((id) => id !== blockerId);
    if (blockers.length === 0 && blocked.state === 'pending') {
      const prepared = await this.lifecycle.prepareTransition(blocked, 'in_progress', {
        reasonCode: 'ticket.blocker_cleared',
        reason: `Corrective Ticket ${blockerId} closed; ${blocked.name} can resume.`,
        evidenceRefs: [blockerId],
      });
      const resumed = TicketSchema.parse({ ...prepared.ticket, blockedByTicketIds: blockers });
      await this.repository.commit(replaceTicket(prepared.objects, resumed));
      return;
    }
    const updated = TicketSchema.parse({
      ...blocked,
      ...reviseObjectEnvelope(blocked),
      blockedByTicketIds: blockers,
    });
    await this.repository.commit([updated, createDomainEvent({
      projectId: blocked.projectId,
      aggregate: { id: blocked.id, objectType: 'ticket' },
      eventType: 'ticket.blocker_removed',
      payload: { blockerId, remainingBlockers: blockers.length },
      phaseId: blocked.phaseId,
      stepId: blocked.stepId,
      ticketId: blocked.id,
      correlationId: blocked.source.correlationId,
      causationId: blockerId,
      objectRevision: updated.revision,
    })]);
  }

  private async processingActor(ticket: Ticket): Promise<ActorRegistration> {
    const actorId = ticket.activeAssignmentId
      ? await this.repository.read(ticket.activeAssignmentId).then((assignment) => {
          if (assignment.objectType !== 'ticket-assignment') {
            throw new Error(`Ticket ${ticket.name} has an invalid active assignment`);
          }
          return assignment.assigneeActorId;
        })
      : ticket.creatorActorId;
    const actor = await this.repository.read(actorId);
    if (actor.objectType !== 'actor-registration') {
      throw new Error(`Ticket ${ticket.name} processing actor is not registered`);
    }
    return actor;
  }
}

function replaceTicket(
  objects: readonly PersistedDomainObject[],
  ticket: Ticket,
): PersistedDomainObject[] {
  return objects.map((object) => object.objectType === 'ticket' && object.id === ticket.id ? ticket : object);
}
