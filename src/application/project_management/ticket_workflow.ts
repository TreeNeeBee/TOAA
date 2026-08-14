import { createObjectEnvelope, reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import { stepDependsOn, stepSatisfiesDependency, type Step, type StepType } from '../../domain/steps/step.js';
import {
  TICKET_PRIORITY,
  TicketSchema,
  transitionTicket,
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
import { ChangelistSchema, type Changelist } from '../../domain/evidence/evidence.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { capabilitiesForStep } from '../../domain/workflow/role_profile.js';
import { TicketLifecycleService, releaseCapacityFor } from './ticket_lifecycle_service.js';
import { TicketTraceService } from './ticket_trace_service.js';
import { createDomainEvent } from '../observability/domain_event_factory.js';
import type { ActorRegistration } from '../../domain/project_management/index.js';
import type { PersistedDomainObject } from '../../domain/objects/persisted.js';
import { TicketCatalog } from './ticket_catalog.js';
import { TicketBlockerService } from './ticket_blocker_service.js';

export class TicketWorkflow {
  private readonly lifecycle: TicketLifecycleService;
  private readonly traces: TicketTraceService;
  private readonly catalog: TicketCatalog;
  private readonly blockers: TicketBlockerService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.lifecycle = new TicketLifecycleService(repository);
    this.traces = new TicketTraceService(repository);
    this.catalog = new TicketCatalog(repository);
    this.blockers = new TicketBlockerService(repository);
  }

  async list(): Promise<Ticket[]> {
    return this.catalog.list();
  }

  async storyForStep(stepId: ObjectId): Promise<WorkTicket> {
    return this.catalog.storyForStep(stepId);
  }

  async openBug(input: {
    creatorActorId: ObjectId;
    failedStep: Step;
    targetStep: Step;
    verificationStep: Step;
    kind: BugTicket['bugKind'];
    severity: BugTicket['severity'];
    message: string;
    summary: string;
    category: BugTicket['failure']['category'];
    code: string;
    retryable: boolean;
    switchProvider: boolean;
    details?: Record<string, unknown>;
    rawEvidenceRef?: string;
    tool?: string;
    exitCode?: number;
    statusCode?: number;
    correlationId: ObjectId;
    causationId?: ObjectId;
    parentChangeRequestId?: ObjectId;
    routingObjects?: readonly PersistedDomainObject[];
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
    workspaceBinding?: TicketWorkspaceBinding;
  }): Promise<BugTicket> {
    const targetStory = await this.storyForStep(input.targetStep.id);
    const parentChangeRequest = input.parentChangeRequestId
      ? await this.requireTicket(input.parentChangeRequestId)
      : undefined;
    if (parentChangeRequest && parentChangeRequest.type !== 'change-request') {
      throw new Error(`Bug parent ${parentChangeRequest.id} is not a Change Request`);
    }
    const causationTicket = input.causationId
      ? await this.ticketIfPresent(input.causationId)
      : undefined;
    const existing = (await this.list()).find((ticket): ticket is BugTicket =>
      ticket.type === 'bug' &&
      ticket.state !== 'closed' &&
      ticket.state !== 'cancelled' &&
      ticket.projectId === input.targetStep.projectId &&
      ticket.parentTicketId === (parentChangeRequest?.id ?? targetStory.id) &&
      ticket.failure.failedStepId === input.failedStep.id &&
      ticket.failure.targetStepId === input.targetStep.id &&
      ticket.failure.code === input.code &&
      ticket.failure.summary === input.summary,
    );
    if (existing) return existing;
    const envelope = createObjectEnvelope({
      name: await this.nextName('BUG', input.targetStep.name.split('-')[0] ?? 'P'),
      objectType: 'ticket',
      projectId: input.targetStep.projectId,
    });
    const workspaceBinding = inheritedWorkspaceBinding(
      input.workspaceBinding ?? parentChangeRequest?.workspaceBinding ??
        causationTicket?.workspaceBinding ?? targetStory.workspaceBinding,
      envelope.createdAt,
    );
    const bug = TicketSchema.parse({
      ...envelope,
      type: 'bug',
      phaseId: input.targetStep.phaseId,
      stepId: input.failedStep.id,
      role: input.targetStep.role,
      agent: 'Debugger',
      creatorActorId: input.creatorActorId,
      requiredCapabilities: capabilitiesForStep(input.targetStep.type, 'bug'),
      priority: severityPriority(input.severity),
      parentTicketId: parentChangeRequest?.id ?? targetStory.id,
      rootTicketId: targetStory.rootTicketId,
      description: input.summary,
      acceptance: [
        `Repair ${input.targetStep.name} without unrelated rewrites.`,
        `Propagate the accepted correction through Change Requests until ${input.verificationStep.name} passes.`,
        'Persist the verified solution to debug-wiki.',
      ],
      relatedTicketIds: [targetStory.id, ...(parentChangeRequest ? [parentChangeRequest.id] : [])],
      ...(workspaceBinding
        ? { workspaceBinding, workspaceBindingHistory: [workspaceBinding] }
        : {}),
      state: 'created',
      submittedAt: envelope.createdAt,
      source: {
        kind: input.sourceKind ?? 'runtime',
        correlationId: input.correlationId,
        causationId: input.causationId,
        externalId: input.sourceExternalId ?? input.failedStep.name,
      },
      bugKind: input.kind,
      maxAttempts: input.targetStep.maxAttempts,
      severity: input.severity,
      failure: {
        category: input.category,
        code: input.code,
        message: input.message,
        summary: input.summary,
        retryable: input.retryable,
        switchProvider: input.switchProvider,
        details: input.details,
        rawEvidenceRef: input.rawEvidenceRef,
        failedStepId: input.failedStep.id,
        failedStepType: input.failedStep.type,
        targetStepId: input.targetStep.id,
        targetStepType: input.targetStep.type,
        verificationStepId: input.verificationStep.id,
        verificationStepType: input.verificationStep.type,
        tool: input.tool,
        exitCode: input.exitCode,
        statusCode: input.statusCode,
      },
    }) as BugTicket;
    const blockedStory = await this.blockers.prepareWorkIfLive(targetStory, bug.id, 'defect');
    // A defect found by a verification Step blocks that Step's own Story too: its verdict cannot be
    // trusted until the repair lands. Leaving it in progress would also keep the verifying actor's
    // capacity held while the correction is routed back through the very same Step.
    const failedStory = input.failedStep.id === input.targetStep.id
      ? undefined
      : await this.storyForStep(input.failedStep.id);
    const blockedFailedStory = failedStory
      ? await this.blockers.prepareWorkIfLive(failedStory, bug.id, 'defect')
      : undefined;
    const blockedParent = parentChangeRequest
      ? await this.blockers.prepare(parentChangeRequest, bug.id, 'defect')
      : undefined;
    await this.repository.commit([
      ...(input.routingObjects ?? []),
      bug,
      ...blockedStory,
      ...(blockedFailedStory ?? []),
      ...(blockedParent ?? []),
    ]);
    return bug;
  }

  async openEnhancement(input: {
    creatorActorId: ObjectId;
    sourceStep: Step;
    targetStep: Step;
    verificationStep: Step;
    kind: EnhancementTicket['enhancementKind'];
    finding: string;
    affectedArtifacts?: string[];
    sourceQualityAssessmentId?: ObjectId;
    sourceBugTicketId?: ObjectId;
    parentChangeRequestId?: ObjectId;
    correlationId: ObjectId;
    causationId?: ObjectId;
    routingObjects?: readonly PersistedDomainObject[];
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
    workspaceBinding?: TicketWorkspaceBinding;
  }): Promise<EnhancementTicket> {
    const targetStory = await this.storyForStep(input.targetStep.id);
    const parentChangeRequest = input.parentChangeRequestId
      ? await this.requireTicket(input.parentChangeRequestId)
      : undefined;
    if (parentChangeRequest && parentChangeRequest.type !== 'change-request') {
      throw new Error(`Enhancement parent ${parentChangeRequest.id} is not a Change Request`);
    }
    const causationTicket = input.causationId
      ? await this.ticketIfPresent(input.causationId)
      : undefined;
    const existing = (await this.list()).find((ticket): ticket is EnhancementTicket =>
      ticket.type === 'enhancement' &&
      ticket.state !== 'closed' &&
      ticket.state !== 'cancelled' &&
      ticket.projectId === input.targetStep.projectId &&
      ticket.parentTicketId === (parentChangeRequest?.id ?? targetStory.id) &&
      ticket.stepId === input.sourceStep.id &&
      ticket.targetStepId === input.targetStep.id &&
      ticket.enhancementKind === input.kind &&
      ticket.sourceQualityAssessmentId === input.sourceQualityAssessmentId &&
      ticket.finding === input.finding,
    );
    if (existing) return existing;
    const envelope = createObjectEnvelope({
      name: await this.nextName('ENH', input.targetStep.name.split('-')[0] ?? 'P'),
      objectType: 'ticket',
      projectId: input.targetStep.projectId,
    });
    const workspaceBinding = inheritedWorkspaceBinding(
      input.workspaceBinding ?? parentChangeRequest?.workspaceBinding ??
        causationTicket?.workspaceBinding ?? targetStory.workspaceBinding,
      envelope.createdAt,
    );
    const enhancement = TicketSchema.parse({
      ...envelope,
      type: 'enhancement',
      phaseId: input.targetStep.phaseId,
      stepId: input.sourceStep.id,
      role: input.targetStep.role,
      agent: input.targetStep.agent,
      creatorActorId: input.creatorActorId,
      requiredCapabilities: capabilitiesForStep(input.targetStep.type, 'enhancement'),
      priority: TICKET_PRIORITY.high,
      parentTicketId: parentChangeRequest?.id ?? targetStory.id,
      rootTicketId: targetStory.rootTicketId,
      description: input.finding,
      acceptance: [input.finding, `Pass ${input.verificationStep.name}.`],
      relatedTicketIds: [targetStory.id, ...(parentChangeRequest ? [parentChangeRequest.id] : [])],
      ...(workspaceBinding
        ? { workspaceBinding, workspaceBindingHistory: [workspaceBinding] }
        : {}),
      maxAttempts: input.targetStep.maxAttempts,
      state: 'created',
      submittedAt: envelope.createdAt,
      source: {
        kind: input.sourceKind ?? 'quality-gate',
        correlationId: input.correlationId,
        causationId: input.causationId,
        externalId: input.sourceExternalId ?? input.sourceStep.name,
      },
      enhancementKind: input.kind,
      finding: input.finding,
      affectedArtifacts: input.affectedArtifacts ?? [],
      sourceQualityAssessmentId: input.sourceQualityAssessmentId,
      sourceBugTicketId: input.sourceBugTicketId,
      targetStepId: input.targetStep.id,
      verificationStepId: input.verificationStep.id,
    }) as EnhancementTicket;
    const blockedStory = await this.blockers.prepareWorkIfLive(
      targetStory,
      enhancement.id,
      'quality-gap',
    );
    const blockedParent = parentChangeRequest
      ? await this.blockers.prepare(parentChangeRequest, enhancement.id, 'quality-gap')
      : undefined;
    await this.repository.commit([
      ...(input.routingObjects ?? []),
      enhancement,
      ...blockedStory,
      ...(blockedParent ?? []),
    ]);
    return enhancement;
  }

  /**
   * A Change Request that asks HIGH_LEVEL_DESIGN for packages a later Step turned out to need.
   *
   * Distinct from the corrective chain: nothing failed and nothing is being repaired. The Step
   * discovered a requirement the accepted design did not anticipate, so this opens against the
   * design directly rather than descending from a Bug, and its source is the Step that asked.
   */
  async openDependencyChangeRequest(input: {
    creatorActorId: ObjectId;
    requestingStepId: ObjectId;
    /** The Ticket whose attempt raised the request; parked so it stops holding its role's capacity. */
    requestingTicket?: Ticket;
    /**
     * `request` asks the manifest owner to change the dependency set. `recheck` tells a downstream
     * Step the set already changed and asks whether its own work still holds — it owns no part of
     * the manifest and must not be handed the request's instructions.
     */
    kind?: 'request' | 'recheck';
    targetStep: Step;
    packages: string[];
    reason: string;
    correlationId: ObjectId;
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
    /** Previous downstream re-check in the same dependency-change chain. */
    parentChangeRequestId?: ObjectId;
  }): Promise<ChangeRequestTicket> {
    const existing = await this.findOpenDependencyRequest(
      input.targetStep,
      input.packages,
      input.requestingStepId,
    );
    if (existing) return existing;
    // The work that discovered the need is the source; the request stands on its own rather than
    // descending from a defect, so it is also the root of its own thread.
    const requester = await this.storyForStep(input.requestingStepId);
    const requestingTicket = input.requestingTicket
      ? await this.requireTicket(input.requestingTicket.id)
      : undefined;
    const envelope = createObjectEnvelope({
      name: await this.nextName('DEP', input.targetStep.name.split('-')[0] ?? 'P'),
      objectType: 'ticket',
      projectId: input.targetStep.projectId,
    });
    const summary = `Dependencies required downstream: ${input.packages.join(', ')}`;
    const workspaceBinding = inheritedWorkspaceBinding(
      requestingTicket?.workspaceBinding ?? requester.workspaceBinding,
      envelope.createdAt,
    );
    const request = TicketSchema.parse({
      ...envelope,
      type: 'change-request',
      phaseId: input.targetStep.phaseId,
      stepId: input.targetStep.id,
      role: input.targetStep.role,
      agent: input.targetStep.agent,
      creatorActorId: input.creatorActorId,
      requiredCapabilities: capabilitiesForStep(input.targetStep.type, 'change-request'),
      priority: TICKET_PRIORITY.high,
      parentTicketId: requester.id,
      description: `${summary}. ${input.reason}`,
      acceptance: input.kind === 'recheck'
        ? [
            `Confirm ${input.targetStep.name} still holds against the changed dependency set.`,
            'Record an explicit not-applicable disposition when nothing here is affected.',
          ]
        : [
            'Check the requested packages against the accepted dependency set for compatibility.',
            'Update the manifest through add_dependency so the sandbox is rebuilt with them.',
          ],
      dependencyTicketIds: [],
      state: 'created',
      submittedAt: envelope.createdAt,
      source: {
        kind: input.sourceKind ?? 'runtime',
        correlationId: input.correlationId,
        causationId: requester.id,
        externalId: input.sourceExternalId,
      },
      rootTicketId: requester.rootTicketId,
      relatedTicketIds: [requester.id],
      ...(workspaceBinding
        ? { workspaceBinding, workspaceBindingHistory: [workspaceBinding] }
        : {}),
      sourceTicketId: requester.id,
      parentChangeRequestId: input.parentChangeRequestId,
      triggerStepId: input.requestingStepId,
      sourceStepId: input.requestingStepId,
      targetStepId: input.targetStep.id,
      contractDelta: {
        summary,
        before: [],
        after: input.packages.map((name) => `${name} is available to the project`),
        affectedArtifacts: ['package.json'],
      },
      // A re-check hop owns none of the manifest and cannot call add_dependency. Handing it the
      // request's plan told a CODE Step to "add cron after a compatibility check" when cron was
      // already installed — nothing to do, no stated way to conclude, and it listed directories
      // until the no-progress guard stopped it.
      implementationPlan: input.kind === 'recheck'
        ? [
            `Check this Step's artifacts and tests against the accepted dependency change (${input.packages.join(', ')}).`,
            'Apply only what this Step owns; if nothing here is affected, record that as the outcome.',
          ]
        : [`Add ${input.packages.join(', ')} after a compatibility check.`],
      verificationGate: input.kind === 'recheck'
        ? [`${input.targetStep.name} still holds against the changed dependency set.`]
        : ['The sandbox rebuilds and the requesting Step can resolve the packages.'],
    }) as ChangeRequestTicket;
    await this.repository.insert(request, request.state);
    // The work that raised the request cannot proceed until the design answers, and a Ticket that
    // cannot proceed must not hold its role's capacity. A CODE Bug left `in_progress` here kept the
    // developer's only slot, and the re-check Change Request the answer arrives as targets that same
    // Step — so the run aborted with no actor able to take it.
    if (requestingTicket) {
      await this.repository.commit(
        await this.blockers.prepare(requestingTicket, request.id, 'dependency'),
      );
    }
    return request;
  }

  private async findOpenDependencyRequest(
    target: Step,
    packages: readonly string[],
    requestingStepId: ObjectId,
  ): Promise<ChangeRequestTicket | undefined> {
    const wanted = new Set(packages);
    const objects = await this.repository.list({ objectType: 'ticket', projectId: target.projectId });
    return objects.find((object): object is ChangeRequestTicket =>
      object.objectType === 'ticket' &&
      object.type === 'change-request' &&
      object.targetStepId === target.id &&
      object.sourceStepId === requestingStepId &&
      object.state !== 'closed' &&
      object.state !== 'cancelled' &&
      object.contractDelta.after.every((line) => wanted.has(line.split(' ')[0] ?? '')) &&
      object.contractDelta.after.length === wanted.size);
  }

  async openChangeRequest(input: {
    creatorActorId: ObjectId;
    sourceTicketId: ObjectId;
    triggerStepId: ObjectId;
    sourceStepId: ObjectId;
    /** The one Step this CR is applied to; the chain grows a child per Step, not a list. */
    targetStepId: ObjectId;
    contractDelta: ChangeRequestTicket['contractDelta'];
    implementationPlan: string[];
    verificationGate: string[];
    parentChangeRequestId?: ObjectId;
  }): Promise<ChangeRequestTicket> {
    const targetObject = await this.repository.read(input.targetStepId);
    if (targetObject.objectType !== 'step') {
      throw new Error(`Change Request target ${input.targetStepId} is not a Step`);
    }
    const target = targetObject;
    const source = await this.requireTicket(input.sourceTicketId);
    if (source.type !== 'bug' && source.type !== 'enhancement') {
      throw new Error('Change Request source must be a Bug or Enhancement Ticket');
    }
    const parent = source.parentTicketId
      ? await this.requireTicket(source.parentTicketId)
      : undefined;
    if (!parent || !['story', 'task', 'change-request'].includes(parent.type)) {
      throw new Error(`Source Ticket ${source.id} does not belong to executable work`);
    }
    const existing = (await this.list()).find((ticket): ticket is ChangeRequestTicket =>
      ticket.type === 'change-request' &&
      ticket.state !== 'cancelled' &&
      ticket.sourceTicketId === source.id &&
      ticket.parentChangeRequestId === input.parentChangeRequestId,
    );
    if (existing) return existing;
    const envelope = createObjectEnvelope({
      name: await this.nextName('CR', parent.name.split('-')[0] ?? 'P'),
      objectType: 'ticket',
      projectId: source.projectId,
    });
    const workspaceBinding = inheritedWorkspaceBinding(source.workspaceBinding, envelope.createdAt);
    const request = TicketSchema.parse({
      ...envelope,
      type: 'change-request',
      phaseId: source.phaseId,
      // The CR works on its target Step, so it is routed to whoever owns that Step — not to the
      // role that happened to open it. A chain crosses roles by design.
      stepId: input.targetStepId,
      role: target.role,
      agent: target.agent,
      creatorActorId: input.creatorActorId,
      requiredCapabilities: capabilitiesForStep(target.type, 'change-request'),
      priority: source.priority,
      parentTicketId: parent.id,
      rootTicketId: source.rootTicketId,
      description: input.contractDelta.summary,
      acceptance: input.verificationGate,
      /** Source linkage is causal, not a scheduling dependency: the source waits for this CR. */
      dependencyTicketIds: [],
      relatedTicketIds: [source.id],
      ...(workspaceBinding
        ? { workspaceBinding, workspaceBindingHistory: [workspaceBinding] }
        : {}),
      state: 'created',
      submittedAt: envelope.createdAt,
      source: {
        kind: 'runtime',
        correlationId: source.source.correlationId,
        causationId: source.id,
      },
      sourceTicketId: source.id,
      maxAttempts: source.maxAttempts,
      parentChangeRequestId: input.parentChangeRequestId,
      triggerStepId: input.triggerStepId,
      sourceStepId: input.sourceStepId,
      targetStepId: input.targetStepId,
      originFailure: source.type === 'bug' ? source.failure : undefined,
      contractDelta: input.contractDelta,
      implementationPlan: input.implementationPlan,
      verificationGate: input.verificationGate,
    }) as ChangeRequestTicket;
    // Handing the source over happens once, at the head of the chain. A child CR carries the same
    // delta one Step further; by then the source is already blocked behind the chain and is not
    // in progress to hand off again.
    //
    // `parentChangeRequestId` alone cannot decide that, because it carries two relationships. It is
    // the previous hop of this chain only when the parent CR was opened against this same source
    // Ticket. When a Bug is raised inside a failing CR, that CR is recorded as the Bug's parent too
    // — but the Bug is a source in its own right, and the CR it propagates is the head of a new
    // chain whose source has never been handed off. Skipping the hand-off there also skips the
    // `changeRequestTicketIds` back-link, which is what keeps the Bug schedulable forever.
    const chainParent = input.parentChangeRequestId
      ? await this.requireTicket(input.parentChangeRequestId)
      : undefined;
    const continuesChain = chainParent?.type === 'change-request' &&
      chainParent.sourceTicketId === source.id;
    const sourceObjects = continuesChain
      ? []
      : await this.prepareSourceChangeRequest(source, request);
    await this.repository.commit([request, ...sourceObjects]);
    return request;
  }

  async setSolution(ticketId: ObjectId, solution: TicketSolution): Promise<Ticket> {
    let ticket = await this.requireTicket(ticketId);
    if (ticket.state === 'created' || ticket.state === 'reopened') {
      ticket = await this.saveTransition(ticket, 'in_progress');
    } else if (ticket.state === 'pending') {
      ticket = await this.saveTransition(ticket, 'in_progress');
    }
    const initiator = await this.processingActor(ticket);
    const eventType = solution.status === 'verified'
      ? 'verified'
      : solution.status === 'rejected'
        ? 'correction'
        : 'resolution_proposed';
    const built = await this.traces.build(ticket, [{
      eventType,
      initiatorActorId: initiator.id,
      initiatorRole: initiator.role,
      assignmentId: ticket.activeAssignmentId,
      fromOwnerActorId: initiator.id,
      toOwnerActorId: initiator.id,
      reasonCode: `ticket.solution_${solution.status}`,
      reason: `${initiator.name} recorded a ${solution.status} solution for ${ticket.name}.`,
      evidenceRefs: ticket.changelistIds,
      correlationId: ticket.source.correlationId,
      causationId: ticket.id,
    }]);
    const updated = TicketSchema.parse({ ...built.ticket, solution });
    await this.repository.commit([
      ...built.events,
      updated,
      createDomainEvent({
        projectId: ticket.projectId,
        aggregate: { id: ticket.id, objectType: 'ticket' },
        eventType: `ticket.solution_${solution.status}`,
        payload: { solutionStatus: solution.status },
        phaseId: ticket.phaseId,
        stepId: ticket.stepId,
        ticketId: ticket.id,
        correlationId: ticket.source.correlationId,
        causationId: ticket.id,
        objectRevision: updated.revision,
      }),
    ]);
    return updated;
  }

  async setDebugWikiCandidates(ticketId: ObjectId, entryIds: readonly string[]): Promise<BugTicket> {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.type !== 'bug') throw new Error(`Ticket ${ticketId} is not a Bug`);
    const updated = TicketSchema.parse({
      ...ticket,
      ...reviseObjectEnvelope(ticket),
      debugWikiCandidateEntryIds: [...new Set(entryIds)],
    }) as BugTicket;
    await this.repository.update(updated, updated.state);
    return updated;
  }

  async prepareAttemptExtension(input: {
    ticket: Ticket;
    maxAttempts: number;
    pmActorId: ObjectId;
    decisionId: ObjectId;
    reason: string;
  }): Promise<{ ticket: Ticket; objects: PersistedDomainObject[] }> {
    if (input.maxAttempts <= input.ticket.maxAttempts) {
      throw new Error(`Attempt extension for ${input.ticket.name} must increase maxAttempts`);
    }
    const pm = await this.repository.read(input.pmActorId);
    if (pm.objectType !== 'actor-registration' || pm.role !== 'project-manager') {
      throw new Error(`Attempt extension for ${input.ticket.name} requires a registered Project Manager`);
    }
    const built = await this.traces.build(input.ticket, [{
      eventType: 'escalated',
      initiatorActorId: pm.id,
      initiatorRole: pm.role,
      assignmentId: input.ticket.activeAssignmentId,
      fromOwnerActorId: input.ticket.activeAssignmentId
        ? (await this.processingActor(input.ticket)).id
        : undefined,
      reasonCode: 'ticket.attempt_budget_extended',
      reason: input.reason,
      evidenceRefs: [input.decisionId],
      correlationId: input.ticket.source.correlationId,
      causationId: input.decisionId,
    }]);
    const ticket = TicketSchema.parse({
      ...built.ticket,
      maxAttempts: input.maxAttempts,
    });
    return {
      ticket,
      objects: [
        ...built.events,
        ticket,
        createDomainEvent({
          projectId: ticket.projectId,
          aggregate: { id: ticket.id, objectType: 'ticket' },
          eventType: 'ticket.attempt_budget_extended',
          payload: { previousMaxAttempts: input.ticket.maxAttempts, maxAttempts: input.maxAttempts },
          phaseId: ticket.phaseId,
          stepId: ticket.stepId,
          ticketId: ticket.id,
          correlationId: ticket.source.correlationId,
          causationId: input.decisionId,
          objectRevision: ticket.revision,
        }),
      ],
    };
  }

  async recordChange(input: {
    ticketId: ObjectId;
    stepId: ObjectId;
    summary: string;
    entries: Changelist['entries'];
    commit?: string;
    verification?: string[];
    verificationAssessmentId?: ObjectId;
    application?: ChangeRequestApplicationDecision;
  }): Promise<Changelist> {
    const ticket = await this.requireTicket(input.ticketId);
    if (input.verificationAssessmentId) {
      const assessment = await this.repository.read(input.verificationAssessmentId);
      if (
        assessment.objectType !== 'quality-assessment' ||
        assessment.subject.objectType !== 'step' ||
        assessment.subject.id !== input.stepId ||
        !assessment.passed
      ) {
        throw new Error('Changelist verificationAssessmentId must reference a passing assessment for the same Step');
      }
    }
    const equivalent = await this.findEquivalentChangelist(ticket, input);
    if (equivalent) return equivalent;
    const envelope = createObjectEnvelope({
      name: `${ticket.name}-CL${String(ticket.changelistIds.length + 1).padStart(2, '0')}`,
      objectType: 'changelist',
      projectId: ticket.projectId,
    });
    const changelist = ChangelistSchema.parse({
      ...envelope,
      ticketId: ticket.id,
      stepId: input.stepId,
      entries: input.entries,
      commit: input.commit,
      summary: input.summary,
      verification: input.verification ?? [],
    });
    const initiator = await this.processingActor(ticket);
    const built = await this.traces.build(ticket, [{
      eventType: ticket.type === 'change-request' ? 'handed_off' : 'resolution_proposed',
      initiatorActorId: initiator.id,
      initiatorRole: initiator.role,
      assignmentId: ticket.activeAssignmentId,
      fromOwnerActorId: initiator.id,
      toOwnerActorId: initiator.id,
      reasonCode: 'ticket.changelist_recorded',
      reason: `${initiator.name} recorded Changelist ${changelist.name}: ${input.summary}`,
      evidenceRefs: [changelist.id, ...(input.verificationAssessmentId ? [input.verificationAssessmentId] : [])],
      correlationId: ticket.source.correlationId,
      causationId: changelist.id,
    }]);
    let updated = TicketSchema.parse({
      ...built.ticket,
      changelistIds: [...ticket.changelistIds, changelist.id],
    });
    if (updated.type === 'change-request') {
      updated = TicketSchema.parse({
        ...updated,
        applications: [
          ...updated.applications,
          {
            stepId: input.stepId,
            changelistId: changelist.id,
            verificationAssessmentId: input.verificationAssessmentId,
            appliedAt: new Date().toISOString(),
            ...(input.application ?? {
              outcome: 'applied' as const,
              reasonCategory: 'contract-applied' as const,
              inspectedArtifacts: [],
              evidence: [],
            }),
          },
        ],
      });
    }
    await this.repository.commit([
      changelist,
      ...built.events,
      updated,
      createDomainEvent({
        projectId: ticket.projectId,
        aggregate: { id: ticket.id, objectType: 'ticket' },
        eventType: 'ticket.changelist_recorded',
        payload: {
          changelistId: changelist.id,
          stepId: input.stepId,
          ...(ticket.type === 'change-request'
            ? { applicationOutcome: input.application?.outcome ?? 'applied' }
            : {}),
        },
        phaseId: ticket.phaseId,
        stepId: input.stepId,
        ticketId: ticket.id,
        correlationId: ticket.source.correlationId,
        causationId: changelist.id,
        objectRevision: updated.revision,
      }),
    ]);
    return changelist;
  }

  async closeVerified(ticketId: ObjectId): Promise<Ticket> {
    let ticket = await this.requireTicket(ticketId);
    if (ticket.state === 'cancelled') {
      throw new Error(`Cancelled Ticket ${ticket.name} must be reopened before verified closure`);
    }
    const request = ticket.type === 'change-request' ? ticket : undefined;
    if (request) {
      // Its own Step, and only that one. A downstream Step's evidence belongs to the child CR
      // opened for it, which closes on its own.
      const verified = request.applications.some((application) =>
        application.stepId === request.targetStepId && application.verificationAssessmentId);
      if (!verified) {
        throw new Error(
          `Change Request ${request.name} is missing a verified application for ${request.targetStepId}`,
        );
      }
    }
    if (ticket.solution?.status !== 'verified') {
      throw new Error(`Ticket ${ticket.name} cannot close without a verified solution`);
    }
    if (ticket.state !== 'closed') {
      const path: Array<'in_progress' | 'resolved' | 'closed'> = [];
      if (ticket.state === 'created' || ticket.state === 'pending' || ticket.state === 'reopened') {
        path.push('in_progress');
      }
      if (ticket.state !== 'resolved') path.push('resolved');
      path.push('closed');
      ticket = await this.lifecycle.transitionPath(ticket, path, {
        reasonCode: 'ticket.verified_close',
        reason: `Ticket ${ticket.name} passed all verification gates and closed.`,
        evidenceRefs: [...ticket.changelistIds, ...(ticket.solution?.verification ?? [])],
      });
    }

    if (ticket.type === 'change-request') {
      let source = await this.requireTicket(ticket.sourceTicketId);
      // Only a corrective chain resolves its source on closure. A dependency request is opened by
      // the Story that needed packages: nothing about that Story is being repaired, and it carries
      // no implementation solution to mark verified.
      if (source.type !== 'bug' && source.type !== 'enhancement') return ticket;
      const openSibling = (await this.list()).some((candidate) =>
        candidate.type === 'change-request' &&
        candidate.sourceTicketId === source.id &&
        candidate.id !== ticket.id &&
        candidate.state !== 'closed' &&
        candidate.state !== 'cancelled',
      );
      if (!openSibling) {
        if (!source.solution) {
          throw new Error(`Source Ticket ${source.name} has no implementation solution`);
        }
        if (source.solution.status !== 'verified') {
          source = await this.setSolution(source.id, {
            ...source.solution,
            status: 'verified',
            verification: [
              ...source.solution.verification,
              `Change Request ${ticket.name} completed all affected Step gates.`,
            ],
            updatedAt: new Date().toISOString(),
          });
        }
        await this.closeVerified(source.id);
      }
    }
    await this.blockers.release(ticket);
    return ticket;
  }

  /**
   * Hands back work the scheduler can no longer reach.
   *
   * Work left `in_progress` is not by itself a problem: a deferred infrastructure failure leaves its
   * Ticket exactly there so the next run resumes it. What cannot recover is a Ticket whose parent
   * has since been blocked or parked — the scheduler will not start work it believes is already
   * running, and will not descend into a parent it cannot work. A run killed mid-attempt left three
   * tasks in that position; every later pass then saw active work it could not advance, and the
   * phase stopped for lack of semantic progress with every actor idle.
   */
  async reclaimUnreachableWork(projectId: ObjectId): Promise<number> {
    const objects = await this.repository.list({ objectType: 'ticket', projectId });
    const byId = new Map(objects
      .filter((object): object is Ticket => object.objectType === 'ticket')
      .map((ticket) => [ticket.id, ticket]));
    let reclaimed = 0;
    for (const ticket of byId.values()) {
      if (ticket.state !== 'in_progress' || !ticket.parentTicketId) continue;
      const parent = byId.get(ticket.parentTicketId);
      const parentBlocked = parent !== undefined &&
        (parent.state === 'pending' || parent.blockedByTicketIds.length > 0);
      if (!parentBlocked) continue;
      const prepared = await this.lifecycle.prepareTransition(ticket, 'pending', {
        pendingReason: 'interrupted',
      });
      const released = await releaseCapacityFor(this.repository, ticket);
      await this.repository.commit([...prepared.objects, ...(released ? [released] : [])]);
      reclaimed += 1;
    }
    return reclaimed;
  }

  /**
   * Releases a Ticket parked behind a corrective hop that is itself waiting on that Ticket's Step.
   *
   * A repair chain that propagates a change forward opens hops on downstream Steps, and those Steps
   * cannot become ready until the Step that discovered the defect delivers. While its Story stays
   * parked, neither side can move: the Phase reports no semantic progress with every actor idle.
   * Prevention lives where the hop is opened; this reclaims the runs that already recorded one.
   */
  async releaseCyclicCorrectiveBlockers(projectId: ObjectId): Promise<number> {
    const objects = await this.repository.list({ projectId });
    const tickets = objects.filter((object): object is Ticket => object.objectType === 'ticket');
    const steps = new Map(objects
      .filter((object): object is Step => object.objectType === 'step')
      .map((step) => [step.id, step]));
    const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
    // Unparking is capacity-bounded. A Ticket that resumes takes its role's slot back, so a role
    // with one slot cannot take back two at once: the live run unparked a Story and a Change
    // Request that both needed system-engineer, and routing then refused the second at 2/1 and
    // aborted. What is left parked is released by a later pass, once the first one finishes.
    const assignments = new Map(objects
      .filter((object) => object.objectType === 'ticket-assignment')
      .map((assignment) => [assignment.id, assignment]));
    const headroom = new Map(objects
      .filter((object) => object.objectType === 'actor-registration')
      .map((actor) => [actor.id, actor.capacity - actor.activeAssignmentIds.length]));
    let released = 0;
    for (const ticket of tickets) {
      if (ticket.blockedByTicketIds.length === 0 || !ticket.stepId) continue;
      const own = steps.get(ticket.stepId);
      // A Step that already delivered satisfies its dependants, so a hop downstream of it is
      // reachable and the parking is the ordinary mid-repair hold.
      if (!own || stepSatisfiesDependency(own)) continue;
      for (const blockerId of ticket.blockedByTicketIds) {
        const blocker = byId.get(blockerId);
        if (!blocker) continue;
        // A Bug holds its Story directly and advances through Change Requests, so the hop that
        // cannot be reached is one edge further out than the blocker itself. Releasing only the
        // direct Story-to-hop edge left the same Phase idle: the Story was still parked behind the
        // Bug, and the Bug was still waiting for the hop that needed the Story.
        // Hops are found through each Change Request's own `sourceTicketId`, the direction the
        // closure cascade already trusts. The back-reference on the source is a denormalized copy
        // and had drifted in the live run: the hop holding the Phase was absent from it.
        const hops = blocker.type === 'change-request'
          ? [blocker]
          : tickets.filter((hop): hop is ChangeRequestTicket =>
            hop.type === 'change-request' && hop.sourceTicketId === blocker.id);
        const unreachable = hops.some((hop) => {
          if (hop.state === 'closed' || hop.state === 'cancelled') return false;
          const target = steps.get(hop.targetStepId);
          return target !== undefined &&
            target.id !== ticket.stepId &&
            stepDependsOn(target, ticket.stepId!, steps);
        });
        if (!unreachable) continue;
        // Re-read: releasing commits a revision, so a Ticket parked behind two such hops would
        // offer a stale copy on the second pass.
        const current = await this.requireTicket(ticket.id);
        const resumes = current.state === 'pending' && current.blockedByTicketIds.length === 1;
        const assignment = current.activeAssignmentId
          ? assignments.get(current.activeAssignmentId)
          : undefined;
        const owner = assignment?.objectType === 'ticket-assignment' && assignment.capacityConsumed
          ? assignment.assigneeActorId
          : undefined;
        if (resumes && owner !== undefined) {
          if ((headroom.get(owner) ?? 0) <= 0) continue;
          headroom.set(owner, (headroom.get(owner) ?? 0) - 1);
        }
        await this.blockers.releaseFrom(current, blockerId);
        released += 1;
      }
    }
    return released;
  }

  async reconcileClosedCorrectiveTickets(projectId: ObjectId): Promise<void> {
    const closed = (await this.list()).filter((ticket) =>
      ticket.projectId === projectId &&
      ticket.state === 'closed' &&
      (ticket.type === 'change-request' || ticket.type === 'bug' || ticket.type === 'enhancement'));
    for (const ticket of closed) await this.closeVerified(ticket.id);
  }

  async cancelUnresolved(ticketId: ObjectId): Promise<Ticket> {
    let ticket = await this.requireTicket(ticketId);
    if (ticket.state === 'cancelled' || ticket.state === 'closed') return ticket;
    if (ticket.solution || ticket.changelistIds.length > 0) {
      throw new Error(`Ticket ${ticket.name} has implementation evidence and cannot be cancelled as unresolved`);
    }
    if (ticket.state === 'resolved') {
      throw new Error(`Resolved Ticket ${ticket.name} cannot be cancelled as unresolved`);
    }
    ticket = await this.saveTransition(ticket, 'cancelled');
    await this.blockers.release(ticket);
    return ticket;
  }

  private async requireTicket(id: ObjectId): Promise<Ticket> {
    return this.catalog.require(id);
  }

  private async ticketIfPresent(id: ObjectId): Promise<Ticket | undefined> {
    try {
      const object = await this.repository.read(id);
      return object.objectType === 'ticket' ? object : undefined;
    } catch {
      return undefined;
    }
  }

  private async findEquivalentChangelist(
    ticket: Ticket,
    input: {
      stepId: ObjectId;
      summary: string;
      entries: Changelist['entries'];
      commit?: string;
      verification?: string[];
      verificationAssessmentId?: ObjectId;
    },
  ): Promise<Changelist | undefined> {
    if (ticket.type === 'change-request' && input.verificationAssessmentId) {
      const application = ticket.applications.find((candidate) =>
        candidate.stepId === input.stepId &&
        candidate.verificationAssessmentId === input.verificationAssessmentId,
      );
      if (application) {
        const object = await this.repository.read(application.changelistId);
        if (object.objectType !== 'changelist') {
          throw new Error(`Change Request ${ticket.name} references an invalid Changelist`);
        }
        return object;
      }
    }
    for (const changelistId of ticket.changelistIds) {
      const object = await this.repository.read(changelistId);
      if (object.objectType !== 'changelist') continue;
      if (
        object.stepId === input.stepId &&
        object.summary === input.summary &&
        object.commit === input.commit &&
        canonicalJson(object.entries) === canonicalJson(input.entries) &&
        canonicalJson(object.verification) === canonicalJson(input.verification ?? [])
      ) {
        return object;
      }
    }
    return undefined;
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

  private async prepareSourceChangeRequest(
    source: BugTicket | EnhancementTicket,
    request: ChangeRequestTicket,
  ): Promise<PersistedDomainObject[]> {
    if (source.state !== 'in_progress') {
      throw new Error(`Source Ticket ${source.name} must be in progress before handing off a Change Request`);
    }
    const actor = await this.processingActor(source);
    const prepared = await this.lifecycle.prepareTransition(source, 'pending', {
      pendingReason: source.type === 'bug' ? 'defect' : 'quality-gap',
      beforeTrace: [{
        eventType: 'handed_off',
        initiatorActorId: actor.id,
        initiatorRole: actor.role,
        assignmentId: source.activeAssignmentId,
        fromOwnerActorId: actor.id,
        toOwnerActorId: actor.id,
        reasonCode: 'ticket.change_request_handoff',
        reason: `Implementation is handed off through Change Request ${request.name}.`,
        evidenceRefs: [request.id],
        correlationId: source.source.correlationId,
        causationId: request.id,
      }],
    });
    const linked = TicketSchema.parse({
      ...prepared.ticket,
      changeRequestTicketIds: [...new Set([...source.changeRequestTicketIds, request.id])],
      relatedTicketIds: [...new Set([...source.relatedTicketIds, request.id])],
    });
    return replaceTicket(prepared.objects, linked);
  }

  private async saveTransition(
    ticket: Ticket,
    next: Parameters<typeof transitionTicket>[1],
    pendingReason?: 'defect' | 'quality-gap',
  ): Promise<Ticket> {
    return this.lifecycle.transition(ticket, next, { pendingReason });
  }

  private async nextName(prefix: string, phaseName: string): Promise<string> {
    return this.catalog.nextName(prefix, phaseName);
  }
}

function severityPriority(severity: BugTicket['severity']): number {
  if (severity === 'critical') return TICKET_PRIORITY.critical;
  if (severity === 'high') return TICKET_PRIORITY.high;
  if (severity === 'medium') return TICKET_PRIORITY.normal;
  return TICKET_PRIORITY.low;
}

function inheritedWorkspaceBinding(
  binding: TicketWorkspaceBinding | undefined,
  boundAt: string,
): TicketWorkspaceBinding | undefined {
  return binding ? { ...binding, reason: 'inherited', boundAt } : undefined;
}

function replaceTicket(
  objects: readonly PersistedDomainObject[],
  ticket: Ticket,
): PersistedDomainObject[] {
  return objects.map((object) =>
    object.objectType === 'ticket' && object.id === ticket.id ? ticket : object,
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function verificationStepTypeForFailure(type: StepType): StepType {
  return type;
}
