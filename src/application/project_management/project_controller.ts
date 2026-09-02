import type { ObjectId } from '../../domain/identity/object_id.js';
import { stepContextFingerprint, xcompilerBuildId } from '../../core/build_identity.js';
import { reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { Checkpoint } from '../../domain/evidence/evidence.js';
import type { Phase } from '../../domain/phases/phase.js';
import type { Project } from '../../domain/projects/project.js';
import {
  StepSchema,
  VERIFICATION_STEP_TYPES,
  type Step,
} from '../../domain/steps/step.js';
import {
  isActiveTicket,
  TicketSchema,
  type BugTicket,
  type ChangeRequestApplicationDecision,
  type ChangeRequestTicket,
  type EnhancementTicket,
  type Ticket,
  type TicketSource,
  type TicketSolution,
  type TicketWorkspaceBinding,
  type WorkTicket,
} from '../../domain/tickets/ticket.js';
import type { Changelist } from '../../domain/evidence/evidence.js';
import type { PendingReason } from '../../domain/workflow/pending_reason.js';
import { TicketWorkflow } from './ticket_workflow.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { evaluateAttemptExtension } from '../../domain/tickets/retry_policy.js';
import { TicketRegistrationService } from './ticket_registration_service.js';
import { ProjectStateService } from './project_state_service.js';
import { GovernanceService } from './governance_service.js';
import { createDomainEvent } from '../observability/domain_event_factory.js';
import { DomainAuditTrail } from '../observability/domain_audit_trail.js';
import type { AttemptFailure } from '../execution/failure_classification.js';
import type { TestOutcome } from '../execution/test_outcome.js';
import type { DeliveryGateFinding } from '../../domain/quality/delivery_gate.js';
import { buildDebugBrief, buildFailureSignature } from '../../core/debug_brief.js';
import { WorkScheduler, workModeFor, type ScheduledWork } from './work_scheduler.js';
import { CorrectiveWorkflowService } from './corrective_workflow_service.js';
import {
  ProjectManagerIntakeService,
  type ProjectManagerProblemIntake,
} from './project_manager_intake.js';

export type { ScheduledWork, WorkMode } from './work_scheduler.js';

export class ProjectController {
  private readonly tickets: TicketWorkflow;
  private readonly registration: TicketRegistrationService;
  private readonly state: ProjectStateService;
  private readonly governance: GovernanceService;
  private readonly scheduler: WorkScheduler;
  private readonly corrective: CorrectiveWorkflowService;
  private readonly intake: ProjectManagerIntakeService;
  private readonly traces: DomainAuditTrail;

  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    /**
     * Called once every V-model Step of a Phase is closed and before the delivery Ticket is.
     *
     * That instant is the only correct one for anything that reads the finished files: every
     * ChangeSet has merged, so nothing more will be written, and delivery has not closed, so what
     * this produces is part of the delivered record rather than a change made to it afterwards.
     */
    private readonly hooks: { onStepsClosed?: (phaseId: ObjectId) => Promise<void> } = {},
  ) {
    this.tickets = new TicketWorkflow(repository);
    this.registration = new TicketRegistrationService(repository);
    this.state = new ProjectStateService(repository);
    this.governance = new GovernanceService(repository);
    this.scheduler = new WorkScheduler(repository);
    this.corrective = new CorrectiveWorkflowService(repository);
    this.intake = new ProjectManagerIntakeService(repository);
    this.traces = new DomainAuditTrail(repository);
  }

  async next(phaseId: ObjectId): Promise<ScheduledWork | undefined> {
    return this.scheduler.next(phaseId);
  }

  async resume(phaseId: ObjectId): Promise<ScheduledWork | undefined> {
    return this.scheduler.resume(phaseId);
  }

  async reconcilePhaseDeliveryBugs(
    phaseId: ObjectId,
    findings: readonly Pick<DeliveryGateFinding, 'code' | 'target'>[],
    phaseGateAssessmentId: ObjectId,
  ): Promise<ObjectId[]> {
    return this.tickets.reconcilePhaseDeliveryBugs(phaseId, findings, phaseGateAssessmentId);
  }

  async start(work: ScheduledWork): Promise<ScheduledWork> {
    const mode = workModeFor(work.ticket);
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
    ticket = TicketSchemaWithRevision(ticket, { attempts: ticket.attempts + 1 });
    await this.repository.commit([step, ticket]);
    if (ticket.state === 'created' || ticket.state === 'pending' || ticket.state === 'reopened') {
      ticket = await this.saveTicketTransition(ticket, 'in_progress');
    }
    if (ticket.type === 'story') await this.startTasks(ticket);
    await this.checkpoint(step, `Started ${mode} work through ${ticket.name}`);
    return { phase, step: await this.requireStep(step.id), ticket };
  }

  private async extendConvergingTicket(ticket: Ticket): Promise<Ticket> {
    const evidence: Array<{
      signature?: string;
      category?: string;
      toolchainBuildId?: string;
      stepContextFingerprint?: string;
    }> = [];
    const recordedAttemptNumbers = new Set<number>();
    for (const logId of ticket.logIds) {
      const object = await this.repository.read(logId);
      if (object.objectType !== 'log') continue;
      if (
        object.level === 'info' &&
        object.data.mode === 'change-request' &&
        typeof object.data.attempt === 'number'
      ) {
        recordedAttemptNumbers.add(object.data.attempt);
      }
      if (object.level !== 'error') continue;
      evidence.push({
        signature: typeof object.data.failureSignature === 'string'
          ? object.data.failureSignature
          : undefined,
        category: typeof object.data.failureCategory === 'string'
          ? object.data.failureCategory
          : undefined,
        toolchainBuildId: typeof object.data.toolchainBuildId === 'string'
          ? object.data.toolchainBuildId
          : undefined,
        stepContextFingerprint: typeof object.data.stepContextFingerprint === 'string'
          ? object.data.stepContextFingerprint
          : undefined,
      });
    }
    // Older builds could return a CR attempt as successful without applying it or writing a failure
    // log. The strict extension policy then has no fingerprint to evaluate and permanently blocks
    // the fixed build before it can execute once. Recover only when append-only records prove every
    // exhausted attempt started, while the CR has neither an application nor any terminal error.
    // PM first materializes that missing outcome as a structured current-build failure; the ordinary
    // recurrence policy remains the sole authority for the extension and every later attempt.
    if (
      evidence.length === 0 &&
      ticket.type === 'change-request' &&
      ticket.applications.length === 0 &&
      ticket.attempts > 0 &&
      recordedAttemptNumbers.size >= ticket.maxAttempts
    ) {
      evidence.push(await this.recordMissingChangeRequestOutcome(ticket, recordedAttemptNumbers));
      ticket = await this.requireTicket(ticket.id);
      if (ticket.type !== 'change-request') {
        throw new Error('Change Request type changed while recording its missing attempt outcome');
      }
    }
    const stepForContext = ticket.stepId ? await this.requireStep(ticket.stepId) : undefined;
    const decision = evaluateAttemptExtension(
      evidence,
      xcompilerBuildId(),
      stepForContext ? stepContextFingerprint(stepForContext) : undefined,
    );
    if (!decision.extend) {
      throw new Error(
        `Ticket ${ticket.name} stopped after ${ticket.attempts} attempts: ${decision.reason}`,
      );
    }
    const project = await this.requireProject(ticket.projectId);
    const governance = await this.governance.prepareDecision({
      projectId: project.id,
      decisionType: 'budget',
      decidedByActorId: project.pmActorId,
      authority: 'project-manager',
      options: ['stop', `extend:${ticket.attempts + 1}`],
      selected: `extend:${ticket.attempts + 1}`,
      rationale: decision.reason,
      confidence: 1,
      evidenceRefs: ticket.logIds,
      correlationId: ticket.source.correlationId,
      causationId: ticket.id,
    });
    const extension = await this.tickets.prepareAttemptExtension({
      ticket,
      maxAttempts: ticket.attempts + 1,
      pmActorId: project.pmActorId,
      decisionId: governance.decision.id,
      reason: decision.reason,
    });
    await this.repository.commit([
      governance.decision,
      governance.managementPlan,
      ...extension.objects,
      createDomainEvent({
        projectId: project.id,
        aggregate: { id: governance.decision.id, objectType: 'decision-record' },
        eventType: 'governance.decision_recorded',
        payload: { decisionType: 'budget', selected: governance.decision.selected },
        phaseId: ticket.phaseId,
        stepId: ticket.stepId,
        ticketId: ticket.id,
        correlationId: ticket.source.correlationId,
        causationId: ticket.id,
        objectRevision: governance.decision.revision,
      }),
    ]);
    const extended = extension.ticket;
    const step = ticket.stepId ? await this.requireStep(ticket.stepId) : undefined;
    if (step) {
      await this.checkpoint(
        step,
        `Extended ${ticket.name} to ${extended.maxAttempts} attempts: ${decision.reason}`,
      );
    }
    return extended;
  }

  private async recordMissingChangeRequestOutcome(
    ticket: ChangeRequestTicket,
    recordedAttemptNumbers: ReadonlySet<number>,
  ): Promise<{ signature: string; category: string; toolchainBuildId: string }> {
    const step = await this.requireStep(ticket.targetStepId);
    const reason = `${ticket.name} exhausted its attempt budget without a Change Request application or terminal failure`;
    const failure: AttemptFailure = {
      kind: 'execution',
      category: 'internal',
      code: 'attempt_outcome_missing',
      message: reason,
      retryable: true,
      switchProvider: false,
      details: {
        attempts: ticket.attempts,
        maxAttempts: ticket.maxAttempts,
        recordedAttemptNumbers: [...recordedAttemptNumbers].sort((left, right) => left - right),
      },
    };
    const brief = buildDebugBrief({
      reason,
      failureLog: reason,
      phase: step.type,
      targetPhase: step.type,
      typedFailure: failure,
    });
    const failureSignature = buildFailureSignature(brief, failure.code);
    const toolchainBuildId = xcompilerBuildId();
    await this.traces.recordLog({
      projectId: ticket.projectId,
      subject: { id: ticket.id, objectType: 'ticket' },
      level: 'error',
      message: reason,
      data: {
        stepId: ticket.targetStepId,
        mode: 'change-request',
        failureLog: reason,
        failureCategory: brief.category,
        structuredFailure: failure,
        failureSignature,
        toolchainBuildId,
      },
      correlationId: ticket.source.correlationId,
      causationId: ticket.source.causationId,
    });
    return { signature: failureSignature, category: brief.category, toolchainBuildId };
  }

  async deferInfrastructureFailure(work: ScheduledWork, reason: string): Promise<void> {
    await this.deferNonProjectAttempt(
      work,
      'external-service',
      `Infrastructure failure deferred without V-model routing: ${reason}`,
    );
  }

  async deferPermissionBlocked(work: ScheduledWork, reason: string): Promise<void> {
    await this.deferNonProjectAttempt(
      work,
      'permission',
      `Permission blocked without V-model routing: ${reason}`,
    );
  }

  async deferCancelledAttempt(work: ScheduledWork, reason: string): Promise<void> {
    await this.deferNonProjectAttempt(
      work,
      'interrupted',
      `Cancelled attempt returned to PM without V-model routing: ${reason}`,
    );
  }

  async retainAgentExecutionFailure(work: ScheduledWork, reason: string): Promise<void> {
    const step = await this.requireStep(work.step.id);
    const ticket = await this.requireTicket(work.ticket.id);
    if (step.state !== 'in_progress' || ticket.state !== 'in_progress') {
      throw new Error(`Only active work can retain an agent execution failure: ${step.name}/${ticket.name}`);
    }
    await this.checkpoint(
      step,
      `Agent execution stalled; retained ${ticket.name} for an explicit resume without V-model defect routing: ${reason}`,
    );
  }

  async recordChangeRequestVerificationFailure(input: {
    work: ScheduledWork;
    unprovenBugTicketIds: ObjectId[];
    testOutcomes: readonly TestOutcome[];
  }): Promise<string> {
    if (input.work.ticket.type !== 'change-request') {
      throw new Error('Change Request verification failure requires a Change Request');
    }
    const bugs: BugTicket[] = [];
    for (const ticketId of input.unprovenBugTicketIds) {
      const ticket = await this.requireTicket(ticketId);
      if (ticket.type !== 'bug') throw new Error(`Unproven source ${ticket.name} is not a Bug`);
      bugs.push(ticket);
    }
    const requiredSelectors = [...new Set(
      bugs.flatMap((bug) => bug.verificationContract.testSelectors),
    )].sort();
    const executedSelectors = [...new Set(
      input.testOutcomes.flatMap((outcome) => outcome.args.filter((arg) => !arg.startsWith('-'))),
    )].sort();
    const bugNames = bugs.map((bug) => bug.name).join(', ') || '(unknown Bug)';
    const reason = `${input.work.ticket.name} did not replay the immutable verification contract for ${bugNames}`;
    const failureLog = [
      reason,
      `required selectors: ${requiredSelectors.join(', ') || '(original gate scope)'}`,
      `executed selectors: ${executedSelectors.join(', ') || '(none)'}`,
      ...requiredSelectors.map((selector) => `FAIL ${selector}`),
    ].join('\n');
    const failure: AttemptFailure = {
      kind: 'execution',
      category: 'test',
      code: 'bug_verification_not_replayed',
      message: failureLog,
      retryable: true,
      switchProvider: false,
      details: {
        bugTicketIds: bugs.map((bug) => bug.id),
        requiredSelectors,
        executedSelectors,
      },
    };
    const brief = buildDebugBrief({
      reason,
      failureLog,
      phase: input.work.step.type,
      targetPhase: input.work.step.type,
      typedFailure: failure,
    });
    await this.traces.recordLog({
      projectId: input.work.step.projectId,
      subject: { id: input.work.ticket.id, objectType: 'ticket' },
      level: 'error',
      message: reason,
      data: {
        phaseId: input.work.step.phaseId,
        stepId: input.work.step.id,
        stepName: input.work.step.name,
        mode: 'change-request',
        failureLog,
        failureCategory: brief.category,
        structuredFailure: failure,
        testOutcomes: input.testOutcomes,
        failureSignature: buildFailureSignature(brief, failure.code),
        toolchainBuildId: xcompilerBuildId(),
        stepContextFingerprint: stepContextFingerprint(input.work.step),
      },
      correlationId: input.work.ticket.source.correlationId,
      causationId: input.work.ticket.source.causationId,
    });
    await this.checkpoint(
      await this.requireStep(input.work.step.id),
      `${reason}; candidate retained without delivery or merge.`,
    );
    return reason;
  }

  private async deferNonProjectAttempt(
    work: ScheduledWork,
    pendingReason: PendingReason,
    checkpoint: string,
  ): Promise<void> {
    const step = await this.requireStep(work.step.id);
    const ticket = await this.requireTicket(work.ticket.id);
    if (step.state !== 'in_progress' || ticket.state !== 'in_progress') {
      throw new Error(`Only active work can return an attempt to PM: ${step.name}/${ticket.name}`);
    }
    const revisedStep = StepSchemaWithRevision(step, {
      attempts: Math.max(0, step.attempts - 1),
    });
    const revisedTicket = TicketSchemaWithRevision(ticket, {
      attempts: Math.max(0, ticket.attempts - 1),
    });
    await this.repository.commit([revisedStep, revisedTicket]);
    for (const task of await this.ticketDescendants(revisedTicket.id)) {
      if (task.state === 'in_progress') {
        await this.state.transitionTicket(task, 'pending', pendingReason);
      }
    }
    const parkedTicket = await this.state.transitionTicket(revisedTicket, 'pending', pendingReason);
    const parkedStep = await this.state.transitionStep(revisedStep, 'pending', pendingReason);
    await this.checkpoint(
      parkedStep,
      `${checkpoint}; ${parkedTicket.name} is pending (${pendingReason}) and actor capacity was released.`,
    );
  }

  async deliverNormal(work: ScheduledWork, qualityAssessmentId: ObjectId): Promise<void> {
    if (work.ticket.type !== 'story') {
      throw new Error('deliverNormal requires normal Story work');
    }
    let step = await this.requireStep(work.step.id);
    if (step.state !== 'in_progress') throw new Error(`Step ${step.name} is not in progress`);
    await this.requirePassingQualityAssessment(step, qualityAssessmentId);
    step = await this.attachQuality(step, qualityAssessmentId);
    step = await this.saveStepTransition(step, 'delivered');
    let story = await this.requireTicket(work.ticket.id);
    await this.completeTasks(story);
    story = isVerificationStep(step)
      ? await this.saveTicketTransitionPath(story, ['resolved', 'closed'])
      : await this.saveTicketTransition(story, 'resolved');

    if (isVerificationStep(step)) {
      step = await this.saveStepTransition(step, 'closed');
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
    targetStepId?: ObjectId;
    message: string;
    summary: string;
    failure: AttemptFailure;
    bugKind: BugTicket['bugKind'];
    rawEvidenceRef?: string;
    tool?: string;
    exitCode?: number;
    statusCode?: number;
    correlationId: ObjectId;
    causationId?: ObjectId;
    parentChangeRequestId?: ObjectId;
    discoveringStepId?: ObjectId;
    creatorActorId: ObjectId;
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
    workspaceBinding?: TicketWorkspaceBinding;
    testOutcomes?: readonly TestOutcome[];
    affectedArtifacts?: readonly string[];
  }): Promise<BugTicket> {
    return this.corrective.routeFailure(input);
  }

  async routeQualityGap(input: {
    sourceStepId: ObjectId;
    targetStepId?: ObjectId;
    finding: string;
    affectedArtifacts?: string[];
    kind: EnhancementTicket['enhancementKind'];
    qualityAssessmentId?: ObjectId;
    correlationId: ObjectId;
    causationId?: ObjectId;
    parentChangeRequestId?: ObjectId;
    /** Corrective Bug whose work discovered this independent upstream quality gap. */
    sourceBugTicketId?: ObjectId;
    creatorActorId: ObjectId;
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
    workspaceBinding?: TicketWorkspaceBinding;
  }): Promise<EnhancementTicket> {
    return this.corrective.routeQualityGap(input);
  }

  routeDependencyChange(
    input: Parameters<CorrectiveWorkflowService['routeDependencyChange']>[0],
  ): ReturnType<CorrectiveWorkflowService['routeDependencyChange']> {
    return this.corrective.routeDependencyChange(input);
  }

  routeContractChange(
    input: Parameters<CorrectiveWorkflowService['routeContractChange']>[0],
  ): ReturnType<CorrectiveWorkflowService['routeContractChange']> {
    return this.corrective.routeContractChange(input);
  }

  /** The only boundary that may turn a Phase-external problem report into an internal Ticket. */
  intakeProblems(input: ProjectManagerProblemIntake) {
    return this.intake.accept(input);
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
  }): Promise<ChangeRequestTicket | undefined> {
    return this.corrective.propagateCorrectiveChange(input);
  }

  async completeChangeRequestStep(input: {
    work: ScheduledWork;
    qualityAssessmentId: ObjectId;
    summary: string;
    entries: Changelist['entries'];
    commit?: string;
    verification?: string[];
    application?: ChangeRequestApplicationDecision;
    testOutcomes?: readonly TestOutcome[];
  }): ReturnType<CorrectiveWorkflowService['completeChangeRequestStep']> {
    return this.corrective.completeChangeRequestStep(input);
  }

  async activateChangeRequest(ticketId: ObjectId): Promise<ChangeRequestTicket> {
    return this.corrective.activateChangeRequest(ticketId);
  }

  async reclaimUnreachableWork(projectId: ObjectId): Promise<number> {
    return this.tickets.reclaimUnreachableWork(projectId);
  }

  async releaseCyclicCorrectiveBlockers(projectId: ObjectId): Promise<number> {
    return this.tickets.releaseCyclicCorrectiveBlockers(projectId);
  }

  async reconcileClosedCorrectiveTickets(projectId: ObjectId): Promise<void> {
    await this.tickets.reconcileClosedCorrectiveTickets(projectId);
    const tickets = await this.tickets.list();
    for (const ticket of tickets) {
      if (ticket.projectId === projectId && ticket.type === 'change-request' && isActiveTicket(ticket)) {
        await this.corrective.activateChangeRequest(ticket.id);
      }
    }
    const objects = await this.repository.list({ objectType: 'step', projectId });
    const closedSteps = objects.filter((object): object is Step =>
      object.objectType === 'step' && object.state === 'closed');
    for (const step of closedSteps) {
      let story = await this.tickets.storyForStep(step.id);
      if (story.state === 'closed' || story.blockedByTicketIds.length > 0) continue;
      await this.completeTasks(story);
      const path = ticketClosurePath(story);
      if (path.includes('in_progress')) {
        story = (await this.registration.routeAndAssign(story.id, {
          forStepId: step.id,
          administrative: true,
        })).ticket as WorkTicket;
      }
      if (path.length > 0) await this.saveTicketTransitionPath(story, path);
    }
  }

  async completePhase(phaseId: ObjectId): Promise<{ nextPhaseId?: ObjectId; projectDelivered: boolean }> {
    let phase = await this.requirePhase(phaseId);
    if (!phase.qualityAssessmentId) {
      throw new Error(`Cannot deliver ${phase.name}: Phase delivery gate has no passing assessment`);
    }
    const phaseAssessment = await this.repository.read(phase.qualityAssessmentId);
    if (
      phaseAssessment.objectType !== 'quality-assessment' ||
      phaseAssessment.subject.objectType !== 'phase' ||
      phaseAssessment.subject.id !== phase.id ||
      !phaseAssessment.passed
    ) {
      throw new Error(`Cannot deliver ${phase.name}: Phase delivery assessment is invalid or failed`);
    }
    const incomplete = (await this.scheduler.phaseSteps(phase)).filter((step) => step.state !== 'closed');
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
    await this.hooks.onStepsClosed?.(phase.id);
    let delivery = phaseTickets.find(
      (ticket): ticket is WorkTicket =>
        ticket.phaseId === phase.id && ticket.type === 'story' && ticket.workKind === 'delivery',
    );
    let epic = phaseTickets.find(
      (ticket): ticket is WorkTicket => ticket.id === phase.epicTicketId && ticket.type === 'epic',
    );
    if (!delivery || !epic) throw new Error(`Phase ${phase.name} delivery Ticket graph is incomplete`);
    delivery = (await this.registration.routeAndAssign(delivery.id)).ticket as WorkTicket;
    await this.saveTicketTransitionPath(delivery, ['in_progress', 'resolved', 'closed']);
    epic = (await this.registration.routeAndAssign(epic.id)).ticket as WorkTicket;
    await this.saveTicketTransitionPath(epic, ['in_progress', 'resolved', 'closed']);
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
      await this.state.selectCurrentPhase(project, next);
      return { nextPhaseId: next.id, projectDelivered: false };
    }
    if (project.state !== 'in_progress') {
      throw new Error(`Project ${project.name} is not in progress at final Phase completion`);
    }
    project = await this.saveProjectTransition(project, 'delivered');
    await this.saveProjectTransition(project, 'closed');
    return { projectDelivered: true };
  }

  async attachPhaseQuality(phaseId: ObjectId, qualityAssessmentId: ObjectId): Promise<Phase> {
    return this.state.attachPhaseQuality(await this.requirePhase(phaseId), qualityAssessmentId);
  }

  private async startTasks(story: WorkTicket): Promise<void> {
    const descendants = await this.ticketDescendants(story.id);
    for (const task of descendants) {
      if (task.state === 'created' || task.state === 'pending' || task.state === 'reopened') {
        const assigned = await this.registration.routeAndAssign(task.id, {
          inheritedFromTicketId: story.id,
        });
        await this.saveTicketTransition(assigned.ticket, 'in_progress');
      }
    }
  }

  private async completeTasks(story: Ticket): Promise<void> {
    const descendants = (await this.ticketDescendants(story.id)).reverse();
    for (let task of descendants) {
      const path = ticketClosurePath(task);
      if (path.includes('in_progress')) {
        task = (await this.registration.routeAndAssign(task.id, {
          forStepId: task.stepId,
          administrative: true,
        })).ticket;
      }
      if (path.length > 0) await this.saveTicketTransitionPath(task, path);
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

  private async attachQuality(step: Step, qualityAssessmentId: ObjectId): Promise<Step> {
    return this.state.attachQuality(step, qualityAssessmentId);
  }

  private async checkpoint(step: Step, reason: string): Promise<Checkpoint> {
    return this.state.checkpoint(step, reason);
  }

  private async requirePhase(id: ObjectId): Promise<Phase> {
    return this.state.requirePhase(id);
  }

  private async requireProject(id: ObjectId): Promise<Project> {
    return this.state.requireProject(id);
  }

  private async requireStep(id: ObjectId): Promise<Step> {
    return this.state.requireStep(id);
  }

  private async requireTicket(id: ObjectId): Promise<Ticket> {
    return this.state.requireTicket(id);
  }

  private async requirePassingQualityAssessment(step: Step, id: ObjectId): Promise<void> {
    return this.state.requirePassingQualityAssessment(step, id);
  }

  private async saveStepTransition(
    step: Step,
    next: Parameters<ProjectStateService['transitionStep']>[1],
    pendingReason?: PendingReason,
  ): Promise<Step> {
    return this.state.transitionStep(step, next, pendingReason);
  }

  private async savePhaseTransition(
    phase: Phase,
    next: Parameters<ProjectStateService['transitionPhase']>[1],
  ): Promise<Phase> {
    return this.state.transitionPhase(phase, next);
  }

  private async saveProjectTransition(
    project: Project,
    next: Parameters<ProjectStateService['transitionProject']>[1],
  ): Promise<Project> {
    return this.state.transitionProject(project, next);
  }

  private async saveTicketTransition(
    ticket: Ticket,
    next: Parameters<ProjectStateService['transitionTicket']>[1],
    pendingReason?: PendingReason,
  ): Promise<Ticket> {
    return this.state.transitionTicket(ticket, next, pendingReason);
  }

  private async saveTicketTransitionPath(
    ticket: Ticket,
    path: readonly Parameters<ProjectStateService['transitionTicket']>[1][],
    pendingReason?: PendingReason,
  ): Promise<Ticket> {
    return this.state.transitionTicketPath(ticket, path, pendingReason);
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

function ticketClosurePath(
  ticket: Ticket,
): Array<'in_progress' | 'resolved' | 'closed'> {
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
