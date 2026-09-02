import { describe, expect, it } from 'vitest';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { createObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { objectRef } from '../src/domain/objects/object_ref.js';
import { KpiSchema, calculateQuality, evaluateKpi } from '../src/domain/quality/quality.js';
import { StepSchema, transitionStep } from '../src/domain/steps/step.js';
import { TicketSchema, transitionTicket } from '../src/domain/tickets/ticket.js';

describe('new domain lifecycle', () => {
  it('keeps id immutable while name remains a revisable display label', () => {
    const project = createObjectEnvelope({ name: 'report', objectType: 'project' });
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
    const project = createObjectEnvelope({ name: 'report', objectType: 'project' });
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
        identity: {
          version: 1,
          category: 'test',
          code: 'unit_assertion_failed',
          failedStepId: failedStep.id,
          targetStepId: targetStep.id,
          verificationStepId: failedStep.id,
          testSelectors: [],
          artifactTargets: [],
        },
      },
      verificationContract: {
        kind: 'test-gate',
        verificationStepId: failedStep.id,
        verificationStepType: 'UNIT_TEST',
        testSelectors: [],
        artifactTargets: [],
      },
    });

    expect(() => transitionTicket(bug, 'pending')).toThrow(/pendingReason/u);
    const active = transitionTicket(bug, 'in_progress');
    // Resolution says the repair landed; it does not say the repair was verified, because
    // verification is the verdict this state is waiting for.
    expect(() => transitionTicket(active, 'resolved')).toThrow(/requires a solution/u);
    const repaired = {
      ...active,
      solution: {
        status: 'proposed' as const,
        approach: 'Correct the aggregation branch.',
        rationale: 'The branch used the previous value.',
        changes: ['src/aggregate.ts'],
        verification: [],
        updatedAt: '2026-08-01T02:00:00.000Z',
      },
    };
    const resolved = transitionTicket(repaired, 'resolved');
    expect(resolved.state).toBe('resolved');
  });

  it('derives quality from KPI observations instead of accepting a writable score', () => {
    const project = createObjectEnvelope({ name: 'report', objectType: 'project' });
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

describe('a schema field added after objects were persisted', () => {
  // Captured from a live workspace: a Change Request written before `changeKind` existed. Long prose
  // is trimmed; every field is the shape the runtime actually stored.
  const legacyChangeRequest = {
  "id": "01a05c13-6ca0-7218-aeb3-cf545d093282",
  "name": "CR-P1-001",
  "objectType": "ticket",
  "projectId": "01a05bff-e632-7a2e-ae1e-798bae86b6dc",
  "schemaVersion": 1,
  "revision": 12,
  "createdAt": "2026-09-01T08:26:12.000Z",
  "updatedAt": "2026-09-01T08:30:48.711Z",
  "type": "change-request",
  "phaseId": "01a05bff-e634-7a71-8e98-42564b92431a",
  "stepId": "01a05bff-e634-72f7-9625-0407eca704c1",
  "role": "system-engineer",
  "agent": "Architect",
  "creatorActorId": "01a05bff-e633-7478-bb03-0b38b64a6b82",
  "requiredCapabilities": [
    "detailed-design",
    "integration-test-design"
  ],
  "priority": 192,
  "parentTicketId": "01a05bff-e637-7697-8921-2c010c91d051",
  "rootTicketId": "01a05bff-e634-748e-8105-26883513fd3d",
  "description": "Add runtime imports from src/models/news",
  "acceptance": [
    "Paired baseline test contract is incompl",
    "Pass P1-S007."
  ],
  "checkpointIds": [],
  "dependencyTicketIds": [],
  "blockedByTicketIds": [],
  "relatedTicketIds": [
    "01a05c10-e4ed-730c-aa52-8fd2403afa44"
  ],
  "duplicateTicketIds": [],
  "logIds": [
    "01a05c13-6fbc-76bf-ac26-bfb98584880e"
  ],
  "changelistIds": [
    "01a05c17-a573-7993-8c61-2f417ba427a5"
  ],
  "assignmentIds": [
    "01a05c13-6f03-7da7-8687-5e3580918787"
  ],
  "traceFirstEventId": "01a05c13-6cae-7dfc-bde9-fcead3e5d0fa",
  "traceLastEventId": "01a05c17-a587-7d82-aa35-86b0bd1714ee",
  "traceEventCount": 11,
  "traceChainHash": "sha256:8090715be42ad65002fe5fe6cbf777264e415da0b402014dfd7bfda98921cad7",
  "workspaceBinding": {
    "kind": "canonical",
    "relativePath": "worktrees/master",
    "branch": "master",
    "revision": "74287c125dd44792a697eeb47cd8041fa8c95f50",
    "reason": "recovered",
    "boundAt": "2026-09-01T08:26:12.738Z"
  },
  "workspaceBindingHistory": [
    {
      "kind": "ticket",
      "relativePath": "worktrees/tickets/01a05bff-e637-7697-892",
      "branch": "xcompiler/ticket/01a05bff-e637-7697-8921",
      "revision": "9d559975ef8268aff980ec55993f8577aaa7ff12",
      "workspaceId": "01a05c10-e492-79f7-827c-d7d2491715b0",
      "changeSetId": "01a05c10-e493-7c9c-88af-d34ecfc23ed5",
      "reason": "inherited",
      "boundAt": "2026-09-01T08:26:12.000Z"
    },
    {
      "kind": "canonical",
      "relativePath": "worktrees/master",
      "branch": "master",
      "revision": "74287c125dd44792a697eeb47cd8041fa8c95f50",
      "reason": "recovered",
      "boundAt": "2026-09-01T08:26:12.738Z"
    }
  ],
  "baselineRevision": "74287c125dd44792a697eeb47cd8041fa8c95f50",
  "commits": [
    {
      "revision": "74287c125dd44792a697eeb47cd8041fa8c95f50",
      "kind": "baseline",
      "attempt": 1,
      "stepId": "01a05bff-e634-72f7-9625-0407eca704c1",
      "summary": "attempt baseline",
      "recordedAt": "2026-09-01T08:26:12.793Z"
    },
    {
      "revision": "cf6d918ac3df6a6587218dfb96afa8daa2a70ffe",
      "kind": "verified",
      "attempt": 1,
      "stepId": "01a05bff-e634-72f7-9625-0407eca704c1",
      "summary": "verified change",
      "recordedAt": "2026-09-01T08:30:48.680Z"
    }
  ],
  "attempts": 1,
  "maxAttempts": 7,
  "state": "closed",
  "source": {
    "kind": "runtime",
    "correlationId": "01a05bff-e634-748e-8105-26883513fd3d",
    "causationId": "01a05c10-e4ed-730c-aa52-8fd2403afa44"
  },
  "submittedAt": "2026-09-01T08:26:12.000Z",
  "registeredAt": "2026-09-01T08:26:12.014Z",
  "solution": {
    "status": "verified",
    "approach": "Apply the accepted delta from P1-S002 in",
    "rationale": "Add runtime imports from src/models/news",
    "changes": [
      "tests/modules/news.test.ts"
    ],
    "verification": [
      "Paired baseline test contract is incompl",
      "Pass P1-S007."
    ],
    "updatedAt": "2026-09-01T08:30:48.707Z"
  },
  "resolvedAt": "2026-09-01T08:30:48.711Z",
  "closedAt": "2026-09-01T08:30:48.711Z",
  "sourceTicketIds": [
    "01a05c10-e4ed-730c-aa52-8fd2403afa44"
  ],
  "triggerStepId": "01a05bff-e634-7115-a884-1faf3a3f6130",
  "sourceStepId": "01a05bff-e634-7115-a884-1faf3a3f6130",
  "targetStepId": "01a05bff-e634-72f7-9625-0407eca704c1",
  "propagationStepIds": [
    "01a05bff-e634-72f7-9625-0407eca704c1",
    "01a05bff-e634-782b-9ccb-971ffc8cfb52"
  ],
  "originFailures": [],
  "contractDelta": {
    "summary": "Add runtime imports from src/models/news",
    "before": [
      "Paired baseline test contract is incompl"
    ],
    "after": [
      "Paired baseline test contract is incompl",
      "Pass P1-S007."
    ],
    "affectedArtifacts": [
      "tests/modules/news.test.ts"
    ]
  },
  "implementationPlan": [
    "Apply the accepted delta from P1-S002 in",
    "Preserve unrelated accepted artifacts."
  ],
  "verificationGate": [
    "Paired baseline test contract is incompl",
    "Pass P1-S007."
  ],
  "applications": [
    {
      "outcome": "applied",
      "reasonCategory": "contract-applied",
      "rationale": "tests/modules/news.test.ts already impor",
      "inspectedArtifacts": [
        "tests/modules/news.test.ts"
      ],
      "evidence": [
        "File imports validateNewsItem, createNew",
        "Runtime assertions call isValidSource('b"
      ],
      "stepId": "01a05bff-e634-72f7-9625-0407eca704c1",
      "changelistId": "01a05c17-a573-7993-8c61-2f417ba427a5",
      "verificationAssessmentId": "01a05c17-a4bb-7bd8-b21f-1fecd99c8e20",
      "appliedAt": "2026-09-01T08:30:48.691Z"
    }
  ]
};

  it('reads a Change Request written before changeKind existed', async () => {
    // Adding a required field to a persisted schema invalidates every workspace that predates it,
    // and the refusal arrives as an unhandled error at startup — indistinguishable from corruption.
    // Absence means "written by an older build", and those Tickets were corrective.
    const { TicketSchema } = await import('../src/domain/tickets/ticket.js');
    const parsed = TicketSchema.parse(legacyChangeRequest);
    expect(parsed.type).toBe('change-request');
    expect((parsed as { changeKind?: string }).changeKind).toBe('corrective');
  });
});
