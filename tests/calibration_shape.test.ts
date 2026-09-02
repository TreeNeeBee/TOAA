import { describe, it, expect } from 'vitest';
import {
  calibrateDocPaths,
  calibrateProducedInputGlobs,
  calibrateStepShape,
  ensureEssentialToolRefs,
} from '../src/agents/calibration.js';
import type { Step } from '../src/core/plan.js';

describe('calibrateStepShape', () => {
  it('backfills missing role / acceptance / systemPrompt with phase-aware defaults', () => {
    const raw = [
      // 模拟 LLM 漏写 role 与 acceptance 的 FUNCTIONAL_TEST Step
      {
        id: 'S011',
        phase: 'FUNCTIONAL_TEST',
        title: '项目交付物准备',
        description: '编写交付文档',
        systemPrompt: '你现在是 ',
        inputs: [],
        outputs: ['docs/08-functional-test.md'],
      },
    ] as unknown as Step[];
    const [s] = calibrateStepShape(raw);
    expect(s!.role).toBe('Tester');
    expect(s!.acceptance.length).toBeGreaterThan(0);
    expect(s!.systemPrompt.length).toBeGreaterThanOrEqual(20);
    expect(s!.tools).toEqual([
      'skill:test-execution',
      'skill:record-replay-fixtures',
      'skill:verification-before-delivery',
      'read_file',
      'list_dir',
    ]);
    expect(s!.dependsOn).toEqual([]);
    expect(s!.maxAttempts).toBe(3);
  });

  it('adds phase-aware default tools when a writable step forgot to declare any', () => {
    const raw = [
      { id: 'S001', phase: 'DETAILED_DESIGN', title: '任务拆解', description: '编写任务清单', systemPrompt: 'x'.repeat(30), role: 'Planner', outputs: ['docs/03-detailed-design.md'] },
      { id: 'S002', phase: 'UNIT_TEST', title: '补测试', description: '写测试并执行', systemPrompt: 'x'.repeat(30), role: 'Tester', outputs: ['tests/test_app.py'] },
      { id: 'S003', phase: 'CODE', title: '实现代码', description: '编写实现', systemPrompt: 'x'.repeat(30), role: 'Coder', outputs: ['src/app.py'] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out[0]!.tools).toEqual([
      'skill:artifact-authoring',
      'skill:test-design',
      'read_file',
      'list_dir',
      'run_tests',
    ]);
    expect(out[1]!.tools).toEqual([
      'skill:test-execution',
      'skill:record-replay-fixtures',
      'read_file',
      'list_dir',
    ]);
    expect(out[2]!.tools).toEqual([
      'skill:artifact-authoring',
      'skill:test-design',
      'run_program',
      'run_tests',
      'read_file',
      'list_dir',
    ]);
  });

  it('preserves tester capabilities when a test phase already has a write tool', () => {
    const tools = ensureEssentialToolRefs({
      phase: 'UNIT_TEST',
      tools: ['write_file'],
      outputs: ['tests/test_app.py', 'docs/05-unit-test.md'],
    });

    expect(tools).toEqual(expect.arrayContaining(['write_file', 'skill:test-execution']));
  });

  // From a live run: CODE needed a package, `add_dependency` refused because HIGH_LEVEL_DESIGN owns
  // the manifest, the Change Request routed there and the flow rolled back — and HIGH_LEVEL_DESIGN
  // had only authoring tools, which carry no `add_dependency`. Every dependency Change Request ended
  // at a Step told to do something it had no tool to do. The dependency Skill was wired to nobody.
  // A planner that declared only write tools left three of the four development phases unable to
  // read anything. The Change Request disposition contract requires inspecting the affected
  // artifacts before recording an outcome, so a Step that cannot read produces no valid completion
  // and spends its whole round budget — how a downstream dependency re-check stalled without making
  // a single tool call.
  // The delivery gate requires S1-S3 to execute their baseline suites once a correction routed back
  // from CODE proves a product baseline exists. The runner is injected automatically at that point,
  // but only if the Step has it — and none of the three did, so the requirement passed silently
  // without a single test being executed.
  it('gives a baseline-owning phase the runner its delivery gate can require', async () => {
    const { buildDefaultSkills } = await import('../src/skills/index.js');
    for (const phase of [
      'REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN', 'CODE',
    ] as const) {
      const refs = ensureEssentialToolRefs({
        phase,
        tools: ['write_file', 'append_file'],
        outputs: ['docs/x.md', 'tests/unit/a.test.ts'],
      });
      expect(buildDefaultSkills().resolve(refs).resolvedToolNames, phase).toContain('run_tests');
    }
  });

  it('gives every Step the ability to read what it is judged on', async () => {
    const { buildDefaultSkills } = await import('../src/skills/index.js');
    for (const phase of [
      'REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN', 'CODE',
      'UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST',
    ] as const) {
      const refs = ensureEssentialToolRefs({
        phase,
        tools: ['write_file', 'append_file'],
        outputs: ['docs/x.md'],
      });
      const effective = buildDefaultSkills().resolve(refs).resolvedToolNames;
      expect(effective, phase).toContain('read_file');
      expect(effective, phase).toContain('list_dir');
    }
  });

  it('hands the manifest owner the tool it owns', async () => {
    const tools = ensureEssentialToolRefs({
      phase: 'HIGH_LEVEL_DESIGN',
      tools: ['write_file', 'append_file'],
      outputs: ['docs/02-high-level-design.md', 'package.json'],
    });
    expect(tools).toEqual(expect.arrayContaining(['skill:dependency-resolution']));

    // What matters is the tool the Step can actually call once skills are expanded.
    const { buildDefaultSkills } = await import('../src/skills/index.js');
    expect(buildDefaultSkills().resolve(tools).resolvedToolNames)
      .toEqual(expect.arrayContaining(['add_dependency']));
  });

  it('gives it to no other design phase, because the ownership is exclusive', async () => {
    const { buildDefaultSkills } = await import('../src/skills/index.js');
    for (const phase of ['REQUIREMENT_ANALYSIS', 'DETAILED_DESIGN'] as const) {
      const tools = ensureEssentialToolRefs({
        phase,
        tools: ['write_file', 'append_file'],
        outputs: ['docs/01-requirement-analysis.md'],
      });
      expect(buildDefaultSkills().resolve(tools).resolvedToolNames, phase).not.toContain('add_dependency');
    }
  });

  it('pairs explicit write_file and append_file for context-sized authoring', () => {
    expect(ensureEssentialToolRefs({
      phase: 'CODE',
      tools: ['write_file'],
      outputs: ['src/app.ts'],
    })).toEqual([
      'write_file',
      'skill:artifact-authoring',
      'skill:test-design',
      'run_program',
      'run_tests',
      'append_file',
      'read_file',
      'list_dir',
    ]);

    expect(ensureEssentialToolRefs({
      phase: 'CODE',
      tools: ['append_file'],
      outputs: ['src/app.ts'],
    })).toEqual([
      'append_file',
      'skill:artifact-authoring',
      'skill:test-design',
      'run_program',
      'run_tests',
      'write_file',
      'read_file',
      'list_dir',
    ]);
  });

  it('maps role aliases to whitelist (developer -> Coder, qa -> Tester)', () => {
    const raw = [
      { id: 'S001', phase: 'CODE', title: 'x', description: 'x', systemPrompt: 'this is a long enough prompt for code', role: 'developer', outputs: ['src/x.py'] },
      { id: 'S002', phase: 'UNIT_TEST', title: 'y', description: 'y', systemPrompt: 'this is a long enough prompt for test', role: 'QA', outputs: [] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out[0]!.role).toBe('Coder');
    expect(out[1]!.role).toBe('Tester');
  });

  it('falls back to phase default when role is junk', () => {
    const raw = [
      { id: 'S001', phase: 'HIGH_LEVEL_DESIGN', title: 'a', description: 'a', systemPrompt: 'x'.repeat(30), role: 'wizard', outputs: ['docs/02-high-level-design.md'] },
    ] as unknown as Step[];
    expect(calibrateStepShape(raw)[0]!.role).toBe('Architect');
  });

  it('normalizes valid but phase-incompatible roles back to the phase owner', () => {
    const raw = [
      { id: 'S001', phase: 'DETAILED_DESIGN', title: 'a', description: 'a', systemPrompt: 'x'.repeat(30), role: 'Coder', outputs: ['docs/03-detailed-design.md'] },
      { id: 'S002', phase: 'CODE', title: 'b', description: 'b', systemPrompt: 'x'.repeat(30), role: 'Tester', outputs: ['src/app.py'] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out[0]!.role).toBe('Architect');
    expect(out[1]!.role).toBe('Coder');
  });

  it('infers phase from outputs path when LLM writes a junk phase like "---"', () => {
    // 真实回放：用户报错 S008 phase="---" 但 outputs=["docs/05-delivery.md"]，校准为新 FUNCTIONAL_TEST
    const raw = [
      { id: 'S008', phase: '---', title: '项目交付物清单', description: 'd', systemPrompt: 'x'.repeat(30), role: 'Planner', outputs: ['docs/05-delivery.md'] },
    ] as unknown as Step[];
    expect(calibrateStepShape(raw)[0]!.phase).toBe('FUNCTIONAL_TEST');
  });

  it('maps phase aliases to the canonical V-model phases', () => {
    const raw = [
      { id: 'S001', phase: 'design', title: 'a', description: 'a', systemPrompt: 'x'.repeat(30), role: 'Architect', outputs: [] },
      { id: 'S002', phase: 'implement', title: 'b', description: 'b', systemPrompt: 'x'.repeat(30), role: 'Coder', outputs: [] },
      { id: 'S003', phase: 'packaging', title: 'c', description: 'c', systemPrompt: 'x'.repeat(30), role: 'Planner', outputs: [] },
      { id: 'S004', phase: 'testing', title: 'd', description: 'd', systemPrompt: 'x'.repeat(30), role: 'Tester', outputs: [] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out.map((s) => s.phase)).toEqual(['DETAILED_DESIGN', 'CODE', 'FUNCTIONAL_TEST', 'UNIT_TEST']);
  });

  it('infers src and executable test outputs as CODE-owned when phase is missing', () => {
    const raw = [
      { id: 'S001', title: 'a', description: 'a', systemPrompt: 'x'.repeat(30), role: 'Coder', outputs: ['src/foo.py'] },
      { id: 'S002', title: 'b', description: 'b', systemPrompt: 'x'.repeat(30), role: 'Tester', outputs: ['tests/test_foo.py'] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out[0]!.phase).toBe('CODE');
    expect(out[1]!.phase).toBe('CODE');
    expect(out[1]!.role).toBe('Coder');
  });

  it('adds delivery documentation bundle paths based on project type', () => {
    const raw = [
      { id: 'S001', phase: 'FUNCTIONAL_TEST', title: 'd', description: 'd', systemPrompt: 'x'.repeat(30), role: 'Tester', outputs: ['docs/08-functional-test.md'] },
    ] as unknown as Step[];
    expect(calibrateDocPaths(raw, 'application')[0]!.outputs).toEqual([
      'README.md',
      'docs/quickstart.md',
      'docs/08-functional-test.md',
    ]);
    expect(calibrateDocPaths(raw, 'library')[0]!.outputs).toEqual([
      'README.md',
      'docs/quickstart.md',
      'docs/08-functional-test.md',
      'docs/api-guide.md',
    ]);
  });

  it('normalizes and guarantees the canonical topic input for requirement analysis', () => {
    const raw = [
      {
        id: 'S001',
        phase: 'REQUIREMENT_ANALYSIS',
        title: 'requirements',
        description: 'requirements',
        systemPrompt: 'x'.repeat(30),
        role: 'Planner',
        inputs: ['docs/project-topic.md'],
        outputs: ['docs/topic.md'],
      },
      {
        id: 'S002',
        phase: 'REQUIREMENT_ANALYSIS',
        title: 'requirements without declared input',
        description: 'requirements without declared input',
        systemPrompt: 'x'.repeat(30),
        role: 'Planner',
        inputs: [],
        outputs: [],
      },
    ] as unknown as Step[];

    const out = calibrateDocPaths(raw, 'application');

    expect(out[0]!.inputs).toEqual(['docs/topic.md']);
    expect(out[0]!.outputs).not.toContain('docs/topic.md');
    expect(out[1]!.inputs).toEqual(['docs/topic.md']);
  });

  it('removes test-plan docs from the right-side test phases that do not own them', () => {
    const raw = [
      {
        id: 'S001',
        phase: 'CODE',
        title: 'code',
        description: 'code',
        systemPrompt: 'x'.repeat(30),
        role: 'Coder',
        outputs: ['src/app.py', 'docs/tests/unit-test-plan.md'],
      },
      {
        id: 'S002',
        phase: 'UNIT_TEST',
        title: 'unit',
        description: 'unit',
        systemPrompt: 'x'.repeat(30),
        role: 'Tester',
        outputs: ['docs/tests/unit-test-plan.md', 'tests/test_app.py'],
        dependsOn: ['S001'],
      },
    ] as unknown as Step[];

    const out = calibrateDocPaths(raw, 'application');

    expect(out[0]!.outputs).toContain('docs/tests/unit-test-plan.md');
    expect(out[1]!.outputs).toEqual(['docs/05-unit-test.md', 'tests/test_app.py']);
  });

  it('normalizes noncanonical test-plan doc names before removing wrong phase ownership', () => {
    const raw = [
      {
        id: 'S001',
        phase: 'CODE',
        title: 'code',
        description: 'code',
        systemPrompt: 'x'.repeat(30),
        role: 'Coder',
        outputs: ['src/app.ts', 'docs/04-unit-test-plan.md', 'docs/tests/unit-test-plan.md'],
      },
      {
        id: 'S002',
        phase: 'UNIT_TEST',
        title: 'unit',
        description: 'unit',
        systemPrompt: 'x'.repeat(30),
        role: 'Tester',
        outputs: ['docs/unit_test_plan.md', 'tests/app.test.ts'],
        dependsOn: ['S001'],
      },
    ] as unknown as Step[];

    const out = calibrateDocPaths(raw, 'application');

    expect(out[0]!.outputs).toContain('docs/tests/unit-test-plan.md');
    expect(out[0]!.outputs.filter((item) => item === 'docs/tests/unit-test-plan.md')).toHaveLength(1);
    expect(out[0]!.outputs).not.toContain('docs/04-unit-test-plan.md');
    expect(out[0]!.outputs).not.toContain('docs/unit_test_plan.md');
    expect(out[1]!.outputs).toEqual(['docs/05-unit-test.md', 'tests/app.test.ts']);
  });
});

describe('calibrateProducedInputGlobs', () => {
  it('expands a produced glob to exact Step outputs and leaves an unmatched glob rejectable', () => {
    const steps = [
      {
        id: 'S004',
        inputs: [],
        outputs: ['src/main.ts', 'src/services/report.ts', 'src/schema.json'],
      },
      {
        id: 'S005',
        inputs: ['src/**/*.ts', 'tests/missing/**/*.ts'],
        outputs: ['docs/05-unit-test.md'],
      },
    ] as Step[];

    expect(calibrateProducedInputGlobs(steps)[1]!.inputs).toEqual([
      'src/main.ts',
      'src/services/report.ts',
      'tests/missing/**/*.ts',
    ]);
  });
});

// A delivered project passed 115 assertions of the form `expect(typeof item.title).toBe('string')`
// while every one of its hundred records carried the same summary twice: every field present,
// every type right, the content wrong. Whether an assertion examines a value or its type cannot be
// told from source text with any reliability, so the acceptance level is told what it owes instead,
// and the Phase delivery gate judges the same question against the run's real output.
describe('acceptance level owes outcome assertions', () => {
  it('requires the FUNCTIONAL_TEST Step to assert produced content, not shape', async () => {
    const { calibrateDocPaths } = await import('../src/agents/calibration.js');
    const steps = [
      { id: 'S008', phase: 'FUNCTIONAL_TEST', acceptance: 'Acceptance suite passes.',
        inputs: [], outputs: [] },
      { id: 'S004', phase: 'CODE', acceptance: 'Product compiles.', inputs: [], outputs: [] },
    ] as never;

    const [acceptanceStep, codeStep] = calibrateDocPaths(steps, 'application');

    expect(acceptanceStep!.acceptance).toContain('Acceptance suite passes.');
    expect(acceptanceStep!.acceptance).toContain('assert what the produced result contains');
    // Phrased without any domain vocabulary: the Step it instructs may be verifying a scraper, a
    // compiler, a migration, or a report.
    expect(acceptanceStep!.acceptance).not.toMatch(/news|scrape|http|markdown/iu);
    // Only the acceptance level owes this; the levels that build the product are untouched.
    expect(codeStep!.acceptance).toBe('Product compiles.');
  });

  it('does not restate the requirement when it is already there', async () => {
    const { calibrateDocPaths } = await import('../src/agents/calibration.js');
    const once = calibrateDocPaths(
      [{ id: 'S008', phase: 'FUNCTIONAL_TEST', acceptance: 'a', inputs: [], outputs: [] }] as never,
      'application',
    );
    const twice = calibrateDocPaths(once, 'application');
    const occurrences = twice[0]!.acceptance.split('assert what the produced result contains').length - 1;
    expect(occurrences).toBe(1);
  });
});
