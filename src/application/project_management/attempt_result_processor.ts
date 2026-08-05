import { createObjectId, type ObjectId } from '../../domain/identity/object_id.js';
import type { Phase } from '../../domain/phases/phase.js';
import { STEP_TYPE_ORDER, type Step } from '../../domain/steps/step.js';
import type { TicketSolution } from '../../domain/tickets/ticket.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { AuditLogger } from '../../audit/audit.js';
import { changelistEntries, type AttemptResult } from '../execution/attempt_runner.js';
import type { ProjectController, ScheduledWork } from './project_controller.js';
import type { TicketRegistrationService } from './ticket_registration_service.js';

export interface AttemptResultProcessorOptions {
  repository: DomainObjectRepositoryPort;
  controller: ProjectController;
  tickets: TicketRegistrationService;
  audit: AuditLogger;
  recordVerifiedBugResolution?: (ticketId: ObjectId) => Promise<void>;
  onTransition: (event: AttemptTransitionEvent) => Promise<void>;
}

export interface AttemptTransitionEvent {
  event: 'ticket_routed' | 'step_delivered';
  projectId: ObjectId;
  phaseId: ObjectId;
  stepId: ObjectId;
  stepName: string;
  ticketId: ObjectId;
  ticketType: string;
  correlationId: ObjectId;
  causationId?: ObjectId;
  message: string;
}

export type AttemptDisposition =
  | { action: 'continue' }
  | { action: 'stop'; reason: string };

export class AttemptResultProcessor {
  constructor(private readonly options: AttemptResultProcessorOptions) {}

