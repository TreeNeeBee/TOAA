import type { Changelist } from '../../domain/evidence/evidence.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { VERIFICATION_STEP_TYPES, type Step } from '../../domain/steps/step.js';
import type {
  BugTicket,
  ChangeRequestTicket,
  EnhancementTicket,
  Ticket,
  TicketSolution,
  WorkTicket,
} from '../../domain/tickets/ticket.js';
import type { AttemptFailure } from '../execution/failure_classification.js';
import { ProjectStateService } from './project_state_service.js';
import type { ScheduledWork } from './work_scheduler.js';
import { TicketWorkflow } from './ticket_workflow.js';

export class CorrectiveWorkflowService {
  private readonly tickets: TicketWorkflow;
  private readonly state: ProjectStateService;

  constructor(repository: DomainObjectRepositoryPort) {
    this.tickets = new TicketWorkflow(repository);
    this.state = new ProjectStateService(repository);
  }

  async routeFailure(input: {
    failedStepId: ObjectId;
    message: string;
    summary: string;
    failure: AttemptFailure;
    rawEvidenceRef?: string;
    tool?: string;
    exitCode?: number;
    statusCode?: number;
    correlationId: ObjectId;
    causationId?: ObjectId;
    parentChangeRequestId?: ObjectId;
    creatorActorId: ObjectId;
  }): Promise<BugTicket> {
    let failed = await this.state.requireStep(input.failedStepId);
    if (!failed.pairedStepId) throw new Error(`Failure routing requires a paired Step: ${failed.name}`);
    let target = isVerificationStep(failed)
      ? await this.state.requireStep(failed.pairedStepId)
      : failed;
    const verification = isVerificationStep(failed)
      ? failed
      : await this.state.requireStep(failed.pairedStepId);
    failed = await this.state.moveStepPending(failed, 'defect');
    if (target.id !== failed.id && (target.state === 'delivered' || target.state === 'closed')) {
      target = await this.state.transitionStep(target, 'reopened');
    }
    const bug = await this.tickets.openBug({
      creatorActorId: input.creatorActorId,
      failedStep: failed,
      targetStep: target,
      verificationStep: verification,
      kind: 'test-failure',
      severity: 'high',
      message: input.message,
      summary: input.summary,
      category: input.failure.category,
      code: input.failure.code,
      retryable: input.failure.retryable,
      switchProvider: input.failure.switchProvider,
      details: input.failure.details,
      rawEvidenceRef: input.rawEvidenceRef,
      tool: input.tool,
      exitCode: input.exitCode,
      statusCode: input.statusCode,
      correlationId: input.correlationId,
      causationId: input.causationId,
      parentChangeRequestId: input.parentChangeRequestId,
    });
    await this.state.checkpoint(failed, `Failure routed to ${target.name} through ${bug.name}`);
    await this.state.checkpoint(target, `Reopened by ${bug.name}`);
    return bug;
  }

  async routeQualityGap(input: {
    sourceStepId: ObjectId;
    finding: string;
    kind: EnhancementTicket['enhancementKind'];
    qualityAssessmentId?: ObjectId;
    correlationId: ObjectId;
    causationId?: ObjectId;
    parentChangeRequestId?: ObjectId;
    creatorActorId: ObjectId;
  }): Promise<EnhancementTicket> {
    let source = await this.state.requireStep(input.sourceStepId);
    if (!source.pairedStepId) throw new Error(`Quality routing requires a paired Step: ${source.name}`);
    const target = isVerificationStep(source)
      ? await this.state.requireStep(source.pairedStepId)
      : source;
    const verification = isVerificationStep(source)
      ? source
      : await this.state.requireStep(source.pairedStepId);
    source = await this.state.moveStepPending(source, 'quality-gap');
    let reopenedTarget = target;
    if (target.id !== source.id && (target.state === 'delivered' || target.state === 'closed')) {
      reopenedTarget = await this.state.transitionStep(target, 'reopened');
    }
    const enhancement = await this.tickets.openEnhancement({
      creatorActorId: input.creatorActorId,
      sourceStep: source,
      targetStep: reopenedTarget,
      verificationStep: verification,
      kind: input.kind,
      finding: input.finding,
      sourceQualityAssessmentId: input.qualityAssessmentId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      parentChangeRequestId: input.parentChangeRequestId,
    });
    await this.state.checkpoint(source, `Quality gap routed to ${reopenedTarget.name} through ${enhancement.name}`);
    return enhancement;
  }

