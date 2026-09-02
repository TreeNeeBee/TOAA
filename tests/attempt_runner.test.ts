import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderDebugBriefForPrompt } from '../src/core/debug_brief.js';
import {
  reconcileMeasuredQualityAssessment,
  reconcileDeferredSourceQualityAssessment,
  prioritizeAttemptFailureEvidence,
  renderAttemptRetryFeedback,
  renderExecutorFailure,
  renderQualityAssessmentFailure,
  resolveAttemptRoundLimit,
  selectActionableAttemptFailure,
  resolveAttemptTestArgs,
  resolveAttemptVerificationScope,
  resolveBaselineGateExecution,
  sandboxPreparationFailure,
  shouldPreserveFailedCandidate,
  shouldPreserveExistingFiles,
  deliveredManifest,
  isAttemptCancellation,
  DomainAttemptRunner,
  type AttemptInput,
  ticketContextSnapshot,
  advisoryFailuresForStage,
} from '../src/application/execution/attempt_runner.js';
import type { DomainLog } from '../src/domain/observability/records.js';
import { classifyAttemptFailure, classifyFailure } from '../src/application/execution/failure_classification.js';
import type { Plan, Step } from '../src/core/plan.js';
import type { Ticket } from '../src/domain/tickets/ticket.js';
import { getLanguageProfile } from '../src/core/language.js';
import { computeIncrementalAllowedWrites } from '../src/application/execution/execution_context.js';
import { Workspace } from '../src/workspace/workspace.js';

describe('corrective write scope', () => {
  it('limits a focused Enhancement to its structured affected test artifact', () => {
    const plan = fixturePlan();
    const design = {
      ...plan.steps[0]!,
      phase: 'HIGH_LEVEL_DESIGN' as const,
      outputs: [
        'docs/02-high-level-design.md',
        'package.json',
        'tests/modules/domain.test.ts',
      ],
    };
    const allowed = computeIncrementalAllowedWrites(
      plan,
      design,
      getLanguageProfile('typescript'),
      {
        type: 'enhancement',
        affectedArtifacts: ['tests/modules/domain.test.ts'],
      } as Ticket,
    );

    // Narrowing is the point: the named artifact, and none of the Step's unrelated deliverables.
    expect(allowed).toContain('tests/modules/domain.test.ts');
    expect(allowed).not.toContain('package.json');
    expect(allowed).not.toContain('docs/02-high-level-design.md');
    // The fixture directory rides along because the named artifact is a test, and a test that cannot
    // write the data it reads cannot be repaired. Everything else stays out.
    expect(allowed.filter((path) => !path.startsWith('tests/'))).toEqual([]);
  });

  // An artifact list naming nothing this Step owns narrows the allowlist to nothing, and a Step
  // that may write no file cannot act on any instruction it is given — it spends its whole round
  // budget reporting that. A live Enhancement raised at UNIT_TEST carried that Step's own documents
  // and was routed to CODE, which owns none of them; the Change Request branch beside it already
  // had this floor.
  it('falls back to the Step outputs when an Enhancement names nothing it owns', () => {
    const plan = fixturePlan();
    const coding = {
      ...plan.steps[0]!,
      phase: 'CODE' as const,
      outputs: ['src/cli.ts', 'src/upstream/primary.ts'],
    };

    const allowed = computeIncrementalAllowedWrites(
      plan,
      coding,
      getLanguageProfile('typescript'),
      {
        type: 'enhancement',
        affectedArtifacts: ['docs/05-unit-test.md', 'docs/reports/unit-test-report.md'],
      } as Ticket,
    );

    expect(allowed).not.toEqual([]);
    expect(allowed).toEqual(expect.arrayContaining(['src/cli.ts', 'src/upstream/primary.ts']));
    // The floor is the Step's own outputs, never the artifacts it does not own.
    expect(allowed).not.toContain('docs/05-unit-test.md');
  });

  it('keeps a downstream CR inside the current Step outputs when its delta is upstream-owned', () => {
    const plan = fixturePlan();
    const detail = {
      ...plan.steps[0]!,
      phase: 'DETAILED_DESIGN' as const,
      outputs: ['docs/03-detailed-design.md', 'tests/integration/contracts.test.ts'],
    };
    const allowed = computeIncrementalAllowedWrites(
      plan,
      detail,
      getLanguageProfile('typescript'),
      {
        type: 'change-request',
        contractDelta: { affectedArtifacts: ['docs/02-high-level-design.md'] },
      } as Ticket,
    );
    expect(allowed).toEqual(expect.arrayContaining(detail.outputs));
    expect(allowed).not.toContain('package.json');
  });
});

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

