import type { Plan } from '../../core/plan.js';
import { resolveFileTreeService } from '../workspace/file_tree_resolver.js';
import { renderFileManifest, upsertFileManifest } from '../workspace/file_manifest.js';
import { DOC_NAMES } from '../../core/docs.js';
import { createObjectId, type ObjectId } from '../../domain/identity/object_id.js';
import type { Phase } from '../../domain/phases/phase.js';
import { STEP_TYPE_ORDER, type Step } from '../../domain/steps/step.js';
import { ProjectController, type ScheduledWork } from './project_controller.js';
import { TicketRegistrationService } from './ticket_registration_service.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { RoutingActor } from './role_registry.js';
import type { PluginHost } from '../../plugins/host.js';
import type { ToolPermissionRequest } from '../../tools/types.js';
import {
  DomainAttemptRunner,
  type AttemptInput,
  type AttemptResult,
  type AttemptRunnerOptions,
} from '../execution/attempt_runner.js';
import { projectExecutionPlan } from '../execution/execution_adapter.js';
import {
  ProjectStatusProjectionService,
  type ProjectProjectionWriter,
} from './project_projection.js';
import {
  OutboxDispatcher,
  type DomainEventPublisher,
} from '../observability/outbox_dispatcher.js';
import { AttemptResultProcessor } from './attempt_result_processor.js';
import { ProjectProgressGuard } from './progress_guard.js';
import { isCancellationError } from '../../core/cancellation.js';
import type { DeliveryGateFinding } from '../../domain/quality/delivery_gate.js';
import type { TicketWorkspaceBinding } from '../../domain/tickets/ticket.js';
import { QualityAssessmentService } from '../execution/quality_assessment_service.js';

interface MergeIntegrationResult {
  status: 'merged' | 'nothing-to-merge' | 'failed' | 'blocked' | 'awaiting-authorization';
  reason?: string;
  failureLog?: string;
  workspaceBinding?: TicketWorkspaceBinding;
}

export interface ProjectOrchestratorOptions extends Omit<AttemptRunnerOptions, 'repository' | 'plugins'> {
  repository: DomainObjectRepositoryPort;
  plugins: PluginHost;
  projectionWriter?: ProjectProjectionWriter;
  eventPublisher?: DomainEventPublisher;
  attemptRunner?: {
    initialize(): Promise<void>;
    run(input: AttemptInput): Promise<AttemptResult>;
    synchronizeVerifiedBugResolutions?(projectId: ObjectId): Promise<void>;
    recordVerifiedBugResolution?(ticketId: ObjectId): Promise<void>;
  };
  finalGate?: () => Promise<{
    ok: boolean;
    reason?: string;
    failureLog?: string;
    findings?: DeliveryGateFinding[];
    evidence?: string[];
  }>;
  /**
   * Carries the Phase's ChangeSets onto the mainline once its work is finished.
   *
   * Runs after the final gate and before the Phase is delivered: delivering a Phase whose change
   * never landed would let the next Phase build on work the mainline does not have.
   */
  /**
   * Lands a delivered Ticket's change on the mainline.
   *
   * Called as each Step delivers, because the next Step reads its output: a change still on its own
   * branch is invisible to everything that follows it in the V-model.
   */
  integrateTicket?: (rootTicketId: ObjectId) => Promise<MergeIntegrationResult>;
  integratePhase?: (phaseId: ObjectId) => Promise<MergeIntegrationResult>;
  integratePendingAuthorization?: (phaseId: ObjectId) => Promise<MergeIntegrationResult>;
  /** Commits a Runtime-authored delivery artifact before its revision is indexed. */
  commitCanonicalArtifact?: (stepId: ObjectId, summary: string) => Promise<string>;
  onTransition?: (event: {
    event: 'phase_started' | 'step_started' | 'ticket_started' | 'ticket_routed' | 'step_delivered' | 'phase_delivered' | 'project_delivered';
    projectId: ObjectId;
    phaseId: ObjectId;
    stepId?: ObjectId;
    stepName?: string;
    ticketId?: ObjectId;
    ticketName?: string;
    ticketType?: string;
    creatorActorId?: ObjectId;
    creatorRole?: string;
    assigneeActorId?: ObjectId;
    assigneeRole?: string;
    assigneeAgent?: string;
    correlationId: ObjectId;
    causationId?: ObjectId;
    message?: string;
  }) => void | Promise<void>;
}

export interface ProjectOrchestratorResult {
  totalSteps: number;
  executedSteps: number;
  failedStepId?: string;
  failureLog?: string;
  failureReason?: string;
  phaseId: ObjectId;
  nextPhaseId?: ObjectId;
  projectDelivered?: boolean;
}

