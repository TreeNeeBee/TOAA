import type { Plan, Step } from '../../core/plan.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { Ticket } from '../../domain/tickets/ticket.js';

export type CorrectionOrigin = Pick<Step, 'id' | 'phase'>;

const PHASE_ORDER: Record<Step['phase'], number> = {
  REQUIREMENT_ANALYSIS: 0,
  HIGH_LEVEL_DESIGN: 1,
  DETAILED_DESIGN: 2,
  CODE: 3,
  UNIT_TEST: 4,
  INTEGRATION_TEST: 5,
  MODULE_TEST: 6,
  FUNCTIONAL_TEST: 7,
};

/** Resolve the Step that supplied the current corrective Ticket's own failure context. */
export function directCorrectionOrigin(
  plan: Plan,
  ticket: Ticket,
): CorrectionOrigin | undefined {
  if (ticket.type === 'bug') {
    return { id: ticket.failure.failedStepId, phase: ticket.failure.failedStepType };
  }
  if (ticket.type === 'enhancement') {
    // The verification Step is where the repaired contract will eventually be accepted. `stepId`
    // is where the gap was actually discovered and therefore determines whether code existed.
    return plan.steps.find((step) => step.id === ticket.stepId);
  }
  if (ticket.type === 'change-request') {
    if (ticket.originFailure) {
      return {
        id: ticket.originFailure.failedStepId,
        phase: ticket.originFailure.failedStepType,
      };
    }
    return plan.steps.find((step) => step.id === ticket.triggerStepId);
  }
  return undefined;
}

/**
 * Preserve the deepest origin across a nested Bug/Enhancement/CR chain.
 *
 * A correction can reach S1-S3 through more than one Ticket. Looking only at the latest Ticket
 * loses the fact that product code already existed when the chain began and can incorrectly defer
 * the source Step's executable baseline gate.
 */
export async function resolveCorrectionChainOrigin(
  repository: DomainObjectRepositoryPort,
  plan: Plan,
  ticket: Ticket,
): Promise<CorrectionOrigin | undefined> {
  const queue: Ticket[] = [ticket];
  const seen = new Set<ObjectId>();
  let deepest: CorrectionOrigin | undefined;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);

    const candidate = directCorrectionOrigin(plan, current);
    if (
      candidate &&
      (!deepest || PHASE_ORDER[candidate.phase] > PHASE_ORDER[deepest.phase])
    ) {
      deepest = candidate;
    }

    for (const id of correctionParentIds(current)) {
      if (seen.has(id)) continue;
      const object = await repository.read(id);
      if (object.objectType === 'ticket' && isCorrectiveTicket(object)) queue.push(object);
    }
  }

  return deepest;
}

function correctionParentIds(ticket: Ticket): ObjectId[] {
  const ids: ObjectId[] = [];
  if (ticket.parentTicketId) ids.push(ticket.parentTicketId);
  if (ticket.type === 'enhancement') {
    if (ticket.sourceBugTicketId) ids.push(ticket.sourceBugTicketId);
  }
  if (ticket.type === 'change-request') {
    ids.push(ticket.sourceTicketId);
    if (ticket.parentChangeRequestId) ids.push(ticket.parentChangeRequestId);
  }
  return [...new Set(ids)];
}

function isCorrectiveTicket(ticket: Ticket): boolean {
  return ['bug', 'enhancement', 'change-request'].includes(ticket.type);
}
