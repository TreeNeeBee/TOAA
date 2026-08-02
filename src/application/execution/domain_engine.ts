import type { Plan } from '../../core/plan.js';
import { createObjectId, type ObjectId } from '../../domain/identity/object_id.js';
import type { Phase } from '../../domain/phases/phase.js';
import { STEP_TYPE_ORDER, type Step } from '../../domain/steps/step.js';
import type { TicketSolution } from '../../domain/tickets/ticket.js';
import { DomainScheduler, type ScheduledWork } from '../../domain/workflow/scheduler.js';
import type { DomainObjectRepository } from '../../infrastructure/repository/domain_object_repository.js';
import type { PluginHost } from '../../plugins/host.js';
import type { ToolPermissionRequest } from '../../tools/types.js';
import {
  DomainAttemptRunner,
  changelistEntries,
  type AttemptInput,
  type AttemptResult,
  type AttemptRunnerOptions,
} from './attempt_runner.js';
import { projectExecutionPlan } from './execution_adapter.js';
import { classifyAttemptFailure } from './failure_classification.js';

export interface DomainEngineOptions extends Omit<AttemptRunnerOptions, 'repository' | 'plugins'> {
  repository: DomainObjectRepository;
  plugins: PluginHost;
  maxTransitions?: number;
  attemptRunner?: {
    initialize(): Promise<void>;
    run(input: AttemptInput): Promise<AttemptResult>;
    synchronizeVerifiedBugResolutions?(projectId: ObjectId): Promise<void>;
    recordVerifiedBugResolution?(ticketId: ObjectId): Promise<void>;
  };
  finalGate?: () => Promise<{ ok: boolean; reason?: string; failureLog?: string }>;
  onTransition?: (event: {
    event: 'phase_started' | 'step_started' | 'ticket_started' | 'ticket_routed' | 'step_delivered' | 'phase_delivered' | 'project_delivered';
    projectId: ObjectId;
    phaseId: ObjectId;
    stepId?: ObjectId;
    stepName?: string;
    ticketId?: ObjectId;
    ticketType?: string;
    correlationId: ObjectId;
    causationId?: ObjectId;
    message?: string;
  }) => void | Promise<void>;
}

export interface DomainEngineResult {
  totalSteps: number;
  executedSteps: number;
  failedStepId?: string;
  failureLog?: string;
  failureReason?: string;
  phaseId: ObjectId;
  nextPhaseId?: ObjectId;
  projectDelivered?: boolean;
}

export class DomainExecutionEngine {
  private readonly scheduler: DomainScheduler;
  private readonly runner: NonNullable<DomainEngineOptions['attemptRunner']>;

  constructor(private readonly options: DomainEngineOptions, private readonly draft: Plan) {
    this.scheduler = new DomainScheduler(options.repository);
    this.runner = options.attemptRunner ?? new DomainAttemptRunner(options, draft.language);
  }