export class ProjectOrchestrator {
  private readonly scheduler: ProjectController;
  private readonly runner: NonNullable<ProjectOrchestratorOptions['attemptRunner']>;
  private readonly tickets: TicketRegistrationService;
  private readonly projection: ProjectStatusProjectionService;
  private readonly outbox: OutboxDispatcher;
  private readonly results: AttemptResultProcessor;
  private readonly quality: QualityAssessmentService;

  constructor(private readonly options: ProjectOrchestratorOptions, private readonly draft: Plan) {
    this.scheduler = new ProjectController(options.repository, {
      onStepsClosed: (phaseId) => this.publishFileManifest(phaseId),
    });
    this.runner = options.attemptRunner ?? new DomainAttemptRunner(options, draft.language);
    this.tickets = new TicketRegistrationService(options.repository);
    this.projection = new ProjectStatusProjectionService(options.repository, options.projectionWriter);
    this.outbox = new OutboxDispatcher(options.repository, {
      publish: async (event) => {
        await this.projection.refresh(event.projectId);
        await options.eventPublisher?.publish(event);
      },
    });
    this.results = new AttemptResultProcessor({
      repository: options.repository,
      controller: this.scheduler,
      tickets: this.tickets,
      audit: options.audit,
      recordVerifiedBugResolution: this.runner.recordVerifiedBugResolution?.bind(this.runner),
      onTransition: (event) => this.transition(event),
    });
    this.quality = new QualityAssessmentService(options.repository);
  }

  /**
   * Writes the file manifest into the delivery document.
   *
   * Called when every V-model Step has closed and the delivery Ticket has not: every ChangeSet has
   * merged so the files are final, and delivery is still open so the manifest is part of what is
   * delivered rather than an edit made to a delivered artifact.
   *
   * The tree is reconciled before rendering. Incremental updates only cover writes this process performed, and
   * a squash merge lands the whole of CODE's work without passing through a tool at all — a
   * manifest built from the incremental index would omit exactly the files the project consists of.
   *
   * Failure propagates. The manifest is a delivery artifact by the same rule as the documents
   * beside it, and a Phase that could not produce one has not delivered what it claims.
   */
  private async publishFileManifest(phaseId: ObjectId): Promise<void> {
    const phase = await this.options.repository.read(phaseId);
    if (phase.objectType !== 'phase') return;
    const plans = await this.options.repository.list({
      objectType: 'project-management-plan',
      projectId: phase.projectId,
    });
    const plan = plans.find((object) => object.objectType === 'project-management-plan');
    if (plan?.objectType === 'project-management-plan' && plan.fileTree?.publishManifestOnDelivery === false) {
      return;
    }
    const tree = await resolveFileTreeService(
      this.options.repository,
      phase.projectId,
      this.options.workspace.root,
    );
    await tree.rescan();
    const document = await this.options.workspace.readFile(DOC_NAMES.delivery).catch(() => '');
    const section = renderFileManifest(await tree.entries(), { scannedAt: new Date().toISOString() });
    await this.options.workspace.writeFile(DOC_NAMES.delivery, upsertFileManifest(document, section));
    const finalRevision = this.options.commitCanonicalArtifact
      ? await this.options.commitCanonicalArtifact(phase.id, 'publish delivery file manifest')
      : undefined;
    // The manifest write is itself part of the delivered tree. Reconcile after its commit so the
    // indexed revision and the canonical working copy cannot diverge at the delivery boundary.
    await tree.rescan(finalRevision);
    await this.options.audit.event('note', `published the file manifest into ${DOC_NAMES.delivery}`, {
      messageId: 'domain.file_manifest_published',
      projectId: phase.projectId,
      phaseId,
    });
  }

