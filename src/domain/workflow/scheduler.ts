import { createHash } from 'node:crypto';
import type { ObjectId } from '../identity/object_id.js';
import { createObjectEnvelope, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { CheckpointSchema, type Checkpoint } from '../evidence/evidence.js';
import { transitionPhase, type Phase } from '../phases/phase.js';
import { ProjectSchema, transitionProject, type Project } from '../projects/project.js';
import {
  STEP_TYPE_ORDER,
  StepSchema,
  VERIFICATION_STEP_TYPES,
  transitionStep,
  type Step,
} from '../steps/step.js';
import {
  isActiveTicket,
  TicketSchema,
  transitionTicket,
  type BugTicket,
  type ChangeRequestTicket,
  type EnhancementTicket,
  type Ticket,
  type TicketSolution,
  type WorkTicket,
} from '../tickets/ticket.js';
import type { Changelist } from '../evidence/evidence.js';
import { TicketWorkflow } from '../tickets/workflow.js';
import type { DomainObjectRepository } from '../../infrastructure/repository/domain_object_repository.js';
import { ProjectPlanSchema } from '../planning/plan.js';
import { evaluateAttemptExtension } from '../tickets/retry_policy.js';

export type WorkMode = 'normal' | 'debug' | 'enhancement' | 'change-request';

export interface ScheduledWork {
  phase: Phase;
  step: Step;
  ticket: Ticket;
  mode: WorkMode;
}

export class DomainScheduler {
  private readonly tickets: TicketWorkflow;

  constructor(private readonly repository: DomainObjectRepository) {
    this.tickets = new TicketWorkflow(repository);
  }

  async next(phaseId: ObjectId): Promise<ScheduledWork | undefined> {
    const phase = await this.requirePhase(phaseId);
    const steps = await this.phaseSteps(phase);
    const tickets = await this.tickets.list();
    for (const step of steps) {
      if (step.state === 'closed') continue;
      if (!(await this.stepDependenciesReady(step))) continue;
      const corrective = activeCorrectiveTicket(step, tickets);
      if (corrective && await this.ticketDependenciesReady(corrective, tickets)) {
        return { phase, step, ticket: corrective, mode: modeFor(corrective) };
      }
      const story = tickets.find(
        (ticket): ticket is WorkTicket =>
          ticket.type === 'story' &&
          ticket.workKind === 'v-model-step' &&
          ticket.stepId === step.id,
      );
      if (
        story &&
        (story.state === 'created' || story.state === 'reopened' || story.state === 'in_progress') &&
        story.blockedByTicketIds.length === 0 &&
        await this.ticketDependenciesReady(story, tickets)
      ) {
        return { phase, step, ticket: story, mode: 'normal' };
      }
    }
    return undefined;
  }

  async resume(phaseId: ObjectId): Promise<ScheduledWork | undefined> {
    const phase = await this.requirePhase(phaseId);
    const inProgress = (await this.phaseSteps(phase)).filter((step) => step.state === 'in_progress');
    if (inProgress.length > 1) {
      throw new Error(`Phase ${phase.name} has multiple in-progress Steps: ${inProgress.map((step) => step.name).join(', ')}`);
    }
    if (inProgress.length === 1) {
      const tickets = await this.tickets.list();
      const step = inProgress[0]!;
      const active = activeCorrectiveTicket(step, tickets) ?? tickets.find(
        (ticket) => ticket.type === 'story' && ticket.stepId === step.id && ticket.state === 'in_progress',
      );
      if (!active) throw new Error(`In-progress Step ${step.name} has no active Ticket`);
      return { phase, step, ticket: active, mode: modeFor(active) };
    }
    return this.next(phaseId);
  }

  async start(work: ScheduledWork): Promise<ScheduledWork> {
    let ticket = await this.requireTicket(work.ticket.id);
    if (ticket.attempts >= ticket.maxAttempts) {
      ticket = await this.extendConvergingTicket(ticket);
    }
    let project = await this.requireProject(work.phase.projectId);
    if (project.state === 'created') project = await this.saveProjectTransition(project, 'planning');
    if (project.state === 'planning' || project.state === 'pending') {
      await this.saveProjectTransition(project, 'in_progress');
    }
    let phase = await this.requirePhase(work.phase.id);
    if (phase.state === 'created' || phase.state === 'pending' || phase.state === 'reopened') {
      phase = await this.savePhaseTransition(phase, 'in_progress');
    }
    let step = await this.requireStep(work.step.id);
    if (step.state === 'delivered' || step.state === 'closed') {
      step = await this.saveStepTransition(step, 'reopened');
    }
    if (step.state === 'created' || step.state === 'pending' || step.state === 'reopened') {
      step = await this.saveStepTransition(step, 'in_progress');
    }
    // Step attempts are cumulative audit telemetry across independent Tickets.
    step = StepSchemaWithRevision(step, { attempts: step.attempts + 1 });
    await this.repository.update(step, step.state);
    ticket = TicketSchemaWithRevision(ticket, { attempts: ticket.attempts + 1 });
    await this.repository.update(ticket, ticket.state);
    if (ticket.state === 'created' || ticket.state === 'pending' || ticket.state === 'reopened') {
      ticket = await this.saveTicketTransition(ticket, 'in_progress');
    }
    if (ticket.type === 'story') await this.startTasks(ticket);
    await this.checkpoint(step, `Started ${work.mode} work through ${ticket.name}`);
    return { phase, step: await this.requireStep(step.id), ticket, mode: work.mode };
  }

  private async extendConvergingTicket(ticket: Ticket): Promise<Ticket> {
    const evidence = [];
    for (const logId of ticket.logIds) {
      const object = await this.repository.read(logId);
      if (object.objectType !== 'log' || object.level !== 'error') continue;
      evidence.push({
        signature: typeof object.data.failureSignature === 'string'
          ? object.data.failureSignature
          : undefined,
        category: typeof object.data.failureCategory === 'string'
          ? object.data.failureCategory
          : undefined,
      });
    }
    const decision = evaluateAttemptExtension(evidence);
    if (!decision.extend) {
      throw new Error(
        `Ticket ${ticket.name} stopped after ${ticket.attempts} attempts: ${decision.reason}`,
      );
    }
    const extended = TicketSchemaWithRevision(ticket, {
      maxAttempts: ticket.attempts + 1,
    });
    await this.repository.update(extended, extended.state);
    const step = ticket.stepId ? await this.requireStep(ticket.stepId) : undefined;
    if (step) {
      await this.checkpoint(
        step,
        `Extended ${ticket.name} to ${extended.maxAttempts} attempts: ${decision.reason}`,
      );
    }
    return extended;
  }

  async deferInfrastructureFailure(work: ScheduledWork, reason: string): Promise<void> {
    const step = await this.requireStep(work.step.id);
    const ticket = await this.requireTicket(work.ticket.id);
    if (step.state !== 'in_progress' || ticket.state !== 'in_progress') {
      throw new Error(`Infrastructure failure can only defer active work: ${step.name}/${ticket.name}`);
    }
    const revisedStep = StepSchemaWithRevision(step, {
      attempts: Math.max(0, step.attempts - 1),
    });
    await this.repository.update(revisedStep, revisedStep.state);
    const revisedTicket = TicketSchemaWithRevision(ticket, {
      attempts: Math.max(0, ticket.attempts - 1),
    });
    await this.repository.update(revisedTicket, revisedTicket.state);
    await this.checkpoint(revisedStep, `Infrastructure failure deferred without V-model routing: ${reason}`);
  }

  async recoverMisroutedInfrastructureBug(ticketId: ObjectId): Promise<void> {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.type !== 'bug') throw new Error(`Ticket ${ticketId} is not a Bug`);
    if (ticket.changeRequestTicketIds.length > 0 || ticket.solution || ticket.changelistIds.length > 0) {
      throw new Error(`Bug ${ticket.name} contains implementation evidence and cannot be recovered as misrouted`);
    }
    const failedStep = await this.requireStep(ticket.failure.failedStepId);
    const targetStep = await this.requireStep(ticket.failure.targetStepId);
    const parent = ticket.parentTicketId ? await this.requireTicket(ticket.parentTicketId) : undefined;

    await this.tickets.cancelUnresolved(ticket.id);

    if (targetStep.id !== failedStep.id) {
      let currentTarget = await this.requireStep(targetStep.id);
      if (currentTarget.state === 'in_progress') {
        currentTarget = await this.saveStepTransition(currentTarget, 'delivered');
      }
      const revisedTarget = StepSchemaWithRevision(currentTarget, {
        attempts: Math.max(0, currentTarget.attempts - ticket.attempts),
      });
      await this.repository.update(revisedTarget, revisedTarget.state);

      let currentFailed = await this.requireStep(failedStep.id);
      if (currentFailed.state === 'pending') {
        currentFailed = await this.saveStepTransition(currentFailed, 'in_progress');
      }
      const revisedFailed = StepSchemaWithRevision(currentFailed, {
        attempts: Math.max(0, currentFailed.attempts - 1),
      });
      await this.repository.update(revisedFailed, revisedFailed.state);
      await this.checkpoint(revisedFailed, `Restored after cancelling misrouted ${ticket.name}`);
    } else {
      const current = await this.requireStep(targetStep.id);
      const revised = StepSchemaWithRevision(current, {
        attempts: Math.max(0, current.attempts - ticket.attempts - 1),
      });
      await this.repository.update(revised, revised.state);
      await this.checkpoint(revised, `Restored after cancelling misrouted ${ticket.name}`);
    }

    if (parent) {
      const currentParent = await this.requireTicket(parent.id);
      const revisedParent = TicketSchemaWithRevision(currentParent, {
        attempts: Math.max(0, currentParent.attempts - 1),
      });
      await this.repository.update(revisedParent, revisedParent.state);
    }
  }

  async deliverNormal(work: ScheduledWork, qualityAssessmentId: ObjectId): Promise<void> {
    if (work.mode !== 'normal' || work.ticket.type !== 'story') {
      throw new Error('deliverNormal requires normal Story work');
    }
    let step = await this.requireStep(work.step.id);
    if (step.state !== 'in_progress') throw new Error(`Step ${step.name} is not in progress`);
    await this.requirePassingQualityAssessment(step, qualityAssessmentId);
    step = await this.attachQuality(step, qualityAssessmentId);
    step = await this.saveStepTransition(step, 'delivered');
    let story = await this.requireTicket(work.ticket.id);
    await this.completeTasks(story);
    story = await this.saveTicketTransition(story, 'resolved');

    if (isVerificationStep(step)) {
      step = await this.saveStepTransition(step, 'closed');
      story = await this.saveTicketTransition(story, 'closed');
      if (!step.pairedStepId) throw new Error(`Verification Step ${step.name} has no paired source Step`);
      let source = await this.requireStep(step.pairedStepId);
      if (source.state !== 'delivered') {
        throw new Error(`Paired source Step ${source.name} must be delivered before ${step.name} can close`);
      }
      source = await this.saveStepTransition(source, 'closed');
      const sourceStory = await this.tickets.storyForStep(source.id);
      if (sourceStory.state === 'resolved') await this.saveTicketTransition(sourceStory, 'closed');
      await this.checkpoint(source, `Closed after paired verification ${step.name}`);
    }
    await this.checkpoint(step, `Delivered ${step.name} through ${story.name}`);
  }

  async routeFailure(input: {
    failedStepId: ObjectId;
    message: string;
    summary: string;
    rawEvidenceRef?: string;
    tool?: string;
    exitCode?: number;
    statusCode?: number;
    correlationId: ObjectId;
    causationId?: ObjectId;
    parentChangeRequestId?: ObjectId;
  }): Promise<BugTicket> {
    let failed = await this.requireStep(input.failedStepId);
    if (!failed.pairedStepId) throw new Error(`Failure routing requires a paired Step: ${failed.name}`);
    let target = isVerificationStep(failed)
      ? await this.requireStep(failed.pairedStepId)
      : failed;
    const verification = isVerificationStep(failed)
      ? failed
      : await this.requireStep(failed.pairedStepId);
    failed = await this.moveStepPending(failed, 'defect');
    if (target.id !== failed.id && (target.state === 'delivered' || target.state === 'closed')) {
      target = await this.saveStepTransition(target, 'reopened');
    }
    const bug = await this.tickets.openBug({
      failedStep: failed,
      targetStep: target,
      verificationStep: verification,
      kind: 'test-failure',
      severity: 'high',
      message: input.message,
      summary: input.summary,
      rawEvidenceRef: input.rawEvidenceRef,
      tool: input.tool,
      exitCode: input.exitCode,
      statusCode: input.statusCode,
      correlationId: input.correlationId,
      causationId: input.causationId,
      parentChangeRequestId: input.parentChangeRequestId,
    });
    await this.checkpoint(failed, `Failure routed to ${target.name} through ${bug.name}`);
    await this.checkpoint(target, `Reopened by ${bug.name}`);
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
  }): Promise<EnhancementTicket> {
    let source = await this.requireStep(input.sourceStepId);
    if (!source.pairedStepId) throw new Error(`Quality routing requires a paired Step: ${source.name}`);
    const target = isVerificationStep(source)
      ? await this.requireStep(source.pairedStepId)
      : source;
    const verification = isVerificationStep(source)
      ? source
      : await this.requireStep(source.pairedStepId);
    source = await this.moveStepPending(source, 'quality-gap');
    let reopenedTarget = target;
    if (target.id !== source.id && (target.state === 'delivered' || target.state === 'closed')) {
      reopenedTarget = await this.saveStepTransition(target, 'reopened');
    }
    const enhancement = await this.tickets.openEnhancement({
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
    await this.checkpoint(source, `Quality gap routed to ${reopenedTarget.name} through ${enhancement.name}`);
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
    let step = await this.requireStep(input.work.step.id);
    await this.requirePassingQualityAssessment(step, input.qualityAssessmentId);
    step = await this.attachQuality(step, input.qualityAssessmentId);
    if (step.state === 'pending' || step.state === 'reopened' || step.state === 'created') {
      step = await this.saveStepTransition(step, 'in_progress');
    }
    if (step.state === 'in_progress') step = await this.saveStepTransition(step, 'delivered');
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
    await this.checkpoint(step, `Corrective solution propagated through ${request.name}`);
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
    let step = await this.requireStep(input.work.step.id);
    await this.requirePassingQualityAssessment(step, input.qualityAssessmentId);
    step = await this.attachQuality(step, input.qualityAssessmentId);
    if (step.state === 'in_progress') step = await this.saveStepTransition(step, 'delivered');
    if (isVerificationStep(step)) {
      step = await this.saveStepTransition(step, 'closed');
      if (!step.pairedStepId) throw new Error(`Verification Step ${step.name} has no paired source Step`);
      let source = await this.requireStep(step.pairedStepId);
      if (source.state === 'delivered') {
        source = await this.saveStepTransition(source, 'closed');
        await this.checkpoint(source, `Closed by CR verification ${step.name}`);
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
    const request = await this.requireTicket(input.work.ticket.id);
    if (request.type !== 'change-request') throw new Error('Change Request type changed while applying it');
    const applied = new Set(request.applications.map((application) => application.stepId));
    const complete = request.affectedStepIds.every((id) => applied.has(id));
    if (!complete) return { closed: false };
    const sourceTicket = await this.requireTicket(request.sourceTicketId);
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
    if (request.parentChangeRequestId) {
      await this.activateChangeRequest(request.parentChangeRequestId);
    }
    await this.closeStoriesForClosedSteps([request.sourceStepId, ...request.affectedStepIds]);
    return {
      closed: true,
      sourceTicketId: request.sourceTicketId,
      sourceTicketType: sourceTicket.type,
    };
  }

  async activateChangeRequest(ticketId: ObjectId): Promise<ChangeRequestTicket> {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.type !== 'change-request') throw new Error(`Ticket ${ticketId} is not a Change Request`);
    const applied = new Set(ticket.applications.map((application) => application.stepId));
    for (const stepId of ticket.affectedStepIds.filter((id) => !applied.has(id))) {
      let step = await this.requireStep(stepId);
      if (step.state === 'closed' || step.state === 'delivered') {
        step = await this.saveStepTransition(step, 'reopened');
        await this.checkpoint(step, `Reopened for incremental ${ticket.name}`);
      }
    }
    return ticket;
  }

  async completePhase(phaseId: ObjectId): Promise<{ nextPhaseId?: ObjectId; projectDelivered: boolean }> {
    let phase = await this.requirePhase(phaseId);
    const incomplete = (await this.phaseSteps(phase)).filter((step) => step.state !== 'closed');
    const activeDefects = (await this.tickets.list()).filter((ticket) =>
      ticket.phaseId === phase.id &&
      (ticket.type === 'bug' || ticket.type === 'enhancement' || ticket.type === 'change-request') &&
      isActiveTicket(ticket),
    );
    if (incomplete.length > 0 || activeDefects.length > 0) {
      throw new Error(
        `Cannot deliver ${phase.name}: incomplete Steps [${incomplete.map((step) => step.name).join(', ')}], ` +
        `active Tickets [${activeDefects.map((ticket) => ticket.name).join(', ')}]`,
      );
    }
    if (phase.state !== 'in_progress') throw new Error(`Phase ${phase.name} is not in progress`);
    const phaseTickets = await this.tickets.list();
    const incompleteStories = phaseTickets.filter((ticket) =>
      ticket.phaseId === phase.id &&
      ticket.type === 'story' &&
      ticket.workKind === 'v-model-step' &&
      ticket.state !== 'closed',
    );
    if (incompleteStories.length > 0) {
      throw new Error(`Cannot deliver ${phase.name}: incomplete Stories [${incompleteStories.map((ticket) => ticket.name).join(', ')}]`);
    }
    let delivery = phaseTickets.find(
      (ticket): ticket is WorkTicket =>
        ticket.phaseId === phase.id && ticket.type === 'story' && ticket.workKind === 'delivery',
    );
    let epic = phaseTickets.find(
      (ticket): ticket is WorkTicket => ticket.id === phase.epicTicketId && ticket.type === 'epic',
    );
    if (!delivery || !epic) throw new Error(`Phase ${phase.name} delivery Ticket graph is incomplete`);
    delivery = await this.saveTicketTransition(delivery, 'in_progress') as WorkTicket;
    delivery = await this.saveTicketTransition(delivery, 'resolved') as WorkTicket;
    await this.saveTicketTransition(delivery, 'closed');
    epic = await this.saveTicketTransition(epic, 'in_progress') as WorkTicket;
    epic = await this.saveTicketTransition(epic, 'resolved') as WorkTicket;
    await this.saveTicketTransition(epic, 'closed');
    phase = await this.savePhaseTransition(phase, 'delivered');
    await this.savePhaseTransition(phase, 'closed');
    let project = await this.requireProject(phase.projectId);
    const phases = await Promise.all(project.phaseIds.map((id) => this.requirePhase(id)));
    const next = phases.find((candidate) =>
      candidate.state !== 'closed' &&
      candidate.dependencyPhaseIds.every((dependencyId) =>
        phases.some((dependency) => dependency.id === dependencyId && dependency.state === 'closed'),
      ),
    );
    if (next) {
      project = ProjectSchema.parse({
        ...project,
        ...reviseObjectEnvelope(project),
        currentPhaseId: next.id,
      });
      await this.repository.update(project, project.state);
      const planObject = await this.repository.read(project.projectPlanId);
      if (planObject.objectType !== 'plan' || planObject.planKind !== 'project') {
        throw new Error(`Project ${project.name} does not reference a ProjectPlan`);
      }
      const projectPlan = ProjectPlanSchema.parse({
        ...planObject,
        ...reviseObjectEnvelope(planObject),
        activePhaseId: next.id,
      });
      await this.repository.update(projectPlan, 'planned');
      return { nextPhaseId: next.id, projectDelivered: false };
    }
    if (project.state !== 'in_progress') {
      throw new Error(`Project ${project.name} is not in progress at final Phase completion`);
    }
    project = await this.saveProjectTransition(project, 'delivered');
    await this.saveProjectTransition(project, 'closed');
    return { projectDelivered: true };
  }

  private async phaseSteps(phase: Phase): Promise<Step[]> {
    const steps = await Promise.all(phase.stepIds.map((id) => this.requireStep(id)));
    return steps.sort((left, right) => STEP_TYPE_ORDER[left.type] - STEP_TYPE_ORDER[right.type]);
  }

  private async stepDependenciesReady(step: Step): Promise<boolean> {
    for (const dependencyId of step.dependencyStepIds) {
      const dependency = await this.requireStep(dependencyId);
      if (dependency.state !== 'delivered' && dependency.state !== 'closed') return false;
    }
    return true;
  }

  private async ticketDependenciesReady(ticket: Ticket, tickets: readonly Ticket[]): Promise<boolean> {
    for (const dependencyId of ticket.dependencyTicketIds) {
      const dependency = tickets.find((candidate) => candidate.id === dependencyId);
      if (!dependency || (dependency.state !== 'resolved' && dependency.state !== 'closed')) return false;
    }
    return true;
  }

  private async startTasks(story: WorkTicket): Promise<void> {
    const descendants = await this.ticketDescendants(story.id);
    for (const task of descendants) {
      if (task.state === 'created' || task.state === 'pending' || task.state === 'reopened') {
        await this.saveTicketTransition(task, 'in_progress');
      }
    }
  }

  private async completeTasks(story: Ticket): Promise<void> {
    const descendants = (await this.ticketDescendants(story.id)).reverse();
    for (let task of descendants) {
      if (task.state === 'created') task = await this.saveTicketTransition(task, 'in_progress');
      if (task.state === 'in_progress') task = await this.saveTicketTransition(task, 'resolved');
      if (task.state === 'resolved') await this.saveTicketTransition(task, 'closed');
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

  private async closeStoriesForClosedSteps(stepIds: readonly ObjectId[]): Promise<void> {
    for (const stepId of stepIds) {
      const step = await this.requireStep(stepId);
      if (step.state !== 'closed') continue;
      let story = await this.tickets.storyForStep(step.id);
      if (story.blockedByTicketIds.length > 0) continue;
      if (story.state === 'created' || story.state === 'pending' || story.state === 'reopened') {
        story = await this.saveTicketTransition(story, 'in_progress') as WorkTicket;
      }
      if (story.state === 'in_progress') {
        await this.completeTasks(story);
        story = await this.saveTicketTransition(story, 'resolved') as WorkTicket;
      }
      if (story.state === 'resolved') await this.saveTicketTransition(story, 'closed');
    }
  }

  private async moveStepPending(step: Step, reason: 'defect' | 'quality-gap'): Promise<Step> {
    let current = step;
    if (current.state === 'delivered' || current.state === 'closed') {
      current = await this.saveStepTransition(current, 'reopened');
    }
    if (current.state === 'created' || current.state === 'reopened') {
      current = await this.saveStepTransition(current, 'in_progress');
    }
    if (current.state === 'in_progress') {
      current = await this.saveStepTransition(current, 'pending', reason);
    }
    return current;
  }

  private async attachQuality(step: Step, qualityAssessmentId: ObjectId): Promise<Step> {
    const updated = StepSchemaWithRevision(step, { qualityAssessmentId });
    await this.repository.update(updated, updated.state);
    return updated;
  }

  private async checkpoint(step: Step, reason: string): Promise<Checkpoint> {
    const current = await this.requireStep(step.id);
    const entry = this.repository.registry.require(current.id, 'step');
    const snapshotRefs = [entry.objectRef];
    const checkpoint = CheckpointSchema.parse({
      ...createObjectEnvelope({
        name: `${current.name}-CP${String(current.checkpointIds.length + 1).padStart(3, '0')}`,
        objectType: 'checkpoint',
        projectId: current.projectId,
      }),
      subject: { id: current.id, objectType: 'step' },
      eventSequence: this.repository.registry.currentEventSequence(),
      snapshotRefs,
      contentHash: `sha256:${createHash('sha256').update(JSON.stringify(snapshotRefs)).digest('hex')}`,
      reason,
    });
    await this.repository.insert(checkpoint);
    const updated = StepSchemaWithRevision(current, {
      checkpointIds: [...current.checkpointIds, checkpoint.id],
    });
    await this.repository.update(updated, updated.state);
    return checkpoint;
  }

  private async requirePhase(id: ObjectId): Promise<Phase> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'phase') throw new Error(`Object ${id} is not a Phase`);
    return object;
  }

  private async requireProject(id: ObjectId): Promise<Project> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'project') throw new Error(`Object ${id} is not a Project`);
    return object;
  }

  private async requireStep(id: ObjectId): Promise<Step> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'step') throw new Error(`Object ${id} is not a Step`);
    return object;
  }

  private async requireTicket(id: ObjectId): Promise<Ticket> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'ticket') throw new Error(`Object ${id} is not a Ticket`);
    return object;
  }

  private async requirePassingQualityAssessment(step: Step, id: ObjectId): Promise<void> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'quality-assessment') {
      throw new Error(`Object ${id} is not a Quality Assessment`);
    }
    if (object.subject.objectType !== 'step' || object.subject.id !== step.id) {
      throw new Error(`Quality Assessment ${object.name} does not assess Step ${step.name}`);
    }
    if (!object.passed) {
      throw new Error(`Quality Assessment ${object.name} did not pass: ${object.gaps.join('; ')}`);
    }
  }

  private async saveStepTransition(
    step: Step,
    next: Parameters<typeof transitionStep>[1],
    pendingReason?: 'defect' | 'quality-gap',
  ): Promise<Step> {
    const updated = transitionStep(step, next, { pendingReason });
    await this.repository.update(updated, updated.state);
    return updated;
  }

  private async savePhaseTransition(
    phase: Phase,
    next: Parameters<typeof transitionPhase>[1],
  ): Promise<Phase> {
    const updated = transitionPhase(phase, next);
    await this.repository.update(updated, updated.state);
    return updated;
  }

  private async saveProjectTransition(
    project: Project,
    next: Parameters<typeof transitionProject>[1],
  ): Promise<Project> {
    const updated = transitionProject(project, next);
    await this.repository.update(updated, updated.state);
    return updated;
  }

  private async saveTicketTransition(
    ticket: Ticket,
    next: Parameters<typeof transitionTicket>[1],
  ): Promise<Ticket> {
    const updated = transitionTicket(ticket, next);
    await this.repository.update(updated, updated.state);
    return updated;
  }
}