describe('quality failure evidence', () => {
  it('preserves finding details when a failed assessment has no KPI gaps', () => {
    const rendered = renderQualityAssessmentFailure({
      gaps: [],
      findings: [{
        category: 'test-incomplete',
        code: 'acceptance_product_import_missing',
        summary: 'tests/acceptance.test.ts does not import src/main.ts',
        evidence: [
          'exercises 0/1 required product sources',
          'Import and exercise the planned product entrypoint before CODE.',
        ],
        target: 'current-step',
        dependencyPackages: [],
      }],
    });

    expect(rendered.summary).toContain('tests/acceptance.test.ts');
    expect(rendered.detail).toContain('exercises 0/1 required product sources');
    expect(rendered.detail).toContain('Import and exercise the planned product entrypoint');
  });

  it('uses a non-empty fallback when an invalid failed assessment carries no evidence', () => {
    const rendered = renderQualityAssessmentFailure({ gaps: [], findings: [] });
    expect(rendered.summary).not.toBe('');
    expect(rendered.detail).toBe(rendered.summary);
  });
});

describe('attempt failure classification', () => {
  it('keeps sandbox preparation outside generated-project defect routing', () => {
    expect(sandboxPreparationFailure('P1-S004', 'npm install timed out')).toEqual({
      kind: 'infrastructure',
      category: 'internal',
      code: 'sandbox_not_ready',
      message: 'sandbox is not ready for P1-S004: npm install timed out',
      retryable: true,
      switchProvider: false,
    });
  });

  it('separates LLM provider failures from generated-project execution failures', () => {
    expect(classifyAttemptFailure(
      'all LLM providers failed for role Tester: OpenAI-compatible provider request failed status=429',
    )).toBe('infrastructure');
    expect(classifyAttemptFailure('OpenAI stream idle before first token for 60000ms; aborting'))
      .toBe('infrastructure');
    expect(classifyAttemptFailure('run_tests failed: external upstream API returned HTTP 429'))
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
        summary: 'npm test exit=1\nFAIL tests/modules/upstream.test.ts\nAssertionError: invalid matcher',
      }],
    });

    expect(failure).toContain('FAIL tests/modules/upstream.test.ts');
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
      'Latest failure: expected secondary to be primary after the interface repair',
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
          "AssertionError: expected 'secondary' to be 'primary'",
        ].join('\n'),
      },
    } as unknown as DomainLog, 'DETAILED_DESIGN');

    expect(feedback).toContain('category: test_failure');
    expect(feedback).toContain("expected 'secondary' to be 'primary'");
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

  it('measures module and contract coverage from validated selectors actually executed by Runtime', () => {
    const result = reconcileMeasuredQualityAssessment({
      metrics: { moduleCoverage: 0.2, contractCoverage: 0.1 },
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['model could not collect V8 coverage'],
      unavailableMetrics: ['moduleCoverage', 'contractCoverage'],
      gaps: [],
      blockedBy: ['coverage provider unavailable'],
    }, [{
      tool: 'run_tests',
      ok: true,
      summary: 'npm test exit=0\nTests 8 passed (8)',
      data: {
        effectiveArgs: ['tests/modules/a.test.ts', 'tests/modules/b.test.ts'],
      },
    }], {
      phase: 'MODULE_TEST',
      architectureModules: [
        {
          id: 'M001', name: 'A', responsibility: 'Owns the first product module.',
          sourcePaths: ['src/a.ts'], testPaths: ['tests/modules/a.test.ts'], dependencies: [],
        },
        {
          id: 'M002', name: 'B', responsibility: 'Owns the second product module.',
          sourcePaths: ['src/b.ts'], testPaths: ['tests/modules/b.test.ts'], dependencies: [],
        },
      ],
      baselineTestPaths: ['tests/modules/a.test.ts', 'tests/modules/b.test.ts'],
      supplementalTestPaths: [],
      sourceContracts: [{
        ok: true,
        testPaths: ['tests/modules/a.test.ts', 'tests/modules/b.test.ts'],
        valid: ['tests/modules/a.test.ts', 'tests/modules/b.test.ts'],
        invalid: [],
        references: {
          'tests/modules/a.test.ts': ['src/a.ts'],
          'tests/modules/b.test.ts': ['src/b.ts'],
        },
      }],
    });

    expect(result?.metrics).toMatchObject({
      moduleCoverage: 1,
      contractCoverage: 1,
      testCasePassRate: 1,
    });
    expect(result?.unavailableMetrics).toEqual([]);
  });

  it('does not credit a declared module contract that was not in the successful frozen run', () => {
    const result = reconcileMeasuredQualityAssessment({
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['frozen suite'], unavailableMetrics: [], gaps: [], blockedBy: [],
    }, [{
      tool: 'run_tests', ok: true, summary: 'Tests 4 passed (4)',
      data: { effectiveArgs: ['tests/modules/a.test.ts'] },
    }], {
      phase: 'MODULE_TEST',
      architectureModules: [
        {
          id: 'M001', name: 'A', responsibility: 'Owns the first product module.',
          sourcePaths: ['src/a.ts'], testPaths: ['tests/modules/a.test.ts'], dependencies: [],
        },
        {
          id: 'M002', name: 'B', responsibility: 'Owns the second product module.',
          sourcePaths: ['src/b.ts'], testPaths: ['tests/modules/b.test.ts'], dependencies: [],
        },
      ],
      baselineTestPaths: ['tests/modules/a.test.ts', 'tests/modules/b.test.ts'],
      supplementalTestPaths: [],
      sourceContracts: [{
        ok: true,
        testPaths: ['tests/modules/a.test.ts', 'tests/modules/b.test.ts'],
        valid: ['tests/modules/a.test.ts', 'tests/modules/b.test.ts'],
        invalid: [],
        references: {},
      }],
    });

    expect(result?.metrics.moduleCoverage).toBe(0.5);
    expect(result?.metrics.contractCoverage).toBe(0.5);
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

  it('rejects an accepted invalid manifest before invoking another Step role', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-attempt-contract-'));
    const workspace = new Workspace(tmp);
    await workspace.writeFile('package.json', JSON.stringify({
      scripts: { test: 'vitest run --exclude tests/functional.test.ts' },
    }));
    const runner = contractRunner(workspace);
    let assembled = false;
    (runner as unknown as { assembleContext: () => Promise<never> }).assembleContext = async () => {
      assembled = true;
      throw new Error('the role must not be invoked');
    };

    const result = await runner.run(contractAttempt('REQUIREMENT_ANALYSIS'));

    expect(assembled).toBe(false);
    expect(result.gateFindings).toEqual([
      expect.objectContaining({
        code: 'language_test_entrypoint_contract_invalid',
        target: 'high-level-design',
      }),
    ]);
  });

  it('lets the owning corrective Step enter before enforcing the contract again on delivery', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-attempt-contract-'));
    const workspace = new Workspace(tmp);
    await workspace.writeFile('package.json', JSON.stringify({
      scripts: { test: 'vitest run --exclude tests/functional.test.ts' },
    }));
    const runner = contractRunner(workspace);
    let assembled = false;
    (runner as unknown as { assembleContext: () => Promise<never> }).assembleContext = async () => {
      assembled = true;
      throw new Error('stop after proving the corrective role was entered');
    };
    const input = contractAttempt('HIGH_LEVEL_DESIGN');
    input.mode = 'enhancement';
    input.ticket = {
      ...input.ticket,
      type: 'enhancement',
      targetStepId: input.domainStep.id,
    } as Ticket;

    await runner.run(input);

    expect(assembled).toBe(true);
  });

  it('still rejects a corrective Step that does not own the invalid contract', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-attempt-contract-'));
    const workspace = new Workspace(tmp);
    await workspace.writeFile('package.json', JSON.stringify({
      scripts: { test: 'vitest run --exclude tests/functional.test.ts' },
    }));
    const runner = contractRunner(workspace);
    let assembled = false;
    (runner as unknown as { assembleContext: () => Promise<never> }).assembleContext = async () => {
      assembled = true;
      throw new Error('the unrelated corrective role must not be invoked');
    };
    const input = contractAttempt('DETAILED_DESIGN');
    input.mode = 'enhancement';
    input.ticket = {
      ...input.ticket,
      type: 'enhancement',
      targetStepId: input.domainStep.id,
    } as Ticket;

    const result = await runner.run(input);

    expect(assembled).toBe(false);
    expect(result.gateFindings?.[0]?.target).toBe('high-level-design');
  });

  it('rejects an invalid manifest written by HIGH_LEVEL_DESIGN before delivery', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-attempt-contract-'));
    const workspace = new Workspace(tmp);
    const runner = contractRunner(workspace);
    (runner as unknown as { assembleContext: () => Promise<unknown> }).assembleContext = async () => ({
      assembled: { text: '', debugWikiMatches: [] },
      debugBrief: undefined,
    });
    (runner as unknown as { buildEnvironment: () => Promise<unknown> }).buildEnvironment = async () => ({
      baselineGateExecution: { mode: 'defer', reason: 'initial-pre-code' },
      verificationScope: { testArgs: ['tests/module.test.ts'], inheritedFromTicket: false },
      tools: [], context: {}, snippets: [], hints: [],
      executor: {
        run: async () => {
          await workspace.writeFile('package.json', JSON.stringify({
            scripts: { test: 'vitest run --exclude tests/functional.test.ts' },
          }));
          return {
            success: true,
            rounds: 1,
            toolCalls: [],
            qualityAssessment: {
              metrics: {}, tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
              evidence: [], gaps: [],
            },
            metrics: {
              rounds: 1, parseFailures: 0, repeatedTurns: 0, toolFailRatio: 0,
              progressRatio: 1, healthScore: 1, providers: [],
            },
          };
        },
      },
    });

    const result = await runner.run(contractAttempt('HIGH_LEVEL_DESIGN'));

    expect(result.gateFindings?.[0]).toMatchObject({
      code: 'language_test_entrypoint_contract_invalid',
      target: 'high-level-design',
      affectedArtifacts: ['package.json'],
    });
  });
});

