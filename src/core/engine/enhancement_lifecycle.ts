import type { AuditLogger } from '../../audit/audit.js';
import type { LLMRouter } from '../../llm/router.js';
import {
  V_MODEL_TEST_PHASES,
  type Step,
} from '../plan.js';
import type {
  QualityGateEvaluation,
  StageQualityAssessment,
} from '../quality_gate.js';
import {
  TicketStore,
  type BugTicket,
  type EnhanceKind,
  type EnhanceTicket,
} from '../ticket.js';
import { WorkTicketLifecycle } from './work_ticket_lifecycle.js';

export interface QualityGap {
  assessment: StageQualityAssessment;
  evaluation: QualityGateEvaluation;
  remediationTarget?: 'same-step' | 'paired-source';
}

export class EnhancementLifecycle {
  private lastEnhance?: EnhanceTicket;

  constructor(
    private readonly store: TicketStore,
    private readonly audit: AuditLogger,
    private readonly router: LLMRouter,
    private readonly workTickets: WorkTicketLifecycle,
  ) {}

  async ensureForBug(
    bug: BugTicket,
    target: Step | undefined,
  ): Promise<EnhanceTicket | undefined> {
    if (bug.kind === 'infrastructure') return undefined;
    const existing = bug.enhanceTicketId
      ? this.store.findEnhance(bug.enhanceTicketId)
      : undefined;
    if (existing) return existing;

    const failedWork = bug.source.stepId
      ? this.store.featureForStep(bug.source.stepId, bug.iterationId)
      : undefined;
    const targetWork = target
      ? this.store.featureForStep(target.id, target.iterationId ?? 'P1')
      : undefined;
    const affectedWorkTicketIds = dedup([
      targetWork?.id,
      failedWork?.id,
    ].filter((id): id is string => !!id));
    const responsibleProviders = dedup(
      (targetWork?.modelAttributions ?? [])
        .filter((attribution) =>
          attribution.contribution === 'author' &&
          attribution.outcome === 'produced'
        )
        .map((attribution) => attribution.provider),
    );
    const detectedProviders = dedup(
      bug.modelAttributions
        .filter((attribution) => attribution.outcome === 'detected-gap')
        .map((attribution) => attribution.provider),
    );
    const attributedProviders = responsibleProviders.length > 0
      ? responsibleProviders
      : detectedProviders;
    const kind = classifyEnhanceKind(bug);
    const enhancement = await this.store.createEnhance({
      priority: bug.priority,
      title: `${kind} identified by ${bug.id}`,
      description: bug.debugBrief?.summary ?? bug.reason,
      iterationId: bug.iterationId,
      parentTicketId: bug.rootTicketId,
      rootTicketId: bug.rootTicketId,
      relatedTicketIds: dedup([bug.id, ...affectedWorkTicketIds]),
      blockedByTicketIds: [],
      source: {
        kind: 'runtime',
        externalId: bug.id,
        stepId: target?.id ?? bug.source.stepId,
        phase: target?.phase ?? bug.source.phase,
        role: target?.role ?? bug.source.role,
      },
      acceptance: [
        'The identified quality gap is corrected.',
        'All affected V-model verification gates pass.',
      ],
      artifacts: bug.rawFailureLogPath ? [bug.rawFailureLogPath] : [],
      kind,
      finding: bug.debugBrief?.summary ?? bug.reason,
      sourceBugTicketId: bug.id,
      targetStepId: target?.id,
      targetPhase: target?.phase,
      verificationStepId: bug.verificationStepId ?? bug.source.stepId,
      verificationPhase: bug.verificationPhase ?? bug.source.phase,
      affectedWorkTicketIds,
      changeRequestTicketIds: [],
      disposition: 'debug',
    });
    await this.workTickets.reopenAncestorsFor(enhancement, 'enhancement-opened', {
      enhanceTicketId: enhancement.id,
      sourceBugTicketId: enhancement.sourceBugTicketId,
      sourceQualityGateStepId: enhancement.sourceQualityGateStepId,
    });
    await this.blockAffectedWork(enhancement);
    if (detectedProviders.length > 0 && bug.source.role) {
      await this.store.recordModelAttribution(enhancement, {
        providers: detectedProviders,
        role: bug.source.role,
        contribution: isVModelTestPhase(bug.source.phase ?? target?.phase ?? 'CODE')
          ? 'validator'
          : 'author',
        outcome: 'detected-gap',
        stepId: bug.source.stepId,
        phase: bug.source.phase,
      });
    }
    if (attributedProviders.length > 0 && target) {
      await this.store.recordModelAttribution(enhancement, {
        providers: attributedProviders,
        role: target.role,
        contribution: 'author',
        outcome: 'attributed-gap',
        stepId: target.id,
        phase: target.phase,
      });
      this.router.recordTicketOutcome?.(
        attributedProviders,
        'quality-gap',
        enhancement.id,
      );
    }
    bug.enhanceTicketId = enhancement.id;
    bug.relatedTicketIds = dedup([...bug.relatedTicketIds, enhancement.id]);
    await this.store.persist(bug, 'enhancement-linked', {
      enhanceTicketId: enhancement.id,
      enhanceKind: enhancement.kind,
    });
    await this.audit.event(
      'ticket.enhance.created',
      `${enhancement.id} ${enhancement.kind}: ${enhancement.finding}`,
      {
        messageId: 'engine.enhance_ticket_created',
        ticketId: enhancement.id,
        bugTicketId: bug.id,
        enhanceKind: enhancement.kind,
        affectedWorkTicketIds,
        detectedProviders,
        attributedProviders,
      },
    );
    return enhancement;
  }