  async propagateCorrectiveChange(input: {
    work: ScheduledWork;
    qualityAssessmentId: ObjectId;
    solution: TicketSolution;
    affectedStepIds: ObjectId[];
    contractDelta: ChangeRequestTicket['contractDelta'];
    implementationPlan: string[];
    verificationGate: string[];
    debugWikiCandidateEntryIds?: string[];
    parentChangeRequestId?: ObjectId;
    sourceChange: {
      summary: string;
      entries: Changelist['entries'];
      commit?: string;
      verification: string[];
    };
  }): Promise<ChangeRequestTicket> {
    if (input.work.ticket.type !== 'bug' && input.work.ticket.type !== 'enhancement') {
      throw new Error('propagateCorrectiveChange requires a Bug or Enhancement');
    }
    let step = await this.state.requireStep(input.work.step.id);
    await this.state.requirePassingQualityAssessment(step, input.qualityAssessmentId);
    step = await this.state.attachQuality(step, input.qualityAssessmentId);
    if (step.state === 'pending' || step.state === 'reopened' || step.state === 'created') {
      step = await this.state.transitionStep(step, 'in_progress');
    }
    if (step.state === 'in_progress') step = await this.state.transitionStep(step, 'delivered');
    const solution = { ...input.solution, status: 'proposed' as const };
    if (input.work.ticket.type === 'bug') {
      await this.tickets.setDebugWikiCandidates(
        input.work.ticket.id,
        input.debugWikiCandidateEntryIds ?? [],
      );
    }
    await this.tickets.recordChange({
      ticketId: input.work.ticket.id,
      stepId: step.id,
      summary: input.sourceChange.summary,
      entries: input.sourceChange.entries,
      commit: input.sourceChange.commit,
      verification: input.sourceChange.verification,
      verificationAssessmentId: input.qualityAssessmentId,
    });
    await this.tickets.setSolution(input.work.ticket.id, solution);
    const request = await this.tickets.openChangeRequest({
      creatorActorId: await this.state.ticketOwnerActorId(input.work.ticket.id),
      sourceTicketId: input.work.ticket.id,
      triggerStepId: input.work.ticket.stepId ?? step.id,
      sourceStepId: step.id,
      affectedStepIds: [...new Set(input.affectedStepIds)],
      contractDelta: input.contractDelta,
      implementationPlan: input.implementationPlan,
      verificationGate: input.verificationGate,
      parentChangeRequestId: input.parentChangeRequestId,
    });
    await this.activateChangeRequest(request.id);
    await this.state.checkpoint(step, `Corrective solution propagated through ${request.name}`);
    return request;
  }

