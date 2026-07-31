import type { AuditLogger } from '../../audit/audit.js';
import type { LLMRouter } from '../../llm/router.js';
import type { GitService } from '../../workspace/git.js';
import {
  isDesignChangeRequestPhase,
  TicketStore,
  transitionTicket,
  type BugTicket,
  type ChangeRequestApplication,
  type ChangeRequestTicket,
  type EnhanceTicket,
} from '../ticket.js';
import {
  V_MODEL_TEST_PHASES,
  type Plan,
  type Step,
} from '../plan.js';
import { normalizeGitPath } from './v_model_policy.js';
import { BugLifecycle } from './bug_lifecycle.js';
import { EnhancementLifecycle } from './enhancement_lifecycle.js';
import { WorkTicketLifecycle } from './work_ticket_lifecycle.js';

export class ChangeRequestLifecycle {
  constructor(
    private readonly store: TicketStore,
    private readonly git: GitService,
    private readonly audit: AuditLogger,
    private readonly router: LLMRouter,
    private readonly enhancements: EnhancementLifecycle,
    private readonly bugs: BugLifecycle,
    private readonly workTickets: WorkTicketLifecycle,
  ) {}

  async recordApplication(
    ticket: ChangeRequestTicket,
    application: Omit<ChangeRequestApplication, 'revision' | 'appliedAt'>,
  ): Promise<void> {
    transitionTicket(
      ticket,
      application.kind === 'verification' ? 'verification' : 'in_progress',
    );
    ticket.applications.push({
      ...application,
      revision: ticket.revision,
      appliedAt: new Date().toISOString(),
    });
    ticket.execution.currentStepId = application.stepId;
    ticket.execution.completedStepIds = dedup([
      ...ticket.execution.completedStepIds,
      application.stepId,
    ]);
    await this.store.persist(ticket, 'application-recorded', { application });
  }

  async requestRework(
    ticket: ChangeRequestTicket,
    triggerTicketId: string,
    reason: string,
  ): Promise<void> {
    transitionTicket(ticket, 'in_progress');
    ticket.revision += 1;
    ticket.relatedTicketIds = dedup([...ticket.relatedTicketIds, triggerTicketId]);
    ticket.execution.currentStepId = undefined;
    ticket.revisionReason = reason;
    await this.store.persist(ticket, 'rework-requested', {
      triggerTicketId,
      reason,
    });
  }

  async blockOnChild(
    ticket: ChangeRequestTicket,
    childTicketId: string,
    bugTicketId: string,
    reason: string,
  ): Promise<void> {
    if (!ticket.relatedTicketIds.includes(bugTicketId)) {
      await this.requestRework(ticket, bugTicketId, reason);
    }
    await this.store.block(ticket, childTicketId, reason);
  }

