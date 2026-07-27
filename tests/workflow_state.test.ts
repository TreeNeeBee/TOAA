import { describe, expect, it } from 'vitest';
import {
  PHASES,
  STEP_STATUSES,
  type Phase,
  type Step,
} from '../src/core/plan.js';
import {
  downstreamStepsForRerun,
  incompleteTransitiveDependencies,
  InvalidStepTransitionError,
  resetStepForRerun,
  transitionStep,
  validateExecutionSelection,
} from '../src/core/workflow_state.js';
import { transitionIssue } from '../src/core/issue_state.js';

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
  it('keeps repair mode and obsolete skip state out of persisted plan enums', () => {
    expect(PHASES).not.toContain('DEBUG');
    expect(STEP_STATUSES).not.toContain('SKIPPED');
  });

  it('enforces legal transitions and supports cached-gate completion', () => {
    const current = step('S001', 'UNIT_TEST');
    expect(transitionStep(current, 'DONE', 'cached-gate-passed')).toBe(true);
    expect(current.status).toBe('DONE');
    expect(() => transitionStep(current, 'FAILED', 'attempt-failed'))
      .toThrow(InvalidStepTransitionError);
    expect(() => transitionStep(current, 'PENDING', 'attempt-started'))
      .toThrow(InvalidStepTransitionError);
  });

  it('resets interrupted and downstream work through the same mutation boundary', () => {
    const current = step('S001', 'CODE', [], 'RUNNING');
    current.retries = 2;
    expect(resetStepForRerun(current, 'interrupted')).toBe(true);
    expect(current).toMatchObject({ status: 'PENDING', retries: 0 });
  });

  it('rejects --from selections that bypass incomplete work', () => {
    const order = [
      step('S001', 'REQUIREMENT_ANALYSIS', [], 'DONE'),
      step('S002', 'HIGH_LEVEL_DESIGN', ['S001'], 'FAILED'),
      step('S003', 'DETAILED_DESIGN', ['S002']),
    ];
    const result = validateExecutionSelection(order, { fromStepId: 'S003' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedStepId).toBe('S002');
  });

  it('computes dependency blockers and downstream reruns from one graph policy', () => {
    const source = step('S001', 'CODE', [], 'DONE');
    const unit = step('S002', 'UNIT_TEST', ['S001'], 'FAILED');
    const integration = step('S003', 'INTEGRATION_TEST', ['S002'], 'DONE');
    const byId = new Map([source, unit, integration].map((item) => [item.id, item]));

    expect(incompleteTransitiveDependencies(integration, byId).map((item) => item.id))
      .toEqual(['S002']);
    expect(downstreamStepsForRerun([source, unit, integration], source).map((item) => item.id))
      .toEqual(['S002', 'S003']);
  });

  it('keeps resolved issues terminal while allowing unresolved issues to be rerouted', () => {
    const issue = { status: 'recorded' as const, updatedAt: 'before' };
    transitionIssue(issue, 'unresolved', 'unresolved-at');
    transitionIssue(issue, 'routed', 'routed-at');
    transitionIssue(issue, 'resolved', 'resolved-at');

    expect(issue).toEqual({ status: 'resolved', updatedAt: 'resolved-at' });
    expect(() => transitionIssue(issue, 'routed')).toThrow(
      'Invalid issue transition issue: resolved -> routed',
    );
  });

  it('keeps design issues open while their linked CR is implemented', () => {
    const issue = { status: 'recorded' as const, updatedAt: 'before' };
    transitionIssue(issue, 'routed', 'routed-at');
    transitionIssue(issue, 'change_pending', 'change-pending-at');
    expect(issue.status).toBe('change_pending');
    transitionIssue(issue, 'resolved', 'resolved-at');
    expect(issue.status).toBe('resolved');
  });
});
