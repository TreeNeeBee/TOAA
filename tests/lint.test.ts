import { describe, expect, it } from 'vitest';
import { lintPlan, topoSort } from '../src/core/lint.js';
import { PlanSchema, type Plan } from '../src/core/plan.js';

const baseDeliveryDocs = ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'];

function makePlan(overrides: Partial<Plan> = {}): Plan {
  const base: Plan = {
    version: '1',
    language: 'python',
    intent: 'greenfield',
    projectType: 'application',
    requirementDigest: 'todo CLI app',
    complexityAssessment: {
      level: 'simple',
      rationale: 'unit test fixture',
      splitRecommended: false,
      userForcedPhaseSplit: false,
    },
    implementationPhases: [
      {
        id: 'P1',
        title: 'Core functionality',
        objective: 'Exercise the V-model lint fixture.',
        status: 'current',
        scope: ['Core fixture'],
        deliverables: ['Valid lint plan'],
        dependsOn: [],
        verificationGate: {
          summary: 'P1 gate',
          checks: ['tests pass', 'entrypoint runs', 'functional docs exist'],
          failurePolicy: 'Repair P1 before continuing.',
        },
      },
    ],
    globalPrompt: '',
    baselineSummary: '',
    userAddenda: '',
    dependencies: ['pytest==8.*'],
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        id: 'S001',
        iterationId: 'P1',
        phase: 'REQUIREMENT_ANALYSIS',
        title: 'collect requirements',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Planner',
        tools: [],
        inputs: [],
        outputs: [
          'docs/01-requirement-analysis.md',
          'docs/tests/functional-test-plan.md',
          'tests/test_functional.py',
        ],
        dependsOn: [],
        acceptance: 'requirement doc exists',
        maxAttempts: 3,
      },
      {
        id: 'S002',
        iterationId: 'P1',
        phase: 'HIGH_LEVEL_DESIGN',
        title: 'design architecture and deps',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Architect',
        tools: [],
        inputs: ['docs/01-requirement-analysis.md'],
        outputs: [
          'docs/02-high-level-design.md',
          'docs/tests/module-test-plan.md',
          'tests/test_module.py',
        ],
        dependsOn: ['S001'],
        acceptance: 'arch exists',
        maxAttempts: 3,
      },
      {
        id: 'S003',
        iterationId: 'P1',
        phase: 'DETAILED_DESIGN',
        title: 'plan tasks',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Planner',
        tools: [],
        inputs: ['docs/02-high-level-design.md'],
        outputs: [
          'docs/03-detailed-design.md',
          'docs/tests/integration-test-plan.md',
          'tests/test_integration.py',
        ],
        dependsOn: ['S002'],
        acceptance: 'tasks doc exists',
        maxAttempts: 3,
      },
      {
        id: 'S004',
        iterationId: 'P1',
        phase: 'CODE',
        title: 'implement core',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Coder',
        tools: ['write_file', 'apply_patch'],
        inputs: ['docs/02-high-level-design.md', 'docs/03-detailed-design.md'],
        outputs: ['src/app.py', 'docs/tests/unit-test-plan.md', 'tests/test_app.py'],
        dependsOn: ['S003'],
        acceptance: 'src/app.py exists',
        maxAttempts: 3,
      },
      {
        id: 'S005',
        iterationId: 'P1',
        phase: 'UNIT_TEST',
        title: 'unit test core',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Tester',
        tools: ['run_tests'],
        inputs: ['src/app.py', 'tests/test_app.py'],
        outputs: ['docs/05-unit-test.md'],
        dependsOn: ['S004'],
        acceptance: 'pytest passes',
        maxAttempts: 3,
      },
      {
        id: 'S006',
        iterationId: 'P1',
        phase: 'INTEGRATION_TEST',
        title: 'integration test core',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Tester',
        tools: ['run_tests'],
        inputs: ['src/app.py', 'tests/test_integration.py'],
        outputs: ['docs/06-integration-test.md'],
        dependsOn: ['S005'],
        acceptance: 'integration tests pass',
        maxAttempts: 3,
      },
      {
        id: 'S007',
        iterationId: 'P1',
        phase: 'MODULE_TEST',
        title: 'module test core',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Tester',
        tools: ['run_tests'],
        inputs: ['src/app.py', 'tests/test_module.py'],
        outputs: ['docs/07-module-test.md'],
        dependsOn: ['S006'],
        acceptance: 'module tests pass',
        maxAttempts: 3,
      },
      {
        id: 'S008',
        iterationId: 'P1',
        phase: 'FUNCTIONAL_TEST',
        title: 'functional validation',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Tester',
        tools: ['run_tests'],
        inputs: ['src/app.py', 'tests/test_functional.py'],
        outputs: [...baseDeliveryDocs],
        dependsOn: ['S007'],
        acceptance: 'functional docs exist',
        maxAttempts: 3,
      },
    ],
  };
  return { ...base, ...overrides };
}

