import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { Project } from '../../domain/projects/project.js';
import type { Ticket } from '../../domain/tickets/ticket.js';
import type {
  ToolPermissionDecision,
  ToolPermissionRequest,
  ToolPermissionRequester,
} from '../../tools/types.js';
import { GovernanceService } from './governance_service.js';

export type PermissionStatus = 'requested' | 'approved' | 'denied';

export class ProjectPermissionService {
  private readonly governance: GovernanceService;

  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    private readonly project: Project,
  ) {
    this.governance = new GovernanceService(repository);
  }

  async request(
    request: ToolPermissionRequest,
    authorize: ToolPermissionRequester,
    onStatus?: (status: PermissionStatus) => void | Promise<void>,
  ): Promise<ToolPermissionDecision> {
    const relatedTicket = await this.relatedTicket(request.stepId);
    const interaction = await this.governance.requestInteraction({
      projectId: this.project.id,
      requestedByActorId: this.project.pmActorId,
      interactionType: 'permission',
      prompt: `${request.operationType}: ${request.target}\n${request.reason}`,
      choices: ['approve', 'deny'],
      risk: request.risk,
      relatedTicketId: relatedTicket?.id,
      correlationId: relatedTicket?.source.correlationId ?? this.project.id,
    });
    await onStatus?.('requested');
    const decision = await authorize(request);
    await this.governance.answerInteraction(
      interaction.id,
      decision.approved ? 'approved' : `denied${decision.reason ? `: ${decision.reason}` : ''}`,
    );
    await this.governance.recordDecision({
      projectId: this.project.id,
      decisionType: 'permission',
      decidedByActorId: this.project.pmActorId,
      authority: 'user',
      options: ['approve', 'deny'],
      selected: decision.approved ? 'approve' : 'deny',
      rationale: decision.reason ?? (decision.approved ? request.reason : request.denyBehavior),
      confidence: 1,
      evidenceRefs: [interaction.id, ...(relatedTicket ? [relatedTicket.id] : [])],
      correlationId: relatedTicket?.source.correlationId ?? this.project.id,
      causationId: interaction.id,
    });
    await onStatus?.(decision.approved ? 'approved' : 'denied');
    return decision;
  }

  private async relatedTicket(stepId?: string): Promise<Ticket | undefined> {
    if (!stepId) return undefined;
    const tickets = await this.repository.list({ objectType: 'ticket', projectId: this.project.id });
    return tickets.find((candidate): candidate is Ticket =>
      candidate.objectType === 'ticket' &&
      candidate.stepId === stepId as ObjectId &&
      candidate.state !== 'closed' &&
      candidate.state !== 'cancelled',
    );
  }
}
