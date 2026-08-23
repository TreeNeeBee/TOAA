import { buildDebugBrief } from '../../core/debug_brief.js';
import type { DebugWiki } from '../../core/debug_wiki.js';
import { reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { TicketSchema, type BugTicket } from '../../domain/tickets/ticket.js';
import { executionPhaseFor } from './execution_adapter.js';

/** Persists only verified Bug solutions into the project Debug Wiki. */
export class VerifiedBugKnowledgeService {
  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    private readonly wiki: DebugWiki,
    private readonly language: 'python' | 'typescript',
  ) {}

  async synchronize(projectId: BugTicket['projectId']): Promise<void> {
    const tickets = await this.repository.list({ objectType: 'ticket', projectId });
    for (const ticket of tickets) {
      if (ticket.objectType === 'ticket' && ticket.type === 'bug' && ticket.state === 'closed' &&
          ticket.solution?.status === 'verified' && ticket.debugWikiResolutionEntryIds.length === 0) {
        await this.record(ticket.id);
      }
    }
  }

  async record(ticketId: BugTicket['id']): Promise<void> {
    const object = await this.repository.read(ticketId);
    if (object.objectType !== 'ticket' || object.type !== 'bug') {
      throw new Error(`Ticket ${ticketId} is not a Bug`);
    }
    if (object.state !== 'closed' || object.solution?.status !== 'verified') {
      throw new Error(`Bug ${object.name} must be closed with a verified solution before debug-wiki persistence`);
    }
    if (object.debugWikiResolutionEntryIds.length > 0) return;
    const target = await this.repository.read(object.failure.targetStepId);
    if (target.objectType !== 'step') {
      throw new Error(`Bug ${object.name} target ${object.failure.targetStepId} is not a Step`);
    }
    const assessment = target.qualityAssessmentId
      ? await this.repository.read(target.qualityAssessmentId)
      : undefined;
    const phase = executionPhaseFor(target.type);
    const persisted = await this.wiki.recordResolution({
      brief: buildDebugBrief({
        reason: object.failure.summary,
        failureLog: object.failure.message,
        phase,
        targetPhase: phase,
        typedFailure: object.failure,
      }),
      ticketId: object.id,
      stepId: target.id,
      phase,
      targetPhase: phase,
      language: this.language,
      resolutionPlan: object.solution.approach,
      solution: object.solution.approach,
      evidence: [
        ...object.solution.verification,
        ...(assessment?.objectType === 'quality-assessment' ? assessment.evidence : []),
      ],
      repairFiles: object.solution.changes.filter((item) => !item.startsWith('commit:')),
      usedEntryIds: object.debugWikiCandidateEntryIds,
    });
    const entryIds = persisted.created ? [persisted.created] : persisted.updated;
    await this.repository.update(TicketSchema.parse({
      ...object,
      ...reviseObjectEnvelope(object),
      debugWikiResolutionEntryIds: entryIds,
    }), object.state);
  }
}