function makeTypeScriptPlan(): Plan {
  const plan = makePlan({
    language: 'typescript',
    dependencies: ['vitest', 'zod'],
  });
  plan.steps[1] = {
    ...plan.steps[1]!,
    outputs: [
      'docs/02-high-level-design.md',
      'docs/tests/module-test-plan.md',
      'tests/module.test.ts',
      'package.json',
    ],
  };
  plan.steps[0] = {
    ...plan.steps[0]!,
    outputs: [
      'docs/01-requirement-analysis.md',
      'docs/tests/functional-test-plan.md',
      'tests/functional.test.ts',
    ],
  };
  plan.steps[2] = {
    ...plan.steps[2]!,
    outputs: [
      'docs/03-detailed-design.md',
      'docs/tests/integration-test-plan.md',
      'tests/integration.test.ts',
    ],
  };
  plan.steps[3] = {
    ...plan.steps[3]!,
    outputs: ['src/main.ts', 'docs/tests/unit-test-plan.md', 'tests/main.test.ts'],
  };
  plan.steps[4] = {
    ...plan.steps[4]!,
    inputs: ['src/main.ts', 'tests/main.test.ts'],
    outputs: ['docs/05-unit-test.md'],
    acceptance: 'npm test passes',
  };
  plan.steps[5] = {
    ...plan.steps[5]!,
    inputs: ['src/main.ts', 'tests/integration.test.ts'],
  };
  plan.steps[6] = {
    ...plan.steps[6]!,
    inputs: ['src/main.ts', 'tests/module.test.ts'],
  };
  plan.steps[7] = {
    ...plan.steps[7]!,
    inputs: ['src/main.ts', 'tests/functional.test.ts'],
  };
  return plan;
}

describe('PlanSchema', () => {
  it('parses a valid plan', () => {
    expect(() => PlanSchema.parse(makePlan())).not.toThrow();
  });

  it('accepts the isolated self-bootstrap intent', () => {
    expect(PlanSchema.parse(makePlan({ intent: 'self' })).intent).toBe('self');
  });
});

