import type { ObjectId } from '../../domain/identity/object_id.js';
import type { Phase } from '../../domain/phases/phase.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { STEP_TYPE_ORDER, stepSatisfiesDependency, type Step } from '../../domain/steps/step.js';
import { isActiveTicket, workStepId, type Ticket, type WorkTicket } from '../../domain/tickets/ticket.js';
import { TicketWorkflow } from './ticket_workflow.js';

export type WorkMode = 'normal' | 'debug' | 'enhancement' | 'change-request';

export interface ScheduledWork {
  phase: Phase;
  step: Step;
  ticket: Ticket;
}

export class WorkScheduler {
  private readonly tickets: TicketWorkflow;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.tickets = new TicketWorkflow(repository);
  }

  async next(phaseId: ObjectId): Promise<ScheduledWork | undefined> {
    const phase = await this.requirePhase(phaseId);
    const steps = await this.phaseSteps(phase);
    const tickets = await this.tickets.list();
    const resumed = await this.inProgressWork(phase, steps, tickets);
    if (resumed) return resumed;
    for (const step of steps) {
      const corrective = await this.readyCorrectiveTicket(step, tickets);
      if (corrective) {
        return { phase, step, ticket: corrective };
      }
      // Closed Steps suppress their ordinary Story only. A queued corrective Ticket is allowed to
      // reopen one, and was therefore considered above — and unready dependencies suppress it the
      // same way, for the same reason. A corrective Ticket is matched against the Step it repairs,
      // which is routinely upstream of where the defect was found, so gating it on that Step's
      // dependencies hid every repair queued behind a reopened Step. A live Phase stopped with
      // every actor idle and seven such repairs waiting, none of them blocked and none of them
      // out of attempts.
      if (step.state === 'closed') continue;
      if (!(await this.stepDependenciesReady(step))) continue;
      const story = tickets.find(
        (ticket): ticket is WorkTicket =>
          ticket.type === 'story' &&
          ticket.workKind === 'v-model-step' &&
          ticket.stepId === step.id,
      );
      if (
        story &&
        (story.state === 'created' || story.state === 'pending' ||
          story.state === 'reopened' || story.state === 'in_progress') &&
        story.blockedByTicketIds.length === 0 &&
        await this.ticketDependenciesReady(story, tickets)
      ) {
        return { phase, step, ticket: story };
      }
    }
    return undefined;
  }

  async resume(phaseId: ObjectId): Promise<ScheduledWork | undefined> {
    const phase = await this.requirePhase(phaseId);
    const steps = await this.phaseSteps(phase);
    const inProgress = steps.filter((step) => step.state === 'in_progress');
    if (inProgress.length > 1) {
      throw new Error(
        `Phase ${phase.name} has multiple in-progress Steps: ${inProgress.map((step) => step.name).join(', ')}`,
      );
    }
    const tickets = await this.tickets.list();
    const resumed = await this.inProgressWork(phase, steps, tickets);
    if (resumed) return resumed;
    if (inProgress.length === 0) return this.next(phaseId);
    const step = inProgress[0]!;
    const active = await this.readyCorrectiveTicket(step, tickets) ?? tickets.find(
      (ticket) => ticket.type === 'story' && ticket.stepId === step.id && ticket.state === 'in_progress',
    );
    if (!active) throw new Error(`In-progress Step ${step.name} has no active Ticket`);
    return { phase, step, ticket: active };
  }

  /**
   * Resume owned work before dispatching anything new.
   *
   * A corrective child parks its parent Ticket and Step. Closing the child restores the parent
   * Ticket to `in_progress`; the Step intentionally remains `pending` until `ProjectController`
   * starts that Ticket again. Looking only at Step state loses this hand-off and lets an earlier
   * created Ticket compete with the parent's already-reserved actor capacity.
   */
  private async inProgressWork(
    phase: Phase,
    steps: readonly Step[],
    tickets: readonly Ticket[],
  ): Promise<ScheduledWork | undefined> {
    const stepById = new Map(steps.map((step) => [step.id, step]));
    const candidates = tickets
      .filter((ticket) => ticket.state === 'in_progress')
      .filter((ticket) => ticket.blockedByTicketIds.length === 0)
      .map((ticket) => {
        const stepId = scheduledStepId(ticket);
        return { ticket, step: stepId ? stepById.get(stepId) : undefined };
      })
      .filter((entry): entry is { ticket: Ticket; step: Step } =>
        !!entry.step && entry.step.state !== 'closed')
      .sort((left, right) =>
        STEP_TYPE_ORDER[left.step.type] - STEP_TYPE_ORDER[right.step.type] ||
        correctionRank(right.ticket) - correctionRank(left.ticket) ||
        right.ticket.priority - left.ticket.priority ||
        left.ticket.id.localeCompare(right.ticket.id));
    for (const candidate of candidates) {
      if (
        await this.stepDependenciesReady(candidate.step) &&
        await this.ticketDependenciesReady(candidate.ticket, tickets)
      ) {
        return {
          phase,
          step: candidate.step,
          ticket: candidate.ticket,
        };
      }
    }
    return undefined;
  }

  async phaseSteps(phase: Phase): Promise<Step[]> {
    const steps = await Promise.all(phase.stepIds.map((id) => this.repository.read(id)));
    return steps
      .map((object) => {
        if (object.objectType !== 'step') throw new Error(`Phase ${phase.name} references non-Step ${object.id}`);
        return object;
      })
      .sort((left, right) => STEP_TYPE_ORDER[left.type] - STEP_TYPE_ORDER[right.type]);
  }

  private async stepDependenciesReady(step: Step): Promise<boolean> {
    const dependencies = await Promise.all(step.dependencyStepIds.map((id) => this.repository.read(id)));
    return dependencies.every((object) =>
      object.objectType === 'step' && stepSatisfiesDependency(object));
  }

  private async ticketDependenciesReady(ticket: Ticket, tickets: readonly Ticket[]): Promise<boolean> {
    return ticket.dependencyTicketIds.every((dependencyId) => {
      const dependency = tickets.find((candidate) => candidate.id === dependencyId);
      return !!dependency && (dependency.state === 'resolved' || dependency.state === 'closed');
    });
  }

  private async readyCorrectiveTicket(
    step: Step,
    tickets: readonly Ticket[],
  ): Promise<Ticket | undefined> {
    for (const candidate of activeCorrectiveTickets(step, tickets)) {
      if (await this.ticketDependenciesReady(candidate, tickets)) return candidate;
    }
    return undefined;
  }

  private async requirePhase(id: ObjectId): Promise<Phase> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'phase') throw new Error(`Object ${id} is not a Phase`);
    return object;
  }
}