function contractRunner(workspace: Workspace): DomainAttemptRunner {
  const runner = new DomainAttemptRunner({
    workspace,
    git: {
      ensureRepo: async () => {},
      raw: () => ({
        status: async () => ({ isClean: () => true, files: [] }),
        revparse: async () => 'a'.repeat(40),
      }),
    },
    sandbox: {}, router: {}, repository: {}, audit: { event: async () => {} },
    plugins: { size: 0 }, debugWikiPath: '/tmp/xcompiler-attempt-contract-wiki',
  } as never, 'typescript');
  (runner as unknown as { recordTicketRevision: () => Promise<void> }).recordTicketRevision = async () => {};
  (runner as unknown as {
    failAttempt: (
      _scope: unknown,
      _baseline: string,
      _input: unknown,
      failure: Record<string, unknown>,
    ) => Promise<unknown>;
  }).failAttempt = async (_scope, _baseline, _input, failure) => ({
    ok: false,
    changedFiles: [],
    wikiEntryIds: [],
    testOutcomes: [],
    ...failure,
  });
  return runner;
}

function contractAttempt(phase: Step['phase']): AttemptInput {
  const step = {
    id: phase === 'HIGH_LEVEL_DESIGN' ? 'design-id' : 'requirement-id',
    iterationId: 'P1',
    phase,
    title: phase,
    description: 'Validate the project contract.',
    systemPrompt: 'Validate the project contract.',
    role: phase === 'HIGH_LEVEL_DESIGN' ? 'Architect' : 'Planner',
    tools: ['write_file'],
    inputs: [],
    outputs: phase === 'HIGH_LEVEL_DESIGN' ? ['package.json'] : ['docs/01.md'],
    dependsOn: [],
    acceptance: 'The contract passes.',
    maxAttempts: 3,
  } as Step;
  return {
    plan: { ...fixturePlan(), steps: [step] },
    executionStep: step,
    domainStep: {
      ...step,
      name: phase === 'HIGH_LEVEL_DESIGN' ? 'P1-S002' : 'P1-S001',
      type: phase,
      projectId: 'project-id',
      phaseId: 'phase-id',
      attempts: 1,
      agent: phase === 'HIGH_LEVEL_DESIGN' ? 'Architect' : 'Planner',
    },
    ticket: {
      id: 'story-id',
      type: 'story',
      logIds: [],
      source: { correlationId: 'correlation-id' },
    },
    mode: 'normal',
  } as unknown as AttemptInput;
}

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

