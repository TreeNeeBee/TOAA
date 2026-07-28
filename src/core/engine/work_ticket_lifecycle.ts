import {
  TicketStore,
  type Ticket,
  type WorkTicket,
} from '../ticket.js';
import type {
  Plan,
  Step,
  StepSubtask,
} from '../plan.js';

export class WorkTicketLifecycle {
  constructor(private readonly store: TicketStore) {}

  async registerPlan(plan: Plan): Promise<void> {
    await this.store.load();
    const iterationIds = [...new Set(
      plan.steps.map((step) => step.iterationId ?? 'P1'),
    )];
    for (const iterationId of iterationIds) {
      let root = this.store.all().find(
        (ticket): ticket is WorkTicket =>
          ticket.type === 'feature' &&
          ticket.iterationId === iterationId &&
          ticket.source.externalId === `${plan.requirementDigest}:${iterationId}`,
      );
      if (!root) {
        root = await this.store.createWork({
          type: 'feature',
          iterationId,
          title: `${iterationId} ${plan.intent}`,
          description: plan.requirementDigest,
          priority: 'high',
          source: {
            kind: 'plan',
            externalId: `${plan.requirementDigest}:${iterationId}`,
          },
          acceptance: [
            'All V-model tasks and verification gates in this iteration are complete.',
          ],
          artifacts: [],
        });
      }

      const steps = plan.steps.filter(
        (candidate) => (candidate.iterationId ?? 'P1') === iterationId,
      );
      for (const step of steps) {
        let task = this.store.workForStep(step.id);
        if (!task) {
          task = await this.store.createWork({
            type: 'task',
            iterationId,
            title: `${step.id} ${step.title}`,
            description: step.description,
            priority: 'high',
            parentTicketId: root.id,
            rootTicketId: root.id,
            source: {
              kind: 'plan',
              externalId: step.id,
              stepId: step.id,
              phase: step.phase,
              role: step.role,
            },
            acceptance: [step.acceptance],
            artifacts: [...step.outputs],
          });
          root.relatedTicketIds = dedup([...root.relatedTicketIds, task.id]);
          await this.store.persist(root, 'linked', { relatedTicketId: task.id });
        }
        await this.registerSubTasks(step, step.subTasks ?? [], task, root, []);
        if (step.status === 'DONE' && task.status !== 'closed') {
          await this.completeStep(step);
        } else if (step.status === 'RUNNING' && task.status !== 'in_progress') {
          await this.startStep(step);
        }
      }
    }
  }

  async startStep(step: Step): Promise<void> {
    const ticket = this.store.workForStep(step.id);
    if (!ticket) return;
    await this.childOpened(ticket, 'child-work-started', {
      childTicketId: ticket.id,
      stepId: step.id,
      phase: step.phase,
    });
    if (ticket.status !== 'blocked') {
      await this.store.transition(ticket, 'in_progress', 'work-started', {
        stepId: step.id,
        phase: step.phase,
      });
    } else {
      await this.store.persist(ticket, 'blocked-work-repair-started', {
        stepId: step.id,
        phase: step.phase,
      });
    }
    for (const child of this.descendantsOf(ticket.id)) {
      await this.store.transition(child, 'in_progress', 'work-started', {
        stepId: step.id,
        phase: step.phase,
      });
    }
  }

  async failStep(step: Step, bugTicketId: string): Promise<void> {
    const ticket = this.store.workForStep(step.id);
    if (!ticket) return;
    await this.store.link(ticket, bugTicketId, 'bug-linked');
    await this.store.block(ticket, bugTicketId, `${step.id} is blocked by ${bugTicketId}`);
  }

  async completeStep(step: Step): Promise<void> {
    const ticket = this.store.workForStep(step.id);
    if (!ticket) return;
    for (const child of this.descendantsOf(ticket.id).reverse()) {
      await this.resolveAndClose(child, 'work-completed', { stepId: step.id });
    }
    await this.resolveAndClose(ticket, 'work-completed', {
      stepId: step.id,
      phase: step.phase,
    });
    await this.childClosed(ticket);
  }

