import { createObjectEnvelope, reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { TicketSchema, type Ticket, type TicketState } from '../../domain/tickets/ticket.js';
import type { DomainRole } from '../../domain/workflow/role.js';
import {
  TicketTraceEventSchema,
  hashTicketTraceEvent,
  verifyTicketTrace,
  type AssignmentState,
  type TicketTraceEvent,
  type TicketTraceEventType,
} from '../../domain/project_management/index.js';

export interface TicketTraceAppendInput {
  eventType: TicketTraceEventType;
  initiatorActorId: ObjectId;
  initiatorRole: DomainRole;
  assignmentId?: ObjectId;
  fromOwnerActorId?: ObjectId;
  toOwnerActorId?: ObjectId;
  fromTicketState?: TicketState;
  toTicketState?: TicketState;
  fromAssignmentState?: AssignmentState;
  toAssignmentState?: AssignmentState;
  reasonCode: string;
  reason: string;
  evidenceRefs?: string[];
  correlationId: ObjectId;
  causationId?: ObjectId;
  correctionOfEventId?: ObjectId;
  occurredAt?: string;
}

export interface BuiltTicketTrace {
  ticket: Ticket;
  events: TicketTraceEvent[];
}

export class TicketTraceService {
  constructor(private readonly repository: DomainObjectRepositoryPort) {}

  async list(ticketId: ObjectId): Promise<TicketTraceEvent[]> {
    const objects = await this.repository.list({ objectType: 'ticket-trace-event' });
    const events = objects.filter(
      (object): object is TicketTraceEvent =>
        object.objectType === 'ticket-trace-event' && object.ticketId === ticketId,
    ).sort((left, right) => left.sequence - right.sequence);
    verifyTicketTrace(events);
    return events;
  }

  async append(ticketId: ObjectId, inputs: readonly TicketTraceAppendInput[]): Promise<Ticket> {
    const object = await this.repository.read(ticketId);
    if (object.objectType !== 'ticket') throw new Error(`Object ${ticketId} is not a Ticket`);
    const built = await this.build(object, inputs);
    await this.repository.commit([...built.events, built.ticket]);
    return built.ticket;
  }

  async build(ticket: Ticket, inputs: readonly TicketTraceAppendInput[]): Promise<BuiltTicketTrace> {
    if (inputs.length === 0) return { ticket, events: [] };
    const existing = await this.list(ticket.id);
    let previous = existing.at(-1);
    const events: TicketTraceEvent[] = [];
    for (const input of inputs) {
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const envelope = createObjectEnvelope({
        name: `${ticket.name}-TRACE-${String((previous?.sequence ?? 0) + 1).padStart(4, '0')}`,
        objectType: 'ticket-trace-event',
        projectId: ticket.projectId,
        now: occurredAt,
      });
      const hashInput = {
        ...envelope,
        ticketId: ticket.id,
        phaseId: ticket.phaseId,
        stepId: ticket.stepId,
        assignmentId: input.assignmentId,
        sequence: (previous?.sequence ?? 0) + 1,
        eventType: input.eventType,
        initiatorActorId: input.initiatorActorId,
        initiatorRole: input.initiatorRole,
        fromOwnerActorId: input.fromOwnerActorId,
        toOwnerActorId: input.toOwnerActorId,
        fromTicketState: input.fromTicketState,
        toTicketState: input.toTicketState,
        fromAssignmentState: input.fromAssignmentState,
        toAssignmentState: input.toAssignmentState,
        reasonCode: input.reasonCode,
        reason: input.reason,
        evidenceRefs: input.evidenceRefs ?? [],
        correlationId: input.correlationId,
        causationId: input.causationId,
        correctionOfEventId: input.correctionOfEventId,
        previousEventId: previous?.id,
        previousEventHash: previous?.eventHash,
        occurredAt,
      };
      const event = TicketTraceEventSchema.parse({
        ...hashInput,
        eventHash: hashTicketTraceEvent(hashInput),
      });
      events.push(event);
      previous = event;
    }
    const first = existing[0] ?? events[0];
    const last = events.at(-1)!;
    const updated = TicketSchema.parse({
      ...ticket,
      ...reviseObjectEnvelope(ticket),
      traceFirstEventId: first?.id,
      traceLastEventId: last.id,
      traceEventCount: existing.length + events.length,
      traceChainHash: last.eventHash,
    });
    return { ticket: updated, events };
  }
}
