import type { Plan, Step } from '../plan.js';
import {
  projectWorkStatusToStepStatus,
  TicketStore,
  type Ticket,
  type TicketStatus,
  type WorkTicket,
} from '../ticket.js';
import { WorkTicketGraphCompiler } from './work_ticket_graph.js';

const TERMINAL_BLOCKER_STATUSES = new Set<TicketStatus>(['closed', 'cancelled']);

export interface WorkReadiness {
  ready: boolean;
  repairReady: boolean;
  feature: WorkTicket;
  incompleteDependencies: WorkTicket[];
  activeBlockers: Ticket[];
}

/**
 * Owns the executable Ticket graph. Plan Steps are definitions; their status
 * fields are persisted projections only and never decide scheduling.
 */
export class WorkTicketLifecycle {
  private readonly graph: WorkTicketGraphCompiler;

  constructor(private readonly store: TicketStore) {
    this.graph = new WorkTicketGraphCompiler(store);
  }

  async registerExecutionGraph(plan: Plan): Promise<void> {
    const created = await this.graph.compile(plan);
    for (const { step, feature } of created) {
      await this.initializeStageFeature(step, feature);
    }
    this.projectPlanState(plan);
  }

  featureForStep(step: Step): WorkTicket | undefined {
    return this.store.featureForStep(step.id, step.iterationId ?? 'P1');
  }

  epicForIteration(iterationId: string): WorkTicket | undefined {
    return this.store.epicForIteration(iterationId);
  }

  deliveryForIteration(iterationId: string): WorkTicket | undefined {
    return this.store.deliveryForIteration(iterationId);
  }

  readiness(step: Step): WorkReadiness {
    const feature = this.requireFeature(step);
    const incompleteDependencies = feature.dependsOnTicketIds
      .map((id) => this.store.find(id))
      .filter((ticket): ticket is WorkTicket =>
        !!ticket &&
        isWorkTicket(ticket) &&
        ticket.execution.state !== 'passed'
      );
    const activeBlockers = feature.blockedByTicketIds
      .map((id) => this.store.find(id))
      .filter((ticket): ticket is Ticket =>
        !!ticket && !TERMINAL_BLOCKER_STATUSES.has(ticket.status)
      );
    return {
      ready: incompleteDependencies.length === 0 && activeBlockers.length === 0,
      repairReady:
        incompleteDependencies.length === 0 &&
        activeBlockers.length > 0 &&
        activeBlockers.every((ticket) => blockerTargetsStep(ticket, step, feature)),
      feature,
      incompleteDependencies,
      activeBlockers,
    };
  }

  isStepComplete(step: Step): boolean {
    const feature = this.requireFeature(step);
    return feature.status === 'closed' && feature.execution.state === 'passed';
  }

  executionState(step: Step): WorkTicket['execution']['state'] {
    return this.requireFeature(step).execution.state;
  }

  incompleteSteps(steps: readonly Step[]): Step[] {
    return steps.filter((step) => !this.isStepComplete(step));
  }

  attemptCount(step: Step): number {
    return this.requireFeature(step).execution.attempts;
  }

  maxAttempts(step: Step): number {
    return this.requireFeature(step).execution.maxAttempts;
  }

  async setAttemptCount(step: Step, attempts: number): Promise<void> {
    const feature = this.requireFeature(step);
    feature.execution.attempts = attempts;
    feature.updatedAt = new Date().toISOString();
    this.projectStepState(step, feature);
    await this.store.persist(feature, 'attempt-count-updated', {
      stepId: step.id,
      attempts,
    });
  }

