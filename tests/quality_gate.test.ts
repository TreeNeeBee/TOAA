import { describe, expect, it } from 'vitest';
import {
  defaultQualityGateForPhase,
  evaluateQualityGate,
  normalizeQualityAssessment,
  qualityAssessmentConsistencyIssues,
} from '../src/core/quality_gate.js';
import type { Step } from '../src/core/plan.js';

describe('LLM quality evidence normalization', () => {
  it('preserves independently routable gate findings', () => {
    const parsed = normalizeQualityAssessment({
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['verification report'],
      gaps: [],
      findings: [
        {
          category: 'test-defect',
          code: 'supplement_assertion_contract_conflict',
          summary: 'The supplemental assertion contradicts the accepted contract.',
          evidence: ['tests/verification/p1/unit-test/s005/risk.test.ts:18'],
          target: 'current-step',
          dependencyPackages: [],
        },
        {
          category: 'product-defect',
          code: 'implementation_status_incorrect',
          summary: 'The implementation returns the wrong status.',
          evidence: ['expected=ready actual=pending'],
          target: 'code',
          dependencyPackages: [],
        },
      ],
    });

    expect(parsed?.findings).toHaveLength(2);
    expect(evaluateQualityGate(testStep('UNIT_TEST'), parsed).bugFailures).toHaveLength(2);
  });

  it('rejects a malformed finding instead of silently dropping it', () => {
    expect(normalizeQualityAssessment({
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['verification report'],
      gaps: [],
      findings: [{ category: 'dependency', summary: 'needs a package', evidence: ['import failed'] }],
    })).toBeUndefined();
  });

  it('defines source completion/alignment and stage-specific test metrics', () => {
    expect(defaultQualityGateForPhase('CODE')).toMatchObject({ completionMin: 0.95, upstreamAlignmentMin: 0.9 });
    expect(defaultQualityGateForPhase('UNIT_TEST').metrics).toEqual({
      lineCoverage: 0.8,
      branchCoverage: 0.7,
      testCasePassRate: 1,
    });
    expect(defaultQualityGateForPhase('INTEGRATION_TEST').metrics).toHaveProperty('interfaceCoverage', 0.85);
    expect(defaultQualityGateForPhase('MODULE_TEST').metrics).toHaveProperty('moduleCoverage', 0.9);
    expect(defaultQualityGateForPhase('FUNCTIONAL_TEST').metrics).toHaveProperty('requirementCoverage', 0.95);
  });

  it('classifies metric shortfalls separately from failed tests', () => {
    const step = testStep('UNIT_TEST');
    const coverageGap = evaluateQualityGate(step, {
      metrics: { lineCoverage: 0.72, branchCoverage: 0.62, testCasePassRate: 1 },
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['coverage/coverage-summary.json'], gaps: [],
    });
    expect(coverageGap.enhancementFailures).not.toEqual([]);
    expect(coverageGap.bugFailures).toEqual([]);

    const failedTests = evaluateQualityGate(step, {
      metrics: { lineCoverage: 0.9, branchCoverage: 0.8, testCasePassRate: 0.95 },
      tolerance: { failedTests: 1, skippedTests: 0, warnings: 0 },
      evidence: ['test output'], gaps: [],
    });
    expect(failedTests.bugFailures).toContain('failedTests=1 exceeds tolerance 0');
  });

  it('honors metric shortfall tolerance', () => {
    const step = {
      ...testStep('UNIT_TEST'),
      qualityGate: {
        metrics: { lineCoverage: 0.8 },
        tolerance: { metricShortfall: 0.05, maxFailedTests: 0, maxSkippedTests: 0, maxWarnings: 0 },
      },
    };
    expect(evaluateQualityGate(step, {
      metrics: { lineCoverage: 0.76 },
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['coverage report'], gaps: [],
    }).passed).toBe(true);
  });

  it('preserves semantic defects even when files exist', () => {
    const step = { ...testStep('CODE'), outputs: ['src/main.ts'] };
    const gap = 'src/main.ts is missing retry behavior required by the design';
    const assessment = {
      completion: 0.6,
      upstreamAlignment: 1,
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['src/main.ts'], gaps: [gap], blockedBy: [],
    };
    expect(evaluateQualityGate(step, assessment).passed).toBe(false);
  });

  it('does not infer ownership from metric names in free text', () => {
    const step = { ...testStep('CODE'), outputs: ['src/main.ts'] };
    const misplaced = {
      completion: 1,
      upstreamAlignment: 1,
      metrics: { lineCoverage: 0.39 },
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['npm test -- --coverage'],
      gaps: ['lineCoverage 0.39 is below the UNIT_TEST target 0.80'],
      blockedBy: [],
    };
    expect(evaluateQualityGate(step, misplaced).passed).toBe(false);

    const structured = {
      ...misplaced,
      gaps: [],
      blockedBy: ['UNIT_TEST owns the lineCoverage gate'],
    };
    expect(evaluateQualityGate(step, structured).passed).toBe(true);
  });
});

function testStep(phase: Step['phase']): Step {
  return {
    id: 'S001', iterationId: 'P1', phase, title: phase, description: `Execute ${phase}`,
    systemPrompt: `Complete ${phase} and provide evidence.`,
    role: phase === 'REQUIREMENT_ANALYSIS'
      ? 'Planner'
      : phase === 'HIGH_LEVEL_DESIGN' || phase === 'DETAILED_DESIGN'
        ? 'Architect'
        : phase === 'CODE' ? 'Coder' : 'Tester',
    tools: [], inputs: [], outputs: [], dependsOn: [], acceptance: `${phase} passes`,
    maxAttempts: 3,
  };
}

