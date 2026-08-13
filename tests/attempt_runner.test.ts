import { describe, expect, it } from 'vitest';
import {
  reconcileMeasuredQualityAssessment,
  reconcileDeferredSourceQualityAssessment,
  prioritizeAttemptFailureEvidence,
  renderAttemptRetryFeedback,
  renderExecutorFailure,
  resolveAttemptRoundLimit,
  selectActionableAttemptFailure,
  resolveAttemptTestArgs,
  resolveAttemptVerificationScope,
  resolveBaselineGateExecution,
  shouldPreserveFailedCandidate,
  shouldPreserveExistingFiles,
  deliveredManifest,
  isAttemptCancellation,
} from '../src/application/execution/attempt_runner.js';
import type { DomainLog } from '../src/domain/observability/records.js';
import { classifyAttemptFailure, classifyFailure } from '../src/application/execution/failure_classification.js';
import type { Plan, Step } from '../src/core/plan.js';
import type { Ticket } from '../src/domain/tickets/ticket.js';

describe('attempt verification scope', () => {
  it('reruns the source baseline gate when a verification Bug returns upstream', () => {
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
      testArgs: ['tests/unit/core.test.ts'],
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

  it('defers only the executable baseline on an initial S1-S3 pass', () => {
    const plan = fixturePlan();
    const design = {
      ...plan.steps[0]!,
      id: 'design-id',
      phase: 'HIGH_LEVEL_DESIGN' as const,
      outputs: ['docs/02-high-level-design.md', 'tests/module/core.test.ts'],
    };
    plan.steps.unshift(design);

    expect(resolveBaselineGateExecution(
      plan,
      design,
      { type: 'task' } as Ticket,
    )).toEqual({ mode: 'defer', reason: 'initial-pre-code' });
  });

  it('executes an S1-S3 baseline when the correction originated at S4 or later', () => {
    const plan = fixturePlan();
    const design = {
      ...plan.steps[0]!,
      id: 'design-id',
      phase: 'HIGH_LEVEL_DESIGN' as const,
      outputs: ['docs/02-high-level-design.md', 'tests/module/core.test.ts'],
    };
    plan.steps.unshift(design);
    const ticket = {
      type: 'bug',
      failure: {
        failedStepId: 'code-id',
        failedStepType: 'CODE',
        targetStepId: 'design-id',
        verificationStepId: 'unit-id',
      },
    } as Ticket;

    expect(resolveBaselineGateExecution(plan, design, ticket)).toEqual({
      mode: 'execute',
      reason: 'post-code-correction',
      originStepId: 'code-id',
      originPhase: 'CODE',
    });
  });

  it('keeps a pre-CODE corrective retry deferred until a code baseline exists', () => {
    const plan = fixturePlan();
    const requirement = {
      ...plan.steps[0]!,
      id: 'requirement-id',
      phase: 'REQUIREMENT_ANALYSIS' as const,
      outputs: ['docs/01-requirement-analysis.md', 'tests/functional/core.test.ts'],
    };
    const design = {
      ...plan.steps[0]!,
      id: 'design-id',
      phase: 'HIGH_LEVEL_DESIGN' as const,
      outputs: ['docs/02-high-level-design.md', 'tests/module/core.test.ts'],
    };
    plan.steps.unshift(requirement, design);

    expect(resolveBaselineGateExecution(plan, requirement, {
      type: 'enhancement',
      stepId: 'design-id',
      targetStepId: 'requirement-id',
      verificationStepId: 'unit-id',
    } as Ticket)).toEqual({
      mode: 'defer',
      reason: 'pre-code-correction',
      originStepId: 'design-id',
      originPhase: 'HIGH_LEVEL_DESIGN',
    });
  });

  it('executes an S1-S3 baseline for an Enhancement discovered by a right-side Step', () => {
    const plan = fixturePlan();
    const design = {
      ...plan.steps[0]!,
      id: 'design-id',
      phase: 'HIGH_LEVEL_DESIGN' as const,
      outputs: ['docs/02-high-level-design.md', 'tests/module/core.test.ts'],
    };
    plan.steps.unshift(design);

    expect(resolveBaselineGateExecution(plan, design, {
      type: 'enhancement',
      stepId: 'unit-id',
      targetStepId: 'design-id',
      verificationStepId: 'unit-id',
    } as Ticket)).toEqual({
      mode: 'execute',
      reason: 'post-code-correction',
      originStepId: 'unit-id',
      originPhase: 'UNIT_TEST',
    });
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

  it('only reads provider phrasing out of text the runtime authored', () => {
    // XCompiler can be asked to build an LLM application; its test output legitimately contains
    // this phrasing. Trusting captured output would retry forever instead of opening a Bug, so
    // provider-text matching is opt-in and every un-annotated string stays an execution failure.
    const subjectOutput = 'FAIL tests/router.spec.ts\n  Error: all LLM providers failed for role Tester';
    expect(classifyFailure(subjectOutput).kind).toBe('execution');
    expect(classifyFailure(subjectOutput, { trustProviderText: true }).kind).toBe('infrastructure');
  });

  it('classifies model no-progress loops as agent stalls rather than project defects', () => {
    expect(classifyFailure(
      'repeated read-only/probe actions without progress for 3 rounds',
    )).toMatchObject({
      kind: 'execution',
      category: 'internal',
      code: 'agent_execution_stalled',
      retryable: true,
      switchProvider: true,
    });
  });
});

describe('attempt cancellation detection', () => {
  it('separates terminal SIGINT and Runtime aborts from project defects', () => {
    const promptExit = new Error('User force closed the prompt with SIGINT');
    promptExit.name = 'ExitPromptError';
    expect(isAttemptCancellation(promptExit)).toBe(true);

    const controller = new AbortController();
    controller.abort(new Error('ACP task cancelled by client'));
    expect(isAttemptCancellation(new Error('provider stopped'), controller.signal)).toBe(true);
    expect(isAttemptCancellation(new Error('generated project test failed'))).toBe(false);
  });
});

describe('attempt retry feedback', () => {
  it('persists bounded test output instead of replacing it with the short tool error', () => {
    const failure = renderExecutorFailure({
      success: false,
      rounds: 1,
      finalThought: 'module verification failed',
      error: 'validation defect reported: module contract failed',
      metrics: {
        rounds: 1,
        parseFailures: 0,
        repeatedTurns: 0,
        toolFailRatio: 1,
        progressRatio: 1,
        healthScore: 0,
        providers: [],
      },
      toolCalls: [{
        tool: 'run_tests',
        ok: false,
        error: 'npm test exit=1',
        summary: 'npm test exit=1\nFAIL tests/modules/scrapers.test.ts\nAssertionError: invalid matcher',
      }],
    });

    expect(failure).toContain('FAIL tests/modules/scrapers.test.ts');
    expect(failure).toContain('AssertionError: invalid matcher');
  });

  it('passes compact actionable failure from a rolled-back non-progress attempt', () => {
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

  it('explains when a failed candidate was preserved for incremental correction', () => {
    const feedback = renderAttemptRetryFeedback({
      message: 'Quality gate failed',
      data: {
        workspaceDisposition: 'candidate-preserved',
        failureLog: 'paired baseline test contract is incomplete',
        structuredFailure: { kind: 'execution', category: 'quality' },
      },
    } as unknown as DomainLog, 'REQUIREMENT_ANALYSIS');

    expect(feedback).toContain('candidate files were committed and preserved');
    expect(feedback).toContain('Inspect and patch the preserved candidate');
  });

  it('places the latest rolled-back failure before the original Bug context', () => {
    const evidence = prioritizeAttemptFailureEvidence(
      'Original failure: runPipeline is not a function',
      'Latest failure: expected zhihu to be baidu after the interface repair',
    );

    expect(evidence.indexOf('Latest failure')).toBeLessThan(evidence.indexOf('Original failure'));
    expect(evidence).toContain('## original bug context');
  });

  it('uses the persisted failure category instead of reclassifying provider wording', () => {
    const feedback = renderAttemptRetryFeedback({
      message: 'all LLM providers failed after a low-quality response',
      data: {
        structuredFailure: {
          kind: 'execution',
          category: 'test',
          code: 'test_command_failed',
        },
        failureLog: [
          'run_tests: npm test exit=1 args=tests/integration/pipeline.test.ts',
          "AssertionError: expected 'zhihu' to be 'baidu'",
        ].join('\n'),
      },
    } as unknown as DomainLog, 'DETAILED_DESIGN');

    expect(feedback).toContain('category: test_failure');
    expect(feedback).toContain("expected 'zhihu' to be 'baidu'");
    expect(feedback).not.toContain('This is LLM provider/context infrastructure');
  });

  it('prefers the latest project failure over a newer provider-only retry failure', () => {
    const projectFailure = {
      id: 'project-failure',
      data: { structuredFailure: { kind: 'execution', category: 'test' } },
    } as unknown as DomainLog;
    const providerFailure = {
      id: 'provider-failure',
      data: { structuredFailure: { kind: 'infrastructure', category: 'llm-provider' } },
    } as unknown as DomainLog;

    expect(selectActionableAttemptFailure([projectFailure, providerFailure]))
      .toBe(projectFailure);
  });
});

describe('failed candidate persistence', () => {
  it('preserves project defects and rolls back infrastructure, dependency, and agent stalls', () => {
    expect(shouldPreserveFailedCandidate({
      kind: 'execution', category: 'quality', code: 'quality_gate_failed',
      message: 'quality failed', retryable: true, switchProvider: false,
    })).toBe(true);
    expect(shouldPreserveFailedCandidate({
      kind: 'execution', category: 'test', code: 'test_command_failed',
      message: 'test failed', retryable: true, switchProvider: false,
    })).toBe(true);
    expect(shouldPreserveFailedCandidate({
      kind: 'infrastructure', category: 'llm-provider', code: 'provider_failed',
      message: 'provider failed', retryable: true, switchProvider: true,
    })).toBe(false);
    expect(shouldPreserveFailedCandidate({
      kind: 'execution', category: 'internal', code: 'agent_execution_stalled',
      message: 'no progress', retryable: true, switchProvider: true,
    })).toBe(false);
    expect(shouldPreserveFailedCandidate({
      kind: 'execution', category: 'tool', code: 'dependency_not_owned',
      message: 'manifest owner required', retryable: true, switchProvider: false,
    }, true)).toBe(false);
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

describe('attempt mutation policy', () => {
  it('preserves accepted files for every corrective Ticket mode', () => {
    expect(shouldPreserveExistingFiles('normal')).toBe(false);
    expect(shouldPreserveExistingFiles('debug')).toBe(true);
    expect(shouldPreserveExistingFiles('enhancement')).toBe(true);
    expect(shouldPreserveExistingFiles('change-request')).toBe(true);
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

describe('deferred source quality evidence', () => {
  it('hands a measured coverage gap back to the paired unit-test gate after a real source delta', () => {
    const result = reconcileDeferredSourceQualityAssessment({
      completion: 1,
      upstreamAlignment: 1,
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['focused unit tests added'],
      unavailableMetrics: ['lineCoverage', 'branchCoverage'],
      gaps: ['CODE cannot execute the coverage command'],
      blockedBy: ['UNIT_TEST must measure the new tests'],
    }, {
      currentPhase: 'CODE',
      deferredToChangeRequest: true,
      verificationPhase: 'UNIT_TEST',
      changedFiles: ['tests/unit/core.test.ts'],
    });

    expect(result?.gaps).toEqual([]);
    expect(result?.blockedBy).toContain('deferred to UNIT_TEST: CODE cannot execute the coverage command');
  });

  it('keeps gaps when no source delta was produced or the metric does not belong downstream', () => {
    const assessment = {
      completion: 1,
      upstreamAlignment: 1,
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['inspection only'],
      unavailableMetrics: ['unrelatedMetric'],
      gaps: ['implementation is incomplete'],
      blockedBy: ['UNIT_TEST is pending'],
    };
    expect(reconcileDeferredSourceQualityAssessment(assessment, {
      currentPhase: 'CODE',
      deferredToChangeRequest: true,
      verificationPhase: 'UNIT_TEST',
      changedFiles: [],
    })?.gaps).toEqual(['implementation is incomplete']);
    expect(reconcileDeferredSourceQualityAssessment(assessment, {
      currentPhase: 'CODE',
      deferredToChangeRequest: true,
      verificationPhase: 'UNIT_TEST',
      changedFiles: ['tests/unit/core.test.ts'],
    })?.gaps).toEqual(['implementation is incomplete']);
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
    failure: {
      ...ids,
      failedStepType: ids.failedStepId === 'unit-id' ? 'UNIT_TEST' : 'CODE',
      targetStepType: 'CODE',
      verificationStepType: 'UNIT_TEST',
    },
  } as unknown as Ticket;
}

describe('manifest delivery', () => {
  it('recognises the manifest wherever it sits, and nothing merely named like it', () => {
    // Writing package.json as a plain file output changes nothing about the sandbox on its own, so
    // the runner rebuilds when it sees one delivered. A false positive would rebuild an environment
    // nobody asked to change.
    expect(deliveredManifest(['package.json'], 'package.json')).toBe(true);
    expect(deliveredManifest(['packages/api/package.json'], 'package.json')).toBe(true);
    expect(deliveredManifest(['requirements.txt'], 'requirements.txt')).toBe(true);

    expect(deliveredManifest(['vendor-package.json'], 'package.json')).toBe(false);
    expect(deliveredManifest(['package.json.bak'], 'package.json')).toBe(false);
    expect(deliveredManifest(['src/main.ts', 'docs/02.md'], 'package.json')).toBe(false);
    expect(deliveredManifest([], 'package.json')).toBe(false);
  });
});

describe('quality gaps a Step does not own', () => {
  const assessment = (gaps: string[]) => ({
    completeness: 1, upstreamAlignment: 1, coverage: 1, metrics: {}, evidence: [], gaps,
  }) as never;

  // Both codes name a condition the Step does not own. REQUIREMENT_ANALYSIS runs before
  // HIGH_LEVEL_DESIGN writes package.json; every design phase runs before CODE writes the sources
  // its tsconfig points at. Reporting either accurately cost the Step an attempt, because the gate
  // fails a Step for every gap it reports.
  it.each([
    ['manifest_missing', 'package.json does not exist; it is HIGH_LEVEL_DESIGN output'],
    ['product_not_implemented', 'src/ does not exist; it is CODE output'],
  ] as const)('drops gaps raised by a condition the Step cannot own (%s)', (code, gap) => {
    const blocked = reconcileMeasuredQualityAssessment(
      assessment([gap]),
      [{ tool: 'run_tests', ok: false, code }],
    );
    expect(blocked?.gaps).toEqual([]);
  });

  it('keeps gaps when the Step could have acted on them', () => {
    const real = reconcileMeasuredQualityAssessment(
      assessment(['the renderer has no tests']),
      [{ tool: 'run_tests', ok: false, error: '1 failing' }],
    );
    expect(real?.gaps).toEqual(['the renderer has no tests']);
  });
});