/**
 * Every watchdog wording, not one of them.
 *
 * `PROVIDER_FAILURE_TEXT` used to list `stream idle before first token`, which was one sentence out
 * of several a stream watchdog composes. Two more were added this week — reasoning-only stalls and a
 * missing response header — and neither matched, so an outage of our own provider would have been
 * charged to the generated project as a Bug. The predicate now keys on the prefix the transport puts
 * in front of all of them.
 */
describe('every stream watchdog wording is our infrastructure', () => {
  const wordings = [
    'OpenAI stream idle before first token for 300000ms; aborting',
    'OpenAI stream idle for 60000ms; aborting',
    'OpenAI stream sent 4293 reasoning chars but no content for 300000ms; aborting',
    'OpenAI stream sent no response headers for 30000ms; aborting',
    'OpenAI stream wall-clock 900000ms exceeded; aborting',
  ];

  for (const wording of wordings) {
    it(`classifies "${wording.slice(0, 42)}…" as infrastructure`, () => {
      expect(classifyAttemptFailure(wording)).toBe('infrastructure');
    });
  }

  // The other direction is what the narrow predicate was protecting, and it still has to hold.
  it('leaves a failure the generated project produced as execution', () => {
    expect(classifyAttemptFailure('run_tests failed: external API returned HTTP 429')).toBe('execution');
    expect(classifyAttemptFailure('pytest exit=1: 3 failed')).toBe('execution');
  });
});

