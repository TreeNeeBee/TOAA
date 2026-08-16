import { describe, expect, it } from 'vitest';
import { createObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { objectRef } from '../src/domain/objects/object_ref.js';
import { KpiSchema, calculateQuality, evaluateKpi } from '../src/domain/quality/quality.js';
import { StepSchema, transitionStep } from '../src/domain/steps/step.js';
import { TicketSchema, transitionTicket } from '../src/domain/tickets/ticket.js';

describe('new domain lifecycle', () => {
  it('keeps id immutable while name remains a revisable display label', () => {
    const project = createObjectEnvelope({ name: 'news', objectType: 'project' });
    const phase = createObjectEnvelope({ name: 'P1', objectType: 'phase', projectId: project.id });
    const envelope = createObjectEnvelope({ name: 'P1-S004', objectType: 'step', projectId: project.id });
    const step = StepSchema.parse({
      ...envelope,
      phaseId: phase.id,
      type: 'CODE',
      title: 'Implement core behavior',
      description: 'Implement the approved detailed design.',
      role: 'developer',
      agent: 'Coder',
      state: 'created',
      dependencyStepIds: [],
      inputs: ['docs/03-detailed-design.md'],
      outputs: ['src/main.ts'],
      acceptance: ['The implementation matches the detailed design.'],
      tolerance: {},
      systemPrompt: 'Implement only the approved scope.',
      tools: ['write_file'],
    });

    const started = transitionStep(step, 'in_progress', { now: '2026-08-01T01:00:00.000Z' });
    const delivered = transitionStep(started, 'delivered', { now: '2026-08-01T02:00:00.000Z' });
    const closed = transitionStep(delivered, 'closed', { now: '2026-08-01T03:00:00.000Z' });

    expect(closed.id).toBe(step.id);
    expect(closed.name).toBe('P1-S004');
    expect(closed.revision).toBe(4);
    expect(() => transitionStep(closed, 'in_progress')).toThrow(/Invalid step transition/u);
  });

  it('requires pending reasons and verified defect solutions', () => {
    const project = createObjectEnvelope({ name: 'news', objectType: 'project' });
    const phase = createObjectEnvelope({ name: 'P1', objectType: 'phase', projectId: project.id });
    const failedStep = createObjectEnvelope({ name: 'P1-S005', objectType: 'step', projectId: project.id });
    const targetStep = createObjectEnvelope({ name: 'P1-S004', objectType: 'step', projectId: project.id });
    const creator = createObjectEnvelope({ name: 'developer', objectType: 'actor-registration', projectId: project.id });
    const assignment = createObjectEnvelope({ name: 'assignment', objectType: 'ticket-assignment', projectId: project.id });
    const ticketEnvelope = createObjectEnvelope({ name: 'BUG-P1-001', objectType: 'ticket', projectId: project.id });
    const bug = TicketSchema.parse({
      ...ticketEnvelope,
      type: 'bug',
      phaseId: phase.id,
      stepId: failedStep.id,
      role: 'developer',
      agent: 'Debugger',
      creatorActorId: creator.id,
      activeAssignmentId: assignment.id,
      priority: 192,
      rootTicketId: ticketEnvelope.id,
      description: 'Unit test failed.',
      acceptance: ['The failed test passes.'],
      state: 'created',
      source: { kind: 'runtime', correlationId: ticketEnvelope.id },
      submittedAt: '2026-08-01T00:00:00.000Z',
      bugKind: 'test-failure',
      severity: 'high',
      failure: {
        category: 'test',
        code: 'unit_assertion_failed',
        message: 'expected 2, received 1',
        summary: 'Aggregation result is incorrect.',
        retryable: true,
        switchProvider: false,
        failedStepId: failedStep.id,
        failedStepType: 'UNIT_TEST',
        targetStepId: targetStep.id,
        targetStepType: 'CODE',
        verificationStepId: failedStep.id,
        verificationStepType: 'UNIT_TEST',
      },
    });

    expect(() => transitionTicket(bug, 'pending')).toThrow(/pendingReason/u);
    const active = transitionTicket(bug, 'in_progress');
    expect(() => transitionTicket(active, 'resolved')).toThrow(/verified solution/u);
    const resolved = transitionTicket({
      ...active,
      solution: {
        status: 'verified',
        approach: 'Correct the aggregation branch.',
        rationale: 'The branch used the previous value.',
        changes: ['src/aggregate.ts'],
        verification: ['unit tests passed'],
        updatedAt: '2026-08-01T02:00:00.000Z',
      },
    }, 'resolved');
    expect(resolved.state).toBe('resolved');
  });

  it('derives quality from KPI observations instead of accepting a writable score', () => {
    const project = createObjectEnvelope({ name: 'news', objectType: 'project' });
    const step = createObjectEnvelope({ name: 'P1-S005', objectType: 'step', projectId: project.id });
    const lineCoverage = KpiSchema.parse({
      ...createObjectEnvelope({ name: 'line-coverage', objectType: 'kpi', projectId: project.id }),
      description: 'Unit test line coverage',
      metric: 'lineCoverage',
      comparator: 'gte',
      target: 0.8,
      tolerance: 0.02,
      weight: 1,
      subjectId: step.id,
    });
    const observedAt = '2026-08-01T00:00:00.000Z';
    const value = 0.79;
    const observation = {
      kpiId: lineCoverage.id,
      value,
      passed: evaluateKpi(lineCoverage, value),
      evidence: ['coverage.json'],
      observedAt,
    };

    // Tolerance is policy, not data. A band frozen into the KPI at compile time could only be
    // changed by rebuilding the project, so a workspace planned before the rule existed would keep
    // enforcing the old one — the value here is 0.02 and the structural floor widens it to 0.1, on
    // this already-persisted object.
    expect(evaluateKpi(lineCoverage, 0.71)).toBe(true);
    expect(evaluateKpi(lineCoverage, 0.69)).toBe(false);

    expect(calculateQuality([lineCoverage], [observation])).toEqual({
      score: 1,
      passed: true,
      missingStructuralKpiIds: [],
      missingFunctionalKpiIds: [],
    });

    // A structural number nobody produced is recorded, not held against the Step: asking for a
    // repair that cannot exist is what reopened a live MODULE_TEST twice. The score still drops,
    // so the assessment does not claim to be complete.
    expect(calculateQuality([lineCoverage], [])).toEqual({
      score: 0,
      passed: true,
      missingStructuralKpiIds: [lineCoverage.id],
      missingFunctionalKpiIds: [],
    });

    // A functional metric is the opposite case: unmeasured is as serious as failing, because the
    // claim it carries was never established.
    const passRate = KpiSchema.parse({
      ...createObjectEnvelope({ name: 'pass-rate', objectType: 'kpi', projectId: project.id }),
      description: 'Unit test pass rate',
      metric: 'testCasePassRate',
      comparator: 'gte',
      target: 1,
      tolerance: 0.02,
      weight: 1,
      subjectId: step.id,
    });
    expect(calculateQuality([passRate], [])).toEqual({
      score: 0,
      passed: false,
      missingStructuralKpiIds: [],
      missingFunctionalKpiIds: [passRate.id],
    });
    expect(objectRef(step.id, 'step')).toEqual({ id: step.id, objectType: 'step' });
  });
});
