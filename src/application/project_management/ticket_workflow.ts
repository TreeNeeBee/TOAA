import { createObjectEnvelope, reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import {
  STEP_TYPE_ORDER,
  stepDependsOn,
  stepSatisfiesDependency,
  type Step,
  type StepType,
} from '../../domain/steps/step.js';
import {
  TICKET_PRIORITY,
  TicketSchema,
  transitionTicket,
  type BugTicket,
  type BugVerificationContract,
  type ChangeRequestApplicationDecision,
  type ChangeRequestTicket,
  type EnhancementTicket,
  type Ticket,
  type TicketSource,
  type TicketSolution,
  type TicketWorkspaceBinding,
  type WorkTicket,
  type FailureIdentity,
  changeRequestHopKey,
  failureIdentityKey,
  linkDuplicateBugs,
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
import type { TestOutcome } from '../execution/test_outcome.js';
import type { DeliveryGateFinding } from '../../domain/quality/delivery_gate.js';
import {
  bugVerificationProven,
  bugVerificationSatisfied,
  passedTestSelectors,
} from './bug_verification.js';

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

  /** Applies PM's recorded duplicate decision without comparing or merging technical context. */
  async parkDuplicateBug(
    ticketId: ObjectId,
    originalTicketId: ObjectId,
    pmActorId: ObjectId,
    governanceObjects: readonly PersistedDomainObject[] = [],
  ): Promise<BugTicket> {
    const incoming = await this.requireTicket(ticketId);
    if (incoming.type !== 'bug') throw new Error(`Ticket ${incoming.name} is not a Bug`);
    if (incoming.duplicateOfTicketId) return incoming;
    const original = await this.requireTicket(originalTicketId);
    if (original.type !== 'bug') throw new Error(`Ticket ${original.name} is not a Bug`);
    if (!original.registeredAt || !incoming.registeredAt) {
      throw new Error('Duplicate Bugs must be registered before PM can link them');
    }
    if (original.state === 'closed' || original.state === 'cancelled' || original.duplicateOfTicketId) {
      throw new Error(`Bug ${original.name} is not an active authoritative duplicate target`);
    }
    const pm = await this.repository.read(pmActorId);
    if (pm.objectType !== 'actor-registration' || pm.role !== 'project-manager') {
      throw new Error(`Routing duplicate ${incoming.name} requires a registered Project Manager`);
    }
    const prepared = await this.lifecycle.prepareTransition(incoming, 'pending', {
      initiatorActorId: pm.id,
      pendingReason: 'duplicate',
      reasonCode: 'pm.duplicate_bug_parked',
      reason: `Project Manager linked ${incoming.name} to authoritative Bug ${original.name}.`,
      evidenceRefs: [original.id, ...governanceObjects.map((object) => object.id)],
    });
    const linked = linkDuplicateBugs(original, prepared.ticket as BugTicket);
    await this.repository.commit([
      ...governanceObjects,
      linked.original,
      ...replaceTicket(prepared.objects, linked.duplicate),
      createDomainEvent({
        projectId: incoming.projectId,
        aggregate: { id: incoming.id, objectType: 'ticket' },
        eventType: 'ticket.duplicate_linked',
        payload: { originalTicketId: original.id },
        phaseId: incoming.phaseId,
        stepId: incoming.stepId,
        ticketId: incoming.id,
        correlationId: incoming.source.correlationId,
        causationId: original.id,
        objectRevision: linked.duplicate.revision,
      }),
    ]);
    await this.blockers.release(linked.duplicate);
    return linked.duplicate;
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
    identity: FailureIdentity;
    verificationContract: BugVerificationContract;
  }): Promise<BugTicket> {
    assertBugContractInput(input);
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
        identity: input.identity,
      },
      verificationContract: input.verificationContract,
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
    const sourceBug = input.sourceBugTicketId
      ? await this.requireTicket(input.sourceBugTicketId)
      : undefined;
    if (sourceBug && sourceBug.type !== 'bug') {
      throw new Error(`Enhancement source ${sourceBug.id} is not a Bug`);
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
      ticket.sourceBugTicketId === input.sourceBugTicketId &&
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
      relatedTicketIds: [
        targetStory.id,
        ...(parentChangeRequest ? [parentChangeRequest.id] : []),
        ...(sourceBug ? [sourceBug.id] : []),
      ],
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
    const blockedSourceBug = sourceBug
      ? await this.blockers.prepare(sourceBug, enhancement.id, 'quality-gap')
      : undefined;
    await this.repository.commit([
      ...(input.routingObjects ?? []),
      enhancement,
      ...blockedStory,
      ...(blockedParent ?? []),
      ...(blockedSourceBug ?? []),
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
      changeKind: 'dependency',
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
      sourceTicketIds: [requester.id],
      parentChangeRequestId: input.parentChangeRequestId,
      triggerStepId: input.requestingStepId,
      sourceStepId: input.requestingStepId,
      targetStepId: input.targetStep.id,
      propagationStepIds: [input.targetStep.id],
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
    changeKind?: 'corrective' | 'contract-change';
    creatorActorId: ObjectId;
    sourceTicketIds: ObjectId[];
    triggerStepId: ObjectId;
    sourceStepId: ObjectId;
    /** The one Step this CR is applied to; the chain grows a child per Step, not a list. */
    targetStepId: ObjectId;
    propagationStepIds: ObjectId[];
    contractDelta: ChangeRequestTicket['contractDelta'];
    implementationPlan: string[];
    verificationGate: string[];
    parentChangeRequestId?: ObjectId;
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
    correlationId?: ObjectId;
  }): Promise<ChangeRequestTicket> {
    const changeKind = input.changeKind ?? 'corrective';
    if (input.propagationStepIds.length === 0 || input.propagationStepIds[0] !== input.targetStepId) {
      throw new Error('Change Request propagation must start with its target Step');
    }
    const sourceTickets = await Promise.all(input.sourceTicketIds.map((id) => this.requireTicket(id)));
    const validSource = changeKind === 'corrective'
      ? (ticket: Ticket) => ticket.type === 'bug' || ticket.type === 'enhancement'
      : (ticket: Ticket) => ticket.type === 'story' || ticket.type === 'task';
    if (sourceTickets.length === 0 || sourceTickets.some((ticket) => !validSource(ticket))) {
      throw new Error(changeKind === 'corrective'
        ? 'Corrective Change Request sources must be Bug or Enhancement Tickets'
        : 'Capability Change Request sources must be Story or Task Tickets');
    }
    const sources = sourceTickets;
    const correctiveSources = sources.filter((candidate): candidate is BugTicket | EnhancementTicket =>
      candidate.type === 'bug' || candidate.type === 'enhancement');
    const source = sources[0]!;
    if (sources.some((candidate) => candidate.projectId !== source.projectId || candidate.phaseId !== source.phaseId)) {
      throw new Error('Change Request sources must belong to the same Project and Phase');
    }
    const target = await this.validateChangeRequestScope(input, source);
    const parent = changeKind === 'contract-change'
      ? source
      : source.parentTicketId
        ? await this.requireTicket(source.parentTicketId)
        : undefined;
    if (!parent || !['story', 'task', 'change-request'].includes(parent.type)) {
      throw new Error(`Source Ticket ${source.id} does not belong to executable work`);
    }
    const hopKey = changeRequestHopKey({
      sourceStepId: input.sourceStepId,
      targetStepId: input.targetStepId,
      originFailedStepId: sources.find((candidate): candidate is BugTicket => candidate.type === 'bug')
        ?.failure.failedStepId,
      parentChangeRequestId: input.parentChangeRequestId,
    });
    const open = (await this.list()).filter((ticket): ticket is ChangeRequestTicket =>
      ticket.type === 'change-request' && ticket.state !== 'closed' && ticket.state !== 'cancelled',
    );
    const sameSource = open.find((ticket) =>
      ticket.changeKind === changeKind &&
      sameIds(ticket.sourceTicketIds, sources.map((candidate) => candidate.id)) &&
      ticket.parentChangeRequestId === input.parentChangeRequestId &&
      (changeKind === 'corrective' ||
        (ticket.targetStepId === input.targetStepId &&
          ticket.contractDelta.summary === input.contractDelta.summary)),
    );
    if (sameSource) return sameSource;
    const sameHop = open.find((ticket) =>
      ticket.state !== 'closed' &&
      changeRequestHopKey({
        sourceStepId: ticket.sourceStepId,
        targetStepId: ticket.targetStepId,
        originFailedStepId: ticket.originFailures[0]?.failedStepId,
        parentChangeRequestId: ticket.parentChangeRequestId,
      }) === hopKey,
    );
    if (sameHop && changeKind === 'corrective') {
      return await this.mergeChangeRequestHop(
        sameHop,
        correctiveSources,
        input.contractDelta,
        input.propagationStepIds,
      );
    }
    const envelope = createObjectEnvelope({
      name: await this.nextName('CR', parent.name.split('-')[0] ?? 'P'),
      objectType: 'ticket',
      projectId: source.projectId,
    });
    const workspaceBinding = inheritedWorkspaceBinding(source.workspaceBinding, envelope.createdAt);
    const request = TicketSchema.parse({
      ...envelope,
      type: 'change-request',
      changeKind,
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
      relatedTicketIds: sources.map((candidate) => candidate.id),
      ...(workspaceBinding
        ? { workspaceBinding, workspaceBindingHistory: [workspaceBinding] }
        : {}),
      state: 'created',
      submittedAt: envelope.createdAt,
      source: {
        kind: changeKind === 'contract-change'
          ? input.sourceKind ?? source.source.kind
          : 'runtime',
        correlationId: input.correlationId ?? source.source.correlationId,
        causationId: source.id,
        externalId: changeKind === 'contract-change' ? input.sourceExternalId : undefined,
      },
      sourceTicketIds: sources.map((candidate) => candidate.id),
      maxAttempts: source.maxAttempts,
      parentChangeRequestId: input.parentChangeRequestId,
      triggerStepId: input.triggerStepId,
      sourceStepId: input.sourceStepId,
      targetStepId: input.targetStepId,
      propagationStepIds: [...input.propagationStepIds],
      originFailures: sources
        .filter((candidate): candidate is BugTicket => candidate.type === 'bug')
        .map((candidate) => candidate.failure),
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
      sameIds(chainParent.sourceTicketIds, sources.map((candidate) => candidate.id));
    const sourceObjects = continuesChain || changeKind !== 'corrective' ? [] : (await Promise.all(
      correctiveSources.map((candidate) => this.prepareSourceChangeRequest(candidate, request)),
    )).flat();
    await this.repository.commit([request, ...sourceObjects]);
    return request;
  }

  /**
   * Fold a second Bug's propagation into the hop that already carries it.
   *
   * The two chains are the same correction arriving at the same Step from the same failure, so the
   * target Step should verify the combined contract once rather than twice. Nothing is discarded:
   * the incoming source is cross-referenced, its changelists join the union the target will apply,
   * and its summary is kept alongside the existing one when the two disagree — two Bugs can reach
   * one Step for reasons that are not the same reason, and the Step needs both to know what it is
   * verifying. When they agree, repeating the sentence would only cost context.
   */
  private async mergeChangeRequestHop(
    existing: ChangeRequestTicket,
    sources: readonly (BugTicket | EnhancementTicket)[],
    incoming: ChangeRequestTicket['contractDelta'],
    incomingPropagationStepIds: readonly ObjectId[],
  ): Promise<ChangeRequestTicket> {
    const summaries = dedupeStrings([existing.contractDelta.summary, incoming.summary]);
    const propagationStepIds = await this.orderStepIds([
      ...existing.propagationStepIds,
      ...incomingPropagationStepIds,
    ]);
    const merged = TicketSchema.parse({
      ...existing,
      ...reviseObjectEnvelope(existing),
      relatedTicketIds: dedupeStrings([...existing.relatedTicketIds, ...sources.map((source) => source.id)]),
      sourceTicketIds: dedupeStrings([...existing.sourceTicketIds, ...sources.map((source) => source.id)]),
      changelistIds: dedupeStrings([
        ...existing.changelistIds,
        ...sources.flatMap((source) => source.changelistIds),
      ]),
      originFailures: dedupeFailures([
        ...existing.originFailures,
        ...sources.filter((source): source is BugTicket => source.type === 'bug').map((source) => source.failure),
      ]),
      propagationStepIds,
      contractDelta: {
        ...existing.contractDelta,
        summary: summaries.join('\n'),
        before: dedupeStrings([...existing.contractDelta.before, ...incoming.before]),
        after: dedupeStrings([...existing.contractDelta.after, ...incoming.after]),
        affectedArtifacts: dedupeStrings([
          ...existing.contractDelta.affectedArtifacts,
          ...incoming.affectedArtifacts,
        ]),
      },
    }) as ChangeRequestTicket;
    // The incoming source still has to be handed off. Its Bug is blocked behind this hop exactly as
    // it would be behind a hop of its own, and the `changeRequestTicketIds` back-link is what makes
    // that true — without it the Bug stays schedulable forever and the merge trades one redundant
    // CR for one immortal Bug.
    const incomingSources = sources.filter((source) => !existing.sourceTicketIds.includes(source.id));
    const sourceObjects = (await Promise.all(
      incomingSources.map((source) => this.prepareSourceChangeRequest(source, merged)),
    )).flat();
    await this.repository.commit([merged, ...sourceObjects]);
    return merged;
  }

  private async orderStepIds(ids: readonly ObjectId[]): Promise<ObjectId[]> {
    const steps = await Promise.all([...new Set(ids)].map((id) => this.repository.read(id)));
    return steps
      .map((object) => {
        if (object.objectType !== 'step') throw new Error(`CR propagation target ${object.id} is not a Step`);
        return object;
      })
      .sort((left, right) => STEP_TYPE_ORDER[left.type] - STEP_TYPE_ORDER[right.type])
      .map((step) => step.id);
  }

  private async validateChangeRequestScope(
    input: {
      triggerStepId: ObjectId;
      sourceStepId: ObjectId;
      targetStepId: ObjectId;
      propagationStepIds: readonly ObjectId[];
    },
    source: Ticket,
  ): Promise<Step> {
    if (new Set(input.propagationStepIds).size !== input.propagationStepIds.length) {
      throw new Error('Change Request propagation Steps must be unique');
    }
    const ids = [...new Set([
      input.triggerStepId,
      input.sourceStepId,
      ...input.propagationStepIds,
    ])];
    const objects = await Promise.all(ids.map((id) => this.repository.read(id)));
    const steps = new Map<ObjectId, Step>();
    for (const object of objects) {
      if (object.objectType !== 'step') {
        throw new Error(`Change Request scope object ${object.id} is not a Step`);
      }
      if (object.projectId !== source.projectId || object.phaseId !== source.phaseId) {
        throw new Error('Change Request Steps must belong to the source Project and Phase');
      }
      steps.set(object.id, object);
    }
    const propagation = input.propagationStepIds.map((id) => steps.get(id)!);
    for (let index = 1; index < propagation.length; index += 1) {
      if (STEP_TYPE_ORDER[propagation[index - 1]!.type] >= STEP_TYPE_ORDER[propagation[index]!.type]) {
        throw new Error('Change Request propagation Steps must follow V-model order');
      }
    }
    return steps.get(input.targetStepId)!;
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

  async closeVerified(
    ticketId: ObjectId,
    options: {
      verificationStep?: Step;
      testOutcomes?: readonly TestOutcome[];
      /** Passing Phase assessment that replayed a PM-intake Bug's external delivery gate. */
      phaseGateAssessmentId?: ObjectId;
    } = {},
  ): Promise<Ticket> {
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
      // The last hop of a chain carries its sources to closure, so it must not close while any of
      // them is unproven: a source Bug whose chain has ended has nothing left that would ever run
      // its gate. Earlier hops are unaffected — they close on their own Step's evidence.
      //
      // Stated as a refusal rather than an exception. The chain is unfinished, not corrupt, and the
      // next hop or the reopened Step can still complete it.
      const hasChild = (await this.list()).some((candidate) =>
        candidate.type === 'change-request' &&
        candidate.parentChangeRequestId === request.id &&
        candidate.state !== 'cancelled');
      const finalPropagationHop = !hasChild &&
        request.propagationStepIds.at(-1) === request.targetStepId;
      if (finalPropagationHop) {
        const sources = await Promise.all(
          request.sourceTicketIds.map((sourceTicketId) => this.requireTicket(sourceTicketId)),
        );
        const unproven = sources.some((source) =>
          source.type === 'bug' &&
          source.state !== 'closed' &&
          source.state !== 'cancelled' &&
          !bugVerificationProven(source, options.verificationStep, options.testOutcomes ?? []));
        if (unproven) return ticket;
      }
    }
    // The invariant this enforces is that a Bug never closes on an unreplayed failure. It is stated
    // as a refusal to close rather than as an exception: callers reach here from ordinary flow, and
    // an unfinished Bug is a state the run recovers from, not one it should die on.
    if (
      ticket.type === 'bug' &&
      ticket.state !== 'closed' &&
      !bugVerificationProven(ticket, options.verificationStep, options.testOutcomes ?? [])
    ) return ticket;
    if (ticket.solution?.status !== 'verified') {
      throw new Error(`Ticket ${ticket.name} cannot close without a verified solution`);
    }
    if (
      ticket.type === 'bug' &&
      isPhaseDeliveryGateBug(ticket) &&
      !options.phaseGateAssessmentId &&
      ticket.state !== 'closed'
    ) {
      // The source Step and its downstream CRs prove that the repair is internally coherent. They
      // cannot prove the external user scene that created this Ticket. Park at `resolved`, release
      // the repaired work, and let the next Phase delivery gate provide the closing verdict.
      if (ticket.state !== 'resolved') {
        const path: Array<'in_progress' | 'resolved'> = [];
        if (ticket.state === 'created' || ticket.state === 'pending' || ticket.state === 'reopened') {
          path.push('in_progress');
        }
        path.push('resolved');
        ticket = await this.lifecycle.transitionPath(ticket, path, {
          reasonCode: 'ticket.awaiting_phase_delivery_verification',
          reason: `Ticket ${ticket.name} passed affected Step gates and awaits Phase delivery replay.`,
          evidenceRefs: [...ticket.changelistIds, ...(ticket.solution?.verification ?? [])],
        });
      }
      await this.blockers.release(ticket);
      return ticket;
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
        evidenceRefs: [
          ...ticket.changelistIds,
          ...(ticket.solution?.verification ?? []),
          ...(options.phaseGateAssessmentId ? [options.phaseGateAssessmentId] : []),
        ],
      });
    }

    if (ticket.type === 'change-request') {
      const hasChild = (await this.list()).some((candidate) =>
        candidate.type === 'change-request' &&
        candidate.parentChangeRequestId === ticket.id &&
        candidate.state !== 'cancelled');
      const finalPropagationHop = !hasChild &&
        ticket.propagationStepIds.at(-1) === ticket.targetStepId;
      if (!finalPropagationHop) {
        await this.blockers.release(ticket);
        return ticket;
      }
      for (const sourceTicketId of ticket.sourceTicketIds) {
        let source = await this.requireTicket(sourceTicketId);
        // Only a corrective chain resolves its sources on closure. A dependency request is opened by
        // the Story that needed packages: nothing about that Story is being repaired.
        if (source.type !== 'bug' && source.type !== 'enhancement') continue;
        const openSibling = (await this.list()).some((candidate) =>
          candidate.type === 'change-request' &&
          candidate.sourceTicketIds.includes(source.id) &&
          candidate.id !== ticket.id &&
          candidate.state !== 'closed' &&
          candidate.state !== 'cancelled',
        );
        if (openSibling) continue;
        // An unproven Bug is left open rather than closed or thrown over. Its Story stays blocked,
        // the work stays visible, and the next chain that reaches its proving Step can still finish
        // it. Ending the run here would have destroyed a recoverable state over unfinished work.
        if (
          source.type === 'bug' &&
          source.state !== 'closed' &&
          source.state !== 'cancelled' &&
          !bugVerificationProven(source, options.verificationStep, options.testOutcomes ?? [])
        ) continue;
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
        await this.closeVerified(source.id, options);
      }
    }
    await this.blockers.release(ticket);
    return ticket;
  }

  /** Closes repaired PM-intake Bugs only after their exact Phase finding is absent on replay. */
  async reconcilePhaseDeliveryBugs(
    phaseId: ObjectId,
    findings: readonly Pick<DeliveryGateFinding, 'code' | 'target'>[],
    phaseGateAssessmentId: ObjectId,
  ): Promise<ObjectId[]> {
    const repaired = (await this.list()).filter((ticket): ticket is BugTicket =>
      ticket.type === 'bug' &&
      ticket.phaseId === phaseId &&
      ticket.state === 'resolved' &&
      isPhaseDeliveryGateBug(ticket));
    const closed: ObjectId[] = [];
    for (const bug of repaired) {
      const target = bug.failure.details?.findingTarget;
      const recurred = findings.some((finding) =>
        finding.code === bug.failure.code && finding.target === target);
      if (recurred) continue;
      const result = await this.closeVerified(bug.id, { phaseGateAssessmentId });
      if (result.state === 'closed') closed.push(result.id);
    }
    return closed;
  }

  /** Parks a repaired corrective Ticket until the original verifier reruns, without blocking it. */
  /**
   * Reopens the Bug that was waiting for the gate which has just failed the same way again.
   *
   * A resolved Bug is one whose repair landed and whose verdict is outstanding. When the gate returns
   * that verdict as the same failure, the answer is no — and that belongs to the Ticket that asked,
   * not to a new one. Leaving it resolved strands it: nothing else will ever revisit a Ticket whose
   * verification already came back.
   */
  async reopenResolvedForRecurrence(input: {
    failedStep: Step;
    targetStep: Step;
    identity: FailureIdentity;
    reopenedByActorId: ObjectId;
    parentChangeRequestId?: ObjectId;
    routingObjects?: readonly PersistedDomainObject[];
  }): Promise<BugTicket | undefined> {
    const key = failureIdentityKey(input.identity);
    const waiting = (await this.list()).find((ticket): ticket is BugTicket =>
      ticket.type === 'bug' &&
      ticket.state === 'resolved' &&
      ticket.duplicateOfTicketId === undefined &&
      ticket.failure.targetStepId === input.targetStep.id &&
      failureIdentityKey(ticket.failure.identity) === key);
    if (!waiting) return undefined;

    const parent = input.parentChangeRequestId
      ? await this.requireTicket(input.parentChangeRequestId)
      : undefined;
    if (parent && parent.type !== 'change-request') {
      throw new Error(`Bug recurrence parent ${parent.id} is not a Change Request`);
    }
    const targetStory = await this.storyForStep(input.targetStep.id);
    const failedStory = input.failedStep.id === input.targetStep.id
      ? undefined
      : await this.storyForStep(input.failedStep.id);
    const prepared = await this.lifecycle.prepareTransition(waiting, 'reopened', {
      initiatorActorId: input.reopenedByActorId,
      reasonCode: 'ticket.verification_returned_the_same_failure',
      reason: `${waiting.name} reopened: the gate it awaited reported the same failure again.`,
      evidenceRefs: [
        ...waiting.changelistIds,
        ...(input.routingObjects?.map((object) => object.id) ?? []),
        ...(parent ? [parent.id] : []),
      ],
    });
    const targetBlock = targetStory.blockedByTicketIds.includes(waiting.id)
      ? []
      : await this.blockers.prepareWorkIfLive(targetStory, waiting.id, 'defect');
    const failedBlock = !failedStory || failedStory.blockedByTicketIds.includes(waiting.id)
      ? []
      : await this.blockers.prepareWorkIfLive(failedStory, waiting.id, 'defect');
    const parentBlock = !parent || parent.blockedByTicketIds.includes(waiting.id)
      ? []
      : await this.blockers.prepare(parent, waiting.id, 'defect');
    await this.repository.commit([
      ...(input.routingObjects ?? []),
      ...targetBlock,
      ...failedBlock,
      ...parentBlock,
      ...prepared.objects,
    ]);
    return prepared.ticket as BugTicket;
  }

  async awaitVerification(
    ticketId: ObjectId,
    stepVerification: { stepId: ObjectId; qualityAssessmentId: ObjectId },
  ): Promise<Ticket> {
    let ticket = await this.requireTicket(ticketId);
    if (ticket.type !== 'bug' && ticket.type !== 'enhancement') {
      throw new Error(`Ticket ${ticket.name} cannot wait for corrective verification`);
    }
    // The repair landed; what is left is the verdict, which is what `resolved` means. Parking it as
    // `pending` said it was blocked on something that would clear, so the scheduler kept offering it
    // the Step it had just finished — a live run cycled one Bug through that three times.
    // Resolution claims this Step already checked the repair, so the claim is verified rather than
    // trusted: the caller hands in the assessment its gate produced, and it must be a passing one for
    // the Step that did the work. Without it a Ticket could park itself as finished on its own say-so.
    await this.requirePassingStepAssessment(
      stepVerification.stepId,
      stepVerification.qualityAssessmentId,
      `${ticket.name} cannot await verification without a passing assessment of its own Step`,
    );
    if (ticket.state === 'in_progress') {
      ticket = await this.lifecycle.transition(ticket, 'resolved', {
        reasonCode: 'ticket.awaiting_original_verification',
        reason: `${ticket.name} is repaired and awaits its original verification gate.`,
        evidenceRefs: ticket.changelistIds,
      });
    }
    await this.blockers.release(ticket);
    return ticket;
  }

  /** Persists exact verification at the Step where it happened while later CR impact work continues. */
  async recordBugVerification(
    ticketId: ObjectId,
    step: Step,
    testOutcomes: readonly TestOutcome[],
    qualityAssessmentId: ObjectId,
  ): Promise<BugTicket> {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.type !== 'bug') throw new Error(`Ticket ${ticket.name} is not a Bug`);
    if (!bugVerificationSatisfied(ticket, step, testOutcomes)) return ticket;
    const identityKey = failureIdentityKey(ticket.failure.identity);
    if (ticket.verificationRecords.some((record) =>
      record.failureIdentityKey === identityKey && record.qualityAssessmentId === qualityAssessmentId)) {
      return ticket;
    }
    const updated = TicketSchema.parse({
      ...ticket,
      ...reviseObjectEnvelope(ticket),
      verificationRecords: [
        ...ticket.verificationRecords,
        {
          failureIdentityKey: identityKey,
          verificationStepId: step.id,
          verificationStepType: step.type,
          qualityAssessmentId,
          executedTestSelectors: passedTestSelectors(step, testOutcomes),
          recordedAt: new Date().toISOString(),
        },
      ],
    }) as BugTicket;
    await this.repository.commit([
      updated,
      createDomainEvent({
        projectId: ticket.projectId,
        aggregate: { id: ticket.id, objectType: 'ticket' },
        eventType: 'ticket.bug_verification_recorded',
        payload: {
          verificationStepId: step.id,
          qualityAssessmentId,
          failureIdentityKey: identityKey,
        },
        phaseId: ticket.phaseId,
        stepId: step.id,
        ticketId: ticket.id,
        correlationId: ticket.source.correlationId,
        causationId: qualityAssessmentId,
        objectRevision: updated.revision,
      }),
    ]);
    return updated;
  }

  /** Closes corrections discovered inside a CR only when that CR reruns their original gate. */
  /** Closes corrections discovered inside a CR only when that CR reruns their original gate. */
  /**
   * Closes Bugs parked for a verification that this Step just performed.
   *
   * A Bug handed to the Change Request under repair has no chain of its own, so no hop of its own
   * will ever prove it. Its contract names exactly one Step, and when that Step runs — whoever is
   * running it — the proof exists. Matching on the contract rather than on parentage is what lets a
   * Bug parked by one chain be closed by the chain that actually reached its gate.
   */
  async closeBugsProvenAt(
    projectId: ObjectId,
    step: Step,
    testOutcomes: readonly TestOutcome[],
    verification: readonly string[],
  ): Promise<ObjectId[]> {
    if (testOutcomes.length === 0) return [];
    const parked = (await this.list()).filter((ticket): ticket is BugTicket =>
      ticket.type === 'bug' &&
      ticket.projectId === projectId &&
      ticket.state !== 'closed' &&
      ticket.state !== 'cancelled' &&
      ticket.duplicateOfTicketId === undefined &&
      ticket.verificationContract.verificationStepId === step.id &&
      bugVerificationSatisfied(ticket, step, testOutcomes));
    const closed: ObjectId[] = [];
    for (let bug of parked) {
      const openChain = (await this.list()).some((candidate) =>
        candidate.type === 'change-request' &&
        candidate.sourceTicketIds.includes(bug.id) &&
        candidate.state !== 'closed' &&
        candidate.state !== 'cancelled');
      const solution = bug.solution;
      if (openChain || !solution) continue;
      bug = await this.recordBugVerification(bug.id, step, testOutcomes, step.qualityAssessmentId ?? bug.id);
      bug = await this.setSolution(bug.id, {
        ...solution,
        status: 'verified',
        verification: [...new Set([...solution.verification, ...verification])],
        updatedAt: new Date().toISOString(),
      }) as BugTicket;
      await this.closeVerified(bug.id, { verificationStep: step, testOutcomes });
      closed.push(bug.id);
    }
    return closed;
  }

  async verifyCorrectionsRaisedBy(
    parentChangeRequestId: ObjectId,
    step: Step,
    testOutcomes: readonly TestOutcome[],
    verification: readonly string[],
  ): Promise<ObjectId[]> {
    const candidates = (await this.list()).filter((ticket) =>
      ticket.parentTicketId === parentChangeRequestId &&
      ticket.state !== 'closed' &&
      ticket.state !== 'cancelled' &&
      (ticket.type === 'bug' || ticket.type === 'enhancement'));
    // Only the Bugs. Both types close here, but the caller feeds this list to the verified-Bug
    // knowledge base, which refuses anything else — an Enhancement id reaching it threw and took the
    // whole run down after S005 had already delivered.
    const closed: ObjectId[] = [];
    for (let ticket of candidates) {
      const solution = ticket.solution;
      if (!solution) continue;
      if (ticket.type === 'bug') {
        if (!bugVerificationSatisfied(ticket, step, testOutcomes)) continue;
        if (!step.qualityAssessmentId) {
          throw new Error(`Step ${step.name} has no Quality Assessment for Bug verification`);
        }
        ticket = await this.recordBugVerification(
          ticket.id,
          step,
          testOutcomes,
          step.qualityAssessmentId,
        );
      }
      ticket = await this.setSolution(ticket.id, {
        ...solution,
        status: 'verified',
        verification: [...new Set([...solution.verification, ...verification])],
        updatedAt: new Date().toISOString(),
      });
      const result = await this.closeVerified(ticket.id, { verificationStep: step, testOutcomes });
      if (result.type === 'bug' && result.state === 'closed') closed.push(result.id);
    }
    return closed;
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
        // Hops are found through each Change Request's own source Ticket ids, the direction the
        // closure cascade already trusts. The back-reference on the source is a denormalized copy
        // and had drifted in the live run: the hop holding the Phase was absent from it.
        const hops = blocker.type === 'change-request'
          ? [blocker]
          : tickets.filter((hop): hop is ChangeRequestTicket =>
            hop.type === 'change-request' && hop.sourceTicketIds.includes(blocker.id));
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
        // Remove the cyclic edge without eagerly resuming execution. The target Step may still
        // depend on the source Step that is about to be repaired. Resuming here consumed the only
        // actor slot before the scheduler could dispatch that source, creating a fresh deadlock.
        // The ordinary scheduler will transition this pending Ticket once all Step/Ticket
        // dependencies are actually ready.
        await this.blockers.releaseFrom(current, blockerId, { resume: false });
        released += 1;
      }
    }
    return released;
  }

  async reconcileClosedCorrectiveTickets(projectId: ObjectId): Promise<void> {
    const tickets = await this.list();
    // A child CR is persisted before its parent closes so source Tickets never observe a gap with no
    // active propagation. A crash between those writes leaves an applied, verified parent active and
    // the child already carrying the delta. Finish that interrupted hand-off without invoking the
    // role again; the child, not the parent, now owns every remaining verification obligation.
    const interruptedHandoffs = tickets.filter((ticket): ticket is ChangeRequestTicket =>
      ticket.projectId === projectId &&
      ticket.type === 'change-request' &&
      ticket.state !== 'closed' &&
      ticket.state !== 'cancelled' &&
      ticket.solution?.status === 'verified' &&
      ticket.applications.some((application) =>
        application.stepId === ticket.targetStepId && application.verificationAssessmentId) &&
      tickets.some((candidate) =>
        candidate.type === 'change-request' &&
        candidate.parentChangeRequestId === ticket.id &&
        candidate.state !== 'cancelled'));
    for (const request of interruptedHandoffs) await this.closeVerified(request.id);
    const closed = tickets.filter((ticket) =>
      ticket.projectId === projectId &&
      ticket.state === 'closed' &&
      (ticket.type === 'change-request' || ticket.type === 'bug' || ticket.type === 'enhancement'));
    for (const ticket of closed) {
      await this.closeVerified(ticket.id);
      if (ticket.type === 'change-request') {
        await this.reconcileClosedRequestSources(ticket);
      }
    }
    for (const original of tickets) {
      if (
        original.projectId !== projectId ||
        (original.state !== 'closed' && original.state !== 'cancelled') ||
        original.duplicateTicketIds.length === 0
      ) continue;
      for (const duplicateId of original.duplicateTicketIds) {
        await this.cancelDuplicate(duplicateId, original.id);
      }
    }
  }

  /** Repairs an interrupted hand-off without claiming that the original failure was replayed. */
  private async reconcileClosedRequestSources(request: ChangeRequestTicket): Promise<void> {
    for (const sourceId of request.sourceTicketIds) {
      const source = await this.requireTicket(sourceId);
      if (source.type !== 'bug' || source.state !== 'in_progress' || !source.solution) continue;
      const hasOpenSibling = (await this.list()).some((candidate) =>
        candidate.type === 'change-request' &&
        candidate.sourceTicketIds.includes(source.id) &&
        candidate.state !== 'closed' &&
        candidate.state !== 'cancelled');
      if (hasOpenSibling) continue;
      const resolved = await this.lifecycle.transition(source, 'resolved', {
        reasonCode: 'ticket.interrupted_handoff_reconciled',
        reason: `${source.name} repair was already handed off; restore its pending-verdict state.`,
        evidenceRefs: [request.id, ...source.changelistIds],
      });
      await this.blockers.release(resolved);
    }
  }

  private async cancelDuplicate(ticketId: ObjectId, originalId: ObjectId): Promise<void> {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.state === 'cancelled' || ticket.state === 'closed') return;
    // A stale or crossed link is skipped, not thrown over: this runs inside a sweep across every
    // corrective Ticket in the Project, and one inconsistent pair must not abort the reconciliation
    // for all the others.
    if (ticket.duplicateOfTicketId !== originalId) return;
    const actors = await this.repository.list({ objectType: 'actor-registration', projectId: ticket.projectId });
    const pm = actors.find((object) => object.objectType === 'actor-registration' &&
      object.role === 'project-manager' && object.state === 'active');
    if (!pm || pm.objectType !== 'actor-registration') {
      throw new Error(`Project ${ticket.projectId} has no active Project Manager for duplicate reconciliation`);
    }
    const cancelled = await this.lifecycle.transition(ticket, 'cancelled', {
      initiatorActorId: pm.id,
      reasonCode: 'pm.duplicate_followed_original_terminal',
      reason: `Duplicate ${ticket.name} cancelled after authoritative Ticket ${originalId} became terminal.`,
      evidenceRefs: [originalId],
    });
    await this.blockers.release(cancelled);
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
    const qualityAssessmentId = await this.requireAttachedPassingStepAssessment(request.sourceStepId);
    const actor = await this.processingActor(source);
    const prepared = await this.lifecycle.prepareTransition(source, 'resolved', {
      beforeTrace: [{
        eventType: 'handed_off',
        initiatorActorId: actor.id,
        initiatorRole: actor.role,
        assignmentId: source.activeAssignmentId,
        fromOwnerActorId: actor.id,
        toOwnerActorId: actor.id,
        reasonCode: 'ticket.change_request_handoff',
        reason: `Implementation is handed off through Change Request ${request.name}.`,
        evidenceRefs: [request.id, qualityAssessmentId],
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

  private async requireAttachedPassingStepAssessment(stepId: ObjectId): Promise<ObjectId> {
    const object = await this.repository.read(stepId);
    if (object.objectType !== 'step') {
      throw new Error(`Change Request source ${stepId} is not a Step`);
    }
    if (!object.qualityAssessmentId) {
      throw new Error(`Step ${object.name} has no attached Quality Assessment for corrective handoff`);
    }
    await this.requirePassingStepAssessment(
      object.id,
      object.qualityAssessmentId,
      `Step ${object.name} requires an attached passing Quality Assessment for corrective handoff`,
    );
    return object.qualityAssessmentId;
  }

  private async requirePassingStepAssessment(
    stepId: ObjectId,
    qualityAssessmentId: ObjectId,
    invalidMessage: string,
  ): Promise<void> {
    const assessment = await this.repository.read(qualityAssessmentId);
    if (
      assessment.objectType !== 'quality-assessment' ||
      assessment.subject.objectType !== 'step' ||
      assessment.subject.id !== stepId ||
      !assessment.passed
    ) {
      throw new Error(invalidMessage);
    }
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

function isPhaseDeliveryGateBug(ticket: BugTicket): boolean {
  return ticket.source.kind === 'pm-intake' &&
    ticket.failure.details?.reportOrigin === 'phase-delivery-gate';
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

function dedupeStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function sameIds(left: readonly ObjectId[], right: readonly ObjectId[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}

function dedupeFailures(
  failures: readonly ChangeRequestTicket['originFailures'][number][],
): ChangeRequestTicket['originFailures'] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = failureIdentityKey(failure.identity);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertBugContractInput(input: {
  failedStep: Step;
  targetStep: Step;
  verificationStep: Step;
  category: BugTicket['failure']['category'];
  code: string;
  identity: FailureIdentity;
  verificationContract: BugVerificationContract;
}): void {
  const identity = input.identity;
  if (
    identity.category !== input.category ||
    identity.code !== input.code ||
    identity.failedStepId !== input.failedStep.id ||
    identity.targetStepId !== input.targetStep.id ||
    identity.verificationStepId !== input.verificationStep.id
  ) {
    throw new Error('Bug failure identity does not match its persisted failure and Step routing contract');
  }
  const verification = input.verificationContract;
  if (
    verification.verificationStepId !== input.verificationStep.id ||
    verification.verificationStepType !== input.verificationStep.type
  ) {
    throw new Error('Bug verification contract does not match its verification Step');
  }
}