describe('lintPlan', () => {
  it('passes for a well-formed plan', () => {
    expect(lintPlan(makePlan()).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('requires all core V-model macro phases', () => {
    const plan = makePlan();
    plan.steps = plan.steps.filter((s) => s.phase !== 'DETAILED_DESIGN');
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('Plan must include a DETAILED_DESIGN macro Step'))).toBe(true);
  });

  it('requires planning complexity and implementation phase metadata', () => {
    const plan = makePlan();
    delete plan.complexityAssessment;
    delete plan.implementationPhases;
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('complexityAssessment'))).toBe(true);
    expect(errs.some((e) => e.message.includes('implementationPhases'))).toBe(true);
  });

  it('requires README and QuickStart in delivery outputs', () => {
    const plan = makePlan();
    plan.steps[7]!.outputs = ['docs/08-functional-test.md'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('README.md'))).toBe(true);
    expect(errs.some((e) => e.message.includes('docs/quickstart.md'))).toBe(true);
  });

  it('requires API guide for library delivery outputs', () => {
    const plan = makePlan({ projectType: 'library' });
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('docs/api-guide.md'))).toBe(true);
    plan.steps[7]!.outputs = [...baseDeliveryDocs, 'docs/api-guide.md'];
    expect(lintPlan(plan).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('detects missing dependencies for python', () => {
    const plan = makePlan();
    plan.dependencies = [];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('plan.dependencies'))).toBe(true);
  });

  it('rejects requirements.txt as a Step output', () => {
    const plan = makePlan();
    plan.steps[1]!.outputs = ['docs/02-high-level-design.md', 'docs/tests/module-test-plan.md', 'requirements.txt'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('renderer-owned'))).toBe(true);
  });

  it('passes for a TypeScript plan whose HIGH_LEVEL_DESIGN step owns package.json', () => {
    const errs = lintPlan(makeTypeScriptPlan()).filter((i) => i.level === 'error');
    expect(errs).toEqual([]);
  });

  it('does not require an incremental TypeScript plan to rewrite package.json', () => {
    const plan = makeTypeScriptPlan();
    plan.intent = 'self';
    plan.steps[1]!.outputs = ['docs/02-high-level-design.md', 'docs/tests/module-test-plan.md'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('package.json'))).toBe(false);
  });

  it('rejects TypeScript plans when package.json is not owned by exactly one HIGH_LEVEL_DESIGN step', () => {
    const plan = makeTypeScriptPlan();
    plan.steps[1]!.outputs = ['docs/02-high-level-design.md', 'docs/tests/module-test-plan.md'];
    plan.steps[3]!.outputs = ['src/main.ts', 'docs/tests/unit-test-plan.md', 'package.json'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('exactly one HIGH_LEVEL_DESIGN step must output package.json'))).toBe(true);
    expect(errs.some((e) => e.message.includes('package.json must be authored by a HIGH_LEVEL_DESIGN step'))).toBe(true);
  });

  it('detects CODE without UNIT_TEST coverage', () => {
    const plan = makePlan();
    // remove S005 (UNIT_TEST step)
    plan.steps = plan.steps.filter((s) => s.id !== 'S005');
    plan.steps.find((s) => s.id === 'S006')!.dependsOn = ['S004'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('no corresponding UNIT_TEST'))).toBe(true);
  });

  it('CODE-without-UNIT_TEST error includes actionable remediation hint (suggested id + test file)', () => {
    const plan = makePlan();
    plan.steps = plan.steps.filter((s) => s.id !== 'S005');
    plan.steps.find((s) => s.id === 'S006')!.dependsOn = ['S004'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    const msg = errs.find((e) => e.message.includes('no corresponding UNIT_TEST'))?.message ?? '';
    // 应当告诉 LLM 该建一个新 UNIT_TEST step、给出建议 id（基于现有 max+1）和建议的 tests/ 路径，
    // 以及"在已有 UNIT_TEST 的 dependsOn 里加入该 CODE id 也可"的替代方案。
    expect(msg).toMatch(/phase="UNIT_TEST"/);
    expect(msg).toMatch(/role="Tester"/);
    expect(msg).toMatch(/dependsOn=\["S004"\]/);
    expect(msg).toMatch(/tests\/test_.+\.py/);
    expect(msg).toMatch(/chain-style coverage|include "S004" in/);
  });

  it('detects duplicate outputs', () => {
    const plan = makePlan();
    plan.steps[2]!.outputs = ['docs/01-requirement-analysis.md'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('already produced'))).toBe(true);
  });

  it('detects dependency cycles', () => {
    const plan = makePlan();
    plan.steps[0]!.dependsOn = ['S005'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('cycle'))).toBe(true);
  });

  it('detects phase order violation', () => {
    const plan = makePlan();
    // make REQUIREMENT_ANALYSIS depend on CODE
    plan.steps[0]!.dependsOn = ['S004'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('later phase'))).toBe(true);
  });

  it('rejects design outputs containing src/*.py', () => {
    const plan = makePlan();
    plan.steps[1]!.outputs = ['docs/02-high-level-design.md', 'docs/tests/module-test-plan.md', 'src/leak.py'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('must not output implementation'))).toBe(true);
  });

  it('requires executable tests to be owned by paired left-side phases', () => {
    const plan = makePlan();
    plan.steps[4]!.outputs.push('tests/late_unit.py');
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('UNIT_TEST is validation-only'))).toBe(true);
  });

  it('still bans FUNCTIONAL_TEST step from producing src/*.py', () => {
    const plan = makePlan();
    plan.steps[7]!.outputs = [...baseDeliveryDocs, 'src/leak.py'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('FUNCTIONAL_TEST is validation-only'))).toBe(true);
  });

  it('requires paired test plans from left-side V-model phases', () => {
    const plan = makePlan();
    plan.steps[1]!.outputs = ['docs/02-high-level-design.md'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('MODULE_TEST plan'))).toBe(true);
  });

  it('rejects empty / too-short systemPrompt', () => {
    const plan = makePlan();
    plan.steps[0]!.systemPrompt = 'too short';
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('systemPrompt too short'))).toBe(true);
  });

  it('requires an architecture contract for clearly multi-surface requirements', () => {
    const plan = makePlan({
      requirementDigest: 'Build an OpenAPI server with CLI import/export commands and SQLite persistence.',
    });
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('require architectureModules'))).toBe(true);
  });

  it('requires an architecture contract for multi-surface incremental work', () => {
    const plan = makePlan({
      language: 'typescript',
      intent: 'feature',
      requirementDigest: 'Extend the existing API and auth workflow with reporting export support.',
      baselineSummary: [
        '## Existing project memory',
        '## Module map',
        '- src/api/server.ts: source module',
        '- src/auth/service.ts: source module',
        '- src/reporting/service.ts: source module',
        '- src/persistence/store.ts: source module',
      ].join('\n'),
    });
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('require architectureModules'))).toBe(true);
  });

  it('allows a surgical incremental change on a small baseline', () => {
    const plan = makePlan({
      language: 'typescript',
      intent: 'feature',
      requirementDigest: 'Rename one reporting formatter helper.',
      baselineSummary: [
        '## Existing project memory',
        '## Module map',
        '- src/reporting/service.ts: source module',
        '- src/reporting/format.ts: source module',
      ].join('\n'),
    });
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('Non-trivial request detected'))).toBe(false);
  });
});

describe('topoSort', () => {
  it('orders by dependencies', () => {
    const plan = makePlan();
    const order = topoSort(plan.steps).map((s) => s.id);
    expect(order).toEqual(['S001', 'S002', 'S003', 'S004', 'S005', 'S006', 'S007', 'S008']);
  });

  it('throws on cycle', () => {
    const plan = makePlan();
    plan.steps[0]!.dependsOn = ['S005'];
    expect(() => topoSort(plan.steps)).toThrow();
  });
});