  async process(input: {
    phase: Phase;
    work: ScheduledWork;
    steps: readonly Step[];
    result: AttemptResult;
  }): Promise<AttemptDisposition> {
    const { phase, work, steps, result } = input;
    if (!result.ok) return this.processFailure(phase, work, result);
    if (!result.assessment) {
      return { action: 'stop', reason: 'Passing attempt has no Quality Assessment' };
    }

    if (work.mode === 'normal') {
      await this.options.controller.deliverNormal(work, result.assessment.id);
    } else if (work.ticket.type === 'bug' || work.ticket.type === 'enhancement') {
      const affected = downstreamStepIds(steps, work.step);
      if (affected.length === 0) {
        return {
          action: 'stop',
          reason: `${work.ticket.name} has no downstream verification path`,
        };
      }
      const solution = correctiveSolution(work, result.solutionPlan, result.changedFiles, result.commit);
      const parentTicket = work.ticket.parentTicketId
        ? await this.options.repository.read(work.ticket.parentTicketId)
        : undefined;
      const request = await this.options.controller.propagateCorrectiveChange({
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
      await this.routeTicket(phase, work, request.id, request.type, request.source.correlationId);
    } else if (work.ticket.type === 'change-request') {
      const completion = await this.options.controller.completeChangeRequestStep({
        work,
        qualityAssessmentId: result.assessment.id,
        summary: result.solutionPlan ?? `Applied ${work.ticket.name} to ${work.step.name}.`,
        entries: result.changes ?? changelistEntries(result.changedFiles),
        commit: result.commit,
        verification: result.assessment.evidence,
      });
      if (completion.closed && completion.sourceTicketId && completion.sourceTicketType === 'bug') {
        await this.options.recordVerifiedBugResolution?.(completion.sourceTicketId);
      }
    } else {
      return {
        action: 'stop',
        reason: `Unsupported corrective Ticket ${work.ticket.type}`,
      };
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
    await this.options.onTransition({
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
    return { action: 'continue' };
  }

  private async processFailure(
    phase: Phase,
    work: ScheduledWork,
    result: AttemptResult,
  ): Promise<AttemptDisposition> {
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
      await this.options.controller.deferInfrastructureFailure(work, reason);
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
      return {
        action: 'stop',
        reason: `LLM infrastructure failure; ${work.ticket.name} remains active for retry: ${result.failureLog ?? reason}`,
      };
    }
    if (
      result.assessment &&
      !result.assessment.passed &&
      (work.mode === 'normal' || work.mode === 'change-request')
    ) {
      const routed = await this.options.controller.routeQualityGap({
        creatorActorId: await this.options.tickets.ownerActorId(work.ticket.id),
        sourceStepId: work.step.id,
        finding: [result.reason ?? 'Step quality gate did not pass.', ...result.assessment.evidence]
          .filter(Boolean)
          .join('\n'),
        kind: qualityGapKind(work.step),
        qualityAssessmentId: result.assessment.id,
        correlationId: work.ticket.source.correlationId,
        causationId: work.ticket.id,
        parentChangeRequestId: work.mode === 'change-request' ? work.ticket.id : undefined,
      });
      await this.routeTicket(phase, work, routed.id, routed.type, routed.source.correlationId);
      return { action: 'continue' };
    }
    if (result.failure?.code === 'replay_miss') {
      const routed = await this.options.controller.routeQualityGap({
        creatorActorId: await this.options.tickets.ownerActorId(work.ticket.id),
        sourceStepId: work.step.id,
        finding: result.failure.message,
        kind: 'test-incomplete',
        correlationId: work.ticket.source.correlationId,
        causationId: work.ticket.id,
        parentChangeRequestId: work.mode === 'change-request' ? work.ticket.id : undefined,
      });
      await this.routeTicket(phase, work, routed.id, routed.type, routed.source.correlationId);
      return { action: 'continue' };
    }
    if (work.mode === 'change-request') {
      const routed = await this.options.controller.routeFailure({
        creatorActorId: await this.options.tickets.ownerActorId(work.ticket.id),
        failedStepId: work.step.id,
        message: result.failureLog ?? result.reason ?? 'Change Request verification failed.',
        summary: result.reason ?? `Change Request ${work.ticket.name} failed in ${work.step.name}.`,
        failure: result.failure ?? fallbackExecutionFailure(result.reason),
        correlationId: work.ticket.source.correlationId,
        causationId: work.ticket.id,
        parentChangeRequestId: work.ticket.id,
      });
      await this.routeTicket(phase, work, routed.id, routed.type, routed.source.correlationId);
      return { action: 'continue' };
    }
    if (work.mode !== 'normal') return { action: 'continue' };
    const routed = await this.options.controller.routeFailure({
      creatorActorId: await this.options.tickets.ownerActorId(work.ticket.id),
      failedStepId: work.step.id,
      message: result.failureLog ?? result.reason ?? 'Step execution failed.',
      summary: result.reason ?? 'Step execution failed.',
      failure: result.failure ?? fallbackExecutionFailure(result.reason),
      correlationId: createObjectId(),
    });
    await this.routeTicket(phase, work, routed.id, routed.type, routed.source.correlationId);
    return { action: 'continue' };
  }

  private async routeTicket(
    phase: Phase,
    source: ScheduledWork,
    ticketId: ObjectId,
    ticketType: string,
    correlationId: ObjectId,
  ): Promise<void> {
    await this.options.tickets.routeAndAssign(ticketId);
    await this.options.onTransition({
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
    changes: [...changedFiles, ...(commit ? [`commit:${commit}`] : [])],
    verification: [],
    updatedAt: new Date().toISOString(),
  };
}

function qualityGapKind(step: Step): 'functional-gap' | 'test-incomplete' | 'quality-shortfall' {
  if (
    step.type === 'UNIT_TEST' ||
    step.type === 'INTEGRATION_TEST' ||
    step.type === 'MODULE_TEST' ||
    step.type === 'FUNCTIONAL_TEST'
  ) return 'test-incomplete';
  return step.type === 'CODE' ? 'functional-gap' : 'quality-shortfall';
}

function fallbackExecutionFailure(reason?: string) {
  return {
    kind: 'execution' as const,
    category: 'internal' as const,
    code: 'unclassified_execution_failure',
    message: reason ?? 'Step execution failed.',
    retryable: true,
    switchProvider: false,
  };
}