  async run(phaseId: ObjectId): Promise<ProjectOrchestratorResult> {
    this.throwIfAborted();
    await this.options.plugins.initialize();
    await this.runner.initialize();
    const phase = await this.requirePhase(phaseId);
    await this.outbox.dispatchPending(phase.projectId);
    await this.projection.current(phase.projectId);
    await this.tickets.registerProjectTickets(phase.projectId);
    // Before anything is scheduled: a run starts with nothing in flight, so work still marked
    // in-progress belongs to a run that died mid-attempt and must be handed back.
    const reclaimed = await this.scheduler.reclaimUnreachableWork(phase.projectId);
    if (reclaimed > 0) {
      await this.options.audit.event('note', `reclaimed ${reclaimed} Ticket(s) from an interrupted run`, {
        messageId: 'domain.interrupted_work_reclaimed',
        projectId: phase.projectId,
        phaseId: phase.id,
        reclaimed,
      });
    }
    const unparked = await this.scheduler.releaseCyclicCorrectiveBlockers(phase.projectId);
    if (unparked > 0) {
      await this.options.audit.event('note', `released ${unparked} Ticket(s) parked behind a downstream repair hop`, {
        messageId: 'domain.cyclic_blocker_released',
        projectId: phase.projectId,
        phaseId: phase.id,
        released: unparked,
      });
    }
    await this.scheduler.reconcileClosedCorrectiveTickets(phase.projectId);
    await this.runner.synchronizeVerifiedBugResolutions?.(phase.projectId);
    await this.transition({
      event: 'phase_started', projectId: phase.projectId, phaseId: phase.id,
      correlationId: createObjectId(), message: phase.objective,
    });
    const steps = await this.phaseSteps(phase);
    const projection = projectExecutionPlan(this.draft, phase, steps);
    await this.requirePermission({
      operationType: 'git_operation',
      target: 'git snapshots for transactional Step execution',
      reason: 'Each Step attempt needs a reversible workspace baseline and a verified changelist commit.',
      risk: 'XCompiler may initialize the workspace repository and create local commits.',
      scope: 'current workspace',
      skippable: false,
      denyBehavior: 'Stop because failed attempts cannot be rolled back safely.',
    });
    await this.options.git.ensureRepo();
    if (this.options.integratePendingAuthorization) {
      const pending = await this.options.integratePendingAuthorization(phase.id);
      if (pending.status !== 'merged' && pending.status !== 'nothing-to-merge') {
        return this.failure(
          phase.id,
          steps.length,
          0,
          undefined,
          pending.reason ?? `pending merge integration ${pending.status}`,
        );
      }
    }
    const profileManifest = this.draft.language === 'python' ? 'requirements.txt' : 'package.json';
    if (await this.options.workspace.exists(profileManifest)) {
      await this.requirePermission({
        operationType: 'install_dependency',
        target: `sandbox build ${profileManifest}`,
        reason: 'Prepare project dependencies before executing the V-model.',
        risk: 'The configured package manager executes inside the selected sandbox.',
        scope: 'configured dependency registry',
        skippable: false,
        denyBehavior: 'Stop because downstream Steps cannot be verified.',
      });
      try {
        await this.options.sandbox.build(profileManifest);
      } catch (error) {
        return this.failure(phase.id, steps.length, 0, steps[0], `sandbox build failed: ${(error as Error).message}`);
      }
    }

    let executed = 0;
    const progress = new ProjectProgressGuard(this.options.repository);
    for (;;) {
      this.throwIfAborted();
      const observation = await progress.observe(phase.projectId, phase.id);
      if (observation.stalled) {
        return this.failure(
          phase.id,
          steps.length,
          executed,
          undefined,
          `Domain scheduler made no semantic progress for ${observation.unchangedObservations} observations`,
        );
      }
      let work: ScheduledWork | undefined;
      try {
        work = await this.scheduler.resume(phase.id);
      } catch (error) {
        return this.failure(phase.id, steps.length, executed, undefined, (error as Error).message);
      }
      if (!work) {
        const gate = this.options.finalGate
          ? await this.options.finalGate()
          : { ok: true, evidence: ['All Step and corrective Ticket gates are closed.'] };
        const phaseAssessment = await this.quality.assessPhase({
          phase: await this.requirePhase(phase.id),
          passed: gate.ok,
          evidence: gate.evidence ?? [gate.reason ?? 'Phase delivery gate evaluated.'],
          findings: gate.findings ?? [],
        });
        if (!gate.ok) {
          const acceptance = steps.find((step) => step.type === 'FUNCTIONAL_TEST');
          if (!acceptance || !gate.findings?.length) {
            return this.failure(
              phase.id,
              steps.length,
              executed,
              acceptance,
              gate.reason ?? 'Phase delivery gate failed without routable findings',
            );
          }
          await this.scheduler.intakeProblems({
            projectId: phase.projectId,
            phaseId: phase.id,
            origin: 'phase-delivery-gate',
            reports: gate.findings,
            correlationId: createObjectId(),
          });
          continue;
        }
        await this.scheduler.attachPhaseQuality(phase.id, phaseAssessment.id);
        if (this.options.integratePhase) {
          const integration = await this.options.integratePhase(phase.id);
          if (integration.status === 'blocked' || integration.status === 'awaiting-authorization') {
            // Neither is a defect in the project: the gate could not run, or the mainline is not
            // ours to write to. Both stop delivery without inventing a Bug.
            return this.failure(
              phase.id, steps.length, executed, undefined,
              integration.reason ?? `merge integration ${integration.status}`,
            );
          }
          if (integration.status === 'failed') {
            const acceptance = steps.find((step) => step.type === 'FUNCTIONAL_TEST');
            if (!acceptance) {
              return this.failure(
                phase.id, steps.length, executed, undefined,
                integration.reason ?? 'merge gate failed',
              );
            }
            // The gate observed the failure, so it creates the Bug and PM routes it.
            await this.scheduler.routeFailure({
              creatorActorId: await this.tickets.discovererActorIdForStep(acceptance.id),
              failedStepId: acceptance.id,
              message: integration.failureLog ?? integration.reason ?? 'Merge gate failed.',
              summary: integration.reason ?? 'Merge gate failed.',
              failure: {
                kind: 'execution',
                category: 'test',
                code: 'merge_gate_failed',
                message: integration.failureLog ?? integration.reason ?? 'Merge gate failed.',
                retryable: true,
                switchProvider: false,
              },
              correlationId: createObjectId(),
            });
            continue;
          }
        }
        try {
          const completion = await this.scheduler.completePhase(phase.id);
          await this.transition({
            event: 'phase_delivered',
            projectId: phase.projectId,
            phaseId: phase.id,
            correlationId: createObjectId(),
            message: 'Phase delivery gates passed.',
          });
          if (completion.projectDelivered) {
            await this.transition({
              event: 'project_delivered', projectId: phase.projectId, phaseId: phase.id,
              correlationId: createObjectId(), message: 'Project delivery gates passed.',
            });
          }
          return {
            phaseId: phase.id,
            nextPhaseId: completion.nextPhaseId,
            projectDelivered: completion.projectDelivered,
            totalSteps: steps.length,
            executedSteps: executed,
          };
        } catch (error) {
          return this.failure(phase.id, steps.length, executed, undefined, (error as Error).message);
        }
      }

      let assignee: RoutingActor | undefined;
      const executionStep = projection.byDomainStepId.get(work.step.id);
      if (!executionStep) {
        return this.failure(phase.id, steps.length, executed, work.step, `Execution specification missing for ${work.step.name}`);
      }
      try {
        const firstAssignment = !work.ticket.activeAssignmentId;
        const routed = await this.tickets.routeAndAssign(work.ticket.id, { forStepId: work.step.id });
        assignee = await this.tickets.routingActorById(routed.assignment.assigneeActorId);
        work = { ...work, ticket: routed.ticket };
        if (firstAssignment) {
          const creator = await this.tickets.actorById(routed.ticket.creatorActorId);
          const assigned = await this.tickets.actorById(routed.assignment.assigneeActorId);
          await this.transition({
            event: 'ticket_routed',
            projectId: phase.projectId,
            phaseId: phase.id,
            stepId: work.step.id,
            stepName: work.step.name,
            ticketId: routed.ticket.id,
            ticketName: routed.ticket.name,
            ticketType: routed.ticket.type,
            creatorActorId: creator.id,
            creatorRole: creator.role,
            assigneeActorId: assigned.id,
            assigneeRole: assigned.role,
            assigneeAgent: routed.ticket.agent,
            correlationId: routed.ticket.source.correlationId,
            causationId: routed.ticket.source.causationId,
            message: `${creator.role} created ${routed.ticket.name}; PM routed it to ${assigned.role}/${routed.ticket.agent}`,
          });
        }
        work = await this.scheduler.start(work);
      } catch (error) {
        return this.failure(phase.id, steps.length, executed, work.step, (error as Error).message);
      }
      await this.transition({
        event: 'ticket_started',
        projectId: work.step.projectId,
        phaseId: phase.id,
        stepId: work.step.id,
        stepName: work.step.name,
        ticketId: work.ticket.id,
        ticketType: work.ticket.type,
        correlationId: work.ticket.source.correlationId,
        causationId: work.ticket.source.causationId,
        message: `${work.ticket.name} entered ${work.mode} execution`,
      });
      await this.transition({
        event: 'step_started',
        projectId: work.step.projectId,
        phaseId: phase.id,
        stepId: work.step.id,
        stepName: work.step.name,
        ticketId: work.ticket.id,
        ticketType: work.ticket.type,
        correlationId: work.ticket.source.correlationId,
        causationId: work.ticket.source.causationId,
        message: `${work.mode} execution started`,
      });
      await this.options.plugins.emit('step.before', { plan: projection.plan, step: executionStep });
      let result: AttemptResult;
      try {
        result = await this.runner.run({
          plan: projection.plan,
          executionStep,
          domainStep: work.step,
          ticket: work.ticket,
          mode: work.mode,
          assignee,
        });
      } catch (error) {
        if (isCancellationError(error, this.options.abortSignal)) {
          await this.scheduler.deferCancelledAttempt(
            work,
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      }
      executed += 1;
      await this.options.plugins.emit('step.after', { plan: projection.plan, step: executionStep, ok: result.ok });

      const disposition = await this.results.process({ phase, work, steps, result });
      if (disposition.action === 'stop') {
        // Result processing can park the active Step/Ticket before asking the Runtime to stop.
        // Keep PM's derived cache aligned with those authoritative transitions at the session
        // boundary; no subsequent lifecycle event exists to refresh it for a stopped run.
        await this.projection.refresh(phase.projectId);
        return this.failure(phase.id, steps.length, executed, work.step, disposition.reason);
      }
      if (result.ok && this.options.integrateTicket) {
        // The delivering Ticket itself. Its ChangeSet is keyed on the CODE Story that owns the
        // branch, and a Bug or CR repairing that Story is recorded on the same ChangeSet — whereas
        // `rootTicketId` is the Phase Epic, which owns no branch and matches nothing.
        const landed = await this.options.integrateTicket(work.ticket.id);
        // A failing gate found a defect in the merged result and says so with its own checks, so it
        // takes the repair path every other discovered defect takes. `blocked` is different in kind:
        // the gate could not run, nothing about the project was shown to be wrong, and there is
        // nothing to ask anyone to repair.
        if (landed.status === 'failed') {
          const gate = await this.results.processIntegrationFailure({
            phase,
            work,
            reason: landed.reason ?? 'merge gate rejected the change',
            failureLog: landed.failureLog,
            workspaceBinding: landed.workspaceBinding,
          });
          if (gate.action === 'stop') {
            return this.failure(phase.id, steps.length, executed, work.step, gate.reason);
          }
        } else if (landed.status === 'awaiting-authorization') {
          await this.options.audit.event('note', `${work.step.name} passed its gate but was not merged`, {
            messageId: 'domain.merge_awaiting_authorization',
            projectId: work.step.projectId,
            phaseId: phase.id,
            stepId: work.step.id,
            stepName: work.step.name,
            ticketId: work.ticket.id,
            reason: landed.reason,
          });
          return this.failure(
            phase.id,
            steps.length,
            executed,
            work.step,
            landed.reason ?? 'merge authorization is required before downstream execution',
          );
        } else if (landed.status === 'blocked') {
          return this.failure(
            phase.id, steps.length, executed, work.step,
            landed.reason ?? 'merge integration blocked',
          );
        }
      }
    }
  }

  private throwIfAborted(): void {
    const signal = this.options.abortSignal;
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error('Runtime task cancelled');
    error.name = 'AbortError';
    throw error;
  }

  private async phaseSteps(phase: Phase): Promise<Step[]> {
    const objects = await Promise.all(phase.stepIds.map((id) => this.options.repository.read(id)));
    return objects.map((object) => {
      if (object.objectType !== 'step') throw new Error(`Phase ${phase.name} references non-Step ${object.id}`);
      return object;
    }).sort((left, right) => STEP_TYPE_ORDER[left.type] - STEP_TYPE_ORDER[right.type]);
  }

  private async requirePhase(id: ObjectId): Promise<Phase> {
    const object = await this.options.repository.read(id);
    if (object.objectType !== 'phase') throw new Error(`Object ${id} is not a Phase`);
    if (object.stepIds.length === 0) throw new Error(`Phase ${object.name} is not materialized`);
    return object;
  }

  private async requirePermission(request: ToolPermissionRequest): Promise<void> {
    const decision = this.options.requestPermission
      ? await this.options.requestPermission(request)
      : { approved: false, reason: 'No Runtime permission policy is configured.' };
    if (!decision.approved) throw new Error(`permission denied for ${request.operationType}: ${request.target}`);
  }

  private async transition(event: Parameters<NonNullable<ProjectOrchestratorOptions['onTransition']>>[0]): Promise<void> {
    await this.outbox.dispatchPending(event.projectId);
    await this.projection.refresh(event.projectId);
    await this.options.onTransition?.(event);
  }

  private failure(
    phaseId: ObjectId,
    totalSteps: number,
    executedSteps: number,
    step: Step | undefined,
    reason: string,
  ): ProjectOrchestratorResult {
    return {
      phaseId,
      totalSteps,
      executedSteps,
      failedStepId: step?.id ?? phaseId,
      failureReason: reason,
      failureLog: reason,
    };
  }
}
