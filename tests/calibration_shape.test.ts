import { describe, it, expect } from 'vitest';
import { calibrateDocPaths, calibrateStepShape, ensureEssentialToolRefs } from '../src/agents/calibration.js';
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
    expect(s!.tools).toEqual(['skill:tester']);
    expect(s!.dependsOn).toEqual([]);
    expect(s!.maxRetries).toBe(3);
  });

  it('adds phase-aware default tools when a writable step forgot to declare any', () => {
    const raw = [
      { id: 'S001', phase: 'DETAILED_DESIGN', title: '任务拆解', description: '编写任务清单', systemPrompt: 'x'.repeat(30), role: 'Planner', outputs: ['docs/03-detailed-design.md'] },
      { id: 'S002', phase: 'UNIT_TEST', title: '补测试', description: '写测试并执行', systemPrompt: 'x'.repeat(30), role: 'Tester', outputs: ['tests/test_app.py'] },
      { id: 'S003', phase: 'CODE', title: '实现代码', description: '编写实现', systemPrompt: 'x'.repeat(30), role: 'Coder', outputs: ['src/app.py'] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out[0]!.tools).toEqual(['skill:author']);
    expect(out[1]!.tools).toEqual(['skill:tester']);
    expect(out[2]!.tools).toEqual(['skill:author']);
  });

  it('preserves tester capabilities when a test phase already has a write tool', () => {
    const tools = ensureEssentialToolRefs({
      phase: 'UNIT_TEST',
      tools: ['write_file'],
      outputs: ['tests/test_app.py', 'docs/05-unit-test.md'],
    });

    expect(tools).toEqual(expect.arrayContaining(['write_file', 'skill:tester']));
  });

  it('pairs explicit write_file and append_file so chunked authoring is available in old plans', () => {
    expect(ensureEssentialToolRefs({
      phase: 'CODE',
      tools: ['write_file'],
      outputs: ['src/app.ts'],
    })).toEqual(['write_file', 'append_file']);

    expect(ensureEssentialToolRefs({
      phase: 'CODE',
      tools: ['append_file'],
      outputs: ['src/app.ts'],
    })).toEqual(['append_file', 'write_file']);
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

  it('infers phase from src/ vs tests/ outputs when phase is missing entirely', () => {
    const raw = [
      { id: 'S001', title: 'a', description: 'a', systemPrompt: 'x'.repeat(30), role: 'Coder', outputs: ['src/foo.py'] },
      { id: 'S002', title: 'b', description: 'b', systemPrompt: 'x'.repeat(30), role: 'Tester', outputs: ['tests/test_foo.py'] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out[0]!.phase).toBe('CODE');
    expect(out[1]!.phase).toBe('UNIT_TEST');
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