  async run(phaseId: ObjectId): Promise<DomainEngineResult> {
    await this.options.plugins.initialize();
    await this.runner.initialize();
    const phase = await this.requirePhase(phaseId);
    await this.recoverMisroutedInfrastructureBugs(phase);
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
    const profileManifest = this.draft.language === 'python' ? 'requirements.txt' : 'package.json';
    if (await this.options.workspace.exists(profileManifest)) {
      await this.requirePermission({
        operationType: 'build_command',
        target: `sandbox build ${profileManifest}`,
        reason: 'Prepare project dependencies before executing the V-model.',
        risk: 'The configured package manager executes inside the selected sandbox.',
        scope: 'current workspace sandbox',
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
    const transitionLimit = this.options.maxTransitions ?? Math.max(32, steps.length * 8);
    for (let transition = 0; transition < transitionLimit; transition += 1) {
      let work: ScheduledWork | undefined;
      try {
        work = await this.scheduler.resume(phase.id);
      } catch (error) {
        return this.failure(phase.id, steps.length, executed, undefined, (error as Error).message);
      }
      if (!work) {
        if (this.options.finalGate) {
          const gate = await this.options.finalGate();
          if (!gate.ok) {
            const acceptance = steps.find((step) => step.type === 'ACCEPTANCE_TEST');
            if (!acceptance) {
              return this.failure(phase.id, steps.length, executed, undefined, gate.reason ?? 'Final gate failed');
            }
            await this.scheduler.routeFailure({
              failedStepId: acceptance.id,
              message: gate.failureLog ?? gate.reason ?? 'Final project gate failed.',
              summary: gate.reason ?? 'Final project gate failed.',
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

      const executionStep = projection.byDomainStepId.get(work.step.id);
      if (!executionStep) {
        return this.failure(phase.id, steps.length, executed, work.step, `Execution specification missing for ${work.step.name}`);
      }
      try {
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
      const result = await this.runner.run({
        plan: projection.plan,
        executionStep,
        domainStep: work.step,
        ticket: work.ticket,
        mode: work.mode,
      });
      executed += 1;
      await this.options.plugins.emit('step.after', { plan: projection.plan, step: executionStep, ok: result.ok });

      if (!result.ok) {
        await this.options.audit.event('note', `${work.step.name} attempt rejected`, {
          messageId: 'domain.step_attempt_rejected',
          projectId: work.step.projectId,
          phaseId: phase.id,
          stepId: work.step.id,
          stepName: work.step.name,
          ticketId: work.ticket.id,
          workMode: work.mode,
          reason: result.reason,
          failureLog: result.failureLog,
        });
        if (result.failureKind === 'infrastructure') {
          const reason = result.reason ?? 'LLM infrastructure request failed.';
          await this.scheduler.deferInfrastructureFailure(work, reason);
          await this.options.audit.event('note', `${work.step.name} infrastructure failure deferred`, {
            messageId: 'domain.infrastructure_failure_deferred',
            projectId: work.step.projectId,
            phaseId: phase.id,
            stepId: work.step.id,
            stepName: work.step.name,
            ticketId: work.ticket.id,
            workMode: work.mode,
            reason,
          });
          return this.failure(
            phase.id,
            steps.length,
            executed,
            work.step,
            `LLM infrastructure failure; ${work.ticket.name} remains active for retry: ${result.failureLog ?? reason}`,
          );
        }
        if (
          result.assessment &&
          !result.assessment.passed &&
          (work.mode === 'normal' || work.mode === 'change-request')
        ) {
          const routed = await this.scheduler.routeQualityGap({
            sourceStepId: work.step.id,
            finding: [
              result.reason ?? 'Step quality gate did not pass.',
              ...result.assessment.evidence,
            ].filter(Boolean).join('\n'),
            kind: qualityGapKind(work.step),
            qualityAssessmentId: result.assessment.id,
            correlationId: work.ticket.source.correlationId,
            causationId: work.ticket.id,
            parentChangeRequestId: work.mode === 'change-request' ? work.ticket.id : undefined,
          });
          await this.routed(phase, work, routed.id, routed.type, routed.source.correlationId);
          continue;
        }
        if (work.mode === 'change-request') {
          const routed = await this.scheduler.routeFailure({
            failedStepId: work.step.id,
            message: result.failureLog ?? result.reason ?? 'Change Request verification failed.',
            summary: result.reason ?? `Change Request ${work.ticket.name} failed in ${work.step.name}.`,
            correlationId: work.ticket.source.correlationId,
            causationId: work.ticket.id,
            parentChangeRequestId: work.ticket.id,
          });
          await this.routed(phase, work, routed.id, routed.type, routed.source.correlationId);
          continue;
        }
        if (work.mode !== 'normal') {
          continue;
        }
        const routed = await this.scheduler.routeFailure({
          failedStepId: work.step.id,
          message: result.failureLog ?? result.reason ?? 'Step execution failed.',
          summary: result.reason ?? 'Step execution failed.',
          correlationId: createObjectId(),
        });
        await this.routed(phase, work, routed.id, routed.type, routed.source.correlationId);
        continue;
      }
      if (!result.assessment) {
        return this.failure(phase.id, steps.length, executed, work.step, 'Passing attempt has no Quality Assessment');
      }

      if (work.mode === 'normal') {
        await this.scheduler.deliverNormal(work, result.assessment.id);
      } else if (work.ticket.type === 'bug' || work.ticket.type === 'enhancement') {
        const affected = downstreamStepIds(steps, work.step);
        if (affected.length === 0) {
          return this.failure(phase.id, steps.length, executed, work.step, `${work.ticket.name} has no downstream verification path`);
        }
        const solution = correctiveSolution(work, result.solutionPlan, result.changedFiles, result.commit);
        const parentTicket = work.ticket.parentTicketId
          ? await this.options.repository.read(work.ticket.parentTicketId)
          : undefined;
        const request = await this.scheduler.propagateCorrectiveChange({
          work,
          qualityAssessmentId: result.assessment.id,
          solution,
          affectedStepIds: affected,
          contractDelta: {
            summary: result.solutionPlan ?? `Apply verified correction from ${work.step.name}.`,
            before: [work.ticket.description],
            after: work.ticket.acceptance,
            affectedArtifacts: result.changedFiles.length > 0 ? result.changedFiles : work.step.outputs,
          },
          implementationPlan: [
            `Apply the accepted delta from ${work.step.name} incrementally.`,
            'Preserve unrelated accepted artifacts.',
            'Run every affected downstream quality and verification gate.',
          ],
          verificationGate: work.ticket.acceptance,
          debugWikiCandidateEntryIds: result.wikiEntryIds,
          parentChangeRequestId: parentTicket?.objectType === 'ticket' && parentTicket.type === 'change-request'
            ? parentTicket.id
            : undefined,
          sourceChange: {
            summary: result.solutionPlan ?? `Corrected ${work.ticket.name} in ${work.step.name}.`,
            entries: result.changes ?? changelistEntries(result.changedFiles),
            commit: result.commit,
            verification: result.assessment.evidence,
          },
        });
        await this.routed(phase, work, request.id, request.type, request.source.correlationId);
      } else if (work.ticket.type === 'change-request') {
        const completion = await this.scheduler.completeChangeRequestStep({
          work,
          qualityAssessmentId: result.assessment.id,
          summary: result.solutionPlan ?? `Applied ${work.ticket.name} to ${work.step.name}.`,
          entries: result.changes ?? changelistEntries(result.changedFiles),
          commit: result.commit,
          verification: result.assessment.evidence,
        });
        if (completion.closed && completion.sourceTicketId && completion.sourceTicketType === 'bug') {
          await this.runner.recordVerifiedBugResolution?.(completion.sourceTicketId);
        }
      } else {
        return this.failure(phase.id, steps.length, executed, work.step, `Unsupported corrective Ticket ${work.ticket.type}`);
      }
      await this.options.audit.event('phase.end', `${work.step.name} ${work.mode} gate passed`, {
        messageId: 'domain.step_delivered',
        projectId: work.step.projectId,
        phaseId: phase.id,
        stepId: work.step.id,
        stepName: work.step.name,
        ticketId: work.ticket.id,
        qualityAssessmentId: result.assessment.id,
        commit: result.commit,
      });
      await this.transition({
        event: 'step_delivered',
        projectId: work.step.projectId,
        phaseId: phase.id,
        stepId: work.step.id,
        stepName: work.step.name,
        ticketId: work.ticket.id,
        ticketType: work.ticket.type,
        correlationId: work.ticket.source.correlationId,
        causationId: work.ticket.source.causationId,
        message: `${work.mode} quality gate passed`,
      });
    }
    return this.failure(
      phase.id,
      steps.length,
      executed,
      undefined,
      `Domain scheduler exceeded ${transitionLimit} transitions; active Ticket graph did not converge`,
    );
  }

  private async phaseSteps(phase: Phase): Promise<Step[]> {
    const objects = await Promise.all(phase.stepIds.map((id) => this.options.repository.read(id)));
    return objects.map((object) => {
      if (object.objectType !== 'step') throw new Error(`Phase ${phase.name} references non-Step ${object.id}`);
      return object;
    }).sort((left, right) => STEP_TYPE_ORDER[left.type] - STEP_TYPE_ORDER[right.type]);
  }

  private async recoverMisroutedInfrastructureBugs(phase: Phase): Promise<void> {
    const objects = await this.options.repository.list({ objectType: 'ticket', projectId: phase.projectId });
    for (const object of objects) {
      if (
        object.objectType !== 'ticket' ||
        object.type !== 'bug' ||
        object.phaseId !== phase.id ||
        object.state === 'closed' ||
        object.state === 'cancelled' ||
        object.solution ||
        object.changelistIds.length > 0 ||
        object.changeRequestTicketIds.length > 0 ||
        classifyAttemptFailure(object.failure.message) !== 'infrastructure'
      ) {
        continue;
      }
      await this.scheduler.recoverMisroutedInfrastructureBug(object.id);
      await this.options.audit.event('note', `cancelled misrouted infrastructure Bug ${object.name}`, {
        messageId: 'domain.misrouted_infrastructure_bug_recovered',
        projectId: object.projectId,
        phaseId: phase.id,
        stepId: object.failure.failedStepId,
        ticketId: object.id,
        reason: object.failure.summary,
      });
    }
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
      : { approved: true };
    if (!decision.approved) throw new Error(`permission denied for ${request.operationType}: ${request.target}`);
  }

  private async routed(
    phase: Phase,
    source: ScheduledWork,
    ticketId: ObjectId,
    ticketType: string,
    correlationId: ObjectId,
  ): Promise<void> {
    await this.transition({
      event: 'ticket_routed',
      projectId: phase.projectId,
      phaseId: phase.id,
      stepId: source.step.id,
      stepName: source.step.name,
      ticketId,
      ticketType,
      correlationId,
      causationId: source.ticket.id,
      message: `${ticketType} routed from ${source.step.name}`,
    });
  }

  private async transition(event: Parameters<NonNullable<DomainEngineOptions['onTransition']>>[0]): Promise<void> {
    await this.options.onTransition?.(event);
  }

  private failure(
    phaseId: ObjectId,
    totalSteps: number,
    executedSteps: number,
    step: Step | undefined,
    reason: string,
  ): DomainEngineResult {
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

function downstreamStepIds(steps: readonly Step[], source: Step): ObjectId[] {
  const sourceOrder = STEP_TYPE_ORDER[source.type];
  return steps
    .filter((step) => STEP_TYPE_ORDER[step.type] > sourceOrder)
    .map((step) => step.id);
}

function correctiveSolution(
  work: ScheduledWork,
  plan: string | undefined,
  changedFiles: readonly string[],
  commit?: string,
): TicketSolution {
  return {
    status: 'proposed',
    approach: plan ?? `Repair ${work.ticket.description}`,
    rationale: `The ${work.ticket.type} was reproduced and corrected in ${work.step.name}.`,
    changes: [
      ...changedFiles,
      ...(commit ? [`commit:${commit}`] : []),
    ],
    verification: [],
    updatedAt: new Date().toISOString(),
  };
}

function qualityGapKind(step: Step): 'functional-gap' | 'test-incomplete' | 'quality-shortfall' {
  if (step.type === 'UNIT_TEST' || step.type === 'INTEGRATION_TEST' || step.type === 'SYSTEM_TEST' || step.type === 'ACCEPTANCE_TEST') {
    return 'test-incomplete';
  }
  return step.type === 'CODING' ? 'functional-gap' : 'quality-shortfall';
}