  async recordQualityGap(
    failedStep: Step,
    targetStep: Step,
    qualityGap: QualityGap,
    providers: string[] = [],
  ): Promise<EnhanceTicket> {
    const existing = this.store.activeQualityEnhanceForStep(
      failedStep.id,
      failedStep.iterationId ?? 'P1',
    );
    if (existing) {
      existing.targetStepId = targetStep.id;
      existing.targetPhase = targetStep.phase;
      existing.verificationStepId = failedStep.id;
      existing.verificationPhase = failedStep.phase;
      existing.qualityFailures = qualityGap.evaluation.enhancementFailures;
      existing.qualityAssessment = qualityGap.assessment;
      await this.store.persist(existing, 'quality-gap-refreshed');
      await this.blockAffectedWork(existing);
      this.lastEnhance = existing;
      return existing;
    }

    const failedWork = this.store.featureForStep(
      failedStep.id,
      failedStep.iterationId ?? 'P1',
    );
    const targetWork = this.store.featureForStep(
      targetStep.id,
      targetStep.iterationId ?? 'P1',
    );
    const affectedWorkTicketIds = dedup([
      failedWork?.id,
      targetWork?.id,
    ].filter((id): id is string => !!id));
    const enhancement = await this.store.createEnhance({
      priority: 'high',
      title: `${failedStep.id} ${failedStep.phase} quality target incomplete`,
      description: qualityGap.evaluation.enhancementFailures.join('; '),
      iterationId: failedStep.iterationId ?? 'P1',
      parentTicketId: failedWork?.rootTicketId ?? targetWork?.rootTicketId,
      rootTicketId: failedWork?.rootTicketId ?? targetWork?.rootTicketId,
      relatedTicketIds: affectedWorkTicketIds,
      blockedByTicketIds: [],
      source: {
        kind: 'runtime',
        externalId: `${failedStep.id}:quality-gate`,
        stepId: failedStep.id,
        phase: failedStep.phase,
        role: failedStep.role,
      },
      acceptance: [
        ...qualityGap.evaluation.enhancementFailures.map((failure) => `Resolve: ${failure}`),
        `${failedStep.id} ${failedStep.phase} quality gate passes within configured tolerance.`,
      ],
      artifacts: qualityGap.assessment.evidence,
      kind: isVModelTestPhase(failedStep.phase) ? 'test-incomplete' : 'functional-gap',
      finding: qualityGap.evaluation.enhancementFailures.join('; '),
      sourceQualityGateStepId: failedStep.id,
      targetStepId: targetStep.id,
      targetPhase: targetStep.phase,
      verificationStepId: failedStep.id,
      verificationPhase: failedStep.phase,
      qualityFailures: qualityGap.evaluation.enhancementFailures,
      qualityAssessment: qualityGap.assessment,
      affectedWorkTicketIds,
      changeRequestTicketIds: [],
      disposition: 'debug',
    });
    await this.workTickets.reopenAncestorsFor(enhancement, 'enhancement-opened', {
      enhanceTicketId: enhancement.id,
      sourceBugTicketId: enhancement.sourceBugTicketId,
      sourceQualityGateStepId: enhancement.sourceQualityGateStepId,
    });
    await this.blockAffectedWork(enhancement);
    if (providers.length > 0) {
      await this.store.recordModelAttribution(enhancement, {
        providers,
        role: failedStep.role,
        contribution: isVModelTestPhase(failedStep.phase) ? 'validator' : 'author',
        outcome: 'detected-gap',
        stepId: failedStep.id,
        phase: failedStep.phase,
      });
    }
    const responsibleProviders = dedup(
      (targetWork?.modelAttributions ?? [])
        .filter((attribution) =>
          attribution.contribution === 'author' &&
          attribution.outcome === 'produced'
        )
        .map((attribution) => attribution.provider),
    );
    if (responsibleProviders.length > 0) {
      await this.store.recordModelAttribution(enhancement, {
        providers: responsibleProviders,
        role: targetStep.role,
        contribution: 'author',
        outcome: 'attributed-gap',
        stepId: targetStep.id,
        phase: targetStep.phase,
      });
      this.router.recordTicketOutcome?.(
        responsibleProviders,
        'quality-gap',
        enhancement.id,
      );
    }
    await this.store.transition(enhancement, 'triaged', 'quality-gap-triaged', {
      targetStepId: targetStep.id,
      verificationStepId: failedStep.id,
    });
    await this.store.transition(enhancement, 'in_progress', 'quality-remediation-started');
    this.lastEnhance = enhancement;
    await this.audit.event(
      'ticket.enhance.created',
      `${enhancement.id} ${enhancement.kind}: ${enhancement.finding}`,
      {
        messageId: 'engine.quality_enhance_ticket_created',
        ticketId: enhancement.id,
        sourceQualityGateStepId: failedStep.id,
        targetStepId: targetStep.id,
        verificationStepId: failedStep.id,
        qualityFailures: enhancement.qualityFailures,
      },
    );
    return enhancement;
  }

