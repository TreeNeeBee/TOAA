import { createObjectEnvelope, reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { Step, StepType } from '../../domain/steps/step.js';
import {
  TICKET_PRIORITY,
  TicketSchema,
  transitionTicket,
  type BugTicket,
  type ChangeRequestTicket,
  type EnhancementTicket,
  type Ticket,
  type TicketSolution,
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

export class TicketWorkflow {
  private readonly lifecycle: TicketLifecycleService;
  private readonly traces: TicketTraceService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.lifecycle = new TicketLifecycleService(repository);
    this.traces = new TicketTraceService(repository);
  }

  async list(): Promise<Ticket[]> {
    const tickets: Ticket[] = [];
    for (const entry of this.repository.registry.byType('ticket')) {
      const object = await this.repository.read(entry.id);
      if (object.objectType === 'ticket') tickets.push(object);
    }
    return tickets;
  }

  async storyForStep(stepId: ObjectId): Promise<WorkTicket> {
    const story = (await this.list()).find(
      (ticket): ticket is WorkTicket =>
        ticket.type === 'story' &&
        ticket.workKind === 'v-model-step' &&
        ticket.stepId === stepId,
    );
    if (!story) throw new Error(`V-model Story not found for Step ${stepId}`);
    return story;
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
  }): Promise<BugTicket> {
    const targetStory = await this.storyForStep(input.targetStep.id);
    const parentChangeRequest = input.parentChangeRequestId
      ? await this.requireTicket(input.parentChangeRequestId)
      : undefined;
    if (parentChangeRequest && parentChangeRequest.type !== 'change-request') {
      throw new Error(`Bug parent ${parentChangeRequest.id} is not a Change Request`);
    }
    const existing = (await this.list()).find((ticket): ticket is BugTicket =>
      ticket.type === 'bug' &&
      ticket.state !== 'closed' &&
      ticket.state !== 'cancelled' &&
      ticket.projectId === input.targetStep.projectId &&
      ticket.parentTicketId === (parentChangeRequest?.id ?? targetStory.id) &&
      ticket.failure.failedStepId === input.failedStep.id &&
      ticket.failure.targetStepId === input.targetStep.id &&
      ticket.failure.code === input.code,
    );
    if (existing) return existing;
    const envelope = createObjectEnvelope({
      name: await this.nextName('BUG', input.targetStep.name.split('-')[0] ?? 'P'),
      objectType: 'ticket',
      projectId: input.targetStep.projectId,
    });
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
        `Pass ${input.verificationStep.name}.`,
        'Persist the verified solution to debug-wiki.',
      ],
      relatedTicketIds: [targetStory.id, ...(parentChangeRequest ? [parentChangeRequest.id] : [])],
      state: 'created',
      submittedAt: envelope.createdAt,
      source: {
        kind: 'runtime',
        correlationId: input.correlationId,
        causationId: input.causationId,
        externalId: input.failedStep.name,
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
    const blockedStory = await this.prepareBlockedTicket(targetStory, bug.id, 'defect');
    // A defect found by a verification Step blocks that Step's own Story too: its verdict cannot be
    // trusted until the repair lands. Leaving it in progress would also keep the verifying actor's
    // capacity held while the correction is routed back through the very same Step.
    const failedStory = input.failedStep.id === input.targetStep.id
      ? undefined
      : await this.storyForStep(input.failedStep.id);
    const blockedFailedStory = failedStory
      ? await this.prepareBlockedTicket(failedStory, bug.id, 'defect')
      : undefined;
    const blockedParent = parentChangeRequest
      ? await this.prepareBlockedTicket(parentChangeRequest, bug.id, 'defect')
      : undefined;
    await this.repository.commit([
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
    sourceQualityAssessmentId?: ObjectId;
    sourceBugTicketId?: ObjectId;
    parentChangeRequestId?: ObjectId;
    correlationId: ObjectId;
    causationId?: ObjectId;
  }): Promise<EnhancementTicket> {
    const targetStory = await this.storyForStep(input.targetStep.id);
    const parentChangeRequest = input.parentChangeRequestId
      ? await this.requireTicket(input.parentChangeRequestId)
      : undefined;
    if (parentChangeRequest && parentChangeRequest.type !== 'change-request') {
      throw new Error(`Enhancement parent ${parentChangeRequest.id} is not a Change Request`);
    }
    const existing = (await this.list()).find((ticket): ticket is EnhancementTicket =>
      ticket.type === 'enhancement' &&
      ticket.state !== 'closed' &&
      ticket.state !== 'cancelled' &&
      ticket.projectId === input.targetStep.projectId &&
      ticket.parentTicketId === (parentChangeRequest?.id ?? targetStory.id) &&
      ticket.stepId === input.sourceStep.id &&
      ticket.targetStepId === input.targetStep.id &&
      ticket.enhancementKind === input.kind &&
      ticket.sourceQualityAssessmentId === input.sourceQualityAssessmentId,
    );
    if (existing) return existing;
    const envelope = createObjectEnvelope({
      name: await this.nextName('ENH', input.targetStep.name.split('-')[0] ?? 'P'),
      objectType: 'ticket',
      projectId: input.targetStep.projectId,
    });
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
      maxAttempts: input.targetStep.maxAttempts,
      state: 'created',
      submittedAt: envelope.createdAt,
      source: {
        kind: 'quality-gate',
        correlationId: input.correlationId,
        causationId: input.causationId,
        externalId: input.sourceStep.name,
      },
      enhancementKind: input.kind,
      finding: input.finding,
      sourceQualityAssessmentId: input.sourceQualityAssessmentId,
      sourceBugTicketId: input.sourceBugTicketId,
      targetStepId: input.targetStep.id,
      verificationStepId: input.verificationStep.id,
    }) as EnhancementTicket;
    const blockedStory = await this.prepareBlockedTicket(targetStory, enhancement.id, 'quality-gap');
    const blockedParent = parentChangeRequest
      ? await this.prepareBlockedTicket(parentChangeRequest, enhancement.id, 'quality-gap')
      : undefined;
    await this.repository.commit([
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
    targetStep: Step;
    packages: string[];
    reason: string;
    correlationId: ObjectId;
  }): Promise<ChangeRequestTicket> {
    const existing = await this.findOpenDependencyRequest(input.targetStep, input.packages);
    if (existing) return existing;
    // The work that discovered the need is the source; the request stands on its own rather than
    // descending from a defect, so it is also the root of its own thread.
    const requester = await this.storyForStep(input.requestingStepId);
    const envelope = createObjectEnvelope({
      name: await this.nextName('DEP', input.targetStep.name.split('-')[0] ?? 'P'),
      objectType: 'ticket',
      projectId: input.targetStep.projectId,
    });
    const summary = `Dependencies required downstream: ${input.packages.join(', ')}`;
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
      description: `${summary}. ${input.reason}`,
      acceptance: [
        'Check the requested packages against the accepted dependency set for compatibility.',
        'Update the manifest through add_dependency so the sandbox is rebuilt with them.',
      ],
      dependencyTicketIds: [],
      state: 'created',
      submittedAt: envelope.createdAt,
      source: { kind: 'runtime', correlationId: input.correlationId, causationId: requester.id },
      rootTicketId: envelope.id,
      relatedTicketIds: [requester.id],
      sourceTicketId: requester.id,
      triggerStepId: input.requestingStepId,
      sourceStepId: input.requestingStepId,
      targetStepId: input.targetStep.id,
      contractDelta: {
        summary,
        before: [],
        after: input.packages.map((name) => `${name} is available to the project`),
        affectedArtifacts: ['package.json'],
      },
      implementationPlan: [`Add ${input.packages.join(', ')} after a compatibility check.`],
      verificationGate: ['The sandbox rebuilds and the requesting Step can resolve the packages.'],
    }) as ChangeRequestTicket;
    await this.repository.insert(request, request.state);
    // The work that raised the request cannot proceed until the design answers, and a Ticket that
    // cannot proceed must not hold its role's capacity. A CODE Bug left `in_progress` here kept the
    // developer's only slot, and the re-check Change Request the answer arrives as targets that same
    // Step — so the run aborted with no actor able to take it.
    if (input.requestingTicket) {
      await this.repository.commit(
        await this.prepareBlockedTicket(input.requestingTicket, request.id, 'dependency'),
      );
    }
    return request;
  }

  private async findOpenDependencyRequest(
    target: Step,
    packages: readonly string[],
  ): Promise<ChangeRequestTicket | undefined> {
    const wanted = new Set(packages);
    const objects = await this.repository.list({ objectType: 'ticket', projectId: target.projectId });
    return objects.find((object): object is ChangeRequestTicket =>
      object.objectType === 'ticket' &&
      object.type === 'change-request' &&
      object.targetStepId === target.id &&
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
    /** Overrides the description when a child carries a parent's delta forward. */
    summary?: string;
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
      description: input.summary ?? input.contractDelta.summary,
      acceptance: input.verificationGate,
      /** Source linkage is causal, not a scheduling dependency: the source waits for this CR. */
      dependencyTicketIds: [],
      relatedTicketIds: [source.id],
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
        payload: { changelistId: changelist.id, stepId: input.stepId },
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
    await this.releaseBlockedTickets(ticket);
    return ticket;
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
    await this.releaseBlockedTickets(ticket);
    return ticket;
  }

  private async requireTicket(id: ObjectId): Promise<Ticket> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'ticket') throw new Error(`Object ${id} is not a Ticket`);
    return object;
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

  private async prepareBlockedTicket(
    work: Ticket,
    blockerId: ObjectId,
    pendingReason: 'defect' | 'quality-gap' | 'dependency',
  ): Promise<PersistedDomainObject[]> {
    if (work.state === 'closed' || work.state === 'cancelled') {
      throw new Error(`Cannot block terminal Ticket ${work.name}`);
    }
    const actor = await this.processingActor(work);
    const marker = {
      eventType: 'escalated' as const,
      initiatorActorId: actor.id,
      initiatorRole: actor.role,
      assignmentId: work.activeAssignmentId,
      fromOwnerActorId: actor.id,
      toOwnerActorId: actor.id,
      reasonCode: `ticket.blocked_by_${pendingReason}`,
      reason: `${work.name} is blocked by corrective Ticket ${blockerId}.`,
      evidenceRefs: [blockerId],
      correlationId: work.source.correlationId,
      causationId: blockerId,
    };
    // Only work that has actually started needs a state change to become blocked. A Ticket still in
    // `created` has no owner yet, and the scheduler already skips any Ticket carrying a blocker, so
    // recording the blocker is enough and avoids forcing an assignment just to park it.
    const next = work.state === 'resolved'
      ? 'reopened' as const
      : work.state === 'in_progress'
        ? 'pending' as const
        : undefined;
    if (next) {
      const prepared = await this.lifecycle.prepareTransition(work, next, {
        pendingReason: next === 'pending' ? pendingReason : undefined,
        beforeTrace: [marker],
      });
      const updated = TicketSchema.parse({
        ...prepared.ticket,
        blockedByTicketIds: [...new Set([...prepared.ticket.blockedByTicketIds, blockerId])],
      });
      return replaceTicket(prepared.objects, updated);
    }
    const built = await this.traces.build(work, [marker]);
    const updated = TicketSchema.parse({
      ...built.ticket,
      blockedByTicketIds: [...new Set([...built.ticket.blockedByTicketIds, blockerId])],
    });
    // A Ticket parked before it started still holds the reservation routing made for it. Nothing
    // else reconciles that, and holding it would let one blocked Ticket exhaust a single-capacity
    // role and starve the corrective Ticket that unblocks it.
    const released = await releaseCapacityFor(this.repository, work);
    return [
      ...built.events,
      ...(released ? [released] : []),
      updated,
      createDomainEvent({
        projectId: work.projectId,
        aggregate: { id: work.id, objectType: 'ticket' },
        eventType: 'ticket.blocker_added',
        payload: { blockerId, pendingReason },
        phaseId: work.phaseId,
        stepId: work.stepId,
        ticketId: work.id,
        correlationId: work.source.correlationId,
        causationId: blockerId,
        objectRevision: updated.revision,
      }),
    ];
  }

  /**
   * Clears a terminal corrective Ticket from every Ticket it blocked. This sweeps the actual blocker
   * lists rather than a curated parent/related set, so a Ticket can never stay blocked by a Ticket
   * that is already closed or cancelled.
   */
  private async releaseBlockedTickets(blocker: Ticket): Promise<void> {
    const blocked = (await this.list()).filter(
      (ticket) => ticket.blockedByTicketIds.includes(blocker.id),
    );
    for (const ticket of blocked) await this.unblockTicket(ticket, blocker.id);
  }

  private async unblockTicket(blocked: Ticket, blockerId: ObjectId): Promise<void> {
    const blockers = blocked.blockedByTicketIds.filter((id) => id !== blockerId);
    if (blockers.length === 0 && blocked.state === 'pending') {
      const prepared = await this.lifecycle.prepareTransition(blocked, 'in_progress', {
        reasonCode: 'ticket.blocker_cleared',
        reason: `Corrective Ticket ${blockerId} closed; ${blocked.name} can resume.`,
        evidenceRefs: [blockerId],
      });
      const resumed = TicketSchema.parse({ ...prepared.ticket, blockedByTicketIds: blockers });
      await this.repository.commit(replaceTicket(prepared.objects, resumed));
      return;
    }
    const updated = TicketSchema.parse({
      ...blocked,
      ...reviseObjectEnvelope(blocked),
      blockedByTicketIds: blockers,
    });
    await this.repository.commit([updated, createDomainEvent({
      projectId: blocked.projectId,
      aggregate: { id: blocked.id, objectType: 'ticket' },
      eventType: 'ticket.blocker_removed',
      payload: { blockerId, remainingBlockers: blockers.length },
      phaseId: blocked.phaseId,
      stepId: blocked.stepId,
      ticketId: blocked.id,
      correlationId: blocked.source.correlationId,
      causationId: blockerId,
      objectRevision: updated.revision,
    })]);
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
    const expression = new RegExp(`^${escapeRegExp(prefix)}-${escapeRegExp(phaseName)}-(\\d+)$`, 'u');
    const used = this.repository.registry.byType('ticket').map((entry) => {
      const match = expression.exec(entry.name);
      return match ? Number.parseInt(match[1]!, 10) : 0;
    });
    return `${prefix}-${phaseName}-${String(Math.max(0, ...used) + 1).padStart(3, '0')}`;
  }
}

function severityPriority(severity: BugTicket['severity']): number {
  if (severity === 'critical') return TICKET_PRIORITY.critical;
  if (severity === 'high') return TICKET_PRIORITY.high;
  if (severity === 'medium') return TICKET_PRIORITY.normal;
  return TICKET_PRIORITY.low;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
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
