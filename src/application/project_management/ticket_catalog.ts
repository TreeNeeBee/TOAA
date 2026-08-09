import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { Ticket, WorkTicket } from '../../domain/tickets/ticket.js';

/** Read-only Ticket lookup and deterministic human-readable naming. */
export class TicketCatalog {
  constructor(private readonly repository: DomainObjectRepositoryPort) {}

  async list(): Promise<Ticket[]> {
    const tickets: Ticket[] = [];
    for (const entry of this.repository.registry.byType('ticket')) {
      const object = await this.repository.read(entry.id);
      if (object.objectType === 'ticket') tickets.push(object);
    }
    return tickets;
  }

  async require(id: ObjectId): Promise<Ticket> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'ticket') throw new Error(`Object ${id} is not a Ticket`);
    return object;
  }

  async storyForStep(stepId: ObjectId): Promise<WorkTicket> {
    const story = (await this.list()).find(
      (ticket): ticket is WorkTicket => ticket.type === 'story' &&
        ticket.workKind === 'v-model-step' && ticket.stepId === stepId,
    );
    if (!story) throw new Error(`V-model Story not found for Step ${stepId}`);
    return story;
  }

  nextName(prefix: string, phaseName: string): string {
    const expression = new RegExp(`^${escapeRegExp(prefix)}-${escapeRegExp(phaseName)}-(\\d+)$`, 'u');
    const used = this.repository.registry.byType('ticket').map((entry) => {
      const match = expression.exec(entry.name);
      return match ? Number.parseInt(match[1]!, 10) : 0;
    });
    return `${prefix}-${phaseName}-${String(Math.max(0, ...used) + 1).padStart(3, '0')}`;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
