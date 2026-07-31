import type { AuditLogger } from '../../audit/audit.js';
import type { ExecutorRunMetrics } from '../../agents/executor.js';
import type { Workspace } from '../../workspace/workspace.js';
import {
  buildDebugBrief,
  compactFailureEvidence,
} from '../debug_brief.js';
import {
  cleanFailureLogForDebugContext,
  isNonDebuggableInfrastructureFailure,
} from '../debug_policy.js';
import {
  V_MODEL_TEST_PHASES,
  type Plan,
  type Step,
} from '../plan.js';
import {
  TicketStore,
  type BugKind,
  type BugTicket,
  type ChangeRequestTicket,
} from '../ticket.js';
import { DebugWikiFeedbackService } from './debug_wiki_feedback.js';
import { EnhancementLifecycle } from './enhancement_lifecycle.js';
import { WorkTicketLifecycle } from './work_ticket_lifecycle.js';

export interface DebugFeedbackContext {
  reason: string;
  bugTicketId?: string;
  debugWikiEntryIds?: string[];
}

export class BugLifecycle {
  private lastBug?: BugTicket;

  constructor(
    readonly store: TicketStore,
    private readonly workspace: Workspace,
    private readonly audit: AuditLogger,
    private readonly debugWiki: DebugWikiFeedbackService,
    private readonly enhancements: EnhancementLifecycle,
    private readonly workTickets: WorkTicketLifecycle,
  ) {}

  async recordBug(
    plan: Plan,
    step: Step | undefined,
    input: {
      kind: BugKind;
      reason: string;
      failureLog: string;
      metrics?: ExecutorRunMetrics;
      evidence?: Record<string, unknown>;
    },
  ): Promise<BugTicket> {
    const rawFailureLog = input.failureLog ?? '';
    const cleanedFailureLog = cleanFailureLogForDebugContext(rawFailureLog);
    const debugBrief = buildDebugBrief({
      reason: input.reason,
      failureLog: cleanedFailureLog,
      phase: step?.phase,
    });
    const failureLog = compactFailureEvidence({
      reason: input.reason,
      failureLog: cleanedFailureLog,
      phase: step?.phase,
      maxChars: 6000,
      maxLines: 90,
    });
    const workTicket = step
      ? this.store.featureForStep(step.id, step.iterationId ?? 'P1')
      : undefined;
    const bug = await this.store.createBug({
      priority: input.kind === 'infrastructure' ? 'critical' : 'high',
      title: step ? `${step.id} ${step.phase} failed` : 'Project execution failed',
      description: input.reason,
      iterationId: step?.iterationId ?? 'P1',
      parentTicketId: undefined,
      rootTicketId: workTicket?.rootTicketId,
      relatedTicketIds: workTicket ? [workTicket.id] : [],
      blockedByTicketIds: [],
      source: {
        kind: 'runtime',
        externalId: step?.id,
        stepId: step?.id,
        phase: step?.phase,
        role: step?.role,
      },
      acceptance: [
        step?.acceptance ?? 'The failure is repaired and its verification gate passes.',
        'The confirmed resolution is persisted to debug-wiki before this ticket closes.',
      ],
      artifacts: [],
      kind: input.kind,
      severity: 'error',
      language: plan.language,
      intent: plan.intent,
      requirementDigest: plan.requirementDigest,
      reason: input.reason,
      failureLog,
      failureLogBytes: Buffer.byteLength(rawFailureLog, 'utf8'),
      debugBrief,
      metrics: input.metrics,
      evidence: input.evidence,
    });
    bug.rawFailureLogPath = `.xcompiler/tickets/${bug.id}/failure.raw.log`;
    bug.artifacts = [bug.rawFailureLogPath];
    await this.workspace.writeFile(
      bug.rawFailureLogPath,
      rawFailureLog.endsWith('\n') ? rawFailureLog : `${rawFailureLog}\n`,
    );
    await this.store.persist(bug, 'failure-evidence-attached');
    if (step && input.metrics?.providers.length) {
      await this.store.recordModelAttribution(bug, {
        providers: input.metrics.providers,
        role: step.role,
        contribution: isVModelTestPhase(step.phase) ? 'validator' : 'author',
        outcome: 'detected-gap',
        stepId: step.id,
        phase: step.phase,
      });
    }
    if (step) await this.workTickets.failStep(step, bug.id);
    this.lastBug = bug;
    await this.audit.event('ticket.bug.created', `${bug.id} ${bug.kind}: ${bug.reason}`, {
      messageId: 'engine.bug_ticket_created',
      ticket: bug,
    });
    return bug;
  }