  async linkToChange(
    enhancement: EnhanceTicket,
    changeRequestTicketId: string,
  ): Promise<void> {
    enhancement.changeRequestTicketIds = dedup([
      ...enhancement.changeRequestTicketIds,
      changeRequestTicketId,
    ]);
    enhancement.relatedTicketIds = dedup([
      ...enhancement.relatedTicketIds,
      changeRequestTicketId,
    ]);
    enhancement.disposition = 'change-request';
    if (enhancement.status === 'open' || enhancement.status === 'triaged') {
      await this.store.transition(
        enhancement,
        'in_progress',
        'change-request-linked',
        { changeRequestTicketId },
      );
      return;
    }
    await this.store.persist(enhancement, 'change-request-linked', {
      changeRequestTicketId,
    });
  }

  async close(enhancement: EnhanceTicket, verifiedStep: Step): Promise<void> {
    if (enhancement.status === 'closed') return;
    await this.closeTicket(enhancement);
    await this.audit.event(
      'ticket.enhance.closed',
      `${enhancement.id} closed after ${verifiedStep.id} quality verification`,
      {
        messageId: 'engine.quality_enhance_ticket_closed',
        ticketId: enhancement.id,
        verificationStepId: verifiedStep.id,
        verificationPhase: verifiedStep.phase,
      },
    );
    if (this.lastEnhance?.id === enhancement.id) this.lastEnhance = undefined;
  }

  async resolveVerifiedByStep(step: Step): Promise<void> {
    const matches = this.store.all().filter(
      (ticket): ticket is EnhanceTicket =>
        ticket.type === 'enhance' &&
        ticket.iterationId === (step.iterationId ?? 'P1') &&
        ticket.sourceQualityGateStepId !== undefined &&
        ticket.verificationStepId === step.id &&
        !['closed', 'cancelled', 'failed'].includes(ticket.status),
    );
    for (const enhancement of matches) {
      const hasOpenChangeRequest = enhancement.changeRequestTicketIds.some((ticketId) => {
        const ticket = this.store.find(ticketId);
        return ticket?.type === 'change-request' &&
          !['closed', 'cancelled', 'failed'].includes(ticket.status);
      });
      if (!hasOpenChangeRequest) await this.close(enhancement, step);
    }
  }

