import { describe, expect, it } from 'vitest';
import {
  directCorrectionOrigin,
  resolveCorrectionChainOrigin,
} from '../src/application/execution/correction_provenance.js';
import { resolveBaselineGateExecution } from '../src/application/execution/attempt_policy.js';
import type { Plan, Step } from '../src/core/plan.js';
import type { DomainObjectRepositoryPort } from '../src/domain/ports/repository.js';
import type { Ticket } from '../src/domain/tickets/ticket.js';

describe('correction provenance', () => {
  it('uses the deepest failure in a folded CR when deciding whether baseline code exists', () => {
    const plan = fixturePlan();
    const requirement = plan.steps[0]!;
    const request = {
      id: 'folded-cr',
      objectType: 'ticket',
      type: 'change-request',
      triggerStepId: 'requirement-id',
      sourceTicketIds: ['design-bug', 'unit-bug'],
      originFailures: [
        { failedStepId: 'requirement-id', failedStepType: 'REQUIREMENT_ANALYSIS' },
        { failedStepId: 'unit-id', failedStepType: 'UNIT_TEST' },
      ],
    } as Ticket;

    const origin = directCorrectionOrigin(plan, request);

    expect(origin).toEqual({ id: 'unit-id', phase: 'UNIT_TEST' });
    expect(resolveBaselineGateExecution(plan, requirement, request, origin)).toMatchObject({
      mode: 'execute',
      reason: 'post-code-correction',
      originStepId: 'unit-id',
    });
  });

  it('keeps a post-CODE origin through a nested CR and upstream Enhancement', async () => {
    const plan = fixturePlan();
    const requirement = plan.steps[0]!;
    const sourceBug = {
      id: 'source-bug',
      objectType: 'ticket',
      type: 'bug',
      failure: {
        failedStepId: 'unit-id',
        failedStepType: 'UNIT_TEST',
      },
    } as Ticket;
    const parentCr = {
      id: 'parent-cr',
      objectType: 'ticket',
      type: 'change-request',
      triggerStepId: 'requirement-id',
      sourceTicketIds: ['source-bug'],
      originFailures: [],
    } as Ticket;
    const enhancement = {
      id: 'enhancement-id',
      objectType: 'ticket',
      type: 'enhancement',
      stepId: 'requirement-id',
      targetStepId: 'requirement-id',
      verificationStepId: 'functional-id',
      parentTicketId: 'parent-cr',
    } as Ticket;
    const objects = new Map<string, Ticket>([
      [sourceBug.id, sourceBug],
      [parentCr.id, parentCr],
    ]);
    const repository = {
      read: async (id: string) => {
        const object = objects.get(id);
        if (!object) throw new Error(`missing ${id}`);
        return object;
      },
    } as DomainObjectRepositoryPort;

    const origin = await resolveCorrectionChainOrigin(repository, plan, enhancement);

    expect(origin).toEqual({ id: 'unit-id', phase: 'UNIT_TEST' });
    expect(resolveBaselineGateExecution(plan, requirement, enhancement, origin)).toEqual({
      mode: 'execute',
      reason: 'post-code-correction',
      originStepId: 'unit-id',
      originPhase: 'UNIT_TEST',
    });
  });
});

function fixturePlan(): Plan {
  return {
    language: 'typescript',
    steps: [
      { id: 'requirement-id', phase: 'REQUIREMENT_ANALYSIS' },
      { id: 'code-id', phase: 'CODE' },
      { id: 'unit-id', phase: 'UNIT_TEST' },
      { id: 'functional-id', phase: 'FUNCTIONAL_TEST' },
    ] as Step[],
  } as Plan;
}