  async routeBug(bug: BugTicket | undefined, target: Step, reason: string): Promise<void> {
    if (!bug) return;
    bug.targetStepId = target.id;
    bug.targetPhase = target.phase;
    bug.debugBrief = buildDebugBrief({
      reason: bug.reason,
      failureLog: bug.failureLog,
      phase: bug.source.phase,
      targetPhase: target.phase,
    });
    bug.routedAt = new Date().toISOString();
    await this.store.transition(bug, 'triaged', 'routed', {
      targetStepId: target.id,
      targetPhase: target.phase,
      routingReason: reason,
    });
    await this.audit.event('ticket.bug.routed', `${bug.id} -> ${target.id} ${target.phase}`, {
      messageId: 'engine.bug_ticket_routed',
      ticketId: bug.id,
      targetStepId: target.id,
      targetPhase: target.phase,
      reason,
    });
  }

  async markBugFailed(ticketId: string | undefined, reason: string): Promise<void> {
    const bug = ticketId ? this.store.findBug(ticketId) : undefined;
    if (!bug || ['closed', 'cancelled'].includes(bug.status)) return;
    bug.failureReason = reason;
    await this.store.transition(bug, 'failed', 'debug-failed', { reason });
  }

  async closeBug(
    ticketId: string | undefined,
    step: Step,
    repair?: BugTicket['repair'],
    bugResolutionPlan?: string,
  ): Promise<void> {
    const bug = ticketId ? this.store.findBug(ticketId) : undefined;
    if (!bug || bug.status === 'closed') return;
    if (repair) bug.repair = repair;
    const effectiveRepair = repair ?? bug.repair;
    appendResolutionPlan(bug, step, bugResolutionPlan);
    for (const blockerId of [...bug.blockedByTicketIds]) {
      await this.store.unblock(bug, blockerId);
    }
    if (bug.status === 'open' || bug.status === 'failed') {
      await this.store.transition(bug, 'triaged', 'resolution-triaged');
    }
    if (bug.status === 'triaged') {
      await this.store.transition(bug, 'in_progress', 'debug-started');
    }
    if (bug.status === 'in_progress' || bug.status === 'in_review') {
      await this.store.transition(bug, 'verification', 'verification-passed', {
        verificationStepId: step.id,
        verificationPhase: step.phase,
      });
    }
    if (bug.status !== 'resolved') {
      await this.store.transition(bug, 'resolved', 'resolved');
    }
    await this.debugWiki.recordResolution(bug, step, effectiveRepair);
    await this.store.transition(bug, 'closed', 'closed-after-wiki');
    await this.enhancements.closeForBug(bug, step);
    const workTicket = bug.source.stepId
      ? this.store.featureForStep(bug.source.stepId, bug.iterationId)
      : undefined;
    if (workTicket?.blockedByTicketIds.includes(bug.id)) {
      await this.store.unblock(workTicket, bug.id);
    }
    await this.workTickets.completeStep(step);
    const repairedStepId = effectiveRepair?.repairedStepId ?? step.id;
    const repairedPhase = effectiveRepair?.repairedPhase ?? step.phase;
    await this.audit.event(
      'ticket.bug.closed',
      `${bug.id} resolved by ${repairedStepId} ${repairedPhase}`,
      {
        messageId: 'engine.bug_ticket_closed',
        ticketId: bug.id,
        repairedStepId,
        repairedPhase,
        repair: effectiveRepair,
      },
    );
  }

  async recordBugRepairReady(
    ticketId: string,
    step: Step,
    repair: BugTicket['repair'] | undefined,
    bugResolutionPlan: string | undefined,
  ): Promise<void> {
    const bug = this.store.findBug(ticketId);
    if (!bug) return;
    if (repair) bug.repair = repair;
    appendResolutionPlan(bug, step, bugResolutionPlan, true);
    if (bug.status === 'triaged' || bug.status === 'failed') {
      await this.store.transition(bug, 'in_progress', 'debug-started');
    }
    await this.store.transition(bug, 'verification', 'repair-ready', {
      repairedStepId: step.id,
      repairedPhase: step.phase,
      repair,
    });
  }

  async markBugBlockedByChange(
    bug: BugTicket,
    request: ChangeRequestTicket,
  ): Promise<void> {
    bug.activeChangeRequestTicketId = request.id;
    bug.changeRequestTicketIds = dedup([...bug.changeRequestTicketIds, request.id]);
    await this.store.block(bug, request.id, `${request.id} must pass all affected gates`);
    await this.store.persist(bug, 'change-request-linked', {
      changeRequestTicketId: request.id,
      changeRequestRevision: request.revision,
    });
    await this.audit.event(
      'note',
      `${bug.id} waits for ${request.id} downstream implementation`,
      {
        messageId: 'engine.bug_ticket_blocked_by_change',
        ticketId: bug.id,
        changeRequestTicketId: request.id,
        changeRequestRevision: request.revision,
      },
    );
  }

