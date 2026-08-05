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
import { capabilitiesForRole } from '../../domain/workflow/role_profile.js';
import { TicketLifecycleService } from './ticket_lifecycle_service.js';
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
      requiredCapabilities: capabilitiesForRole(input.targetStep.role),
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
    const blockedParent = parentChangeRequest
      ? await this.prepareBlockedTicket(parentChangeRequest, bug.id, 'defect')
      : undefined;
    await this.repository.commit([
      bug,
      ...blockedStory,
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
      requiredCapabilities: capabilitiesForRole(input.targetStep.role),
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

  async openChangeRequest(input: {
    creatorActorId: ObjectId;
    sourceTicketId: ObjectId;
    triggerStepId: ObjectId;
    sourceStepId: ObjectId;
    affectedStepIds: ObjectId[];
    contractDelta: ChangeRequestTicket['contractDelta'];
    implementationPlan: string[];
    verificationGate: string[];
    parentChangeRequestId?: ObjectId;
  }): Promise<ChangeRequestTicket> {
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
      stepId: input.sourceStepId,
      role: parent.role,
      agent: parent.agent,
      creatorActorId: input.creatorActorId,
      requiredCapabilities: capabilitiesForRole(parent.role),
      priority: source.priority,
      parentTicketId: parent.id,
      rootTicketId: source.rootTicketId,
      description: input.contractDelta.summary,
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
      maxAttempts: source.maxAttempts * Math.max(1, new Set(input.affectedStepIds).size),
      parentChangeRequestId: input.parentChangeRequestId,
      triggerStepId: input.triggerStepId,
      sourceStepId: input.sourceStepId,
      affectedStepIds: [...new Set(input.affectedStepIds)],
      contractDelta: input.contractDelta,
      implementationPlan: input.implementationPlan,
      verificationGate: input.verificationGate,
    }) as ChangeRequestTicket;
    const sourceObjects = await this.prepareSourceChangeRequest(source, request);
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
    if (ticket.type === 'change-request') {
      const applied = new Set(ticket.applications
        .filter((application) => application.verificationAssessmentId)
        .map((application) => application.stepId));
      const missing = ticket.affectedStepIds.filter((stepId) => !applied.has(stepId));
      if (missing.length > 0) {
        throw new Error(`Change Request ${ticket.name} is missing verified applications for ${missing.join(', ')}`);
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
    await this.unblockParent(ticket);
    if (ticket.type === 'bug' || ticket.type === 'enhancement') {
      for (const relatedId of ticket.relatedTicketIds.filter((id) => id !== ticket.parentTicketId)) {
        const related = await this.requireTicket(relatedId);
        if (related.type === 'story' || related.type === 'task') {
          await this.unblockTicket(related, ticket.id);
        }
      }
    }
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
    await this.unblockParent(ticket);
    for (const relatedId of ticket.relatedTicketIds.filter((id) => id !== ticket.parentTicketId)) {
      const related = await this.requireTicket(relatedId);
      if (related.type === 'story' || related.type === 'task') {
        await this.unblockTicket(related, ticket.id);
      }
    }
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
    pendingReason: 'defect' | 'quality-gap',
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
    const next = work.state === 'resolved'
      ? 'reopened' as const
      : work.state === 'created' || work.state === 'in_progress'
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
    return [
      ...built.events,
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

  private async unblockParent(ticket: Ticket): Promise<void> {
    if (!ticket.parentTicketId) return;
    const parent = await this.requireTicket(ticket.parentTicketId);
    await this.unblockTicket(parent, ticket.id);
  }

  private async unblockTicket(parent: Ticket, blockerId: ObjectId): Promise<void> {
    const blockers = parent.blockedByTicketIds.filter((id) => id !== blockerId);
    if (blockers.length === 0 && parent.state === 'pending') {
      const prepared = await this.lifecycle.prepareTransition(parent, 'in_progress', {
        reasonCode: 'ticket.blocker_cleared',
        reason: `Corrective Ticket ${blockerId} closed; ${parent.name} can resume.`,
        evidenceRefs: [blockerId],
      });
      const resumed = TicketSchema.parse({ ...prepared.ticket, blockedByTicketIds: blockers });
      await this.repository.commit(replaceTicket(prepared.objects, resumed));
      return;
    }
    const updated = TicketSchema.parse({
      ...parent,
      ...reviseObjectEnvelope(parent),
      blockedByTicketIds: blockers,
    });
    await this.repository.commit([updated, createDomainEvent({
      projectId: parent.projectId,
      aggregate: { id: parent.id, objectType: 'ticket' },
      eventType: 'ticket.blocker_removed',
      payload: { blockerId, remainingBlockers: blockers.length },
      phaseId: parent.phaseId,
      stepId: parent.stepId,
      ticketId: parent.id,
      correlationId: parent.source.correlationId,
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