/**
 * Lookup follows the top of the failure stack; the history stays in the prompt.
 *
 * A Ticket's own `failure` is the one that opened it, and a repair loop moves through several —
 * unwritten tests, then an import error, then a failing assertion. Keying Debug Wiki retrieval on
 * the opening failure answers the first question for the rest of the Ticket's life: a live Bug
 * received the same entry 51 times while the entry matching its current `ModuleNotFoundError` never
 * appeared once, and the Ticket ran out of attempts on advice for a problem it had already left.
 */
describe('debug lookup keys on the failure in hand', () => {
  const importFailure = {
    message: 'Step executor reached max rounds',
    data: {
      failureLog: [
        'pytest exit=2 args=tests/test_models.py',
        "ImportError while importing test module 'tests/test_models.py'.",
        'tests/test_models.py:3: in <module>',
        '    from models import SignalInfo',
        "E   ModuleNotFoundError: No module named 'models'",
      ].join('\n'),
    },
  } as unknown as DomainLog;

  it('builds the brief from the recorded failure, not from the Ticket that opened', async () => {
    const { briefForAttemptFailure } = await import('../src/application/execution/attempt_policy.js');
    const brief = briefForAttemptFailure(importFailure, 'CODE');
    expect(brief.category).toBe('import_error');
    expect(brief.primaryError).toContain('ModuleNotFoundError');
  });

  /**
   * The consequence, asserted through retrieval: the same failure has to reach the entry written for
   * it. Keying on the Ticket's opening text instead yields `test_failure` and a different entry.
   */
  it('retrieves the entry that matches the current error', async () => {
    const { briefForAttemptFailure } = await import('../src/application/execution/attempt_policy.js');
    const { DebugWiki, bundledDebugWikiPath } = await import('../src/core/debug_wiki.js');
    const wiki = new DebugWiki(bundledDebugWikiPath());

    const current = await wiki.search(briefForAttemptFailure(importFailure, 'CODE'), { limit: 3 });
    expect(current[0]?.entry.id).toBe('agent.calibration.python-imports');

    // What the Ticket carries once the loop has moved on: a description of the loop's shape, whose
    // own text says nothing about imports.
    const { buildDebugBrief } = await import('../src/core/debug_brief.js');
    const opening = buildDebugBrief({
      reason: 'verification command repeated without a successful mutation',
      failureLog: 'run_tests:{"cwd":"."}; the duplicate command was not executed again',
      phase: 'CODE',
    });
    const stale = await wiki.search(opening, { limit: 3 });
    expect(stale.map((match) => match.entry.id)).not.toContain('agent.calibration.python-imports');
  });
});