  async startStep(step: Step): Promise<void> {
    const feature = this.requireFeature(step);
    feature.execution.state = 'running';
    await this.childOpened(feature, 'stage-feature-started', {
      childTicketId: feature.id,
      stepId: step.id,
      phase: step.phase,
    });
    if (feature.status !== 'blocked' && feature.status !== 'in_progress') {
      await this.store.transition(feature, 'in_progress', 'stage-feature-started', {
        stepId: step.id,
        phase: step.phase,
      });
    } else {
      await this.store.persist(feature, 'stage-feature-repair-started', {
        stepId: step.id,
        phase: step.phase,
      });
    }
    for (const child of this.descendantsOf(feature.id)) {
      if (child.status !== 'in_progress') {
        await this.store.transition(child, 'in_progress', 'planned-work-started', {
          stepId: step.id,
          phase: step.phase,
        });
      }
    }
    this.projectStepState(step, feature);
  }

  async failStep(step: Step, bugTicketId: string): Promise<void> {
    const feature = this.requireFeature(step);
    feature.execution.state = 'failed';
    await this.childOpened(feature, 'stage-feature-failed', {
      childTicketId: feature.id,
      stepId: step.id,
      phase: step.phase,
      bugTicketId,
    });
    await this.store.link(feature, bugTicketId, 'bug-linked');
    await this.store.block(feature, bugTicketId, `${step.id} is blocked by ${bugTicketId}`);
    this.projectStepState(step, feature);
  }

  async deferStep(step: Step, reason: string): Promise<void> {
    const feature = this.requireFeature(step);
    feature.execution.state = 'queued';
    feature.failureReason = reason;
    feature.updatedAt = new Date().toISOString();
    this.projectStepState(step, feature);
    await this.store.persist(feature, 'stage-feature-deferred', {
      stepId: step.id,
      phase: step.phase,
      reason,
    });
  }

  async completeStep(step: Step): Promise<void> {
    const feature = this.requireFeature(step);
    for (const child of this.descendantsOf(feature.id).reverse()) {
      await this.resolveAndClose(child, 'planned-work-completed', { stepId: step.id });
    }
    await this.resolveAndClose(feature, 'stage-feature-completed', {
      stepId: step.id,
      phase: step.phase,
    });
    feature.execution.state = 'passed';
    this.projectStepState(step, feature);
    await this.store.persist(feature, 'stage-feature-state-projected', {
      stepId: step.id,
      status: step.status,
    });
  }

  async resetStep(step: Step, reason: string): Promise<void> {
    const feature = this.requireFeature(step);
    feature.failureReason = reason;
    feature.execution.state = 'queued';
    feature.execution.attempts = 0;
    if (feature.status !== 'open') {
      await this.store.transition(feature, 'in_progress', 'stage-feature-reopened', {
        stepId: step.id,
        reason,
      });
    } else {
      await this.store.persist(feature, 'stage-feature-reopened', {
        stepId: step.id,
        reason,
      });
    }
    for (const child of this.descendantsOf(feature.id)) {
      if (child.status !== 'open') {
        await this.store.transition(child, 'in_progress', 'planned-work-reopened', {
          stepId: step.id,
          reason,
        });
      }
    }
    await this.childOpened(feature, 'stage-feature-reopened', {
      childTicketId: feature.id,
      stepId: step.id,
      reason,
    });
    this.projectStepState(step, feature);
  }