  async recordDebugWikiFailure(
    step: Step,
    debug: DebugFeedbackContext,
    outcome: { reason?: string; failureLog: string },
  ): Promise<void> {
    const entryIds = dedup(debug.debugWikiEntryIds ?? []);
    const bug = debug.bugTicketId ? this.store.findBug(debug.bugTicketId) : undefined;
    await this.debugWiki.recordFailure({
      step,
      bug,
      entryIds,
      reason: outcome.reason ?? debug.reason,
      failureLog: outcome.failureLog,
    });
  }

  openBugForFailedStep(stepId: string, iterationId: string): BugTicket | undefined {
    if (
      this.lastBug?.source.stepId === stepId &&
      this.lastBug.iterationId === iterationId &&
      this.lastBug.kind !== 'infrastructure' &&
      !['resolved', 'closed', 'cancelled'].includes(this.lastBug.status)
    ) {
      return this.lastBug;
    }
    return [...this.store.all()].reverse().find(
      (ticket): ticket is BugTicket =>
        ticket.type === 'bug' &&
        ticket.iterationId === iterationId &&
        ticket.source.stepId === stepId &&
        ticket.kind !== 'infrastructure' &&
        !['resolved', 'closed', 'cancelled'].includes(ticket.status),
    );
  }

  openBugTargetingStep(stepId: string, iterationId: string): BugTicket | undefined {
    return [...this.store.all()].reverse().find(
      (ticket): ticket is BugTicket =>
        ticket.type === 'bug' &&
        ticket.iterationId === iterationId &&
        ticket.targetStepId === stepId &&
        ticket.kind !== 'infrastructure' &&
        !['resolved', 'closed', 'cancelled'].includes(ticket.status),
    );
  }

  async resolveBugsVerifiedByStep(step: Step): Promise<void> {
    const bugs = this.store.all().filter(
      (ticket): ticket is BugTicket =>
        ticket.type === 'bug' &&
        ticket.iterationId === (step.iterationId ?? 'P1') &&
        !['resolved', 'closed', 'cancelled'].includes(ticket.status) &&
        (
          ticket.verificationStepId === step.id ||
          (
            ticket.verificationStepId === undefined &&
            ticket.source.stepId === step.id &&
            (ticket.targetStepId === undefined || ticket.targetStepId === step.id)
          )
        ),
    );
    for (const bug of bugs) {
      if (bug.activeChangeRequestTicketId) continue;
      await this.closeBug(
        bug.id,
        step,
        bug.repair,
        bug.bugResolutionPlan ??
          `Repair ${bug.targetStepId ?? bug.source.stepId ?? 'the paired source phase'} and pass ${step.id} ${step.phase}.`,
      );
    }
  }

  async persistBug(
    bug: BugTicket,
    event: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.store.persist(bug, event, extra);
  }

  classifyBugKind(
    step: Step,
    outcome: {
      bugKind?: BugKind;
      rollbackToPairedSource?: boolean;
      reason?: string;
      failureLog?: string;
    },
  ): BugKind {
    if (isNonDebuggableInfrastructureFailure(outcome.reason, outcome.failureLog)) {
      return 'infrastructure';
    }
    if (outcome.bugKind) return outcome.bugKind;
    if (isVModelTestPhase(step.phase) && outcome.rollbackToPairedSource) {
      return step.phase === 'FUNCTIONAL_TEST' ? 'functional-gate' : 'test-gate';
    }
    return 'phase';
  }

}

function appendResolutionPlan(
  bug: BugTicket,
  step: Step,
  plan: string | undefined,
  alwaysAppend = false,
): void {
  if (!plan?.trim()) return;
  bug.bugResolutionPlan = plan.trim();
  const latestPlan = bug.resolutionPlanHistory?.at(-1)?.plan;
  if (!alwaysAppend && latestPlan === bug.bugResolutionPlan) return;
  bug.resolutionPlanHistory = [
    ...(bug.resolutionPlanHistory ?? []),
    {
      at: new Date().toISOString(),
      stepId: step.id,
      phase: step.phase,
      plan: bug.bugResolutionPlan,
      outcome: 'accepted' as const,
    },
  ].slice(-8);
}

function isVModelTestPhase(
  phase: Step['phase'],
): phase is (typeof V_MODEL_TEST_PHASES)[number] {
  return (V_MODEL_TEST_PHASES as readonly string[]).includes(phase);
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
