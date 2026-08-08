import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { Ticket } from '../../domain/tickets/ticket.js';
import type { ContextRecord } from '../../domain/context/context_record.js';
import { ContextService } from './context_service.js';

/**
 * Carries what a closing Ticket learned into the Context of the Step it belonged to.
 *
 * Invariant 34 splits knowledge by Ticket type: ordinary Tickets distil here, Bugs distil to the
 * Debug Wiki. The split matters because the two are read at different times — Step Context is
 * loaded for every attempt on that Step, while a Bug's history is only worth loading when something
 * is being debugged. Mixing them would put defect transcripts in front of every role that touches
 * the Step.
 *
 * Failed and cancelled Tickets do not distil: their record is that the approach did not work, which
 * belongs to the trace, not to the knowledge the next attempt is handed as established.
 */
export class TicketDistillationService {
  private readonly context: ContextService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.context = new ContextService(repository);
  }

  /**
   * Distils `ticket` if it qualifies, and returns whether anything was written.
   *
   * Idempotent: every entry is tagged with the Ticket name and an already-tagged Step Context is
   * left alone, so a retried closure cannot append the same knowledge twice.
   */
  async distil(ticket: Ticket): Promise<boolean> {
    if (!this.qualifies(ticket)) return false;
    const stepId = ticket.stepId;
    if (!stepId) return false;

    const tag = `[${ticket.name}]`;
    let record = await this.context.ensure(ticket.projectId, 'step', stepId);
    if (alreadyDistilled(record, tag)) return false;

    const actorId = await this.distillingActorId(ticket);
    for (const finding of findings(ticket, tag)) {
      record = await this.context.apply(ticket.projectId, {
        scope: 'step',
        ownerId: stepId,
        expectedRevision: record.revision,
        operation: 'append-finding',
        actorId,
        text: finding,
      });
    }
    const change = ticket.solution?.approach ?? ticket.description;
    for (const artifact of ticket.solution?.changes ?? []) {
      record = await this.context.apply(ticket.projectId, {
        scope: 'step',
        ownerId: stepId,
        expectedRevision: record.revision,
        operation: 'add-artifact',
        actorId,
        path: artifact,
        text: `${tag} ${change}`,
      });
    }
    return true;
  }

  private qualifies(ticket: Ticket): boolean {
    if (ticket.type === 'bug') return false;
    // An Epic spans a Phase rather than a Step, so it has no Step Context to distil into.
    if (ticket.type === 'epic') return false;
    return ticket.state === 'closed';
  }

  /** The actor whose work this is: its assignee, or the creator when it closed unassigned. */
  private async distillingActorId(ticket: Ticket): Promise<ObjectId> {
    if (!ticket.activeAssignmentId) return ticket.creatorActorId;
    const assignment = await this.repository.read(ticket.activeAssignmentId);
    return assignment.objectType === 'ticket-assignment'
      ? assignment.assigneeActorId
      : ticket.creatorActorId;
  }
}

function alreadyDistilled(record: ContextRecord, tag: string): boolean {
  return record.findings.some((finding) => finding.text.startsWith(tag));
}

function findings(ticket: Ticket, tag: string): string[] {
  const solution = ticket.solution;
  if (!solution || solution.status === 'rejected') {
    // Nothing was recorded about how the work was done, so the only durable fact is that this
    // Ticket's scope is now covered — enough to stop a later attempt redoing it.
    return [`${tag} delivered: ${ticket.description}`];
  }
  const entries = [`${tag} ${solution.approach} — ${solution.rationale}`];
  if (solution.verification.length > 0) {
    entries.push(`${tag} verified by: ${solution.verification.join('; ')}`);
  }
  return entries;
}
