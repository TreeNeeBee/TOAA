import { createObjectId, type ObjectId } from '../../domain/identity/object_id.js';
import type { Phase } from '../../domain/phases/phase.js';
import { STEP_TYPE_ORDER, type Step } from '../../domain/steps/step.js';
import {
  VALIDATION_CONTRACT_DEFECT_CODE,
  type TicketSolution,
} from '../../domain/tickets/ticket.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { AuditLogger } from '../../audit/audit.js';
import { changelistEntries, type AttemptResult } from '../execution/attempt_runner.js';
import type { ProjectController, ScheduledWork } from './project_controller.js';
import type { TicketRegistrationService } from './ticket_registration_service.js';
import type { DeliveryGateFinding } from '../../domain/quality/delivery_gate.js';

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
  ticketName?: string;
  ticketType: string;
  creatorActorId?: ObjectId;
  creatorRole?: string;
  assigneeActorId?: ObjectId;
  assigneeRole?: string;
  assigneeAgent?: string;
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
    if (!result.ok) return this.processFailure(phase, work, steps, result);
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
      const affectedArtifacts = correctiveAffectedArtifacts(steps, work.step, result);
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
          affectedArtifacts,
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
      // No Change Request means the repair had nowhere to propagate: the Change Request it was
      // raised inside re-applies that Step itself and carries the repair onward. The corrective
      // Ticket closed in place, so there is nothing to route.
      if (request) {
        await this.routeTicket(phase, work, request.id, request.type, request.source.correlationId);
      }
    } else if (work.ticket.type === 'change-request') {
      const completion = await this.options.controller.completeChangeRequestStep({
        work,
        qualityAssessmentId: result.assessment.id,
        summary: result.solutionPlan ?? `Applied ${work.ticket.name} to ${work.step.name}.`,
        entries: result.changes ?? changelistEntries(result.changedFiles),
        commit: result.commit,
        verification: result.assessment.evidence,
        application: result.changeRequestDisposition,
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
    steps: readonly Step[],
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
    // Before anything else: a Step that needs a package it does not own has not produced a defect,
    // and opening a Bug against it would ask the wrong role to repair the wrong artifact. The need
    // goes back to the design that owns the manifest, and PM parks this Step until it answers.
    if (result.dependencyRequest) {
      const routed = await this.options.controller.routeDependencyChange({
        requestingStepId: work.step.id,
        requestingTicket: work.ticket,
        packages: result.dependencyRequest.packages,
        reason: result.dependencyRequest.reason,
        creatorActorId: await this.options.tickets.ownerActorId(work.ticket.id),
        correlationId: work.ticket.source.correlationId,
      });
      await this.routeTicket(phase, work, routed.id, routed.type, routed.source.correlationId);
      return { action: 'continue' };
    }
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
    if (isAgentExecutionStall(result)) {
      const reason = result.reason ?? 'Agent execution stalled without project defect evidence.';
      await this.options.controller.retainAgentExecutionFailure(work, reason);
      await this.options.audit.event('note', `${work.step.name} agent execution stall retained`, {
        messageId: 'domain.agent_execution_stall_retained',
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
        reason: `Agent execution stalled; ${work.ticket.name} remains active and no Bug was created: ${result.failureLog ?? reason}`,
      };
    }
    const gateFindings = deduplicateGateFindings([
      ...(result.gateFindings ?? []),
      ...(result.assessment?.findings ?? []),
    ]);
    if (gateFindings.length > 0 && (work.mode === 'normal' || work.mode === 'change-request')) {
      await this.routeGateFindings(phase, work, steps, result, gateFindings);
      return { action: 'continue' };
    }
    // A verifier that disproves the active CR diagnosis has identified a concrete test/contract
    // defect. Route that Bug before the broader "test suite may be incomplete" fallback; otherwise
    // the discoverer's evidence is downgraded to an Enhancement and the original failed gate is
    // never repaired.
    if (
      work.mode === 'change-request' &&
      work.ticket.type === 'change-request' &&
      result.executor?.validationDefect &&
      work.ticket.originFailure
    ) {
      const routed = await this.options.controller.routeFailure({
        creatorActorId: await this.options.tickets.ownerActorId(work.ticket.id),
        failedStepId: work.ticket.originFailure.failedStepId,
        message: result.failureLog ?? result.executor.validationDefect,
        summary: result.executor.validationDefect,
        failure: {
          kind: 'execution',
          category: 'contract',
          code: VALIDATION_CONTRACT_DEFECT_CODE,
          message: result.executor.validationDefect,
          retryable: work.ticket.originFailure.retryable,
          switchProvider: work.ticket.originFailure.switchProvider,
          details: {
            ...(work.ticket.originFailure.details ?? {}),
            defectKind: 'validation-contract',
            originFailureCategory: work.ticket.originFailure.category,
            originFailureCode: work.ticket.originFailure.code,
            discoveringStepId: work.step.id,
          },
        },
        rawEvidenceRef: work.ticket.originFailure.rawEvidenceRef,
        tool: work.ticket.originFailure.tool,
        exitCode: work.ticket.originFailure.exitCode,
        statusCode: work.ticket.originFailure.statusCode,
        discoveringStepId: work.step.id,
        correlationId: work.ticket.source.correlationId,
        causationId: work.ticket.id,
        parentChangeRequestId: work.ticket.id,
      });
      await this.routeTicket(phase, work, routed.id, routed.type, routed.source.correlationId);
      return { action: 'continue' };
    }
    const semanticTestGap =
      !!result.executor?.validationDefect &&
      !result.testOutcomes.some((outcome) => outcome.status === 'failed' || outcome.status === 'timed_out');
    if (
      (result.failure?.code === 'test_assets_incomplete' || semanticTestGap) &&
      (work.mode === 'normal' || work.mode === 'change-request')
    ) {
      const routed = await this.options.controller.routeQualityGap({
        creatorActorId: await this.options.tickets.ownerActorId(work.ticket.id),
        sourceStepId: work.step.id,
        finding: result.failureLog ?? result.executor?.validationDefect ?? result.reason ??
          'The paired test suite is incomplete.',
        kind: 'test-incomplete',
        correlationId: work.ticket.source.correlationId,
        causationId: work.ticket.id,
        parentChangeRequestId: work.mode === 'change-request' ? work.ticket.id : undefined,
      });
      await this.routeTicket(phase, work, routed.id, routed.type, routed.source.correlationId);
      return { action: 'continue' };
    }
    if (
      result.assessment &&
      !result.assessment.passed &&
      (work.mode === 'normal' || work.mode === 'change-request')
    ) {
      const gaps = result.assessment.gaps.length > 0
        ? result.assessment.gaps
        : [result.reason ?? 'Step quality gate did not pass.'];
      for (const gap of gaps) {
        const routed = await this.options.controller.routeQualityGap({
          creatorActorId: await this.options.tickets.ownerActorId(work.ticket.id),
          sourceStepId: work.step.id,
          finding: [gap, ...result.assessment.evidence].filter(Boolean).join('\n'),
          kind: qualityGapKind(work.step),
          qualityAssessmentId: result.assessment.id,
          correlationId: work.ticket.source.correlationId,
          causationId: work.ticket.id,
          parentChangeRequestId: work.mode === 'change-request' ? work.ticket.id : undefined,
        });
        await this.routeTicket(phase, work, routed.id, routed.type, routed.source.correlationId);
      }
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

  private async routeGateFindings(
    phase: Phase,
    work: ScheduledWork,
    steps: readonly Step[],
    result: AttemptResult,
    findings: readonly DeliveryGateFinding[],
  ): Promise<void> {
    const creatorActorId = await this.options.tickets.ownerActorId(work.ticket.id);
    const queued: Array<{ id: ObjectId; order: number }> = [];
    for (const finding of findings) {
      const target = resolveFindingTarget(steps, work.step, finding);
      if (finding.category === 'dependency') {
        const routed = await this.options.controller.routeDependencyChange({
          requestingStepId: work.step.id,
          requestingTicket: work.ticket,
          packages: finding.dependencyPackages,
          reason: [finding.summary, ...finding.evidence].join('\n'),
          creatorActorId,
          correlationId: work.ticket.source.correlationId,
        });
        queued.push({ id: routed.id, order: Number.MAX_SAFE_INTEGER });
        continue;
      }
      if (finding.category === 'test-defect' || finding.category === 'product-defect') {
        const routed = await this.options.controller.routeFailure({
          creatorActorId,
          failedStepId: work.step.id,
          targetStepId: target.id,
          discoveringStepId: work.step.id,
          message: [finding.summary, ...finding.evidence].join('\n'),
          summary: finding.summary,
          failure: {
            kind: 'execution',
            category: finding.category === 'test-defect' ? 'contract' : 'test',
            code: finding.category === 'test-defect'
              ? VALIDATION_CONTRACT_DEFECT_CODE
              : 'delivery_gate_product_defect',
            message: [finding.summary, ...finding.evidence].join('\n'),
            retryable: true,
            switchProvider: false,
            details: { findingCategory: finding.category, findingTarget: finding.target },
          },
          correlationId: work.ticket.source.correlationId,
          causationId: work.ticket.id,
          parentChangeRequestId: work.mode === 'change-request' ? work.ticket.id : undefined,
        });
        queued.push({ id: routed.id, order: STEP_TYPE_ORDER[target.type] });
        continue;
      }
      const routed = await this.options.controller.routeQualityGap({
        creatorActorId,
        sourceStepId: work.step.id,
        targetStepId: target.id,
        finding: [finding.summary, ...finding.evidence].join('\n'),
        kind: finding.category === 'test-incomplete'
          ? 'test-incomplete'
          : finding.category === 'deliverable-defect'
            ? 'functional-gap'
            : 'quality-shortfall',
        qualityAssessmentId: result.assessment?.id,
        correlationId: work.ticket.source.correlationId,
        causationId: work.ticket.id,
        parentChangeRequestId: work.mode === 'change-request' ? work.ticket.id : undefined,
      });
      queued.push({ id: routed.id, order: STEP_TYPE_ORDER[target.type] });
    }
    await this.options.tickets.registerGateBatch(
      queued.sort((left, right) => left.order - right.order).map((item) => item.id),
    );
  }

  /**
   * Turns a merge gate's verdict into the repair the gate discovered.
   *
   * The gate runs the project's own build and tests against what would actually land, so a failure
   * here is a defect in the delivered change even though the Step's own attempt passed — the two
   * judge different things, and only this one judges the merged result. Halting the run instead left
   * the one finding that most clearly describes a broken project with nowhere to go.
   *
   * The evidence is the gate's own failing checks, verbatim. PM registers and routes; it does not
   * author the technical content — the same division that applies to every other discovering actor.
   */
  async processIntegrationFailure(input: {
    phase: Phase;
    work: ScheduledWork;
    reason: string;
    failureLog?: string;
  }): Promise<AttemptDisposition> {
    const { phase, work } = input;
    await this.options.audit.event('note', `${work.step.name} merge gate rejected the change`, {
      messageId: 'domain.merge_gate_rejected',
      projectId: work.step.projectId,
      phaseId: phase.id,
      stepId: work.step.id,
      stepName: work.step.name,
      ticketId: work.ticket.id,
      reason: input.reason,
      failureLog: input.failureLog,
    });
    // Without a paired Step there is no Step to route the repair to, and inventing one would attach
    // the defect to whatever happened to be nearby.
    if (!work.step.pairedStepId) {
      return { action: 'stop', reason: input.reason };
    }
    const routed = await this.options.controller.routeFailure({
      failedStepId: work.step.id,
      message: input.failureLog ?? input.reason,
      summary: input.reason,
      failure: fallbackExecutionFailure(input.reason),
      correlationId: work.ticket.source.correlationId,
      causationId: work.ticket.id,
      creatorActorId: await this.options.tickets.ownerActorId(work.ticket.id),
    });
    await this.routeTicket(phase, work, routed.id, routed.type, routed.source.correlationId);
    return { action: 'continue' };
  }

  private async routeTicket(
    _phase: Phase,
    _source: ScheduledWork,
    ticketId: ObjectId,
    _ticketType: string,
    _correlationId: ObjectId,
  ): Promise<void> {
    // Corrective work enters PM's registered queue first. The orchestrator's scheduler selects the
    // next dependency-ready Ticket and only then calls routeAndAssign. Reserving actor capacity here
    // can deadlock when another queued correction has higher scheduling priority.
    await this.options.tickets.register(ticketId);
  }
}

export function isAgentExecutionStall(result: AttemptResult): boolean {
  return result.failure?.category === 'internal' &&
    result.failure.code === 'agent_execution_stalled';
}

function downstreamStepIds(steps: readonly Step[], source: Step): ObjectId[] {
  const sourceOrder = STEP_TYPE_ORDER[source.type];
  return steps
    .filter((step) => STEP_TYPE_ORDER[step.type] > sourceOrder)
    .map((step) => step.id);
}

function resolveFindingTarget(
  steps: readonly Step[],
  current: Step,
  finding: DeliveryGateFinding,
): Step {
  if (finding.target === 'current-step') return current;
  if (finding.target === 'paired-source') {
    const paired = current.pairedStepId
      ? steps.find((step) => step.id === current.pairedStepId)
      : undefined;
    if (!paired) throw new Error(`Gate finding for ${current.name} requires a paired source Step`);
    return paired;
  }
  const type = finding.target === 'requirement-analysis'
    ? 'REQUIREMENT_ANALYSIS'
    : finding.target === 'high-level-design'
      ? 'HIGH_LEVEL_DESIGN'
      : finding.target === 'detailed-design'
        ? 'DETAILED_DESIGN'
        : 'CODE';
  const target = steps.find((step) => step.type === type);
  if (!target) throw new Error(`Gate finding target ${type} is not materialized in this Phase`);
  return target;
}

function deduplicateGateFindings(findings: readonly DeliveryGateFinding[]): DeliveryGateFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = JSON.stringify({
      category: finding.category,
      summary: finding.summary,
      target: finding.target,
      dependencyPackages: [...finding.dependencyPackages].sort(),
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Uses changed files, or an explicitly validated deferred disposition, as the CR's exact scope. */
export function correctiveAffectedArtifacts(
  _steps: readonly Step[],
  source: Step,
  result: AttemptResult,
): string[] {
  if (result.changedFiles.length > 0) return [...new Set(result.changedFiles)];
  if (result.bugResolutionDisposition?.outcome === 'deferred') {
    return [...new Set(result.bugResolutionDisposition.affectedArtifacts)];
  }
  return [...source.outputs];
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