  async resetStep(step: Step, reason: string): Promise<void> {
    const ticket = this.store.workForStep(step.id);
    if (!ticket) return;
    ticket.failureReason = reason;
    if (ticket.status !== 'open') {
      await this.store.transition(ticket, 'in_progress', 'work-reopened', {
        stepId: step.id,
        reason,
      });
    } else {
      await this.store.persist(ticket, 'work-reopened', { stepId: step.id, reason });
    }
    for (const child of this.descendantsOf(ticket.id)) {
      if (child.status !== 'open') {
        await this.store.transition(child, 'in_progress', 'work-reopened', {
          stepId: step.id,
          reason,
        });
      } else {
        await this.store.persist(child, 'work-reopened', {
          stepId: step.id,
          reason,
        });
      }
    }
    await this.childOpened(ticket, 'child-work-reopened', {
      childTicketId: ticket.id,
      stepId: step.id,
      reason,
    });
  }

  async childOpened(
    ticket: Ticket,
    event: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    let child = ticket;
    while (child.parentTicketId) {
      const parent = this.store.find(child.parentTicketId);
      if (!parent) return;
      if (parent.status === 'resolved' || parent.status === 'closed') {
        await this.store.transition(parent, 'in_progress', event, {
          ...extra,
          directChildTicketId: child.id,
        });
      }
      child = parent;
    }
  }

  async childClosed(ticket: Ticket): Promise<void> {
    if (!ticket.parentTicketId) return;
    const parent = this.store.find(ticket.parentTicketId);
    if (!parent || parent.type !== 'feature') return;
    const children = this.store.all().filter(
      (candidate) => candidate.parentTicketId === parent.id,
    );
    if (children.length > 0 && children.every((candidate) => candidate.status === 'closed')) {
      await this.resolveAndClose(parent, 'all-child-work-completed');
    }
  }

  private async registerSubTasks(
    step: Step,
    subTasks: StepSubtask[],
    parent: WorkTicket,
    root: WorkTicket,
    ancestry: number[],
  ): Promise<void> {
    for (const [index, subTask] of subTasks.entries()) {
      const path = [...ancestry, index + 1];
      const externalId = `${step.id}/${path.join('.')}/${subTask.id}`;
      let ticket = this.store.all().find(
        (candidate): candidate is WorkTicket =>
          candidate.type === 'sub-task' &&
          candidate.source.externalId === externalId,
      );
      if (!ticket) {
        ticket = await this.store.createWork({
          type: 'sub-task',
          iterationId: step.iterationId ?? 'P1',
          title: `${subTask.id} ${subTask.title}`,
          description: subTask.description,
          parentTicketId: parent.id,
          rootTicketId: root.id,
          source: {
            kind: 'plan',
            externalId,
            stepId: step.id,
            phase: step.phase,
            role: step.role,
          },
          acceptance: subTask.acceptance ? [subTask.acceptance] : [],
          artifacts: subTask.outputs ?? [],
        });
        parent.relatedTicketIds = dedup([...parent.relatedTicketIds, ticket.id]);
        await this.store.persist(parent, 'linked', { relatedTicketId: ticket.id });
      }
      await this.registerSubTasks(step, subTask.subTasks ?? [], ticket, root, path);
    }
  }

  private descendantsOf(parentId: string): WorkTicket[] {
    const direct = this.store.all().filter(
      (ticket): ticket is WorkTicket =>
        ticket.type === 'sub-task' && ticket.parentTicketId === parentId,
    );
    return direct.flatMap((ticket) => [ticket, ...this.descendantsOf(ticket.id)]);
  }

  private async resolveAndClose(
    ticket: Ticket,
    event: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (['open', 'triaged', 'failed'].includes(ticket.status)) {
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

function dedup(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
