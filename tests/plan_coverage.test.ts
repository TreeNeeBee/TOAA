import { describe, it, expect } from 'vitest';
import { calibratePlanCoverage } from '../src/agents/calibration.js';
import { lintPlan } from '../src/core/lint.js';
import type { Step, Plan } from '../src/core/plan.js';

const baseDeliveryDocs = ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'];

function mkStep(over: Partial<Step> & Pick<Step, 'id' | 'phase'>): Step {
  return {
    id: over.id,
    iterationId: over.iterationId ?? 'P1',
    phase: over.phase,
    title: over.title ?? `${over.phase} ${over.id}`,
    description: over.description ?? `${over.phase} ${over.id}`,
    systemPrompt: over.systemPrompt ?? '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
    role: over.role ?? 'Coder',
    tools: over.tools ?? [],
    inputs: over.inputs ?? [],
    outputs: over.outputs ?? [],
    dependsOn: over.dependsOn ?? [],
    acceptance: over.acceptance ?? '完成。',
    maxAttempts: 3,
  };
}

describe('calibratePlanCoverage', () => {
  it('appends a synthetic UNIT_TEST step covering all uncovered CODE steps when planner forgot UNIT_TEST entirely', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'REQUIREMENT_ANALYSIS', role: 'Planner', outputs: ['docs/01-requirement-analysis.md', 'docs/tests/functional-test-plan.md'] }),
      mkStep({ id: 'S002', phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: ['docs/02-high-level-design.md', 'docs/tests/module-test-plan.md'], dependsOn: ['S001'] }),
      mkStep({ id: 'S003', phase: 'DETAILED_DESIGN', role: 'Architect', outputs: ['docs/03-detailed-design.md', 'docs/tests/integration-test-plan.md'], dependsOn: ['S002'] }),
      mkStep({ id: 'S004', phase: 'CODE', outputs: ['src/dbc_parser.py'], dependsOn: ['S003'] }),
      mkStep({ id: 'S005', phase: 'CODE', outputs: ['src/excel_exporter.py'], dependsOn: ['S004'] }),
    ];
    const out = calibratePlanCoverage(steps);
    expect(out.length).toBe(6);
    const test = out[5]!;
    expect(test.phase).toBe('UNIT_TEST');
    expect(test.role).toBe('Tester');
    expect(test.id).toBe('S006');
    expect(test.dependsOn).toEqual(['S004', 'S005']);
    expect(test.outputs).toEqual(['docs/05-unit-test.md']);
    expect(test.inputs).toEqual(expect.arrayContaining([
      'tests/test_unit_s004.py',
      'tests/test_unit_s005.py',
    ]));
    expect(out[3]!.outputs).toContain('tests/test_unit_s004.py');
    expect(out[4]!.outputs).toContain('tests/test_unit_s005.py');
    expect(test.tools).toContain('skill:tester');
  });

  it('is idempotent / no-op when every CODE step is already transitively covered', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'CODE', outputs: ['src/a.py'] }),
      mkStep({ id: 'S002', phase: 'CODE', outputs: ['src/b.py'], dependsOn: ['S001'] }),
      // chain-style: only one UNIT_TEST that depends on S002 — covers S001 transitively
      mkStep({ id: 'S003', phase: 'UNIT_TEST', role: 'Tester', outputs: ['tests/test_b.py'], dependsOn: ['S002'] }),
    ];
    const out = calibratePlanCoverage(steps);
    expect(out.length).toBe(3);
    expect(out[0]!.outputs).toContain('tests/test_b.py');
    expect(out[2]!.outputs).toEqual([]);
    expect(out[2]!.inputs).toContain('tests/test_b.py');
    expect(calibratePlanCoverage(out)).toEqual(out);
  });

  it('only injects coverage for the still-uncovered CODE steps when partial coverage exists', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'CODE', outputs: ['src/a.py'] }),
      mkStep({ id: 'S002', phase: 'CODE', outputs: ['src/b.py'] }),
      mkStep({ id: 'S003', phase: 'UNIT_TEST', role: 'Tester', outputs: ['tests/test_a.py'], dependsOn: ['S001'] }),
    ];
    const out = calibratePlanCoverage(steps);
    expect(out.length).toBe(4);
    expect(out[3]!.dependsOn).toEqual(['S002']);
  });

  it('adds baselines to left-side stages and keeps supplements out of planned verification outputs', () => {
    const steps: Step[] = [
      mkStep({
        id: 'S000',
        phase: 'DETAILED_DESIGN',
        role: 'Architect',
        outputs: ['docs/03-detailed-design.md', 'docs/tests/integration-test-plan.md'],
      }),
      mkStep({ id: 'S001', phase: 'CODE', outputs: ['src/app.py'] }),
      mkStep({
        id: 'S002',
        phase: 'UNIT_TEST',
        role: 'Tester',
        outputs: ['docs/05-unit-test.md', 'reports/unit-test-report.md'],
        dependsOn: ['S001'],
      }),
      mkStep({
        id: 'S003',
        phase: 'INTEGRATION_TEST',
        role: 'Tester',
        outputs: ['docs/06-integration-test.md'],
        dependsOn: ['S002'],
      }),
    ];

    const out = calibratePlanCoverage(steps);

    expect(out).not.toBe(steps);
    expect(out).toHaveLength(4);
    expect(out[1]!.outputs).toEqual(expect.arrayContaining([
      'src/app.py',
      'tests/test_unit_s001.py',
    ]));
    expect(out[2]!.outputs).toEqual([
      'docs/05-unit-test.md',
      'reports/unit-test-report.md',
    ]);
    expect(out[2]!.inputs).toContain('tests/test_unit_s001.py');
    expect(out[0]!.outputs).toContain('tests/test_integration_s000.py');
    expect(out[3]!.outputs).toEqual(['docs/06-integration-test.md']);
    expect(out[3]!.inputs).toContain('tests/test_integration_s000.py');
  });

  it('drops planner-declared supplement paths instead of promoting them to baseline ownership', () => {
    const steps: Step[] = [
      mkStep({
        id: 'S001',
        phase: 'CODE',
        outputs: [
          'src/app.py',
          'tests/test_app.py',
          'tests/supplements/unit-supplement.py',
        ],
      }),
      mkStep({
        id: 'S002',
        phase: 'UNIT_TEST',
        role: 'Tester',
        inputs: [
          'tests/test_app.py',
          'tests/supplements/unit-supplement.py',
        ],
        outputs: [
          'docs/05-unit-test.md',
          'tests/verification/p1/unit-test/s002/risk_case.py',
        ],
        dependsOn: ['S001'],
      }),
    ];

    const out = calibratePlanCoverage(steps);

    expect(out[0]!.outputs).toContain('tests/test_app.py');
    expect(out[0]!.outputs).not.toContain('tests/supplements/unit-supplement.py');
    expect(out[1]!.inputs).toEqual(['tests/test_app.py']);
    expect(out[1]!.outputs).toEqual(['docs/05-unit-test.md']);
    expect(out[1]!.systemPrompt).toContain('tests/verification/p1/unit-test/s002/');
  });

  it('adds the paired unit test asset without adding a UNIT_TEST step for an init-only CODE marker', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'CODE', outputs: ['src/pkg/__init__.py'] }),
    ];
    const out = calibratePlanCoverage(steps);
    expect(out).toHaveLength(1);
    expect(out[0]!.outputs).toContain('tests/test_unit_s001.py');
  });

  it('rewires downstream test phases to the synthetic UNIT_TEST step so the calibrated plan fully passes lint', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'REQUIREMENT_ANALYSIS', role: 'Planner', outputs: ['docs/01-requirement-analysis.md', 'docs/tests/functional-test-plan.md'] }),
      mkStep({ id: 'S002', phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: ['docs/02-high-level-design.md', 'docs/tests/module-test-plan.md'], dependsOn: ['S001'] }),
      mkStep({ id: 'S003', phase: 'DETAILED_DESIGN', role: 'Architect', outputs: ['docs/03-detailed-design.md', 'docs/tests/integration-test-plan.md'], dependsOn: ['S002'] }),
      mkStep({ id: 'S004', phase: 'CODE', outputs: ['src/dbc_parser.py', 'docs/tests/unit-test-plan.md'], dependsOn: ['S003'] }),
      mkStep({ id: 'S005', phase: 'CODE', outputs: ['src/excel_exporter.py'], dependsOn: ['S004'] }),
      mkStep({ id: 'S006', phase: 'INTEGRATION_TEST', role: 'Tester', outputs: ['docs/06-integration-test.md'], dependsOn: ['S005'] }),
      mkStep({ id: 'S007', phase: 'MODULE_TEST', role: 'Tester', outputs: ['docs/07-module-test.md'], dependsOn: ['S006'] }),
      mkStep({ id: 'S008', phase: 'FUNCTIONAL_TEST', role: 'Tester', outputs: [...baseDeliveryDocs], dependsOn: ['S007'] }),
    ];
    const calibrated = calibratePlanCoverage(steps);
    const plan: Plan = {
      version: '1',
      language: 'python',
      intent: 'greenfield',
      projectType: 'application',
      requirementDigest: 'd',
      complexityAssessment: {
        level: 'simple',
        rationale: 'coverage calibration fixture',
        splitRecommended: false,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core functionality',
          objective: 'Exercise synthetic test coverage calibration.',
          status: 'current',
          scope: ['Coverage fixture'],
          deliverables: ['Lint-clean calibrated plan'],
          dependsOn: [],
          verificationGate: {
            summary: 'P1 gate',
            checks: ['tests pass', 'delivery docs exist'],
            failurePolicy: 'Repair P1 before continuing.',
          },
        },
      ],
      globalPrompt: '',
      baselineSummary: '',
      userAddenda: '',
      dependencies: ['pytest'],
      createdAt: '2026-01-01T00:00:00.000Z',
      steps: calibrated,
    };
    const integration = calibrated.find((s) => s.phase === 'INTEGRATION_TEST');
    expect(integration?.dependsOn).toContain('S009');
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs).toEqual([]);
  });

  it('injects a TypeScript-friendly synthetic UNIT_TEST step for uncovered TS CODE steps', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'CODE', outputs: ['src/main.ts'] }),
    ];
    const out = calibratePlanCoverage(steps, 'typescript');
    expect(out.length).toBe(2);
    const test = out[1]!;
    expect(test.phase).toBe('UNIT_TEST');
    expect(test.outputs).toEqual(['docs/05-unit-test.md']);
    expect(out[0]!.outputs).toContain('tests/unit_s001.test.ts');
    expect(test.inputs).toContain('tests/unit_s001.test.ts');
    expect(test.systemPrompt).toContain('npm test / Vitest');
    expect(test.acceptance).toContain('Vitest');
  });
});