/**
 * An attempt that wrote real files keeps them, whatever ended it.
 *
 * The failure category describes why an attempt stopped, not whether it achieved anything, and an
 * attempt can be both: a live CODE Step wrote the test files it owed and then ran the same
 * verification command twice, so each rejection rolled the files away and the identical "these
 * declared test files do not exist yet" refusal came back six times until the non-convergence guard
 * stopped the run. The work was correct every time; only the bookkeeping lost it.
 */
describe('failed attempts keep the work they produced', () => {
  const internalFailure = { kind: 'execution', category: 'internal', code: 'agent_execution_stalled' } as never;

  it('preserves the candidate when files changed, whatever the category', async () => {
    const { shouldPreserveFailedCandidate } = await import('../src/application/execution/attempt_policy.js');
    expect(shouldPreserveFailedCandidate(internalFailure, false, 3)).toBe(true);
  });

  it('still rolls back an attempt that produced nothing', async () => {
    const { shouldPreserveFailedCandidate } = await import('../src/application/execution/attempt_policy.js');
    expect(shouldPreserveFailedCandidate(internalFailure, false, 0)).toBe(false);
  });

  // Conditions outside the project return to the baseline no matter what is on disk: a dependency
  // request is answered by another Step, and infrastructure failures are not the project's work.
  it('does not preserve work when the failure is not the project\'s to repair', async () => {
    const { shouldPreserveFailedCandidate } = await import('../src/application/execution/attempt_policy.js');
    expect(shouldPreserveFailedCandidate(internalFailure, true, 5)).toBe(false);
    const infra = { kind: 'infrastructure', category: 'llm-provider', code: 'provider_call_failed' } as never;
    expect(shouldPreserveFailedCandidate(infra, false, 5)).toBe(false);
  });
});

/**
 * A Step is told the metrics its own gate asks for, not a phase table it has to match itself
 * against. CODE has no entry in that table, so a live run measured coverage nobody required, could
 * not collect it, reported the shortfall honestly in `gaps` — and the gate failed it for
 * volunteering, after its suite had already passed.
 */