  async completeChangeRequestStep(input: {
    work: ScheduledWork;
    qualityAssessmentId: ObjectId;
    summary: string;
    entries: Changelist['entries'];
    commit?: string;
    verification?: string[];
  }): Promise<{ closed: boolean; sourceTicketId?: ObjectId; sourceTicketType?: 'bug' | 'enhancement' }> {
    if (input.work.ticket.type !== 'change-request') {
      throw new Error('completeChangeRequestStep requires a Change Request');
    }
    let step = await this.state.requireStep(input.work.step.id);
    await this.state.requirePassingQualityAssessment(step, input.qualityAssessmentId);
    step = await this.state.attachQuality(step, input.qualityAssessmentId);
    if (step.state === 'in_progress') step = await this.state.transitionStep(step, 'delivered');
    if (isVerificationStep(step)) {
      step = await this.state.transitionStep(step, 'closed');
      if (!step.pairedStepId) throw new Error(`Verification Step ${step.name} has no paired source Step`);
      let source = await this.state.requireStep(step.pairedStepId);
      if (source.state === 'delivered') {
        source = await this.state.transitionStep(source, 'closed');
        await this.state.checkpoint(source, `Closed by CR verification ${step.name}`);
        await this.closeStoriesForClosedSteps([source.id]);
      }
    }
    await this.tickets.recordChange({
      ticketId: input.work.ticket.id,
      stepId: step.id,
      summary: input.summary,
      entries: input.entries,
      commit: input.commit,
      verification: input.verification,
      verificationAssessmentId: input.qualityAssessmentId,
    });
    const request = await this.state.requireTicket(input.work.ticket.id);
    if (request.type !== 'change-request') throw new Error('Change Request type changed while applying it');
    const applied = new Set(request.applications.map((application) => application.stepId));
    if (!request.affectedStepIds.every((id) => applied.has(id))) return { closed: false };
    const sourceTicket = await this.state.requireTicket(request.sourceTicketId);
    if (sourceTicket.type !== 'bug' && sourceTicket.type !== 'enhancement') {
      throw new Error(`Change Request ${request.name} has invalid source Ticket ${sourceTicket.name}`);
    }
    await this.tickets.setSolution(request.id, {
      status: 'verified',
      approach: request.solution?.approach ?? request.implementationPlan.join('\n'),
      rationale: request.solution?.rationale ?? request.contractDelta.summary,
      changes: request.solution?.changes ?? request.contractDelta.affectedArtifacts,
      verification: [...request.verificationGate, ...(input.verification ?? [])],
      updatedAt: new Date().toISOString(),
    });
    await this.tickets.closeVerified(request.id);
    if (request.parentChangeRequestId) await this.activateChangeRequest(request.parentChangeRequestId);
    await this.closeStoriesForClosedSteps([request.sourceStepId, ...request.affectedStepIds]);
    return {
      closed: true,
      sourceTicketId: request.sourceTicketId,
      sourceTicketType: sourceTicket.type,
    };
  }

  async activateChangeRequest(ticketId: ObjectId): Promise<ChangeRequestTicket> {
    const ticket = await this.state.requireTicket(ticketId);
    if (ticket.type !== 'change-request') throw new Error(`Ticket ${ticketId} is not a Change Request`);
    if (ticket.state === 'closed' || ticket.state === 'cancelled') return ticket;
    const applied = new Set(ticket.applications.map((application) => application.stepId));
    for (const stepId of ticket.affectedStepIds.filter((id) => !applied.has(id))) {
      let step = await this.state.requireStep(stepId);
      if (step.state === 'closed' || step.state === 'delivered') {
        step = await this.state.transitionStep(step, 'reopened');
        await this.state.checkpoint(step, `Reopened for incremental ${ticket.name}`);
      }
    }
    return ticket;
  }

  private async closeStoriesForClosedSteps(stepIds: readonly ObjectId[]): Promise<void> {
    for (const stepId of stepIds) {
      const step = await this.state.requireStep(stepId);
      if (step.state !== 'closed') continue;
      let story = await this.tickets.storyForStep(step.id);
      if (story.blockedByTicketIds.length > 0) continue;
      await this.completeTasks(story);
      const path = ticketClosurePath(story);
      if (path.length > 0) {
        story = await this.state.transitionTicketPath(story, path) as WorkTicket;
      }
    }
  }

  private async completeTasks(story: Ticket): Promise<void> {
    const descendants = (await this.ticketDescendants(story.id)).reverse();
    for (const task of descendants) {
      const path = ticketClosurePath(task);
      if (path.length > 0) await this.state.transitionTicketPath(task, path);
    }
  }

  private async ticketDescendants(parentId: ObjectId): Promise<Ticket[]> {
    const tickets = await this.tickets.list();
    const descendants: Ticket[] = [];
    const queue = [parentId];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      const children = tickets.filter((ticket) => ticket.parentTicketId === parent && ticket.type === 'task');
      descendants.push(...children);
      queue.push(...children.map((ticket) => ticket.id));
    }
    return descendants;
  }
}

function ticketClosurePath(ticket: Ticket): Array<'in_progress' | 'resolved' | 'closed'> {
  if (ticket.state === 'closed' || ticket.state === 'cancelled') return [];
  if (ticket.state === 'created' || ticket.state === 'pending' || ticket.state === 'reopened') {
    return ['in_progress', 'resolved', 'closed'];
  }
  if (ticket.state === 'in_progress') return ['resolved', 'closed'];
  return ['closed'];
}

function isVerificationStep(step: Step): boolean {
  return (VERIFICATION_STEP_TYPES as readonly string[]).includes(step.type);
}