function activeCorrectiveTickets(step: Step, tickets: readonly Ticket[]): Ticket[] {
  return tickets
    .filter((ticket) => isActiveTicket(ticket))
    .filter((ticket) => ticket.duplicateOfTicketId === undefined)
    .filter((ticket) => ticket.blockedByTicketIds.length === 0)
    .filter((ticket) =>
      // Bugs and Enhancements are repaired at the Step `workStepId` designates, which is the same
      // rule PM routes them by. A Change Request is the exception: it spans several Steps, so it is
      // matched against whichever of them still lacks an application.
      ((ticket.type === 'bug' || ticket.type === 'enhancement') &&
        workStepId(ticket) === step.id &&
        ticket.changeRequestTicketIds.length === 0) ||
      (ticket.type === 'change-request' &&
        ticket.targetStepId === step.id &&
        !ticket.applications.some((application) => application.stepId === step.id)))
    .sort((left, right) =>
      correctionRank(right) - correctionRank(left) ||
      right.priority - left.priority ||
      left.id.localeCompare(right.id));
}

function correctionRank(ticket: Ticket): number {
  if (ticket.type === 'change-request') return 3;
  if (ticket.type === 'bug') return 2;
  if (ticket.type === 'enhancement') return 1;
  return 0;
}

function scheduledStepId(ticket: Ticket): ObjectId | undefined {
  if (ticket.type === 'change-request') return ticket.targetStepId;
  if (ticket.type === 'story' && ticket.workKind !== 'v-model-step') return undefined;
  if (ticket.type === 'epic' || ticket.type === 'task') return undefined;
  return workStepId(ticket);
}

export function workModeFor(ticket: Ticket): WorkMode {
  if (ticket.type === 'bug') return 'debug';
  if (ticket.type === 'enhancement') return 'enhancement';
  if (ticket.type === 'change-request') return 'change-request';
  return 'normal';
}
