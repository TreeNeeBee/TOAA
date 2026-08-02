import { describe, expect, it } from 'vitest';
import {
  reconcileMeasuredQualityAssessment,
  renderAttemptRetryFeedback,
  resolveAttemptRoundLimit,
  resolveAttemptTestArgs,
  resolveAttemptVerificationScope,
} from '../src/application/execution/attempt_runner.js';
import type { DomainLog } from '../src/domain/observability/records.js';
import { classifyAttemptFailure } from '../src/application/execution/failure_classification.js';
import type { Plan, Step } from '../src/core/plan.js';
import type { Ticket } from '../src/domain/tickets/ticket.js';

describe('attempt verification scope', () => {
  it('inherits only the paired test gate when a verification Bug returns to its source Step', () => {
    const plan = fixturePlan();
    const code = plan.steps[0]!;
    const ticket = bugTicket({
      failedStepId: 'unit-id',
      targetStepId: 'code-id',
      verificationStepId: 'unit-id',
    });

    expect(resolveAttemptVerificationScope(plan, code, ticket)).toEqual({
      testArgs: ['tests/unit/core.test.ts'],
      inheritedFromTicket: true,
      verificationStepId: 'unit-id',
      verificationPhase: 'UNIT_TEST',
    });
  });

  it('does not borrow a future test gate for a failure originating in the source Step itself', () => {
    const plan = fixturePlan();
    const code = plan.steps[0]!;
    const ticket = bugTicket({
      failedStepId: 'code-id',
      targetStepId: 'code-id',
      verificationStepId: 'unit-id',
    });

    expect(resolveAttemptVerificationScope(plan, code, ticket)).toEqual({
      testArgs: [],
      inheritedFromTicket: false,
      verificationStepId: undefined,
      verificationPhase: undefined,
    });
  });

  it('enables deterministic Vitest coverage collection for the unit-test gate', () => {
    expect(resolveAttemptTestArgs({
      testArgs: ['tests/unit/core.test.ts'],
      inheritedFromTicket: false,
      verificationStepId: 'unit-id',
      verificationPhase: 'UNIT_TEST',
    }, 'typescript')).toEqual(['tests/unit/core.test.ts', '--coverage']);
    expect(resolveAttemptTestArgs({
      testArgs: ['tests/integration/core.test.ts'],
      inheritedFromTicket: false,
      verificationStepId: 'integration-id',
      verificationPhase: 'INTEGRATION_TEST',
    }, 'typescript')).toEqual(['tests/integration/core.test.ts']);
  });
});

describe('attempt failure classification', () => {
  it('separates LLM provider failures from generated-project execution failures', () => {
    expect(classifyAttemptFailure(
      'all LLM providers failed for role Tester: OpenAI-compatible provider request failed status=429',
    )).toBe('infrastructure');
    expect(classifyAttemptFailure('OpenAI stream idle before first token for 60000ms; aborting'))
      .toBe('infrastructure');
    expect(classifyAttemptFailure('run_tests failed: external news API returned HTTP 429'))
      .toBe('execution');
  });
});

describe('attempt retry feedback', () => {
  it('passes a compact actionable failure from a rolled-back Ticket attempt', () => {
    const feedback = renderAttemptRetryFeedback({
      message: 'Step executor reached max rounds',
      data: {
        failureLog: [
          'run_tests: npm test exit=1',
          'FAIL tests/unit/rss.spec.ts > retries after a parse error',
          "TypeError: Cannot read properties of undefined (reading 'prototype')",
        ].join('\n'),
      },
    } as unknown as DomainLog, 'CODE');

    expect(feedback).toContain('latest failed attempt');
    expect(feedback).toContain('file changes were rolled back');
    expect(feedback).toContain('tests/unit/rss.spec.ts');
    expect(feedback).toContain("Cannot read properties of undefined");
  });
});

describe('attempt round limits', () => {
  it('gives every corrective Ticket a larger derived completion window', () => {
    expect(resolveAttemptRoundLimit('normal', 6)).toBe(6);
    expect(resolveAttemptRoundLimit('debug', 6)).toBe(9);
    expect(resolveAttemptRoundLimit('enhancement', 8)).toBe(12);
    expect(resolveAttemptRoundLimit('change-request', 6, 14)).toBe(14);
  });
});

describe('measured test quality evidence', () => {
  it('overrides model-reported unit metrics with run_tests measurements', () => {
    const result = reconcileMeasuredQualityAssessment({
      metrics: { lineCoverage: 0.9, branchCoverage: 0.9, testCasePassRate: 0.5 },
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['model report'],
      gaps: [],
    }, [{
      tool: 'run_tests',
      ok: true,
      summary: [
        'npm test exit=0 args=tests/unit/core.test.ts --coverage',
        'Tests 5 passed (5)',
        'coverage statements=35.12% branches=86.66% functions=77.77% lines=35.12%',
        'low-coverage files: src/cli.ts=0%, src/adapters/rss-adapter.ts=0%',
      ].join('\n'),
    }]);
    expect(result?.metrics.lineCoverage).toBeCloseTo(0.3512);
    expect(result?.metrics.branchCoverage).toBeCloseTo(0.8666);
    expect(result?.metrics.testCasePassRate).toBe(1);
    expect(result?.evidence.at(-1)).toContain('src/cli.ts=0%');
  });
});

function fixturePlan(): Plan {
  const code: Step = {
    id: 'code-id', iterationId: 'P1', phase: 'CODE', title: 'Code', description: 'Implement.',
    systemPrompt: 'Implement.', role: 'Coder', tools: ['write_file'], inputs: ['docs/design.md'],
    outputs: ['src/core.ts', 'tests/unit/core.test.ts'], dependsOn: [], acceptance: 'implemented', maxAttempts: 3,
  };
  const unit: Step = {
    id: 'unit-id', iterationId: 'P1', phase: 'UNIT_TEST', title: 'Unit', description: 'Verify.',
    systemPrompt: 'Verify.', role: 'Tester', tools: ['run_tests'], inputs: ['tests/unit/core.test.ts'],
    outputs: ['reports/unit.md'], dependsOn: ['code-id'], acceptance: 'tests pass', maxAttempts: 3,
  };
  return {
    version: '1', language: 'typescript', intent: 'greenfield', phaseId: 'P1', projectType: 'application',
    requirementDigest: 'fixture',
    complexityAssessment: {
      level: 'simple', rationale: 'fixture', splitRecommended: false, userForcedPhaseSplit: false,
    },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Core', status: 'current', scope: ['core'],
      deliverables: ['src/core.ts'], dependsOn: [],
    }],
    architectureModules: [], globalPrompt: '', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date(0).toISOString(), steps: [code, unit],
  };
}

function bugTicket(ids: {
  failedStepId: string;
  targetStepId: string;
  verificationStepId: string;
}): Ticket {
  return {
    type: 'bug',
    failure: ids,
  } as unknown as Ticket;
}