  async closeTicket(ticket: ChangeRequestTicket): Promise<void> {
    ticket.revisionReason = undefined;
    if (['open', 'triaged', 'failed'].includes(ticket.status)) {
      await this.store.transition(ticket, 'in_progress', 'change-completed:started');
    }
    if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
      await this.store.transition(ticket, 'resolved', 'change-completed:resolved');
    }
    if (ticket.status !== 'closed') {
      await this.store.transition(ticket, 'closed', 'change-completed:closed');
    }
  }

  async recordFailure(
    request: ChangeRequestTicket,
    bug: BugTicket | undefined,
    step: Step,
  ): Promise<void> {
    if (!bug) return;
    bug.causedByChangeRequestTicketId = request.id;
    bug.changeRequestTicketIds = dedup([...bug.changeRequestTicketIds, request.id]);
    await this.bugs.persistBug(bug, 'change-request-failure', {
      changeRequestTicketId: request.id,
      failedChangeStepId: step.id,
      failedChangeStepPhase: step.phase,
    });
    if (!request.relatedTicketIds.includes(bug.id)) {
      await this.requestRework(
        request,
        bug.id,
        `${step.id} ${step.phase} failed while applying ${request.id}: ${bug.reason}`,
      );
    }
    await this.audit.event(
      'ticket.change-request.revised',
      `${request.id} revision ${request.revision} requires rework after ${step.id}`,
      {
        messageId: 'engine.change_request_rework',
        changeRequestTicketId: request.id,
        revision: request.revision,
        bugTicketId: bug.id,
        enhanceTicketId: bug.enhanceTicketId,
        stepId: step.id,
        phase: step.phase,
      },
    );
  }

  async maybeClose(
    plan: Plan,
    request: ChangeRequestTicket,
    completedStep: Step,
  ): Promise<void> {
    if (['closed', 'cancelled', 'failed'].includes(request.status)) return;
    if (request.blockedByTicketIds.length > 0) return;
    const byId = new Map(plan.steps.map((step) => [step.id, step]));
    if (!request.affectedSteps.every((affected) => {
      const step = byId.get(affected.stepId);
      return !!step && this.workTickets.isStepComplete(step);
    })) {
      return;
    }
    const applied = new Set(request.applications.map((application) => application.stepId));
    if (!request.affectedSteps.every((affected) => applied.has(affected.stepId))) return;
    const linkedEnhancements = this.store.all().filter(
      (ticket): ticket is EnhanceTicket =>
        ticket.type === 'enhance' &&
        (
          ticket.id === request.sourceEnhanceTicketId ||
          ticket.changeRequestTicketIds.includes(request.id)
        ) &&
        !['closed', 'cancelled', 'failed'].includes(ticket.status),
    );
    const enhancementVerificationSteps = linkedEnhancements.map((enhancement) => {
      if (!enhancement.verificationStepId) return { enhancement, step: completedStep };
      return {
        enhancement,
        step: byId.get(enhancement.verificationStepId),
      };
    });
    if (enhancementVerificationSteps.some(
      ({ step }) => !step || !this.workTickets.isStepComplete(step),
    )) {
      return;
    }

    const verifiedProviders = dedup(
      request.modelAttributions
        .filter((attribution) =>
          attribution.contribution === 'change-applier' &&
          attribution.outcome === 'change-applied'
        )
        .map((attribution) => attribution.provider),
    );
    for (const provider of verifiedProviders) {
      const source = [...request.modelAttributions].reverse().find((attribution) =>
        attribution.provider === provider &&
        attribution.contribution === 'change-applier' &&
        attribution.outcome === 'change-applied'
      );
      if (!source) continue;
      await this.store.recordModelAttribution(request, {
        providers: [provider],
        role: source.role,
        contribution: 'change-applier',
        outcome: 'change-verified',
        stepId: source.stepId,
        phase: source.phase,
      });
    }
    await this.closeTicket(request);
    this.router.recordTicketOutcome?.(
      verifiedProviders,
      'change-verified',
      request.id,
    );
    for (const relatedTicketId of request.relatedTicketIds) {
      const bug = this.store.findBug(relatedTicketId);
      if (!bug || bug.status === 'closed') continue;
      bug.activeChangeRequestTicketId = undefined;
      if (bug.blockedByTicketIds.includes(request.id)) {
        await this.store.unblock(bug, request.id);
      }
      await this.bugs.closeBug(
        bug.id,
        completedStep,
        bug.repair,
        bug.bugResolutionPlan,
      );
    }
    for (const { enhancement, step } of enhancementVerificationSteps) {
      await this.enhancements.close(enhancement, step ?? completedStep);
    }
    await this.audit.event(
      'ticket.change-request.closed',
      `${request.id} closed after all affected V-model gates passed`,
      {
        messageId: 'engine.change_request_closed',
        changeRequestTicketId: request.id,
        revision: request.revision,
        applications: request.applications,
        verifiedProviders,
      },
    );

    const parentTicket = request.parentTicketId
      ? this.store.find(request.parentTicketId)
      : undefined;
    const parent = parentTicket?.type === 'change-request' ? parentTicket : undefined;
    if (!parent) return;
    await this.store.unblock(parent, request.id);
    const parentSteps = new Set(parent.affectedSteps.map((affected) => affected.stepId));
    for (const application of request.applications) {
      if (!parentSteps.has(application.stepId)) continue;
      const alreadyRecorded = parent.applications.some(
        (candidate) =>
          candidate.stepId === application.stepId &&
          candidate.commit === application.commit,
      );
      if (alreadyRecorded) continue;
      await this.recordApplication(parent, {
        stepId: application.stepId,
        phase: application.phase,
        kind: application.kind,
        commit: application.commit,
        changedFiles: application.changedFiles,
        summary: `Satisfied by child ${request.id}: ${application.summary}`,
      });
    }
    await this.maybeClose(plan, parent, completedStep);
  }

  async recordApplicationFromAttempt(
    request: ChangeRequestTicket,
    step: Step,
    isDebugAttempt: boolean,
    beforeCommit: string,
    completionCommit: string,
    summary: string | undefined,
  ): Promise<void> {
    const changedFiles = (await this.git.raw().diff([
      '--name-only',
      beforeCommit,
      completionCommit,
      '--',
    ]).catch(() => ''))
      .split(/\r?\n/u)
      .map(normalizeGitPath)
      .filter(Boolean);
    const kind = isDebugAttempt && isDesignChangeRequestPhase(step.phase)
      ? 'design-change' as const
      : isVModelTestPhase(step.phase)
        ? 'verification' as const
        : 'implementation-change' as const;
    await this.recordApplication(request, {
      stepId: step.id,
      phase: step.phase,
      kind,
      commit: completionCommit,
      changedFiles,
      summary: summary?.trim() ||
        `${kind === 'verification' ? 'Verified' : 'Applied'} ${request.id} in ${step.id} ${step.phase}.`,
    });
    await this.audit.event(
      'note',
      `${request.id} ${kind} recorded for ${step.id}`,
      {
        messageId: 'engine.change_request_application',
        changeRequestTicketId: request.id,
        revision: request.revision,
        stepId: step.id,
        phase: step.phase,
        kind,
        commit: completionCommit,
        changedFiles,
      },
    );
  }
}

function isVModelTestPhase(
  phase: Step['phase'],
): phase is (typeof V_MODEL_TEST_PHASES)[number] {
  return (V_MODEL_TEST_PHASES as readonly string[]).includes(phase);
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