  async closeForBug(bug: BugTicket, step: Step): Promise<void> {
    const enhancement = bug.enhanceTicketId
      ? this.store.findEnhance(bug.enhanceTicketId)
      : undefined;
    if (!enhancement || enhancement.status === 'closed') return;
    const validatedDetectorProviders = dedup(
      enhancement.modelAttributions
        .filter((attribution) =>
          attribution.contribution === 'validator' &&
          attribution.outcome === 'detected-gap'
        )
        .map((attribution) => attribution.provider),
    );
    if (validatedDetectorProviders.length > 0) {
      await this.store.recordModelAttribution(enhancement, {
        providers: validatedDetectorProviders,
        role: bug.source.role ?? 'Tester',
        contribution: 'validator',
        outcome: 'finding-validated',
        stepId: bug.source.stepId,
        phase: bug.source.phase,
      });
      this.router.recordTicketOutcome?.(
        validatedDetectorProviders,
        'finding-validated',
        enhancement.id,
      );
    }
    const repairProviders = dedup(
      bug.modelAttributions
        .filter((attribution) =>
          attribution.contribution === 'debugger' &&
          attribution.outcome === 'repair-verified'
        )
        .map((attribution) => attribution.provider),
    );
    if (repairProviders.length > 0) {
      await this.store.recordModelAttribution(enhancement, {
        providers: repairProviders,
        role: 'Debugger',
        contribution: 'debugger',
        outcome: 'repair-verified',
        stepId: step.id,
        phase: step.phase,
      });
      this.router.recordTicketOutcome?.(
        repairProviders,
        'repair-verified',
        enhancement.id,
      );
    }
    await this.closeTicket(enhancement);
    await this.audit.event(
      'ticket.enhance.closed',
      `${enhancement.id} closed after ${bug.id} verification`,
      {
        messageId: 'engine.enhance_ticket_closed',
        ticketId: enhancement.id,
        bugTicketId: bug.id,
        enhanceKind: enhancement.kind,
        validatedDetectorProviders,
        repairProviders,
      },
    );
  }

  private async closeTicket(enhancement: EnhanceTicket): Promise<void> {
    for (const workTicketId of enhancement.affectedWorkTicketIds) {
      const work = this.store.find(workTicketId);
      if (work?.blockedByTicketIds.includes(enhancement.id)) {
        await this.store.unblock(work, enhancement.id);
      }
    }
    if (['open', 'triaged', 'failed'].includes(enhancement.status)) {
      await this.store.transition(
        enhancement,
        'in_progress',
        'enhancement-verified:started',
      );
    }
    if (enhancement.status !== 'resolved' && enhancement.status !== 'closed') {
      await this.store.transition(
        enhancement,
        'resolved',
        'enhancement-verified:resolved',
      );
    }
    if (enhancement.status !== 'closed') {
      await this.store.transition(
        enhancement,
        'closed',
        'enhancement-verified:closed',
      );
    }
  }

  private async blockAffectedWork(enhancement: EnhanceTicket): Promise<void> {
    for (const ticketId of enhancement.affectedWorkTicketIds) {
      const ticket = this.store.find(ticketId);
      if (
        ticket &&
        (ticket.type === 'feature' || ticket.type === 'task' || ticket.type === 'sub-task') &&
        !ticket.blockedByTicketIds.includes(enhancement.id)
      ) {
        await this.store.block(
          ticket,
          enhancement.id,
          `${ticket.id} is blocked by ${enhancement.id}`,
        );
      }
    }
  }
}

function classifyEnhanceKind(bug: BugTicket): EnhanceKind {
  if (
    bug.evidence?.validationDefect ||
    bug.evidence?.stage === 'test-case-completeness'
  ) {
    return 'test-incomplete';
  }
  if (bug.kind === 'functional-gate') return 'functional-gap';
  return 'defect';
}

function isVModelTestPhase(
  phase: Step['phase'],
): phase is (typeof V_MODEL_TEST_PHASES)[number] {
  return (V_MODEL_TEST_PHASES as readonly string[]).includes(phase);
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
