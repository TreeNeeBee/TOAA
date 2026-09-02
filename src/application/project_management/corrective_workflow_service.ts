import type { Changelist } from '../../domain/evidence/evidence.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  STEP_TYPE_ORDER, VERIFICATION_STEP_TYPES, stepDependsOn, stepSatisfiesDependency, type Step,
} from '../../domain/steps/step.js';
import type {
  BugTicket,
  ChangeRequestApplicationDecision,
  ChangeRequestTicket,
  EnhancementTicket,
  Ticket,
  TicketSource,
  TicketSolution,
  TicketWorkspaceBinding,
  WorkTicket,
} from '../../domain/tickets/ticket.js';
import type { AttemptFailure } from '../execution/failure_classification.js';
import type { TestOutcome } from '../execution/test_outcome.js';
import { ProjectStateService } from './project_state_service.js';
import type { ScheduledWork } from './work_scheduler.js';
import { TicketWorkflow } from './ticket_workflow.js';
import { TicketRegistrationService } from './ticket_registration_service.js';
import { TicketBlockerService } from './ticket_blocker_service.js';
import { VERIFICATION_SUPPLEMENT_DIR } from '../../core/test_assets.js';
import { normalizeGitPath } from '../execution/v_model_policy.js';
import {
  buildBugFailureContracts,
  bugVerificationProven,
} from './bug_verification.js';

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

  /** Routes a required accepted-contract change as a CR, without manufacturing a defect Ticket. */
  async routeContractChange(input: {
    reportingStepId: ObjectId;
    targetStepId: ObjectId;
    summary: string;
    evidence: readonly string[];
    expected: string;
    affectedArtifacts: readonly string[];
    creatorActorId: ObjectId;
    correlationId: ObjectId;
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
  }): Promise<ChangeRequestTicket> {
    const reporting = await this.state.requireStep(input.reportingStepId);
    const target = await this.state.requireStep(input.targetStepId);
    if (reporting.phaseId !== target.phaseId || reporting.projectId !== target.projectId) {
      throw new Error('Contract Change Request must remain inside one Project Phase');
    }
    const sourceStory = await this.tickets.storyForStep(reporting.id);
    const objects = await this.repository.list({ objectType: 'step', projectId: target.projectId });
    const propagationStepIds = objects
      .filter((object): object is Step =>
        object.objectType === 'step' &&
        object.phaseId === target.phaseId &&
        STEP_TYPE_ORDER[object.type] >= STEP_TYPE_ORDER[target.type])
      .sort((left, right) => STEP_TYPE_ORDER[left.type] - STEP_TYPE_ORDER[right.type])
      .map((step) => step.id);
    const request = await this.tickets.openChangeRequest({
      changeKind: 'contract-change',
      creatorActorId: input.creatorActorId,
      sourceTicketIds: [sourceStory.id],
      triggerStepId: reporting.id,
      sourceStepId: reporting.id,
      targetStepId: target.id,
      propagationStepIds,
      contractDelta: {
        summary: input.summary,
        before: [...input.evidence],
        after: [`The accepted ${target.name} contract is revised so the Phase can satisfy: ${input.expected}`],
        affectedArtifacts: [...input.affectedArtifacts],
      },
      implementationPlan: [
        `Revise only ${target.name}-owned accepted contracts needed to address this contract change.`,
        'Choose a viable project-independent replacement or contract adjustment from current evidence.',
        'Propagate the accepted delta incrementally through every affected downstream V-model Step.',
      ],
      verificationGate: [
        `The revised project satisfies the original observable expectation: ${input.expected}`,
        'The Phase delivery scenario passes after downstream propagation.',
      ],
      sourceKind: input.sourceKind,
      sourceExternalId: input.sourceExternalId,
      correlationId: input.correlationId,
    });
    await this.registration.register(request.id);
    await this.activateChangeRequest(request.id);
    await this.state.checkpoint(target, `Contract change routed through ${request.name}`);
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
    let failed = await this.state.requireStep(input.failedStepId);
    if (!failed.pairedStepId) throw new Error(`Failure routing requires a paired Step: ${failed.name}`);
    let target = input.targetStepId
      ? await this.state.requireStep(input.targetStepId)
      : isVerificationStep(failed)
        ? failureConfinedToSupplement(failed, input.testOutcomes ?? [])
          ? failed
          : await this.state.requireStep(failed.pairedStepId)
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
    const contracts = buildBugFailureContracts({
      failedStep: failed,
      targetStep: target,
      verificationStep: verification,
      failure: input.failure,
      tool: input.tool,
      exitCode: input.exitCode,
      statusCode: input.statusCode,
      testOutcomes: input.testOutcomes,
      artifactTargets: input.affectedArtifacts,
    });
    // The gate that was going to confirm this repair has just failed on the same thing instead. That
    // is a verdict on the Ticket already waiting for it, not a new defect: reopening it keeps one
    // Ticket for one failure and puts the repair back in front of the role that made it. Opening a
    // second Ticket would leave the first resolved forever, waiting for a verification that had
    // already come back negative.
    const reopened = await this.tickets.reopenResolvedForRecurrence({
      failedStep: failed,
      targetStep: target,
      identity: contracts.identity,
      reopenedByActorId: input.creatorActorId,
      parentChangeRequestId: input.parentChangeRequestId,
      routingObjects: [...routing.objects, ...(discovering?.objects ?? [])],
    });
    if (reopened) {
      await this.state.checkpoint(failed, `Recurrence reopened ${reopened.name}`);
      await this.state.checkpoint(target, `Reopened by recurrence of ${reopened.name}`);
      if (discovering) {
        await this.state.checkpoint(discovering.step, `Discovery parked behind ${reopened.name}`);
      }
      return reopened;
    }
    const bug = await this.tickets.openBug({
      creatorActorId: input.creatorActorId,
      failedStep: failed,
      targetStep: target,
      verificationStep: verification,
      kind: input.bugKind,
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
      workspaceBinding: input.workspaceBinding,
      identity: contracts.identity,
      verificationContract: contracts.verificationContract,
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
      affectedArtifacts: input.affectedArtifacts,
      sourceQualityAssessmentId: input.qualityAssessmentId,
      sourceBugTicketId: input.sourceBugTicketId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      parentChangeRequestId: input.parentChangeRequestId,
      routingObjects: routing.objects,
      sourceKind: input.sourceKind,
      sourceExternalId: input.sourceExternalId,
      workspaceBinding: input.workspaceBinding,
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
    // so the corrective Ticket has no chain of its own and waits for the gate that found it.
    //
    // Waiting is not the same as closing, and the CR it repairs has to be woken explicitly. While
    // the corrective Ticket closed here, its closure released that CR; parking it releases the
    // blocker but leaves the CR parked, so the repair reached its Step and nothing carried it on.
    if (await this.repairedChangeRequestTargetsStep(input.work.ticket, input.affectedStepIds[0]!)) {
      await this.tickets.awaitVerification(input.work.ticket.id, {
        stepId: step.id,
        qualityAssessmentId: input.qualityAssessmentId,
      });
      const repaired = input.work.ticket.parentTicketId;
      if (repaired) await this.activateChangeRequest(repaired);
      await this.state.checkpoint(
        step,
        `Corrective solution completed in ${step.name}; the Change Request it repairs carries it onward`,
      );
      return undefined;
    }
    const request = await this.tickets.openChangeRequest({
      changeKind: 'corrective',
      creatorActorId: await this.state.ticketOwnerActorId(input.work.ticket.id),
      sourceTicketIds: [input.work.ticket.id],
      triggerStepId: input.work.ticket.stepId ?? step.id,
      sourceStepId: step.id,
      // Only the first hop. The rest of the chain is discovered as each application decides
      // whether anything downstream still has to change.
      targetStepId: input.affectedStepIds[0]!,
      propagationStepIds: input.affectedStepIds,
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
    testOutcomes?: readonly TestOutcome[];
  }): Promise<{
    status: 'applied' | 'awaiting-verification';
    closed: boolean;
    sourceTicketIds?: ObjectId[];
    sourceTicketTypes?: Array<'bug' | 'enhancement'>;
    verifiedBugTicketIds?: ObjectId[];
    unprovenBugTicketIds?: ObjectId[];
  }> {
    if (input.work.ticket.type !== 'change-request') {
      throw new Error('completeChangeRequestStep requires a Change Request');
    }
    let step = await this.state.requireStep(input.work.step.id);
    await this.state.requirePassingQualityAssessment(step, input.qualityAssessmentId);
    const request = await this.state.requireTicket(input.work.ticket.id);
    if (request.type !== 'change-request') throw new Error('Change Request type changed while applying it');
    const sourceTickets = await Promise.all(request.sourceTicketIds.map((id) => this.state.requireTicket(id)));
    const dependencyRequest = request.changeKind === 'dependency';
    const contractChange = request.changeKind === 'contract-change';
    if (request.changeKind === 'corrective' && sourceTickets.some((source) =>
      source.type !== 'bug' && source.type !== 'enhancement')) {
      throw new Error(`Change Request ${request.name} has an invalid source Ticket`);
    }
    if ((dependencyRequest || contractChange) && sourceTickets.some((source) =>
      source.type !== 'story' && source.type !== 'task')) {
      throw new Error(`Change Request ${request.name} has an invalid work source Ticket`);
    }
    const correctiveSources = request.changeKind !== 'corrective'
      ? []
      : sourceTickets as Array<BugTicket | EnhancementTicket>;
    let next = dependencyRequest ? undefined : nextPropagationStepId(request, step.id);
    // Stopping at the Change Request under repair is a decision, not the end of the scope: that CR
    // resumes and re-applies its own Step, carrying this repair onward and proving it there. The
    // chain must not be extended past that meeting point, or the same Step receives two deltas.
    const metRepairedRequest = next !== undefined && (await Promise.all(
      correctiveSources.map((source) => this.repairedChangeRequestTargetsStep(source, next!)),
    )).some(Boolean);
    if (metRepairedRequest) {
      next = undefined;
      // The chain stops here because the Change Request under repair owns the next Step, and that
      // CR is parked behind the very Bug this chain repaired. Leaving the block in place deadlocks
      // them: the Bug waits for its original gate, and the only thing that will run that gate is
      // the CR the Bug is holding. The repair has landed, so the Bug releases its hold and waits
      // for the verdict instead of blocking the Step that produces it.
      for (const source of correctiveSources) {
        if (!source.parentTicketId) continue;
        await this.tickets.awaitVerification(source.id, {
          stepId: step.id,
          qualityAssessmentId: input.qualityAssessmentId,
        });
        await this.activateChangeRequest(source.parentTicketId);
      }
    }
    if (!next && !metRepairedRequest) {
      // A Bug closes only once its original failure has been replayed and passed, and the contract
      // can be satisfied at exactly one Step: the one that observed the failure. A chain that ends
      // anywhere else has not proven anything yet.
      //
      // Ending it there is not a crash. Failing to reach the proving Step is an ordinary outcome of
      // how the chain was scoped, so the chain is extended to that Step and the delta travels one
      // more hop. When the proving Step is the one that just ran and the replay still did not
      // happen, there is nowhere further to go: this CR closes and its source Bug stays open, which
      // keeps the failed Story blocked and the work visible. Throwing instead ended the whole run
      // over a Bug that simply was not finished.
      const unproven = correctiveSources.filter((source): source is BugTicket =>
        source.type === 'bug' &&
        source.state !== 'closed' &&
        source.state !== 'cancelled' &&
        !bugVerificationProven(source, step, input.testOutcomes ?? []));
      const proving = unproven
        .map((bug) => bug.verificationContract.verificationStepId)
        .find((stepId) => stepId !== step.id);
      if (proving) next = proving;
    }
    // Nothing is mutated until this hop can actually finish. Delivering the Step and recording the
    // application while a source Bug is unproven would strand the Change Request: it refuses to
    // close, and the scheduler skips a CR that already has an application at its target, so nothing
    // would ever run it again. Returning instead leaves it schedulable for the attempt that can
    // supply the replay.
    const unprovenSources = correctiveSources.filter((source): source is BugTicket =>
      source.type === 'bug' &&
      source.state !== 'closed' &&
      source.state !== 'cancelled' &&
      !bugVerificationProven(source, step, input.testOutcomes ?? []));
    const verificationDueHere = unprovenSources.filter((source) =>
      source.verificationContract.verificationStepId === step.id);
    // A correction cannot pass through the Step that owns its immutable replay contract. Letting it
    // continue merely because another downstream Step exists postpones the verdict until the end of
    // the chain, then manufactures a backward CR to revisit this Step. Besides obscuring the failed
    // gate, that loop can reserve the same role twice. The current CR remains the unit of work until
    // this Step has actually replayed the original failure.
    if (verificationDueHere.length > 0) {
      return {
        status: 'awaiting-verification',
        closed: false,
        unprovenBugTicketIds: verificationDueHere.map((source) => source.id),
      };
    }
    // Not at the meeting point: there the Bug was deliberately handed to the Change Request under
    // repair, which runs the Step that proves it. Retrying here could never produce that proof and
    // would spend the whole attempt budget rediscovering it.
    if (!next && !metRepairedRequest && unprovenSources.length > 0) {
      return {
        status: 'awaiting-verification',
        closed: false,
        unprovenBugTicketIds: unprovenSources.map((source) => source.id),
      };
    }
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
    for (const source of correctiveSources) {
      if (source.type !== 'bug') continue;
      await this.tickets.recordBugVerification(
        source.id,
        step,
        input.testOutcomes ?? [],
        input.qualityAssessmentId,
      );
    }
    // A dependency request is told apart by what its source points at, not by a flag: it was opened
    // by the Story that needed packages, whereas a corrective chain descends from a Bug or
    // Enhancement. Nothing is being repaired, so there is no source defect to resolve and no delta
    // to carry downstream — the design answered, and the Step that asked can run again.
    if (dependencyRequest) {
      await this.completeDependencyRequest(request, input.verification ?? []);
      return { status: 'applied', closed: true };
    }
    // A Bug parked at a meeting point is proven by whichever chain reaches its gate, not only by the
    // one that opened it, so every hop closes what its own Step has just proven.
    await this.tickets.closeBugsProvenAt(
      step.projectId,
      step,
      input.testOutcomes ?? [],
      input.verification ?? [],
    );
    const verifiedRaisedBugs = await this.tickets.verifyCorrectionsRaisedBy(
      request.id,
      step,
      input.testOutcomes ?? [],
      input.verification ?? [],
    );
    // Every downstream owner must evaluate the accepted correction against its own contract and
    // gate. An empty changelist is an auditable no-op application at this Step, not evidence that
    // later artifacts and tests are unaffected.
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
    await this.tickets.closeVerified(request.id, {
      verificationStep: step,
      testOutcomes: input.testOutcomes,
    });
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
      return { status: 'applied', closed: false };
    }
    return {
      status: 'applied',
      closed: true,
      sourceTicketIds: request.sourceTicketIds,
      sourceTicketTypes: correctiveSources.map((source) => source.type),
      verifiedBugTicketIds: [...new Set([
        ...verifiedRaisedBugs,
        ...(await Promise.all(correctiveSources
          .filter((source): source is BugTicket => source.type === 'bug')
          .map(async (source) => await this.state.requireTicket(source.id))))
          .filter((source) => source.state === 'closed')
          .map((source) => source.id),
      ])],
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
      parentChangeRequestId: parent.id,
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
    for (const sourceTicketId of request.sourceTicketIds) {
      const source = await this.state.requireTicket(sourceTicketId);
      const stepId = source.type === 'bug'
        ? source.failure.failedStepId
        : source.type === 'enhancement'
          ? source.verificationStepId
          : undefined;
      if (!stepId) continue;
      const story = await this.tickets.storyForStep(stepId);
      if (
        story.state === 'closed' ||
        story.state === 'cancelled' ||
        story.blockedByTicketIds.includes(request.id) ||
        await this.hopWaitsOnDiscoveringStep(request, stepId)
      ) continue;
      const objects = await this.blockers.prepare(
        story,
        request.id,
        source.type === 'bug' ? 'defect' : 'quality-gap',
      );
      await this.repository.commit(objects);
    }
  }

  /**
   * Whether this hop is aimed downstream of a discovering Step that has not delivered yet.
   *
   * Parking the discovering Story is right when the repair lands upstream: FUNCTIONAL_TEST finds a
   * defect, CODE repairs it, and the test must not re-run and re-declare success in between. It is
   * also right for a hop aimed downstream of a Step that already delivered — the hop is reachable,
   * and only the Story waits. The deadlock is the remaining case: the hop's Step cannot become
   * ready until the discovering Step delivers, so parking that Story leaves each waiting on the
   * other, and the Phase stops with every actor idle.
   */
  private async hopWaitsOnDiscoveringStep(
    request: ChangeRequestTicket,
    discoveringStepId: ObjectId,
  ): Promise<boolean> {
    const discovering = await this.state.requireStep(discoveringStepId);
    if (stepSatisfiesDependency(discovering)) return false;
    const target = await this.state.requireStep(request.targetStepId);
    if (target.id === discoveringStepId) return false;
    const steps = await this.repository.list({ objectType: 'step', projectId: request.projectId });
    const byId = new Map(steps
      .filter((object): object is Step => object.objectType === 'step')
      .map((step) => [step.id, step]));
    return stepDependsOn(target, discoveringStepId, byId);
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
  /**
   * The Ticket at the head of a contract-change chain, whose delta is the change the chain exists to land.
   *
   * Every hop rewrites its own delta with what that hop changed, which is right for scope and wrong
   * for substance: by the third hop the delta reads "docs/03-detailed-design.md is accepted in its
   * current form" and carries none of the requirement. Walking to the head recovers it structurally
   * rather than parsing it back out of the verification gate's prose.
   */
  private async rootContractChange(request: ChangeRequestTicket): Promise<ChangeRequestTicket> {
    let current = request;
    const seen = new Set<ObjectId>([current.id]);
    while (current.parentChangeRequestId && !seen.has(current.parentChangeRequestId)) {
      seen.add(current.parentChangeRequestId);
      // Reading the chain is context, not the work. An unreadable ancestor must not stop the delta
      // from travelling — the nearest one we did read still carries a real change, and losing the
      // whole hop over missing background is a worse answer than slightly poorer background.
      const parent = await this.state.requireTicket(current.parentChangeRequestId).catch(() => undefined);
      if (!parent || parent.type !== 'change-request') break;
      current = parent;
    }
    return current;
  }

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
    // The change itself, unchanged at every hop. Only the scope is local; the requirement is not.
    const root = await this.rootContractChange(parent);
    const child = await this.tickets.openChangeRequest({
      changeKind: parent.changeKind === 'contract-change' ? 'contract-change' : 'corrective',
      creatorActorId,
      sourceTicketIds: parent.sourceTicketIds,
      triggerStepId: parent.triggerStepId,
      sourceStepId: parent.targetStepId,
      targetStepId,
      // The remaining scope, starting at this hop. A hop added to reach a Bug's proving Step is not
      // in the parent's planned scope, so it opens a scope of its own rather than slicing from a
      // list that never contained it.
      propagationStepIds: parent.propagationStepIds.includes(targetStepId)
        ? parent.propagationStepIds.slice(parent.propagationStepIds.indexOf(targetStepId))
        : [targetStepId],
      contractDelta: {
        // What the upstream Step actually changed, stated in full, plus why the chain exists. A hop
        // decides its own exposure, so it needs both: the change to assess, and the requirement that
        // makes the assessment meaningful. Carrying only the first left CODE reading
        // "docs/03-detailed-design.md is accepted in its current form" — a statement about a file it
        // does not own, with nothing to assess — so it answered "not mine", correctly, and the
        // product never changed while the design said it had.
        // A hop that changed nothing passes the upstream change on untouched rather than wrapping it:
        // wrapping nests on every no-op hop and the text grows without bound down a long chain.
        // That a hop changed nothing is stated in the plan, where it is instruction rather than content.
        summary: changed.length > 0 ? applied.summary : parent.contractDelta.summary,
        before: [`This chain exists to satisfy: ${root.contractDelta.summary}`],
        after: changed.length > 0
          ? [`${artifacts.join(', ')} now carry that change; downstream Steps must be consistent with it.`]
          : [...parent.contractDelta.after],
        affectedArtifacts: artifacts,
      },
      // The question a hop answers is impact, not ownership of the upstream file. Naming that file as
      // the task made every Step that did not own it close the chain untouched; naming it as the
      // material to read keeps the guard this construction was written for — a hop never inherits
      // work it cannot do — while asking the judgement that makes the chain worth propagating.
      implementationPlan: [
        `Upstream changed: ${changed.length > 0 ? applied.summary : 'nothing at the previous Step'}`,
        `Read ${artifacts.join(', ')} and decide whether that change affects what this Step owns.`,
        'Apply what it requires of this Step; if nothing here is affected, record that as the outcome.',
        'Either way the change continues downstream, so state what you changed for the next Step.',
      ],
      verificationGate: parent.verificationGate,
      parentChangeRequestId: parent.id,
      correlationId: parent.source.correlationId,
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

function nextPropagationStepId(
  request: ChangeRequestTicket,
  currentStepId: ObjectId,
): ObjectId | undefined {
  const index = request.propagationStepIds.indexOf(currentStepId);
  if (index < 0) {
    throw new Error(`Change Request ${request.name} does not include its current target in propagation scope`);
  }
  return request.propagationStepIds[index + 1];
}

/**
 * Whether a verification Step's failure is confined to the supplement it owns.
 *
 * A verification Step adds risk cases under its own root while the paired baseline belongs to its
 * source Step, and its gate runs both. Routing the whole gate failure to the source is right for the
 * baseline and wrong for the supplement: the source owns neither the file nor the write scope for
 * it. A live FUNCTIONAL_TEST failure — `test_error_csv_content_rows`, a supplement case calling
 * `write_error_csv` with a path the implementation appends its own suffix to — was routed to
 * REQUIREMENT_ANALYSIS, whose allowlist held neither that file nor the implementation. It delivered
 * nine times without touching either, and the run looped until it was stopped by hand.
 *
 * Every failing case must be in the supplement, not merely some: a baseline failure means the
 * product does not satisfy the contract its source defined, and that is the source's to answer no
 * matter what else failed alongside it. A supplement that correctly exposes a product defect lands
 * here first and reports it onward from here, which is how a verification Step raises one anyway.
 */
function failureConfinedToSupplement(step: Step, outcomes: readonly TestOutcome[]): boolean {
  const failing = outcomes
    .filter((outcome) => outcome.status === 'failed' || outcome.status === 'timed_out')
    .flatMap((outcome) => outcome.failedTests);
  if (failing.length === 0) return false;
  // Matched by directory and Step id rather than by rebuilding the exact root: the path is composed
  // from the execution Step while routing holds the domain Step, and the two agreeing on an id is a
  // property of the current wiring, not something this decision should depend on.
  const owned = `${VERIFICATION_SUPPLEMENT_DIR}/`;
  return failing.every((test) => {
    const path = normalizeGitPath(test);
    return path.startsWith(owned) && path.includes(step.id);
  });
}
