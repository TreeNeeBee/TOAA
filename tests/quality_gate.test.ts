import { describe, expect, it } from 'vitest';
import {
  defaultQualityGateForPhase,
  evaluateQualityGate,
  reconcileDevelopmentQualityAssessment,
} from '../src/core/quality_gate.js';
import type { Step } from '../src/core/plan.js';

describe('LLM quality evidence normalization', () => {
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

  it('removes stale missing-output and deferred paired-test notes only', () => {
    const step = {
      ...testStep('HIGH_LEVEL_DESIGN'),
      outputs: ['docs/02-high-level-design.md', 'tests/modules/core.test.ts'],
      tools: ['write_file', 'read_file'],
    };
    const reconciled = reconcileDevelopmentQualityAssessment(step, {
      completion: 0,
      upstreamAlignment: 1,
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: [],
      gaps: [
        'missing required output: tests/modules/core.test.ts',
        'run_tests is not authorized here; tests will be executed in MODULE_TEST',
      ],
    }, []);
    expect(reconciled?.completion).toBe(1);
    expect(reconciled?.gaps).toEqual([]);
    expect(evaluateQualityGate(step, reconciled).passed).toBe(true);
  });

  it('preserves semantic defects even when files exist', () => {
    const step = { ...testStep('CODE'), outputs: ['src/main.ts'] };
    const gap = 'src/main.ts is missing retry behavior required by the design';
    const reconciled = reconcileDevelopmentQualityAssessment(step, {
      completion: 0.6,
      upstreamAlignment: 1,
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: [], gaps: [gap],
    }, []);
    expect(reconciled?.gaps).toEqual([gap]);
    expect(evaluateQualityGate(step, reconciled).passed).toBe(false);
  });

  it('defers downstream coverage findings to the paired verification gate', () => {
    const step = { ...testStep('CODE'), outputs: ['src/main.ts'] };
    const reconciled = reconcileDevelopmentQualityAssessment(step, {
      completion: 1,
      upstreamAlignment: 1,
      metrics: { lineCoverage: 0.39 },
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['npm test -- --coverage'],
      gaps: ['lineCoverage 0.39 is below the UNIT_TEST target 0.80'],
    }, []);
    expect(reconciled?.gaps).toEqual([]);
    expect(evaluateQualityGate(step, reconciled).passed).toBe(true);
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
