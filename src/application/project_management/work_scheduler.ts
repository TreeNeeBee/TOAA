import type { ObjectId } from '../../domain/identity/object_id.js';
import type { Phase } from '../../domain/phases/phase.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { STEP_TYPE_ORDER, type Step } from '../../domain/steps/step.js';
import { isActiveTicket, workStepId, type Ticket, type WorkTicket } from '../../domain/tickets/ticket.js';
import { TicketWorkflow } from './ticket_workflow.js';

export type WorkMode = 'normal' | 'debug' | 'enhancement' | 'change-request';

export interface ScheduledWork {
  phase: Phase;
  step: Step;
  ticket: Ticket;
  mode: WorkMode;
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
    for (const step of steps) {
      if (step.state === 'closed' || !(await this.stepDependenciesReady(step))) continue;
      const corrective = activeCorrectiveTicket(step, tickets);
      if (corrective && await this.ticketDependenciesReady(corrective, tickets)) {
        return { phase, step, ticket: corrective, mode: modeFor(corrective) };
      }
      const story = tickets.find(
        (ticket): ticket is WorkTicket =>
          ticket.type === 'story' &&
          ticket.workKind === 'v-model-step' &&
          ticket.stepId === step.id,
      );
      if (
        story &&
        (story.state === 'created' || story.state === 'reopened' || story.state === 'in_progress') &&
        story.blockedByTicketIds.length === 0 &&
        await this.ticketDependenciesReady(story, tickets)
      ) {
        return { phase, step, ticket: story, mode: 'normal' };
      }
    }
    return undefined;
  }

  async resume(phaseId: ObjectId): Promise<ScheduledWork | undefined> {
    const phase = await this.requirePhase(phaseId);
    const inProgress = (await this.phaseSteps(phase)).filter((step) => step.state === 'in_progress');
    if (inProgress.length > 1) {
      throw new Error(
        `Phase ${phase.name} has multiple in-progress Steps: ${inProgress.map((step) => step.name).join(', ')}`,
      );
    }
    if (inProgress.length === 0) return this.next(phaseId);
    const tickets = await this.tickets.list();
    const step = inProgress[0]!;
    const active = activeCorrectiveTicket(step, tickets) ?? tickets.find(
      (ticket) => ticket.type === 'story' && ticket.stepId === step.id && ticket.state === 'in_progress',
    );
    if (!active) throw new Error(`In-progress Step ${step.name} has no active Ticket`);
    return { phase, step, ticket: active, mode: modeFor(active) };
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
      object.objectType === 'step' &&
      (object.state === 'delivered' || object.state === 'closed'));
  }

  private async ticketDependenciesReady(ticket: Ticket, tickets: readonly Ticket[]): Promise<boolean> {
    return ticket.dependencyTicketIds.every((dependencyId) => {
      const dependency = tickets.find((candidate) => candidate.id === dependencyId);
      return !!dependency && (dependency.state === 'resolved' || dependency.state === 'closed');
    });
  }

  private async requirePhase(id: ObjectId): Promise<Phase> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'phase') throw new Error(`Object ${id} is not a Phase`);
    return object;
  }
}

function activeCorrectiveTicket(step: Step, tickets: readonly Ticket[]): Ticket | undefined {
  return tickets
    .filter((ticket) => isActiveTicket(ticket))
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
      correctionRank(right) - correctionRank(left) || right.priority - left.priority)[0];
}

function correctionRank(ticket: Ticket): number {
  if (ticket.type === 'change-request') return 3;
  if (ticket.type === 'bug') return 2;
  if (ticket.type === 'enhancement') return 1;
  return 0;
}

function modeFor(ticket: Ticket): WorkMode {
  if (ticket.type === 'bug') return 'debug';
  if (ticket.type === 'enhancement') return 'enhancement';
  if (ticket.type === 'change-request') return 'change-request';
  return 'normal';
}