describe('the prompt states this Step\'s metric contract', () => {
  const stepWith = (metrics: Record<string, number>) => ({
    id: 'S004', title: 'implement', phase: 'CODE', role: 'Coder',
    acceptance: 'a', description: 'd', outputs: [], inputs: [], tools: [],
    qualityGate: { metrics },
  }) as never;

  const render = async (metrics: Record<string, number>) => {
    const { renderExecutionUserPrompt } = await import('../src/agents/execution/prompt_renderer.js');
    return renderExecutionUserPrompt({
      step: stepWith(metrics),
      ctx: { contextWindowTokens: 128 * 1024, allowedWrites: ['src/'] },
      contextSnippets: [],
      architectureModules: [],
      dependencies: [],
    } as never, '');
  };

  it('names the required metrics when the gate has them', async () => {
    const text = await render({ lineCoverage: 0.8 });
    expect(text).toContain('lineCoverage');
    expect(text).toMatch(/unavailableMetrics with its cause in\s+blockedBy/u);
    expect(text).toMatch(/never in gaps/u);
  });

  it('says plainly that no metric is owed when the gate requires none', async () => {
    const text = await render({});
    expect(text).toMatch(/requires no metrics/u);
    expect(text).toMatch(/do not record a gap about metrics/u);
  });
});

/**
 * The instruction and the gate have to name the same field.
 *
 * The prompt told a Step to put the cause of an unmeasurable metric in `gaps`, and the gate fails a
 * Step for every gap it declares — so following the instruction was the failure. The rescue that
 * exists for exactly this case, `reconcileMeasuredQualityAssessment`, keys on `blockedBy`, which the
 * instruction never mentioned here. A live CODE Step passed its whole suite, honestly reported that
 * coverage could not be collected, and was failed for saying so.
 */
describe('the unmeasurable-metric instruction names the non-failing field', () => {
  for (const locale of ['zh', 'en'] as const) {
    it(`points ${locale} at blockedBy rather than gaps`, async () => {
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(new URL(`../src/i18n/${locale}.ts`, import.meta.url), 'utf8');
      const line = text.split('\n').find((candidate) => candidate.includes('unavailableMetrics') && candidate.includes('Enhancement'));
      expect(line).toBeDefined();
      expect(line).toContain('blockedBy');
      // The old wording sent the cause to the one field that fails the Step.
      expect(line).not.toMatch(/(?:in|说明原因，并在) gaps 说明原因|explain the cause in gaps/u);
    });
  }
});

/**
 * Retrieval and the prompt ask the same question — which failure is in hand — and answering it from
 * two sources is how they came apart. Lookup followed the top of the stack while the prompt kept
 * describing the failure the Ticket was opened for, so a live Debugger spent 26 attempts re-fixing
 * an ImportError an earlier round had already fixed; the assertion actually failing never reached
 * the model. `debugContextFrom` now takes the resolved brief rather than re-deriving one from the
 * Ticket, which makes the two answers structurally the same value; what remains to guard is that the
 * value follows the newest failure.
 */
