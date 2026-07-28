import { describe, it, expect } from 'vitest';
import { buildPlan } from '../src/agents/planner.js';
import { lintPlan } from '../src/core/lint.js';
import { PlanSchema } from '../src/core/plan.js';
import { renderPlanMarkdown } from '../src/core/render.js';
import type { Step } from '../src/core/plan.js';

const baseStep = (over: Partial<Step>): Step =>
  ({
    id: 'S001',
    iterationId: over.iterationId ?? 'P1',
    phase: 'REQUIREMENT_ANALYSIS',
    title: 't',
    description: 'd',
    systemPrompt: 'sp'.repeat(20),
    role: 'Planner',
    tools: ['write_file'],
    inputs: [],
    outputs: ['docs/01-requirement-analysis.md'],
    dependsOn: [],
    acceptance: 'ok',
    maxRetries: 3,
    ...over,
  }) as Step;

describe('buildPlan — Step id 规整', () => {
  it("把 'id_S009' 这种异常 id 修成 'S009'，并同步更新 dependsOn 引用", () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['pytest==8.*'],
      steps: [
        baseStep({ id: 'S001' }),
        baseStep({ id: 'id_S009', phase: 'UNIT_TEST', outputs: ['tests/x.py'], dependsOn: ['S001'] }),
        baseStep({ id: 'S010', phase: 'UNIT_TEST', outputs: ['tests/y.py'], dependsOn: ['id_S009'] }),
      ],
    };
    const plan = buildPlan(draft);
    expect(plan.steps[1]?.id).toBe('S009');
    expect(plan.steps[2]?.dependsOn).toEqual(['S009']);
    // 整体仍要能通过 schema 校验（id 字段）
    const ids = plan.steps.map((s) => s.id);
    for (const id of ids) expect(id).toMatch(/^S\d{3,}$/);
  });

  it("'S9' -> 'S009'，'step-12' -> 'S012'", () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['pytest==8.*'],
      steps: [baseStep({ id: 'S9' }), baseStep({ id: 'step-12', dependsOn: ['S9'] })],
    };
    const plan = buildPlan(draft);
    expect(plan.steps.map((s) => s.id)).toEqual(['S009', 'S012']);
    expect(plan.steps[1]?.dependsOn).toEqual(['S009']);
  });

  it('buildPlan 输出能通过 PlanSchema id 字段约束（仅检查 id 部分）', () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['pytest==8.*'],
      steps: [baseStep({ id: 'id_S009' })],
    };
    const plan = buildPlan(draft);
    // 只取 id 用 schema 子验证；其它 lint 由独立 lint 流程负责。
    const StepIdOnly = (PlanSchema as any).shape?.steps?._def?.type?.shape?.id;
    if (StepIdOnly) {
      expect(StepIdOnly.safeParse(plan.steps[0]?.id).success).toBe(true);
    } else {
      expect(plan.steps[0]?.id).toMatch(/^S\d{3,}$/);
    }
  });

  it('为 TypeScript plan 注入的 UNIT_TEST 兜底保持 Vitest 语义', () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['vitest'],
      steps: [
        baseStep({ id: 'S001', phase: 'CODE', role: 'Coder', outputs: ['src/main.ts'] }),
      ],
    };
    const plan = buildPlan(draft, { language: 'typescript' });
    const synthetic = plan.steps[1];
    expect(synthetic?.phase).toBe('UNIT_TEST');
    expect(synthetic?.systemPrompt).toContain('npm test / Vitest');
    expect(synthetic?.acceptance).toContain('Vitest');
    expect(plan.steps[0]?.outputs).toContain('tests/unit_s001.test.ts');
  });

  it('校准 TypeScript greenfield 的 package.json 与测试文件产物归属', () => {
    const draft = {
      requirementDigest: 'TypeScript CLI news briefing tool',
      globalPrompt: 'Fetch public news pages, generate markdown briefing, and expose a CLI.',
      projectType: 'application' as const,
      complexityAssessment: {
        level: 'simple' as const,
        rationale: 'single-iteration fixture',
        splitRecommended: false,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core functionality',
          objective: 'Deliver the runnable CLI news briefing slice.',
          status: 'current' as const,
          scope: ['CLI', 'fetcher', 'brief generation'],
          deliverables: ['Runnable TypeScript CLI'],
          dependsOn: [],
          verificationGate: {
            summary: 'P1 gate',
            checks: ['tests pass'],
            failurePolicy: 'Feed failures to Debugger, roll back to the paired V-model phase, and rerun subsequent phases.',
          },
        },
      ],
      dependencies: ['vitest', 'tsx', 'typescript'],
      architectureModules: [
        {
          id: 'M001',
          name: 'news-fetcher',
          responsibility: 'Fetch and normalize public news items.',
          sourcePaths: ['src/news-fetcher.ts'],
          testPaths: ['tests/news-fetcher.test.ts'],
          dependencies: [],
        },
      ],
      steps: [
        baseStep({ id: 'S001', phase: 'REQUIREMENT_ANALYSIS', role: 'Planner', outputs: ['docs/01-requirement-analysis.md', 'docs/tests/functional-test-plan.md'] }),
        baseStep({ id: 'S002', phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: ['docs/02-high-level-design.md', 'docs/tests/module-test-plan.md'], dependsOn: ['S001'] }),
        baseStep({ id: 'S003', phase: 'DETAILED_DESIGN', role: 'Architect', outputs: ['docs/03-detailed-design.md', 'docs/tests/integration-test-plan.md'], dependsOn: ['S002'] }),
        baseStep({
          id: 'S004',
          phase: 'CODE',
          role: 'Coder',
          outputs: ['src/news-fetcher.ts', 'tests/news-fetcher.test.ts', 'docs/tests/unit-test-plan.md', 'package.json', 'tsconfig.json'],
          dependsOn: ['S003'],
        }),
        baseStep({ id: 'S005', phase: 'UNIT_TEST', role: 'Tester', outputs: ['docs/05-unit-test.md'], dependsOn: ['S004'] }),
        baseStep({ id: 'S006', phase: 'INTEGRATION_TEST', role: 'Tester', outputs: ['docs/06-integration-test.md', 'tests/integration/news-cli.test.ts'], dependsOn: ['S005'] }),
        baseStep({ id: 'S007', phase: 'MODULE_TEST', role: 'Tester', outputs: ['docs/07-module-test.md', 'tests/news-fetcher.test.ts'], dependsOn: ['S006'] }),
        baseStep({ id: 'S008', phase: 'FUNCTIONAL_TEST', role: 'Tester', outputs: ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'], dependsOn: ['S007'] }),
      ],
    };

    const plan = buildPlan(draft, { language: 'typescript', intent: 'greenfield' });
    const hld = plan.steps.find((step) => step.phase === 'HIGH_LEVEL_DESIGN');
    const code = plan.steps.find((step) => step.phase === 'CODE');
    const moduleTest = plan.steps.find((step) => step.phase === 'MODULE_TEST');

    expect(hld?.outputs).toContain('package.json');
    expect(hld?.outputs).toContain('tsconfig.json');
    expect(hld?.systemPrompt).toContain('TypeScript runtime/test contract');
    expect(hld?.systemPrompt).toContain('"test": "vitest run"');
    expect(hld?.systemPrompt).toContain('`tsconfig.json`');
    expect(hld?.systemPrompt).toContain('禁止新增或要求 `jest`');
    expect(code?.outputs).not.toContain('package.json');
    expect(code?.outputs).not.toContain('tsconfig.json');
    expect(code?.outputs).not.toContain('tests/news-fetcher.test.ts');
    expect(hld?.outputs).toContain('tests/news-fetcher.test.ts');
    expect(moduleTest?.outputs).not.toContain('tests/news-fetcher.test.ts');
    expect(moduleTest?.inputs).toContain('tests/news-fetcher.test.ts');
    expect(lintPlan(plan).filter((issue) => issue.level === 'error')).toEqual([]);
  });

  it('补齐同一 iteration 内 V 模型宏 Step 的相邻依赖链', () => {
    const draft = {
      requirementDigest: 'DBC CLI to Excel',
      globalPrompt: 'g',
      dependencies: ['pytest'],
      steps: [
        baseStep({ id: 'S001', phase: 'REQUIREMENT_ANALYSIS', role: 'Planner', outputs: ['docs/01-requirement-analysis.md'] }),
        baseStep({ id: 'S002', phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: ['docs/02-high-level-design.md'], dependsOn: ['S001'] }),
        baseStep({ id: 'S003', phase: 'DETAILED_DESIGN', role: 'Architect', outputs: ['docs/03-detailed-design.md'], dependsOn: ['S002'] }),
        baseStep({ id: 'S004', phase: 'CODE', role: 'Coder', outputs: ['src/main.py'], dependsOn: [] }),
        baseStep({ id: 'S005', phase: 'UNIT_TEST', role: 'Tester', outputs: ['tests/test_main.py'], dependsOn: ['S004'] }),
        baseStep({ id: 'S006', phase: 'INTEGRATION_TEST', role: 'Tester', outputs: ['tests/test_integration.py'], dependsOn: ['S005'] }),
        baseStep({ id: 'S007', phase: 'MODULE_TEST', role: 'Tester', outputs: ['tests/test_module.py'], dependsOn: ['S006'] }),
        baseStep({ id: 'S008', phase: 'FUNCTIONAL_TEST', role: 'Tester', outputs: ['README.md'], dependsOn: ['S007'] }),
      ],
    };
    const plan = buildPlan(draft);
    expect(plan.steps.find((step) => step.id === 'S004')?.dependsOn).toContain('S003');
    expect(plan.steps.find((step) => step.id === 'S008')?.dependsOn).toContain('S007');
  });

  it('为复杂或强制分阶段需求生成 P1 当前迭代和 planned 后续迭代', () => {
    const draft = {
      requirementDigest: 'Build a complex reporting platform. Phase 1 core import, Phase 2 dashboard.',
      globalPrompt: 'g',
      dependencies: ['pytest'],
      steps: [baseStep({ id: 'S001', phase: 'CODE', role: 'Coder', outputs: ['src/main.py'] })],
    };
    const plan = buildPlan(draft);
    expect(plan.complexityAssessment?.splitRecommended).toBe(true);
    expect(plan.complexityAssessment?.userForcedPhaseSplit).toBe(true);
    expect(plan.implementationPhases?.[0]?.id).toBe('P1');
    expect(plan.implementationPhases?.[0]?.status).toBe('current');
    expect(plan.implementationPhases?.some((phase) => phase.status === 'planned')).toBe(true);
    expect(plan.implementationPhases?.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects Step subTasks deeper than two levels', () => {
    const plan = buildPlan({
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['pytest'],
      steps: [
        baseStep({
          id: 'S001',
          subTasks: [
            {
              id: 'T1',
              title: 'one',
              description: 'one',
              subTasks: [
                {
                  id: 'T1.1',
                  title: 'two',
                  description: 'two',
                  subTasks: [{ id: 'T1.1.1', title: 'three', description: 'three' }],
                },
              ],
            },
          ],
        }),
      ],
    });
    const parsed = PlanSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes('nested at most 2 levels'))).toBe(true);
    }
  });

  it('把结构化 HIGH_LEVEL_DESIGN 契约注入 HIGH_LEVEL_DESIGN/CODE/MODULE_TEST 的执行提示', () => {
    const draft = {
      requirementDigest: 'small API module',
      globalPrompt: 'g',
      dependencies: ['pytest'],
      architectureModules: [
        {
          id: 'M001',
          name: 'api',
          responsibility: 'Expose the bounded application API surface.',
          sourcePaths: ['src/api.py'],
          testPaths: ['tests/test_api.py'],
          dependencies: [],
        },
      ],
      steps: [
        baseStep({ id: 'S001', phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: ['docs/02-high-level-design.md'] }),
        baseStep({ id: 'S002', phase: 'CODE', role: 'Coder', outputs: ['src/api.py'], dependsOn: ['S001'] }),
        baseStep({ id: 'S003', phase: 'MODULE_TEST', role: 'Tester', outputs: ['tests/test_api.py'], dependsOn: ['S002'] }),
      ],
    };
    const plan = buildPlan(draft);
    expect(plan.steps[0]?.systemPrompt).toContain('M001 api');
    expect(plan.steps[1]?.systemPrompt).toContain('本 CODE Step 仅实现架构模块');
    expect(plan.steps[2]?.systemPrompt).toContain('本 MODULE_TEST Step 只检查并运行');
  });

  it('把误放在 architectureModules.dependencies 的外部包迁移到顶层 dependencies', () => {
    const draft = {
      requirementDigest: 'TypeScript CLI fetcher',
      globalPrompt: 'g',
      dependencies: ['typescript'],
      architectureModules: [
        {
          id: 'M001',
          name: 'fetcher',
          responsibility: 'Fetch and parse public content for the CLI.',
          sourcePaths: ['src/fetcher.ts'],
          testPaths: ['tests/fetcher.test.ts'],
          dependencies: ['cheerio', 'M002'],
        },
        {
          id: 'M002',
          name: 'cli',
          responsibility: 'Expose the command line entrypoint.',
          sourcePaths: ['src/cli.ts'],
          testPaths: ['tests/cli.test.ts'],
          dependencies: ['commander'],
        },
      ],
      steps: [
        baseStep({ id: 'S001', phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: ['docs/02-high-level-design.md'] }),
        baseStep({ id: 'S002', phase: 'CODE', role: 'Coder', outputs: ['src/fetcher.ts', 'src/cli.ts'], dependsOn: ['S001'] }),
        baseStep({ id: 'S003', phase: 'MODULE_TEST', role: 'Tester', outputs: ['tests/fetcher.test.ts', 'tests/cli.test.ts'], dependsOn: ['S002'] }),
      ],
    };

    const plan = buildPlan(draft, { language: 'typescript' });

    expect(plan.dependencies).toEqual(expect.arrayContaining(['typescript', 'cheerio', 'commander']));
    expect(plan.architectureModules?.[0]?.dependencies).toEqual(['M002']);
    expect(plan.architectureModules?.[1]?.dependencies).toEqual([]);
  });

  it('把误放在 sourcePaths 的产品运行时资产迁移到 assetPaths', () => {
    const plan = buildPlan({
      requirementDigest: 'TypeScript CLI renders a bundled text template.',
      globalPrompt: 'Keep the template available at runtime.',
      dependencies: ['handlebars'],
      architectureModules: [
        {
          id: 'M001',
          name: 'template',
          responsibility: 'Own the bundled runtime template used by the renderer.',
          sourcePaths: ['src/templates/brief.md.hbs'],
          testPaths: ['tests/template.test.ts'],
          dependencies: [],
        },
      ],
      steps: [
        baseStep({ id: 'S001', phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: ['docs/02-high-level-design.md'] }),
        baseStep({ id: 'S002', phase: 'CODE', role: 'Coder', outputs: ['src/templates/brief.md.hbs'], dependsOn: ['S001'] }),
        baseStep({ id: 'S003', phase: 'MODULE_TEST', role: 'Tester', outputs: ['tests/template.test.ts'], dependsOn: ['S002'] }),
      ],
    }, { language: 'typescript' });

    expect(plan.architectureModules?.[0]?.sourcePaths).toEqual([]);
    expect(plan.architectureModules?.[0]?.assetPaths).toEqual(['src/templates/brief.md.hbs']);
    expect(plan.steps.find((step) => step.phase === 'CODE')?.subTasks?.[0]?.outputs).toEqual([
      'src/templates/brief.md.hbs',
    ]);
  });

  it('plan markdown 层级展示 V-model macro Step 与两层 subTasks', () => {
    const plan = buildPlan({
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['pytest'],
      steps: [
        baseStep({
          id: 'S001',
          phase: 'CODE',
          role: 'Coder',
          outputs: ['src/main.py'],
          subTasks: [
            {
              id: 'T1',
              title: 'Core module',
              description: 'Implement the core module.',
              acceptance: 'Core module works.',
              outputs: ['src/core.py'],
              subTasks: [
                {
                  id: 'T1.1',
                  title: 'Parser',
                  description: 'Implement parser helper.',
                  acceptance: 'Parser accepts examples.',
                  outputs: ['src/parser.py'],
                },
              ],
            },
          ],
        }),
      ],
    });
    const markdown = renderPlanMarkdown(plan);
    expect(markdown).toContain('## V-model macro workflow');
    expect(markdown).toContain('- S001 P1 CODE:');
    expect(markdown).toContain('  - T1: Core module [src/core.py]');
    expect(markdown).toContain('    - T1.1: Parser [src/parser.py]');
  });
});