  async completeDelivery(iterationId: string, artifacts: string[] = []): Promise<void> {
    const epic = this.requireEpic(iterationId);
    const delivery = this.requireDelivery(iterationId);
    const stageFeatures = this.stageFeatures(iterationId);
    const incomplete = stageFeatures.filter(
      (ticket) => ticket.status !== 'closed' || ticket.execution.state !== 'passed',
    );
    const incompleteEpicDependencies = epic.dependsOnTicketIds
      .map((id) => this.store.find(id))
      .filter((ticket): ticket is WorkTicket =>
        !!ticket &&
        isWorkTicket(ticket) &&
        (ticket.status !== 'closed' || ticket.execution.state !== 'passed')
      );
    const activeBlockers = this.store.all().filter((ticket) =>
      ticket.rootTicketId === epic.id &&
      (ticket.type === 'bug' || ticket.type === 'enhance' || ticket.type === 'change-request') &&
      !TERMINAL_BLOCKER_STATUSES.has(ticket.status)
    );
    if (
      incomplete.length > 0 ||
      incompleteEpicDependencies.length > 0 ||
      activeBlockers.length > 0
    ) {
      throw new Error(
        `cannot deliver ${iterationId}: incomplete features [${incomplete.map((item) => item.id).join(', ')}], ` +
        `incomplete Epic dependencies [${incompleteEpicDependencies.map((item) => item.id).join(', ')}], ` +
        `active blockers [${activeBlockers.map((item) => item.id).join(', ')}]`,
      );
    }
    delivery.artifacts = dedup([...delivery.artifacts, ...artifacts]);
    delivery.execution.state = 'running';
    if (delivery.status !== 'in_progress') {
      await this.store.transition(delivery, 'in_progress', 'delivery-started');
    }
    await this.resolveAndClose(delivery, 'delivery-completed');
    delivery.execution.state = 'passed';
    await this.store.persist(delivery, 'delivery-execution-passed');
    await this.resolveAndClose(epic, 'iteration-epic-completed');
    epic.execution.state = 'passed';
    await this.store.persist(epic, 'iteration-epic-execution-passed');
  }

  async resetExecutionGraph(plan: Plan, reason: string): Promise<void> {
    const iterationIds = new Set(plan.steps.map((step) => step.iterationId ?? 'P1'));
    for (const ticket of this.store.all()) {
      if (!iterationIds.has(ticket.iterationId)) continue;
      if (
        ticket.type === 'bug' ||
        ticket.type === 'enhance' ||
        ticket.type === 'change-request'
      ) {
        if (!TERMINAL_BLOCKER_STATUSES.has(ticket.status)) {
          if (ticket.status === 'resolved') {
            await this.store.transition(ticket, 'closed', 'execution-reset:closed', { reason });
          } else {
            await this.store.transition(ticket, 'cancelled', 'execution-reset:cancelled', { reason });
          }
        }
        continue;
      }
      ticket.blockedByTicketIds = [];
      ticket.failureReason = reason;
      ticket.execution.state = 'queued';
      ticket.execution.attempts = 0;
      if (ticket.status === 'closed' || ticket.status === 'resolved') {
        await this.store.transition(ticket, 'in_progress', 'execution-reset:reopened', { reason });
      } else if (ticket.status !== 'in_progress') {
        await this.store.transition(ticket, 'in_progress', 'execution-reset:started', { reason });
      } else {
        await this.store.persist(ticket, 'execution-reset', { reason });
      }
    }
    this.projectPlanState(plan);
  }

  async reopenAncestorsFor(
    ticket: Ticket,
    event: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.childOpened(ticket, event, extra);
  }

  projectPlanState(plan: Plan): void {
    for (const step of plan.steps) {
      const feature = this.featureForStep(step);
      if (feature) this.projectStepState(step, feature);
    }
  }

  isIterationDelivered(iterationId: string): boolean {
    const epic = this.requireEpic(iterationId);
    const delivery = this.requireDelivery(iterationId);
    return epic.status === 'closed' &&
      epic.execution.state === 'passed' &&
      delivery.status === 'closed' &&
      delivery.execution.state === 'passed';
  }

  private async initializeStageFeature(
    step: Step,
    feature: WorkTicket,
  ): Promise<void> {
    feature.execution.attempts = step.retries;
    if (step.status === 'DONE') {
      await this.completeStep(step);
      return;
    }
    if (step.status === 'RUNNING') {
      feature.execution.state = 'queued';
      await this.store.persist(feature, 'stale-plan-running-reset', {
        stepId: step.id,
        initialStepStatus: step.status,
      });
      this.projectStepState(step, feature);
      return;
    }
    if (step.status === 'FAILED') {
      feature.execution.state = 'failed';
      await this.store.transition(feature, 'failed', 'stage-feature-initialized', {
        stepId: step.id,
        initialStepStatus: step.status,
      });
      this.projectStepState(step, feature);
      return;
    }
    await this.store.persist(feature, 'stage-feature-initialized', {
      stepId: step.id,
      initialStepStatus: step.status,
    });
  }