describe('preconditions a Step does not own', () => {
  // From a live run: DETAILED_DESIGN reported "Test pass rate is 0 because product source files are
  // not yet implemented; this is expected per V-model ... and is not a defect of this step" — an
  // accurate statement about something CODE had not written yet — and the gate failed the Step for
  // it, because a gate fails a Step for every gap it reports. The mechanism meant to drop such gaps
  // matches internal metric identifiers against free prose, and lost to a model writing "test pass
  // rate" where it expected "testCasePassRate".
  it('are parsed into their own field, not into gaps', () => {
    const parsed = normalizeQualityAssessment({
      completion: 1,
      upstreamAlignment: 1,
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['docs/03-detailed-design.md'],
      unavailableMetrics: [],
      gaps: [],
      blockedBy: ['product source is not implemented yet; it is the CODE Step output'],
    });

    expect(parsed?.gaps).toEqual([]);
    expect(parsed?.blockedBy).toEqual([
      'product source is not implemented yet; it is the CODE Step output',
    ]);
  });

  it('do not fail the gate, while a real gap still does', () => {
    const step = {
      id: 'S003', phase: 'DETAILED_DESIGN', title: 'x', description: 'x',
      systemPrompt: 'x', role: 'Architect', tools: [], inputs: [], outputs: [],
      dependsOn: [], acceptance: 'ok',
    } as unknown as Step;
    const base = {
      completion: 1,
      upstreamAlignment: 1,
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['docs/03-detailed-design.md'],
    };

    const blocked = evaluateQualityGate(step, { ...base, gaps: [], blockedBy: ['CODE has not run'] });
    expect(blocked.passed).toBe(true);

    const real = evaluateQualityGate(step, { ...base, gaps: ['the module contract is undefined'], blockedBy: [] });
    expect(real.passed).toBe(false);
  });

  it('accepts the snake_case spelling a model may emit', () => {
    const parsed = normalizeQualityAssessment({
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: [],
      unavailable_metrics: ['lineCoverage'],
      gaps: [],
      blocked_by: ['the manifest is written by HIGH_LEVEL_DESIGN'],
    });
    expect(parsed?.blockedBy).toEqual(['the manifest is written by HIGH_LEVEL_DESIGN']);
    expect(parsed?.unavailableMetrics).toEqual(['lineCoverage']);
  });

  it('rejects measured/unavailable metric conflicts without interpreting model prose', () => {
    const parsed = normalizeQualityAssessment({
      completion: 1,
      upstreamAlignment: 1,
      metrics: { moduleCoverage: 1 },
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['tests/modules/x.test.ts'],
      unavailableMetrics: ['moduleCoverage'],
      gaps: [],
      blockedBy: [],
    })!;

    expect(qualityAssessmentConsistencyIssues(parsed)).toEqual([
      'qualityAssessment.metrics.moduleCoverage conflicts with qualityAssessment.unavailableMetrics',
    ]);
  });

  it('rejects a deferred pre-CODE blocker duplicated as a completed Step gap', () => {
    const parsed = normalizeQualityAssessment({
      completion: 1,
      upstreamAlignment: 1,
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['docs/02-high-level-design.md'],
      unavailableMetrics: ['moduleCoverage'],
      gaps: ['the paired baseline cannot run before its implementation exists'],
      blockedBy: ['CODE owns the product implementation'],
      findings: [],
    })!;

    expect(qualityAssessmentConsistencyIssues(parsed, {
      baselineExecutionDeferred: true,
    })).toEqual([
      expect.stringContaining('gaps contradict completion=1 during deferred baseline execution'),
    ]);
    expect(qualityAssessmentConsistencyIssues(parsed, {
      baselineExecutionDeferred: false,
    })).toEqual([]);
  });
});

describe('a gap about a tool the Step does not have', () => {
  const codeStep = (tools: string[]) => ({
    id: 'S004', phase: 'CODE', title: 'x', description: 'x', systemPrompt: 'x',
    role: 'Coder', tools, inputs: [], outputs: [], dependsOn: [], acceptance: 'ok',
  } as unknown as Step);
  const base = {
    completion: 1,
    upstreamAlignment: 1,
    metrics: {},
    tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
    evidence: ['src/cli.ts'],
    unavailableMetrics: [],
    blockedBy: [],
  };

  // Seen three times in live runs: CODE reported "cannot run tsc/vitest here, the whitelist has no
  // run_program/run_tests", the gate failed it for being right, an Enhancement was raised, and the
  // Step then had nothing left to do and stalled. `blockedBy` is the channel for this; a model that
  // uses it never reaches here, and this only stops the gate punishing accuracy.
  it('does not fail the Step, because the whitelist says so', () => {
    const result = evaluateQualityGate(codeStep(['write_file']), {
      ...base,
      gaps: ['cannot run tsc --noEmit or vitest: the tool whitelist has no run_program/run_tests'],
    });
    expect(result.passed).toBe(true);
  });

  it('still fails when the Step does have the tool', () => {
    const result = evaluateQualityGate(codeStep(['write_file', 'run_tests']), {
      ...base,
      gaps: ['run_tests reports 3 failing cases'],
    });
    expect(result.passed).toBe(false);
  });

  it('still fails on a gap that names no tool at all', () => {
    const result = evaluateQualityGate(codeStep(['write_file']), {
      ...base,
      gaps: ['the renderer has no error handling'],
    });
    expect(result.passed).toBe(false);
  });
});
