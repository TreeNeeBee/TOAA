import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { Ticket } from '../../domain/tickets/ticket.js';
import type { TicketTraceEvent } from '../../domain/project_management/index.js';
import { TicketTraceService } from './ticket_trace_service.js';

export interface TicketFlowMetrics {
  ticketCount: number;
  routedTicketCount: number;
  resolvedTicketCount: number;
  averageRoutingLatencyMs?: number;
  maximumRoutingLatencyMs?: number;
  averageResolutionCycleMs?: number;
  totalHandoffs: number;
  totalReopens: number;
  totalEscalations: number;
  stalledTicketIds: ObjectId[];
}

export class TicketFlowMetricsService {
  private readonly traces: TicketTraceService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.traces = new TicketTraceService(repository);
  }

  async calculate(projectId: ObjectId): Promise<TicketFlowMetrics> {
    const objects = await this.repository.list({ objectType: 'ticket', projectId });
    const tickets = objects.filter((object): object is Ticket => object.objectType === 'ticket');
    const routingLatencies: number[] = [];
    const resolutionCycles: number[] = [];
    let totalHandoffs = 0;
    let totalReopens = 0;
    let totalEscalations = 0;
    let routedTicketCount = 0;
    let resolvedTicketCount = 0;
    const stalledTicketIds: ObjectId[] = [];

    for (const ticket of tickets) {
      const events = await this.traces.list(ticket.id);
      const routed = first(events, 'routed');
      const started = first(events, 'started');
      const resolved = first(events, 'resolved');
      if (routed) {
        routedTicketCount += 1;
        routingLatencies.push(elapsed(ticket.submittedAt, routed.occurredAt));
      }
      if (started && resolved) {
        resolvedTicketCount += 1;
        resolutionCycles.push(elapsed(started.occurredAt, resolved.occurredAt));
      }
      totalHandoffs += count(events, 'handed_off') + count(events, 'reassigned');
      totalReopens += count(events, 'reopened');
      totalEscalations += count(events, 'escalated');
      if (
        (ticket.state === 'pending' || ticket.state === 'in_progress') &&
        Date.now() - Date.parse(ticket.updatedAt) > 24 * 60 * 60 * 1_000
      ) {
        stalledTicketIds.push(ticket.id);
      }
    }

    return {
      ticketCount: tickets.length,
      routedTicketCount,
      resolvedTicketCount,
      averageRoutingLatencyMs: average(routingLatencies),
      maximumRoutingLatencyMs: routingLatencies.length > 0 ? Math.max(...routingLatencies) : undefined,
      averageResolutionCycleMs: average(resolutionCycles),
      totalHandoffs,
      totalReopens,
      totalEscalations,
      stalledTicketIds,
    };
  }
}

function first(
  events: readonly TicketTraceEvent[],
  eventType: TicketTraceEvent['eventType'],
): TicketTraceEvent | undefined {
  return events.find((event) => event.eventType === eventType);
}

function count(events: readonly TicketTraceEvent[], eventType: TicketTraceEvent['eventType']): number {
  return events.filter((event) => event.eventType === eventType).length;
}

function elapsed(from: string, to: string): number {
  return Math.max(0, Date.parse(to) - Date.parse(from));
}

function average(values: readonly number[]): number | undefined {
  return values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : undefined;
}