describe('failure in hand', () => {
  const importError = [
    'pytest exit=2 args=tests/modules/test_main_module.py',
    "E   ImportError: cannot import name 'validate_args' from 'src.main'",
  ].join('\n');
  const assertionFailure = [
    'pytest exit=1 args=tests/modules/test_excel_writer_module.py',
    'FAILED tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data',
    "E   assert None == ''",
  ].join('\n');

  const runnerFor = (logs: unknown[]): DomainAttemptRunner => new DomainAttemptRunner({
    workspace: {}, git: {}, router: {}, audit: {}, plugins: { size: 0 },
    debugWikiPath: '/tmp/xcompiler-brief-wiki',
    repository: { read: async (id: string) => logs.find((log) => (log as { id: string }).id === id) },
  } as never, 'python');

  const attempt = (logIds: string[]): AttemptInput => ({
    ticket: {
      id: 'BUG-1', type: 'bug', logIds,
      failure: { summary: 'collection failed', message: importError, category: 'test', code: 'test_command_failed' },
    },
    domainStep: { id: 'step-1' },
    executionStep: { phase: 'HIGH_LEVEL_DESIGN' },
  } as never);

  const log = (id: string, failureLog: string) => ({
    id, objectType: 'log', level: 'error', message: 'attempt failed',
    data: { stepId: 'step-1', failureLog },
  });

  const briefFor = async (runner: DomainAttemptRunner, input: AttemptInput) =>
    await (runner as unknown as {
      latestFailureBrief(value: AttemptInput): Promise<unknown>;
    }).latestFailureBrief(input);

  it('follows the newest failure, not the one the Ticket was opened for', async () => {
    const runner = runnerFor([log('l1', importError), log('l2', assertionFailure)]);
    const brief = await briefFor(runner, attempt(['l1', 'l2']));
    const rendered = renderDebugBriefForPrompt(brief as never);
    expect(rendered).toContain('test_writes_signal_data');
    expect(rendered).not.toContain('validate_args');
    expect(rendered).not.toContain('ImportError');
  });

  it('falls back to the Ticket failure while no attempt has failed yet', async () => {
    const brief = await briefFor(runnerFor([]), attempt([]));
    expect(brief).toBeUndefined();
  });
});

/**
 * What the Ticket carries into the prompt. The renderer caps each snippet, so the order and the size
 * of what goes in decides what the model actually reads: a live Bug's Ticket held 43KB of the pytest
 * output from the day it was opened, the cap kept the first 3000 characters of that, and the failure
 * in hand reached the model only as a one-line summary further down. It spent 26 attempts re-fixing
 * the ImportError it could read in full.
 */
describe('ticket context snapshot', () => {
  const openingDump = ['ImportError: cannot import name validate_args', 'x'.repeat(43_000)].join('\n');

  const snapshot = (ticket: unknown): Record<string, unknown> =>
    ticketContextSnapshot(ticket) as Record<string, unknown>;

  it('bounds a captured failure so it cannot crowd out the Ticket fields', () => {
    const trimmed = snapshot({
      id: 'BUG-1', state: 'in_progress',
      description: openingDump,
      acceptance: ['Repair P1-S002 without unrelated rewrites.'],
      failure: { summary: 'collection failed', message: openingDump, code: 'test_command_failed' },
    });
    expect(String(trimmed.description).length).toBeLessThan(1400);
    expect(String(trimmed.description)).toContain('ImportError');
    expect(String(trimmed.description)).toContain('ticket history trimmed');
    expect((trimmed.failure as Record<string, string>).message.length).toBeLessThan(1400);
    // The fields the routed role needs survive intact.
    expect(trimmed.acceptance).toEqual(['Repair P1-S002 without unrelated rewrites.']);
    expect((trimmed.failure as Record<string, string>).code).toBe('test_command_failed');
  });

  it('leaves a short failure untouched', () => {
    const trimmed = snapshot({ description: 'assert None == \'\'', failure: { message: 'short' } });
    expect(trimmed.description).toBe('assert None == \'\'');
    expect((trimmed.failure as Record<string, string>).message).toBe('short');
  });
});

describe('advisoryFailuresForStage', () => {
  it('exempts the compile check from Steps that run before any product source exists', () => {
    // S001-S003 deliver documents and the paired baseline tests; `src/` is S004's output. A
    // whole-project typecheck therefore fails for the absence of inputs, and holding that against
    // the Step blocks a completion no role there can earn.
    for (const type of ['REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN'] as const) {
      expect(advisoryFailuresForStage(type)).toEqual([
        { tool: 'run_program', errorIncludes: 'TS18003' },
      ]);
    }
  });

  it('holds every later Step to the compile check', () => {
    // From CODE onward the sources exist, so the same failure is a real defect of the Step.
    for (const type of [
      'CODE', 'UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST',
    ] as const) {
      expect(advisoryFailuresForStage(type)).toEqual([]);
    }
  });
});