  private descendantsOf(parentId: string): WorkTicket[] {
    const direct = this.store.all().filter(
      (ticket): ticket is WorkTicket =>
        isWorkTicket(ticket) && ticket.parentTicketId === parentId,
    );
    return direct.flatMap((ticket) => [ticket, ...this.descendantsOf(ticket.id)]);
  }

  private async childOpened(
    ticket: Ticket,
    event: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    let child = ticket;
    while (child.parentTicketId) {
      const parent = this.store.find(child.parentTicketId);
      if (!parent) return;
      if (
        parent.status === 'open' ||
        parent.status === 'triaged' ||
        parent.status === 'failed' ||
        parent.status === 'resolved' ||
        parent.status === 'closed'
      ) {
        if (isWorkTicket(parent)) parent.execution.state = 'running';
        await this.store.transition(parent, 'in_progress', event, {
          ...extra,
          directChildTicketId: child.id,
        });
      }
      child = parent;
    }
  }

  private requireFeature(step: Step): WorkTicket {
    const feature = this.featureForStep(step);
    if (!feature) throw new Error(`missing stage Feature for Plan Step ${step.id}`);
    return feature;
  }

  private requireEpic(iterationId: string): WorkTicket {
    const epic = this.epicForIteration(iterationId);
    if (!epic) throw new Error(`missing Epic for iteration ${iterationId}`);
    return epic;
  }

  private requireDelivery(iterationId: string): WorkTicket {
    const delivery = this.deliveryForIteration(iterationId);
    if (!delivery) throw new Error(`missing delivery Feature for iteration ${iterationId}`);
    return delivery;
  }

  private stageFeatures(iterationId: string): WorkTicket[] {
    return this.store.all().filter(
      (ticket): ticket is WorkTicket =>
        ticket.type === 'feature' &&
        ticket.workKind === 'v-model-stage' &&
        ticket.iterationId === iterationId,
    );
  }

  private projectStepState(step: Step, feature: WorkTicket): void {
    step.status = projectWorkStatusToStepStatus(feature);
    step.retries = feature.execution.attempts;
  }

  private async resolveAndClose(
    ticket: Ticket,
    event: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (['open', 'triaged', 'failed', 'blocked'].includes(ticket.status)) {
      await this.store.transition(ticket, 'in_progress', `${event}:started`, extra);
    }
    if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
      await this.store.transition(ticket, 'resolved', `${event}:resolved`, extra);
    }
    if (ticket.status !== 'closed') {
      await this.store.transition(ticket, 'closed', `${event}:closed`, extra);
    }
  }
}

function isWorkTicket(ticket: Ticket): ticket is WorkTicket {
  return ticket.type === 'epic' ||
    ticket.type === 'feature' ||
    ticket.type === 'task' ||
    ticket.type === 'sub-task';
}

function dedup(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function blockerTargetsStep(
  ticket: Ticket,
  step: Step,
  feature: WorkTicket,
): boolean {
  if (ticket.type === 'bug') {
    return ticket.targetStepId === step.id ||
      ticket.source.stepId === step.id ||
      ticket.verificationStepId === step.id;
  }
  if (ticket.type === 'enhance') {
    return ticket.affectedWorkTicketIds.includes(feature.id) ||
      ticket.targetStepId === step.id ||
      ticket.source.stepId === step.id ||
      ticket.verificationStepId === step.id;
  }
  if (ticket.type === 'change-request') {
    return ticket.designSource.stepId === step.id ||
      ticket.affectedSteps.some((affected) => affected.stepId === step.id);
  }
  return false;
}
