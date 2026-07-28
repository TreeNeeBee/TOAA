import { describe, expect, it } from 'vitest';
import {
  PHASES,
  STEP_STATUSES,
  stepExecutionKey,
  type Phase,
  type Step,
} from '../src/core/plan.js';
import {
  downstreamStepsForRerun,
  stepTransitivelyDependsOn,
  validateExecutionSelection,
} from '../src/core/workflow_state.js';
import {
  TICKET_VERSION,
  transitionTicket,
  type WorkTicket,
} from '../src/core/ticket.js';

function step(
  id: string,
  phase: Phase,
  dependsOn: string[] = [],
  status: Step['status'] = 'PENDING',
): Step {
  return {
    id,
    iterationId: 'P1',
    phase,
    title: id,
    description: id,
    systemPrompt: 'A sufficiently detailed execution prompt.',
    role: phase === 'CODE' ? 'Coder' : phase.endsWith('_TEST') ? 'Tester' : 'Architect',
    tools: [],
    inputs: [],
    outputs: [`docs/${id}.md`],
    dependsOn,
    acceptance: 'accepted',
    status,
    retries: 0,
    maxRetries: 3,
  };
}

describe('workflow state policy', () => {
  it('scopes repeated Step IDs by iteration', () => {
    expect(stepExecutionKey({ id: 'S001', iterationId: 'P1' })).toBe('P1:S001');
    expect(stepExecutionKey({ id: 'S001', iterationId: 'P2' })).toBe('P2:S001');
  });

  it('keeps repair mode and obsolete skip state out of persisted plan enums', () => {
    expect(PHASES).not.toContain('DEBUG');
    expect(STEP_STATUSES).not.toContain('SKIPPED');
  });

  it('rejects --from selections that bypass incomplete work', () => {
    const order = [
      step('S001', 'REQUIREMENT_ANALYSIS', [], 'DONE'),
      step('S002', 'HIGH_LEVEL_DESIGN', ['S001'], 'FAILED'),
      step('S003', 'DETAILED_DESIGN', ['S002']),
    ];
    const result = validateExecutionSelection(order, {
      fromStepId: 'S003',
      isComplete: (candidate) => candidate.status === 'DONE',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedStepId).toBe('S002');
  });

  it('computes transitive dependencies and downstream reruns from one graph policy', () => {
    const source = step('S001', 'CODE', [], 'DONE');
    const unit = step('S002', 'UNIT_TEST', ['S001'], 'FAILED');
    const integration = step('S003', 'INTEGRATION_TEST', ['S002'], 'DONE');
    const byId = new Map([source, unit, integration].map((item) => [item.id, item]));

    expect(stepTransitivelyDependsOn(integration, source.id, byId)).toBe(true);
    expect(downstreamStepsForRerun([source, unit, integration], source).map((item) => item.id))
      .toEqual(['S002', 'S003']);
  });

  it('reopens completed work through the shared ticket transition guard', () => {
    const ticket: WorkTicket = {
      version: TICKET_VERSION,
      id: 'TASK-P1-001',
      type: 'task',
      status: 'open',
      priority: 'high',
      title: 'Implement service',
      description: 'Implement the approved service contract.',
      iterationId: 'P1',
      parentTicketId: 'FEATURE-P1-001',
      rootTicketId: 'EPIC-P1-001',
      relatedTicketIds: [],
      blockedByTicketIds: [],
      workKind: 'planned-work',
      dependsOnTicketIds: [],
      execution: {
        state: 'queued',
        attempts: 0,
        maxAttempts: 3,
      },
      source: { kind: 'plan', stepId: 'S004', phase: 'CODE', role: 'Coder' },
      acceptance: ['Unit tests pass.'],
      artifacts: ['src/service.ts'],
      modelAttributions: [],
      createdAt: 'created-at',
      updatedAt: 'created-at',
    };
    transitionTicket(ticket, 'in_progress', 'started-at');
    transitionTicket(ticket, 'resolved', 'resolved-at');
    transitionTicket(ticket, 'closed', 'closed-at');
    transitionTicket(ticket, 'in_progress', 'reopened-at');

    expect(ticket).toMatchObject({ status: 'in_progress', updatedAt: 'reopened-at' });
    expect(() => transitionTicket(ticket, 'open')).toThrow(
      'Invalid ticket transition TASK-P1-001: in_progress -> open',
    );
  });
});