function StepSchemaWithRevision(
  step: Step,
  changes: Partial<Pick<Step, 'qualityAssessmentId' | 'checkpointIds' | 'attempts'>>,
): Step {
  return StepSchema.parse({
    ...step,
    ...reviseObjectEnvelope(step),
    ...changes,
  });
}

function TicketSchemaWithRevision(
  ticket: Ticket,
  changes: Partial<Pick<Ticket, 'attempts' | 'maxAttempts'>>,
): Ticket {
  return TicketSchema.parse({
    ...ticket,
    ...reviseObjectEnvelope(ticket),
    ...changes,
  });
}

function activeCorrectiveTicket(step: Step, tickets: readonly Ticket[]): Ticket | undefined {
  return tickets
    .filter((ticket) => isActiveTicket(ticket))
    .filter((ticket) => ticket.blockedByTicketIds.length === 0)
    .filter((ticket) =>
      (ticket.type === 'bug' &&
        ticket.failure.targetStepId === step.id &&
        ticket.changeRequestTicketIds.length === 0) ||
      (ticket.type === 'enhancement' &&
        ticket.targetStepId === step.id &&
        ticket.changeRequestTicketIds.length === 0) ||
      (ticket.type === 'change-request' &&
        ticket.affectedStepIds.includes(step.id) &&
        !ticket.applications.some((application) => application.stepId === step.id)),
    )
    .sort((left, right) =>
      correctionRank(right) - correctionRank(left) || right.priority - left.priority,
    )[0];
}

function correctionRank(ticket: Ticket): number {
  if (ticket.type === 'change-request') return 3;
  if (ticket.type === 'bug') return 2;
  if (ticket.type === 'enhancement') return 1;
  return 0;
}

function modeFor(ticket: Ticket): WorkMode {
  if (ticket.type === 'bug') return 'debug';
  if (ticket.type === 'enhancement') return 'enhancement';
  if (ticket.type === 'change-request') return 'change-request';
  return 'normal';
}

function isVerificationStep(step: Step): boolean {
  return (VERIFICATION_STEP_TYPES as readonly string[]).includes(step.type);
}
