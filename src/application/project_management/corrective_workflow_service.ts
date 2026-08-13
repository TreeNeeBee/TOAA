import type { Changelist } from '../../domain/evidence/evidence.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { STEP_TYPE_ORDER, VERIFICATION_STEP_TYPES, type Step } from '../../domain/steps/step.js';
import type {
  BugTicket,
  ChangeRequestApplicationDecision,
  ChangeRequestTicket,
  EnhancementTicket,
  Ticket,
  TicketSource,
  TicketSolution,
  WorkTicket,
} from '../../domain/tickets/ticket.js';
import type { AttemptFailure } from '../execution/failure_classification.js';
import { ProjectStateService } from './project_state_service.js';
import type { ScheduledWork } from './work_scheduler.js';
import { TicketWorkflow } from './ticket_workflow.js';
import { TicketRegistrationService } from './ticket_registration_service.js';
import { TicketBlockerService } from './ticket_blocker_service.js';

export class CorrectiveWorkflowService {
  private readonly tickets: TicketWorkflow;
  private readonly state: ProjectStateService;
  private readonly registration: TicketRegistrationService;
  private readonly blockers: TicketBlockerService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.tickets = new TicketWorkflow(repository);
    this.state = new ProjectStateService(repository);
    this.registration = new TicketRegistrationService(repository);
    this.blockers = new TicketBlockerService(repository);
  }

  /**
   * Sends a dependency need back to the design that owns the manifest.
   *
   * The same shape as a defect rolling back to the Step that caused it, because it is the same
   * situation: work discovered that an accepted upstream artifact is wrong for it. HIGH_LEVEL_DESIGN
   * decides the whole dependency set, so a Step that needs a package cannot simply take it — the
   * design has to check it against everything already resolved, and the flow returns there.
   *
   * PM drives every transition here; the Step only reported what it needed.
   */
  async routeDependencyChange(input: {
    /** The Step that discovered the need. Parked until the design answers. */
    requestingStepId: ObjectId;
    /** The Ticket being worked when the need was found; parked with the Step it belongs to. */
    requestingTicket?: Ticket;
    packages: readonly string[];
    reason: string;
    creatorActorId: ObjectId;
    correlationId: ObjectId;
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
  }): Promise<ChangeRequestTicket> {
    if (input.packages.length === 0) {
      throw new Error('A dependency change request must name at least one package');
    }
    const requesting = await this.state.requireStep(input.requestingStepId);
    const design = await this.designStepFor(requesting);
    if (design.id === requesting.id) {
      throw new Error(`${requesting.name} owns the manifest and must not request a change to itself`);
    }
    const parked = await this.state.moveStepPending(requesting, 'dependency');
    const target = design.state === 'delivered' || design.state === 'closed'
      ? await this.state.transitionStep(design, 'reopened')
      : design;

    const request = await this.tickets.openDependencyChangeRequest({
      creatorActorId: input.creatorActorId,
      requestingStepId: parked.id,
      requestingTicket: input.requestingTicket,
      targetStep: target,
      packages: [...input.packages],
      reason: input.reason,
      correlationId: input.correlationId,
      sourceKind: input.sourceKind,
      sourceExternalId: input.sourceExternalId,
    });
    await this.registration.register(request.id);
    await this.state.checkpoint(parked, `Dependency change requested through ${request.name}`);
    return request;
  }

  /** The HIGH_LEVEL_DESIGN Step of the requesting Step's Phase: the one that owns the manifest. */
  private async designStepFor(step: Step): Promise<Step> {
    const objects = await this.repository.list({ objectType: 'step', projectId: step.projectId });
    const design = objects.find((object): object is Step =>
      object.objectType === 'step' &&
      object.phaseId === step.phaseId &&
      object.type === 'HIGH_LEVEL_DESIGN');
    if (!design) throw new Error(`Phase of ${step.name} has no HIGH_LEVEL_DESIGN Step to own dependencies`);
    return design;
  }

  async routeFailure(input: {
    failedStepId: ObjectId;
    /** Explicit owner for test-defect and phase-gate findings; defaults to the V-model pair. */
    targetStepId?: ObjectId;
    message: string;
    summary: string;
    failure: AttemptFailure;
    bugKind?: BugTicket['bugKind'];
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
  }): Promise<BugTicket> {
    let failed = await this.state.requireStep(input.failedStepId);
    if (!failed.pairedStepId) throw new Error(`Failure routing requires a paired Step: ${failed.name}`);
    let target = input.targetStepId
      ? await this.state.requireStep(input.targetStepId)
      : isVerificationStep(failed)
        ? await this.state.requireStep(failed.pairedStepId)
        : failed;
    const verification = isVerificationStep(target)
      ? target
      : isVerificationStep(failed)
        ? failed
        : await this.state.requireStep(target.pairedStepId ?? failed.pairedStepId);
    const routing = this.state.prepareCorrectiveRouting(failed, target, 'defect');
    failed = routing.source;
    target = routing.target;
    const discovering = input.discoveringStepId &&
      input.discoveringStepId !== failed.id &&
      input.discoveringStepId !== target.id
      ? this.state.prepareStepPending(await this.state.requireStep(input.discoveringStepId), 'defect')
      : undefined;
    const bug = await this.tickets.openBug({
      creatorActorId: input.creatorActorId,
      failedStep: failed,
      targetStep: target,
      verificationStep: verification,
      kind: input.bugKind ?? 'test-failure',
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
      routingObjects: [...routing.objects, ...(discovering?.objects ?? [])],
      sourceKind: input.sourceKind,
      sourceExternalId: input.sourceExternalId,
    });
    await this.state.checkpoint(failed, `Failure routed to ${target.name} through ${bug.name}`);
    await this.state.checkpoint(target, `Reopened by ${bug.name}`);
    if (discovering) {
      await this.state.checkpoint(discovering.step, `Discovery parked behind ${bug.name}`);
    }
    return bug;
  }

  async routeQualityGap(input: {
    sourceStepId: ObjectId;
    /** Explicit owner selected during gate triage; defaults to the paired source. */
    targetStepId?: ObjectId;
    finding: string;
    kind: EnhancementTicket['enhancementKind'];
    qualityAssessmentId?: ObjectId;
    correlationId: ObjectId;
    causationId?: ObjectId;
    parentChangeRequestId?: ObjectId;
    creatorActorId: ObjectId;
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
  }): Promise<EnhancementTicket> {
    let source = await this.state.requireStep(input.sourceStepId);
    if (!source.pairedStepId) throw new Error(`Quality routing requires a paired Step: ${source.name}`);
    const target = input.targetStepId
      ? await this.state.requireStep(input.targetStepId)
      : isVerificationStep(source)
        ? await this.state.requireStep(source.pairedStepId)
        : source;
    const verification = isVerificationStep(target)
      ? target
      : isVerificationStep(source)
        ? source
        : await this.state.requireStep(target.pairedStepId ?? source.pairedStepId);
    const routing = this.state.prepareCorrectiveRouting(source, target, 'quality-gap');
    source = routing.source;
    const reopenedTarget = routing.target;
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
      routingObjects: routing.objects,
      sourceKind: input.sourceKind,
      sourceExternalId: input.sourceExternalId,
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
  }): Promise<ChangeRequestTicket | undefined> {
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
    // The chain never opens onto the Step that the Change Request under repair will re-apply
    // itself. A Bug or Enhancement raised inside a CR is repaired upstream, and the parked CR then
    // resumes and re-applies its own Step carrying that repair; opening a hop there would hand the
    // same Step two deltas from two chains, and whichever landed first would close the Step and
    // strand the other. With the first hop already at that Step there is no chain to open at all,
    // so the corrective Ticket closes here and its closure releases the CR waiting on it.
    if (await this.repairedChangeRequestTargetsStep(input.work.ticket, input.affectedStepIds[0]!)) {
      await this.tickets.setSolution(input.work.ticket.id, {
        ...solution,
        status: 'verified',
        verification: input.sourceChange.verification,
        updatedAt: new Date().toISOString(),
      });
      await this.tickets.closeVerified(input.work.ticket.id);
      await this.state.checkpoint(
        step,
        `Corrective solution completed in ${step.name}; the Change Request it repairs carries it onward`,
      );
      return undefined;
    }
    const request = await this.tickets.openChangeRequest({
      creatorActorId: await this.state.ticketOwnerActorId(input.work.ticket.id),
      sourceTicketId: input.work.ticket.id,
      triggerStepId: input.work.ticket.stepId ?? step.id,
      sourceStepId: step.id,
      // Only the first hop. The rest of the chain is discovered as each application decides
      // whether anything downstream still has to change.
      targetStepId: input.affectedStepIds[0]!,
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
    application?: ChangeRequestApplicationDecision;
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
      application: input.application,
    });
    const request = await this.state.requireTicket(input.work.ticket.id);
    if (request.type !== 'change-request') throw new Error('Change Request type changed while applying it');
    const sourceTicket = await this.state.requireTicket(request.sourceTicketId);
    // A dependency request is told apart by what its source points at, not by a flag: it was opened
    // by the Story that needed packages, whereas a corrective chain descends from a Bug or
    // Enhancement. Nothing is being repaired, so there is no source defect to resolve and no delta
    // to carry downstream — the design answered, and the Step that asked can run again.
    if (sourceTicket.type === 'story' || sourceTicket.type === 'task') {
      await this.completeDependencyRequest(request, input.verification ?? []);
      return { closed: true };
    }
    if (sourceTicket.type !== 'bug' && sourceTicket.type !== 'enhancement') {
      throw new Error(`Change Request ${request.name} has invalid source Ticket ${sourceTicket.name}`);
    }
    // Every downstream owner must evaluate the accepted correction against its own contract and
    // gate. An empty changelist is an auditable no-op application at this Step, not evidence that
    // later artifacts and tests are unaffected.
    let next = await this.nextDownstreamStepId(step);
    // A repair chain also ends where it meets the Change Request it was repairing. When a Bug is
    // raised against a CR being applied, the fix is made upstream and propagates back down; the
    // parked CR resumes and re-applies at its own target Step, carrying the repair with it and
    // continuing its chain from there. Propagating past that meeting point would hand the same Step
    // two deltas: whichever applied first closes the Step, stranding the other on a Step the
    // scheduler no longer visits.
    if (next && await this.repairedChangeRequestTargetsStep(sourceTicket, next)) next = undefined;
    // Read before closing: closure releases the assignment, and the child records who handed the
    // delta on.
    const handedOnBy = next ? await this.state.ticketOwnerActorId(request.id) : undefined;
    // Persist the next hop before closing this one. Source-Ticket closure checks for an active
    // sibling CR; closing first creates a false instant in which no sibling exists, prematurely
    // closes the Bug/Enhancement, unblocks its failed Story, and can consume the role capacity the
    // next hop needs.
    if (next) {
      await this.openChildChangeRequest(request, next, handedOnBy!, {
        summary: input.summary,
        entries: input.entries,
      });
    }
    // This CR closes as soon as its own Step is verified. The already-persisted child carries the
    // remaining work, so the current assignee's capacity is released without closing the source.
    await this.tickets.setSolution(request.id, {
      status: 'verified',
      approach: request.solution?.approach ?? request.implementationPlan.join('\n'),
      rationale: request.solution?.rationale ?? request.contractDelta.summary,
      changes: request.solution?.changes ?? request.contractDelta.affectedArtifacts,
      verification: [...request.verificationGate, ...(input.verification ?? [])],
      updatedAt: new Date().toISOString(),
    });
    await this.tickets.closeVerified(request.id);
    // `parentChangeRequestId` carries two relationships: the previous hop of this chain, which is
    // already closed and ignores this, and a CR parked while a Bug found inside it was repaired.
    // The second is the one that needs waking, and nothing else wakes it.
    if (request.parentChangeRequestId) {
      await this.activateChangeRequest(request.parentChangeRequestId);
    }
    const storySteps = next
      ? [request.sourceStepId, request.targetStepId]
      : await this.closedStepIdsForPhase(step);
    await this.closeStoriesForClosedSteps(storySteps);
    if (next) {
      // The source Bug or Enhancement waits for the last descendant, not for this hop.
      return { closed: false };
    }
    return {
      closed: true,
      sourceTicketId: request.sourceTicketId,
      sourceTicketType: sourceTicket.type,
    };
  }

  /**
   * Opens the one Step this Change Request is due to be applied to next.
   *
   * Reopening the whole downstream chain at once put every affected Step into `reopened` before
   * anyone knew whether the delta would even reach them: a CR that resolves at the first Step still
   * left the rest reopened, and the V-model's own ordering was replaced by a scheduler picking from
   * a pool. The state machine advances one Step at a time, so activation does too.
   */
  /**
   * Closes a satisfied dependency request and lets the Step that raised it continue.
   *
   * The requesting Step was parked on `dependency`, not on a defect, so nothing about it needs
   * repairing — it simply could not proceed until the manifest carried what it asked for.
   */
  private async completeDependencyRequest(
    request: ChangeRequestTicket,
    verification: readonly string[],
  ): Promise<void> {
    await this.tickets.setSolution(request.id, {
      status: 'verified',
      approach: request.implementationPlan.join('\n'),
      rationale: request.contractDelta.summary,
      changes: request.contractDelta.affectedArtifacts,
      verification: [...request.verificationGate, ...verification],
      updatedAt: new Date().toISOString(),
    });
    await this.tickets.closeVerified(request.id);

    // Every downstream Step re-checks, whether or not this hop changed anything. Only the Step
    // owner can verify whether the changed dependency environment affects its contract.
    const applied = await this.state.requireStep(request.targetStepId);
    const next = await this.nextDownstreamStepId(applied);
    if (next) {
      await this.openDependencyRecheck(request, next);
      return;
    }
    // Nothing downstream is left, so the Step that raised the need can run again.
    const requesting = await this.state.requireStep(request.sourceStepId);
    if (requesting.state === 'pending') {
      await this.state.transitionStep(requesting, 'in_progress');
    }
  }

  /** Carries "the dependency environment changed" one Step further, for that Step to verify. */
  private async openDependencyRecheck(
    parent: ChangeRequestTicket,
    targetStepId: ObjectId,
  ): Promise<void> {
    const target = await this.state.requireStep(targetStepId);
    const reopened = target.state === 'delivered' || target.state === 'closed'
      ? await this.state.transitionStep(target, 'reopened')
      : target;
    const child = await this.tickets.openDependencyChangeRequest({
      creatorActorId: parent.creatorActorId,
      requestingStepId: parent.sourceStepId,
      targetStep: reopened,
      packages: parent.contractDelta.after.map((line) => line.split(' ')[0] ?? line),
      reason: `The dependency set changed upstream; confirm ${reopened.name} still holds against it.`,
      kind: 'recheck',
      correlationId: parent.source.correlationId,
      sourceKind: parent.source.kind,
      sourceExternalId: parent.source.externalId,
    });
    await this.registration.register(child.id);
  }

  async activateChangeRequest(ticketId: ObjectId): Promise<ChangeRequestTicket> {
    const ticket = await this.state.requireTicket(ticketId);
    if (ticket.type !== 'change-request') throw new Error(`Ticket ${ticketId} is not a Change Request`);
    if (ticket.state === 'closed' || ticket.state === 'cancelled') return ticket;
    await this.ensureVerificationStoryBlocked(ticket);
    if (ticket.applications.some((application) => application.stepId === ticket.targetStepId)) {
      return ticket;
    }
    let step = await this.state.requireStep(ticket.targetStepId);
    if (step.state === 'closed' || step.state === 'delivered') {
      step = await this.state.transitionStep(step, 'reopened');
      await this.state.checkpoint(step, `Reopened for incremental ${ticket.name}`);
    }
    return ticket;
  }

  /** Keeps the discovering verification Story parked for the lifetime of every active CR hop. */
  private async ensureVerificationStoryBlocked(request: ChangeRequestTicket): Promise<void> {
    const source = await this.state.requireTicket(request.sourceTicketId);
    const stepId = source.type === 'bug'
      ? source.failure.failedStepId
      : source.type === 'enhancement'
        ? source.verificationStepId
        : undefined;
    if (!stepId) return;
    const story = await this.tickets.storyForStep(stepId);
    if (
      story.state === 'closed' ||
      story.state === 'cancelled' ||
      story.blockedByTicketIds.includes(request.id)
    ) return;
    const objects = await this.blockers.prepare(
      story,
      request.id,
      source.type === 'bug' ? 'defect' : 'quality-gap',
    );
    await this.repository.commit(objects);
  }

  /**
   * Whether `stepId` is where the Change Request this repair chain came from will apply itself.
   *
   * A Bug raised inside a Change Request records that CR as its parent, and every hop of the chain
   * the Bug propagates keeps the Bug as its source. So the CR under repair is reachable from any
   * hop, and the Step it targets is where the two chains meet.
   */
  private async repairedChangeRequestTargetsStep(
    source: BugTicket | EnhancementTicket,
    stepId: ObjectId,
  ): Promise<boolean> {
    if (!source.parentTicketId) return false;
    const parent = await this.state.requireTicket(source.parentTicketId);
    return parent.type === 'change-request' && parent.targetStepId === stepId;
  }

  /**
   * The Step immediately after `step` in the V-model, or undefined at the end of the chain.
   *
   * Recomputed at each hop rather than taken from a list fixed when the first CR opened, which is
   * what makes the propagation scope discovered rather than asserted in advance.
   */
  private async nextDownstreamStepId(step: Step): Promise<ObjectId | undefined> {
    const objects = await this.repository.list({ objectType: 'step', projectId: step.projectId });
    const downstream = objects
      .filter((object): object is Step =>
        object.objectType === 'step' &&
        object.phaseId === step.phaseId &&
        STEP_TYPE_ORDER[object.type] > STEP_TYPE_ORDER[step.type])
      .sort((left, right) =>
        (STEP_TYPE_ORDER[left.type] - STEP_TYPE_ORDER[right.type]) || left.name.localeCompare(right.name));
    return downstream[0]?.id;
  }

  /**
   * Carries the delta one Step further as its own Ticket, registered so PM routes it.
   *
   * A child rather than another application on the same Ticket, because whoever owns the next Step
   * owns this work: its gate, its attempts, and its closure. One Ticket spanning four roles has no
   * single owner to hold to any of that.
   */
  private async openChildChangeRequest(
    parent: ChangeRequestTicket,
    targetStepId: ObjectId,
    creatorActorId: ObjectId,
    applied: { summary: string; entries: Changelist['entries'] },
  ): Promise<ChangeRequestTicket> {
    // What travels downstream is what this hop changed, not the instructions that repaired the
    // Step where the chain began. Copying the parent's plan verbatim handed a DETAILED_DESIGN Step
    // "create docs/01-requirement-analysis.md" — files it does not own and that already existed —
    // so it had nothing to do, produced no actions, and the attempt stopped for no progress.
    const changed = [...new Set(applied.entries.map((entry) => entry.path))];
    const artifacts = changed.length > 0 ? changed : parent.contractDelta.affectedArtifacts;
    const child = await this.tickets.openChangeRequest({
      creatorActorId,
      sourceTicketId: parent.sourceTicketId,
      triggerStepId: parent.triggerStepId,
      sourceStepId: parent.targetStepId,
      targetStepId,
      contractDelta: {
        summary: changed.length > 0
          ? applied.summary
          : `${parent.contractDelta.summary} (no artifact changed at the previous Step)`,
        before: parent.contractDelta.after,
        after: artifacts.map((artifact) => `${artifact} is accepted in its current form`),
        affectedArtifacts: artifacts,
      },
      // A downstream hop checks its own work against the accepted change; it does not re-run the
      // repair that produced it.
      implementationPlan: [
        `Check this Step's artifacts and tests against the accepted change to ${artifacts.join(', ')}.`,
        'Apply only what this Step owns; if nothing here is affected, record that as the outcome.',
      ],
      verificationGate: parent.verificationGate,
      parentChangeRequestId: parent.id,
    });
    await this.registration.register(child.id);
    await this.activateChangeRequest(child.id);
    return child;
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
        // A Step closed through a Change Request application may own a Story that was never
        // dispatched on its own. Closing it still runs through `in_progress`, so PM registers and
        // assigns it first rather than transitioning an unowned Ticket.
        if (path.includes('in_progress')) {
          story = (await this.registration.routeAndAssign(story.id, {
            forStepId: step.id,
            administrative: true,
          })).ticket as WorkTicket;
        }
        await this.state.transitionTicketPath(story, path);
      }
    }
  }

  private async closedStepIdsForPhase(step: Step): Promise<ObjectId[]> {
    const objects = await this.repository.list({ objectType: 'step', projectId: step.projectId });
    return objects
      .filter((object): object is Step =>
        object.objectType === 'step' && object.phaseId === step.phaseId && object.state === 'closed')
      .map((object) => object.id);
  }

  private async completeTasks(story: Ticket): Promise<void> {
    const descendants = (await this.ticketDescendants(story.id)).reverse();
    for (let task of descendants) {
      const path = ticketClosurePath(task);
      if (path.includes('in_progress')) {
        // A CR can satisfy a Step before its ordinary Story was ever dispatched. Its planned Tasks
        // still need auditable ownership, but no actor capacity is consumed because this is PM
        // reconciling work already performed through the CR rather than dispatching new execution.
        task = (await this.registration.routeAndAssign(task.id, {
          forStepId: task.stepId,
          administrative: true,
        })).ticket;
      }
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
