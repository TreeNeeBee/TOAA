import { describe, it, expect } from 'vitest';
import { Planner } from '../src/agents/planner.js';
import { LLMRequestError } from '../src/llm/errors.js';
import type { ChatMessage, ChatOptions, LLMClient } from '../src/llm/types.js';

function fakeLLM(reply: string | string[]): LLMClient {
  const replies = Array.isArray(reply) ? reply : [reply];
  let calls = 0;
  return {
    name: 'fake',
    async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      const current = replies[Math.min(calls, replies.length - 1)]!;
      calls += 1;
      // 模拟 router/Fallback 的行为：先跑 validate，失败立即抛出（让 FallbackClient 切换 provider）。
      if (options?.validate) options.validate(current);
      return current;
    },
  };
}

function observingLLM(reply: string, seen: ChatMessage[][]): LLMClient {
  return {
    name: 'observing',
    async chat(messages, options): Promise<string> {
      seen.push(messages);
      if (options?.validate) options.validate(reply);
      return reply;
    },
  };
}

/**
 * Mimics the provider router: a validate failure is not raised as itself, it is aggregated into one
 * `all LLM providers failed` error carrying the last underlying failure as `cause`. `fakeLLM` above
 * raises the underlying error directly, which is why the repair loop looked covered while never
 * firing in a real run.
 */
function routedLLM(reply: string[]): LLMClient {
  const replies = reply;
  let calls = 0;
  return {
    name: 'routed',
    async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      const current = replies[Math.min(calls, replies.length - 1)]!;
      calls += 1;
      if (options?.validate) {
        try {
          options.validate(current);
        } catch (error) {
          throw new LLMRequestError(
            `all LLM providers failed for role Planner: primary: ${(error as Error).message}`,
            {
              code: 'all_providers_failed',
              mode: 'router',
              retryable: true,
              switchProvider: true,
              details: { contentRejectedOnly: true },
            },
            { cause: error },
          );
        }
      }
      return current;
    },
  };
}

const minimalStep = (id: string, phase: string, outputs: string[] = [], iterationId = 'P1') =>
  ({
    id,
    iterationId,
    phase,
    title: `${phase} ${id}`,
    description: 'd',
    systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
    role: 'Coder',
    tools: [],
    inputs: [],
    outputs,
    dependsOn: [],
    acceptance: 'ok',
  });

const phaseRole: Record<string, string> = {
  REQUIREMENT_ANALYSIS: 'Planner',
  HIGH_LEVEL_DESIGN: 'Architect',
  DETAILED_DESIGN: 'Architect',
  CODE: 'Coder',
  UNIT_TEST: 'Tester',
  INTEGRATION_TEST: 'Tester',
  MODULE_TEST: 'Tester',
  FUNCTIONAL_TEST: 'Tester',
};

function iterationDoc(iterationId: string, basename: string): string {
  return iterationId === 'P1' ? `docs/${basename}` : `docs/iterations/${iterationId}/${basename}`;
}

function iterationTestPlan(iterationId: string, basename: string): string {
  return iterationId === 'P1' ? `docs/tests/${basename}` : `docs/iterations/${iterationId}/tests/${basename}`;
}

function testPhaseDeliveryGate(name: string) {
  return {
    kind: 'phase-delivery' as const,
    summary: `${name} real-user delivery gate`,
    checks: ['Run the primary real-user flow.'],
    testAssetPolicy: 'phase-aggregate' as const,
    externalDataPolicy: 'live' as const,
    scenarios: [{
      name: `${name.toLowerCase()}-primary-flow`,
      description: 'Exercise the fixture as a real user.',
      operation: 'Run the primary fixture command.',
      environment: 'live' as const,
      expected: 'The command succeeds.',
      execution: { command: 'python', args: ['-c', 'print("ok")'] },
    }],
    freezeBeforeExecution: true,
    routeEachFinding: true as const,
  };
}

function withDeliveryGates<T extends { implementationPhases: readonly Record<string, unknown>[] }>(plan: T): T {
  return {
    ...plan,
    implementationPhases: plan.implementationPhases.map((phase) => ({
      ...phase,
      deliveryGate: phase.deliveryGate ?? testPhaseDeliveryGate(String(phase.id ?? 'phase')),
    })),
  } as T;
}

function vModelSteps(iterationId = 'P1', start = 1, sourcePath = 'src/x.py', moduleTestPath = 'tests/test_x.py') {
  const functionalDocs = iterationId === 'P1'
    ? ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md']
    : [iterationDoc(iterationId, '08-functional-test.md'), iterationDoc(iterationId, 'quickstart.md')];
  const specs: Array<[string, string[]]> = [
    ['REQUIREMENT_ANALYSIS', [iterationDoc(iterationId, '01-requirement-analysis.md'), iterationTestPlan(iterationId, 'functional-test-plan.md')]],
    ['HIGH_LEVEL_DESIGN', [iterationDoc(iterationId, '02-high-level-design.md'), iterationTestPlan(iterationId, 'module-test-plan.md')]],
    ['DETAILED_DESIGN', [iterationDoc(iterationId, '03-detailed-design.md'), iterationTestPlan(iterationId, 'integration-test-plan.md')]],
    ['CODE', [sourcePath, iterationTestPlan(iterationId, 'unit-test-plan.md')]],
    ['UNIT_TEST', [iterationDoc(iterationId, '05-unit-test.md'), `tests/test_unit_${iterationId.toLowerCase()}.py`]],
    ['INTEGRATION_TEST', [iterationDoc(iterationId, '06-integration-test.md'), `tests/test_integration_${iterationId.toLowerCase()}.py`]],
    ['MODULE_TEST', [iterationDoc(iterationId, '07-module-test.md'), moduleTestPath]],
    ['FUNCTIONAL_TEST', functionalDocs],
  ];
  return specs.map(([phase, outputs], index) => ({
    ...minimalStep(`S${String(start + index).padStart(3, '0')}`, phase, outputs, iterationId),
    role: phaseRole[phase] ?? 'Coder',
    dependsOn: index === 0 ? [] : [`S${String(start + index - 1).padStart(3, '0')}`],
  }));
}

const planMetadata = {
  projectType: 'application',
  complexityAssessment: {
    level: 'simple',
    rationale: 'test fixture',
    splitRecommended: false,
    userForcedPhaseSplit: false,
  },
  implementationPhases: [
    {
      id: 'P1',
      title: 'Core functionality',
      objective: 'Exercise the planner skeleton fixture.',
      status: 'current',
      scope: ['Core fixture'],
      deliverables: ['Valid draft plan'],
      dependsOn: [],
      deliveryGate: testPhaseDeliveryGate('P1'),
    },
  ],
};

const clarifyOptions = [
  { label: 'A', answer: 'Use the recommended default setting for phase one.' },
  { label: 'B', answer: 'Use the stricter enterprise-oriented setting.' },
  { label: 'C', answer: 'Use the smallest demonstrable setting.' },
];

const withClarifyOptions = <T extends { options?: typeof clarifyOptions }>(question: T): T & { options: typeof clarifyOptions } => ({
  ...question,
  options: question.options ?? clarifyOptions,
});

const projectShapeQuestions = [
  {
    id: 'Q1',
    category: 'functionality',
    question: 'Who are the primary users of the weather data capability?',
    why: 'Defines the user-facing journeys.',
  },
  {
    id: 'Q2',
    category: 'data',
    question: 'Which weather fields must be accepted and returned?',
    why: 'Defines the input and output contract.',
  },
  {
    id: 'Q3',
    category: 'acceptance',
    question: 'What examples should prove the API is correct?',
    why: 'Defines verifiable acceptance cases.',
  },
  {
    id: 'Q4',
    category: 'functionality',
    question: 'How should unknown locations be handled?',
    why: 'Defines failure behaviour.',
  },
  {
    id: 'Q5',
    category: 'data',
    question: 'Should responses include raw provider payloads or normalized values only?',
    why: 'Defines the data boundary.',
  },
  {
    id: 'Q6',
    category: 'boundary',
    question: 'Should this deliverable be an API library or SDK, a runnable application or service, or a mixed deliverable with both?',
    why: 'Determines projectType and delivery documentation.',
  },
  {
    id: 'Q7',
    category: 'quality',
    question: 'What concrete latency and reliability targets should the weather lookup meet?',
    why: 'Defines measurable quality gates.',
  },
  {
    id: 'Q8',
    category: 'extensibility',
    question: 'Which future provider or forecast capability should the design keep stable for?',
    why: 'Defines extension points.',
  },
  {
    id: 'Q9',
    category: 'data',
    question: 'Do you already have a weather provider API key, token, or auth method for this external API call?',
    why: 'Determines whether implementation should use user-provided credentials or a public no-key provider.',
    options: [
      { label: 'A', answer: 'No credentials are available; use a public no-key/no-token weather API by default.' },
      { label: 'B', answer: 'Use a user-provided API key or token from environment variables.' },
      { label: 'C', answer: 'Support both configured credentials and a no-key public fallback.' },
    ],
  },
].map(withClarifyOptions);

const languageClarificationQuestion = {
  id: 'Q10',
  category: 'boundary',
  question: 'Which development language should this project use for the first delivery?',
  why: 'Determines whether XCompiler should generate Python or TypeScript runtime, tests, and sandbox commands.',
  options: [
    { label: 'A', answer: 'Python CLI/script implementation, the default when no language is specified.' },
    { label: 'B', answer: 'TypeScript / Node.js CLI implementation.' },
  ],
};

describe('Planner.decompose — V 模型骨架完整性校验', () => {
  it('澄清阶段在 API/library 与应用形态不明时必须提出项目形态问题', async () => {
    const questionsWithoutShape = projectShapeQuestions.map((question) =>
      question.id === 'Q6'
        ? {
            ...question,
            question: 'Which external weather provider is in scope for the first release?',
            why: 'Defines external-system ownership.',
          }
        : question,
    );
    const p = new Planner(fakeLLM(JSON.stringify(questionsWithoutShape)));
    await expect(p.clarify('Build an API for weather data')).rejects.toThrow(/project shape question/);
  });

  it('澄清阶段接受显式 API library / application / mixed 边界问题', async () => {
    const p = new Planner(fakeLLM(JSON.stringify(projectShapeQuestions)));
    const questions = await p.clarify('Build an API for weather data');
    expect(questions.some((question) => question.question.includes('API library'))).toBe(true);
  });

  it('澄清阶段在外部 API 需求中必须确认凭证或免 key 接口策略', async () => {
    const questionsWithoutCredential = projectShapeQuestions.filter((question) => question.id !== 'Q9');
    const p = new Planner(fakeLLM(JSON.stringify(questionsWithoutCredential)));
    await expect(p.clarify('Build a CLI that fetches weather data from an external API')).rejects.toThrow(/external API credential question/);
  });

  it('澄清阶段在 topic 无法判断开发语言时必须确认 Python 或 TypeScript', async () => {
    const p = new Planner(fakeLLM(JSON.stringify(projectShapeQuestions)));
    await expect(
      p.clarify('Build a report generator tool', { languageAmbiguous: true }),
    ).rejects.toThrow(/development language question/);
  });

  it('澄清阶段接受开发语言确认问题', async () => {
    const p = new Planner(fakeLLM(JSON.stringify([...projectShapeQuestions, languageClarificationQuestion])));
    const questions = await p.clarify('Build a report generator tool', { languageAmbiguous: true });
    expect(questions.some((question) => question.question.includes('development language'))).toBe(true);
  });

  it('拒绝只有 REQUIREMENT_ANALYSIS + HIGH_LEVEL_DESIGN 两步的残缺 plan（用户回放）', async () => {
    const draft = {
      requirementDigest: '批量 DBC → Excel',
      globalPrompt: '',
      ...planMetadata,
      dependencies: ['pytest'],
      steps: vModelSteps().slice(0, 2),
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/Planner draft incomplete/);
  });

  it('计划契约可修复失败会带反馈重试，而不是直接中止 build', async () => {
    const sourcePaths = [
      'src/cli_entry.py',
      'src/dbc_parser.py',
      'src/signal_filter.py',
      'src/excel_exporter.py',
    ];
    const testPaths = [
      'tests/test_module_cli_entry.py',
      'tests/test_module_dbc_parser.py',
      'tests/test_module_signal_filter.py',
      'tests/test_module_excel_exporter.py',
    ];
    const steps = vModelSteps('P1', 1, sourcePaths[0], testPaths[0]);
    const code = steps.find((step) => step.phase === 'CODE')!;
    code.outputs = [...sourcePaths, 'docs/tests/unit-test-plan.md'];
    code.subTasks = sourcePaths.map((sourcePath, index) => ({
      id: `ST${String(index + 1).padStart(3, '0')}`,
      title: `Implement M00${index + 1}`,
      description: `Implement ${sourcePath}`,
      outputs: [sourcePath],
      subTasks: [],
    }));
    const moduleTest = steps.find((step) => step.phase === 'MODULE_TEST')!;
    moduleTest.outputs = ['docs/07-module-test.md', ...testPaths];
    const architectureModules = sourcePaths.map((sourcePath, index) => ({
      id: `M00${index + 1}`,
      name: `Module ${index + 1}`,
      responsibility: `Own ${sourcePath}`,
      sourcePaths: [sourcePath],
      testPaths: [testPaths[index]!],
      dependencies: index === 0 ? [] : [`M00${index}`],
    }));
    const phasePlan = {
      requirementDigest: 'DBC CLI parses files, filters signals, and writes Excel output.',
      globalPrompt: 'Build a DBC to Excel CLI.',
      projectType: 'application',
      complexityAssessment: {
        level: 'moderate',
        rationale: 'CLI plus parser, filter, and Excel IO modules.',
        splitRecommended: true,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core DBC export',
          objective: 'Deliver the core CLI conversion path.',
          status: 'current',
          scope: ['parse DBC', 'filter ECU signals', 'write Excel'],
          deliverables: ['CLI', 'Excel output'],
          dependsOn: [],
          verificationGate: {
            summary: 'Run generated tests and CLI smoke checks.',
            checks: ['pytest', 'CLI help'],
            failurePolicy: 'Create Bug Ticket, send failure log to Debugger, rollback to paired V-model phase, then rerun subsequent phases.',
          },
        },
        {
          id: 'P2',
          title: 'Robust reporting',
          objective: 'Enhance error CSV and performance checks.',
          status: 'planned',
          scope: ['error reporting'],
          deliverables: ['error report'],
          dependsOn: ['P1'],
          verificationGate: {
            summary: 'Run regression and performance checks.',
            checks: ['pytest'],
            failurePolicy: 'Create Bug Ticket and repair through V-model rollback.',
          },
        },
      ],
    };
    const invalidStepPlan = {
      requirementDigest: phasePlan.requirementDigest,
      globalPrompt: phasePlan.globalPrompt,
      dependencies: ['pytest', 'openpyxl', 'jsonschema'],
      architectureModules: architectureModules.slice(0, 3),
      steps,
    };
    const validStepPlan = {
      ...invalidStepPlan,
      architectureModules,
    };
    const p = new Planner(fakeLLM([
      JSON.stringify(withDeliveryGates(phasePlan)),
      JSON.stringify(invalidStepPlan),
      JSON.stringify(validStepPlan),
    ]));

    const draft = await p.decompose({
      rawRequirement: '写一个 python CLI，解析 dbc 文件，按 ECU 过滤信号并写入 Excel。',
      clarifications: [],
    });

    expect(draft.architectureModules).toHaveLength(4);
    expect(draft.steps.find((step) => step.phase === 'CODE')?.subTasks).toHaveLength(4);
  });

  it('拒绝旧 V 模型阶段名，避免 alias 校准掩盖 planner 输出错误', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      ...planMetadata,
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'TASK', ['docs/03-tasks.md']),
        minimalStep('S004', 'CODE', ['src/x.py']),
        minimalStep('S005', 'TEST', ['tests/test_x.py']),
        minimalStep('S006', 'REFACTOR', ['docs/04-refactor.md']),
        minimalStep('S007', 'DELIVERY', ['docs/05-delivery.md']),
      ],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/non-canonical phase/);
  });

  it('拒绝缺 CODE 的 plan（即使其他阶段齐全）', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      ...planMetadata,
      dependencies: ['pytest'],
      steps: vModelSteps().filter((step) => step.phase !== 'CODE'),
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/missing=\[CODE\]/);
  });

  it('拒绝缺 FUNCTIONAL_TEST 的 plan', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      ...planMetadata,
      dependencies: ['pytest'],
      steps: vModelSteps().filter((step) => step.phase !== 'FUNCTIONAL_TEST'),
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/missing=\[FUNCTIONAL_TEST\]/);
  });

  it('拒绝缺 UNIT_TEST 的 plan', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      ...planMetadata,
      dependencies: ['pytest'],
      steps: vModelSteps().filter((step) => step.phase !== 'UNIT_TEST'),
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/missing=\[UNIT_TEST\]/);
  });

  it('接受 V 模型宏阶段完整的 plan', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      ...planMetadata,
      dependencies: ['pytest'],
      steps: vModelSteps(),
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    const out = await p.decompose({ rawRequirement: 'x', clarifications: [] });
    expect(out.steps.length).toBe(8);
  });

  it('拒绝缺少复杂度评估或 implementation phase 的 plan', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      projectType: 'application',
      dependencies: ['pytest'],
      steps: vModelSteps(),
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/complexityAssessment/);
  });

  it('拒绝缺少 projectType 的 plan，避免本地推断掩盖 LLM 判定缺失', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      complexityAssessment: {
        level: 'simple',
        rationale: 'test fixture',
        splitRecommended: false,
        userForcedPhaseSplit: false,
      },
      implementationPhases: planMetadata.implementationPhases,
      dependencies: ['pytest'],
      steps: vModelSteps(),
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/projectType/);
  });

  it('拒绝没有可执行真实用户场景的 PhasePlan', async () => {
    const phaseWithoutGate = { ...planMetadata.implementationPhases[0]!, deliveryGate: undefined };
    const phasePlan = {
      requirementDigest: 'Build a runnable command.',
      globalPrompt: '',
      projectType: 'application',
      complexityAssessment: planMetadata.complexityAssessment,
      implementationPhases: [phaseWithoutGate],
    };
    const planner = new Planner(fakeLLM(JSON.stringify(phasePlan)));

    await expect(planner.decompose({ rawRequirement: 'Build a runnable command.', clarifications: [] }))
      .rejects.toThrow(/deliveryGate with executable real-user scenarios/);
  });

  it('拒绝把完整 shell 命令塞进 TypeScript Phase 交付场景的 command 字段', async () => {
    const invalid = withDeliveryGates({
      requirementDigest: 'Build a small TypeScript command.',
      globalPrompt: '',
      projectType: 'application',
      complexityAssessment: planMetadata.complexityAssessment,
      implementationPhases: planMetadata.implementationPhases,
    });
    invalid.implementationPhases[0]!.deliveryGate.scenarios[0]!.execution = {
      command: 'npx ts-node src/main.ts',
      args: [],
    };
    const planner = new Planner(fakeLLM(JSON.stringify(invalid)), undefined, 'typescript');

    await expect(planner.planPhasePlan({
      rawRequirement: 'Build a small TypeScript command.',
      clarifications: [],
    })).rejects.toThrow(/execution\.command must contain one executable only/);
  });

  it('拒绝 StepPlan 未交付 Phase 真实场景引用的 TypeScript 入口', async () => {
    const phasePlan = withDeliveryGates({
      requirementDigest: 'Build a small TypeScript command.',
      globalPrompt: '',
      projectType: 'application',
      complexityAssessment: planMetadata.complexityAssessment,
      implementationPhases: planMetadata.implementationPhases,
    });
    phasePlan.implementationPhases[0]!.deliveryGate.scenarios[0]!.execution = {
      command: 'npx',
      args: ['tsx', 'src/main.ts'],
    };
    const stepPlan = {
      requirementDigest: phasePlan.requirementDigest,
      globalPrompt: '',
      dependencies: ['typescript', 'tsx', 'vitest'],
      architectureModules: [{
        id: 'M001',
        name: 'CliEntrypoint',
        responsibility: 'Own the complete command entrypoint and its observable behavior.',
        sourcePaths: ['src/cli.ts'],
        testPaths: ['tests/cli.test.ts'],
        dependencies: [],
      }],
      steps: vModelSteps('P1', 1, 'src/cli.ts', 'tests/cli.test.ts'),
    };
    const planner = new Planner(
      fakeLLM([JSON.stringify(phasePlan), JSON.stringify(stepPlan)]),
      undefined,
      'typescript',
    );

    await expect(planner.decompose({
      rawRequirement: phasePlan.requirementDigest,
      clarifications: [],
    })).rejects.toThrow(/src\/main\.ts.*not delivered|not delivered.*src\/main\.ts/);
  });

  it('多阶段需求先生成 PhasePlan，再只展开当前 P1 的 V 模型 StepPlan', async () => {
    const requirementDigest = 'Build a staged number formatting utility. Phase 1 core, Phase 2 polish, Phase 3 scale.';
    const phasePlan = {
      requirementDigest,
      globalPrompt: '',
      projectType: 'application',
      complexityAssessment: {
        level: 'complex',
        rationale: 'user requested staged delivery across three phases',
        splitRecommended: true,
        userForcedPhaseSplit: true,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core functionality',
          objective: 'Deliver the core formatting slice.',
          status: 'current',
          scope: ['Core formatting workflow'],
          deliverables: ['Runnable utility'],
          dependsOn: [],
        },
        {
          id: 'P2',
          title: 'Polish',
          objective: 'Improve formatting and configuration after P1.',
          status: 'planned',
          scope: ['Formatting', 'Configuration'],
          deliverables: ['Deferred polish plan'],
          dependsOn: ['P1'],
        },
        {
          id: 'P3',
          title: 'Scale',
          objective: 'Add larger input handling and performance checks.',
          status: 'planned',
          scope: ['Scale guardrails'],
          deliverables: ['Deferred scale plan'],
          dependsOn: ['P2'],
        },
      ],
    };
    const stepPlan = {
      requirementDigest,
      globalPrompt: '',
      dependencies: ['pytest'],
      steps: vModelSteps('P1', 1, 'src/main.py', 'tests/test_main.py'),
    };
    const p = new Planner(fakeLLM([JSON.stringify(withDeliveryGates(phasePlan)), JSON.stringify(stepPlan)]));
    const plan = await p.decompose({ rawRequirement: requirementDigest, clarifications: [] });
    expect(plan.implementationPhases?.map((phase) => phase.id)).toEqual(['P1', 'P2', 'P3']);
    expect(plan.steps).toHaveLength(8);
    expect(plan.steps.every((step) => step.iterationId === 'P1')).toBe(true);
  });

  it('激活后只展开 P2，并保留 P1 complete 与未来阶段目标', async () => {
    const requirementDigest = 'Add presentation polish after the completed core utility.';
    const phasePlan = {
      requirementDigest,
      globalPrompt: 'Preserve P1 behavior.',
      projectType: 'application' as const,
      complexityAssessment: {
        level: 'moderate' as const,
        rationale: 'Core and polish are separate iterations.',
        splitRecommended: true,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core',
          objective: 'Completed core utility.',
          status: 'complete' as const,
          scope: ['Core'],
          deliverables: ['Core utility'],
          dependsOn: [],
        },
        {
          id: 'P2',
          title: 'Polish',
          objective: 'Add presentation polish.',
          status: 'current' as const,
          scope: ['Presentation'],
          deliverables: ['Polished output'],
          dependsOn: ['P1'],
        },
      ],
    };
    const stepPlan = {
      requirementDigest,
      globalPrompt: 'Preserve P1 behavior.',
      dependencies: ['pytest'],
      steps: vModelSteps('P2', 1, 'src/presentation.py', 'tests/test_presentation.py'),
    };
    const planner = new Planner(fakeLLM(JSON.stringify(stepPlan)));

    const plan = await planner.decomposePhase(
      { rawRequirement: requirementDigest, clarifications: [], intent: 'feature' },
      withDeliveryGates(phasePlan),
      'P2',
    );

    expect(plan.implementationPhases?.map((phase) => `${phase.id}:${phase.status}`))
      .toEqual(['P1:complete', 'P2:current']);
    expect(plan.steps.every((step) => step.iterationId === 'P2')).toBe(true);
  });

  it('StepPlan receives Skill metadata but not inactive instructions', async () => {
    const seen: ChatMessage[][] = [];
    const stepPlan = {
      requirementDigest: 'Build the core fixture.',
      globalPrompt: '',
      dependencies: ['pytest'],
      steps: vModelSteps('P1', 1, 'src/main.py', 'tests/test_main.py'),
    };
    const planner = new Planner(observingLLM(JSON.stringify(stepPlan), seen));
    await planner.decomposePhase(
      { rawRequirement: 'Build the core fixture.', clarifications: [] },
      withDeliveryGates({
        requirementDigest: 'Build the core fixture.',
        globalPrompt: '',
        ...planMetadata,
      }),
      'P1',
    );

    const system = seen[0]?.find((message) => message.role === 'system')?.content ?? '';
    expect(system).toContain('skill:systematic-debugging');
    expect(system).toContain('Investigate and repair reproducible software failures');
    expect(system).not.toContain('## 1. Establish Evidence');
    expect(system).not.toContain('Treat Debug Wiki matches as hypotheses');
  });

  it('PhasePlan 校验失败时会把错误反馈给 Planner 并重试', async () => {
    const requirementDigest = 'Build a small number formatter and add presentation polish in a later phase.';
    const invalidPhasePlan = {
      requirementDigest,
      globalPrompt: '',
      projectType: 'application',
      complexityAssessment: {
        level: 'moderate',
        rationale: 'multi-step delivery',
        splitRecommended: true,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core functionality',
          objective: 'Deliver the core number formatting function.',
          status: 'current',
          scope: ['Number formatting'],
          deliverables: ['Formatting function'],
          dependsOn: [],
        },
      ],
    };
    const repairedPhasePlan = {
      ...invalidPhasePlan,
      implementationPhases: [
        ...invalidPhasePlan.implementationPhases,
        {
          id: 'P2',
          title: 'Reporting export',
          objective: 'Add presentation polish after P1.',
          status: 'planned',
          scope: ['Presentation polish'],
          deliverables: ['Polished output format'],
          dependsOn: ['P1'],
        },
      ],
    };
    const stepPlan = {
      requirementDigest: 'P1 core number formatting function.',
      globalPrompt: '',
      dependencies: ['pytest'],
      steps: vModelSteps('P1', 1, 'src/main.py', 'tests/test_main.py'),
    };

    const p = new Planner(fakeLLM([
      JSON.stringify(withDeliveryGates(invalidPhasePlan)),
      JSON.stringify(withDeliveryGates(repairedPhasePlan)),
      JSON.stringify(stepPlan),
    ]));
    const plan = await p.decompose({ rawRequirement: requirementDigest, clarifications: [] });

    expect(plan.implementationPhases?.map((phase) => phase.id)).toEqual(['P1', 'P2']);
    expect(plan.steps).toHaveLength(8);
  });

  it('模块契约测试被 CODE 当作单元测试时会反馈并重试', async () => {
    const requirementDigest = 'Build a small TypeScript CLI.';
    const phasePlan = {
      requirementDigest,
      globalPrompt: '',
      projectType: 'application' as const,
      complexityAssessment: {
        level: 'simple' as const,
        rationale: 'one bounded CLI',
        splitRecommended: false,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core',
          objective: 'Deliver the CLI.',
          status: 'current' as const,
          scope: ['CLI'],
          deliverables: ['Runnable CLI'],
          dependsOn: [],
        },
      ],
    };
    const moduleTestPath = 'tests/modules/cli-contract.test.ts';
    const module = {
      id: 'M001',
      name: 'CLI',
      responsibility: 'Own command parsing and dispatch.',
      sourcePaths: ['src/main.ts'],
      testPaths: [moduleTestPath],
      dependencies: [],
    };
    const invalidSteps = vModelSteps('P1', 1, 'src/main.ts', moduleTestPath);
    invalidSteps[3] = {
      ...invalidSteps[3]!,
      outputs: [...invalidSteps[3]!.outputs, moduleTestPath],
    };
    const repairedSteps = vModelSteps('P1', 1, 'src/main.ts', moduleTestPath);
    const invalid = {
      requirementDigest,
      globalPrompt: '',
      dependencies: ['typescript', 'vitest'],
      architectureModules: [module],
      steps: invalidSteps,
    };
    const repaired = { ...invalid, steps: repairedSteps };
    const planner = new Planner(
      fakeLLM([JSON.stringify(invalid), JSON.stringify(repaired)]),
      undefined,
      'typescript',
    );

    const plan = await planner.decomposePhase(
      { rawRequirement: requirementDigest, clarifications: [] },
      withDeliveryGates(phasePlan),
      'P1',
    );

    expect(plan.steps.find((step) => step.phase === 'CODE')?.outputs).not.toContain(moduleTestPath);
    expect(plan.architectureModules?.[0]?.testPaths).toEqual([moduleTestPath]);
  });

  // From a live run: the planner gave README.md to both CODE and FUNCTIONAL_TEST, and the plan rules
  // only ran after decompose returned — so the build died with exit 3 after two model calls, and the
  // one party able to repair the plan was never told. The rules now run inside the repair loop.
  it('两个 Step 抢同一个 output 时会带反馈重试，而不是让 build 直接失败', async () => {
    const requirementDigest = 'Build a small TypeScript CLI.';
    const phasePlan = {
      requirementDigest,
      globalPrompt: '',
      projectType: 'application' as const,
      complexityAssessment: {
        level: 'simple' as const,
        rationale: 'one bounded CLI',
        splitRecommended: false,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core',
          objective: 'Deliver the CLI.',
          status: 'current' as const,
          scope: ['CLI'],
          deliverables: ['Runnable CLI'],
          dependsOn: [],
        },
      ],
    };
    const moduleTestPath = 'tests/modules/cli-contract.test.ts';
    const module = {
      id: 'M001',
      name: 'CLI',
      responsibility: 'Own command parsing and dispatch.',
      sourcePaths: ['src/main.ts'],
      testPaths: [moduleTestPath],
      dependencies: [],
    };
    // S008 FUNCTIONAL_TEST already owns README.md; CODE claiming it too is the live failure.
    const contendedSteps = vModelSteps('P1', 1, 'src/main.ts', moduleTestPath);
    contendedSteps[3] = {
      ...contendedSteps[3]!,
      outputs: [...contendedSteps[3]!.outputs, 'README.md'],
    };
    const contended = {
      requirementDigest,
      globalPrompt: '',
      dependencies: ['typescript', 'vitest'],
      architectureModules: [module],
      steps: contendedSteps,
    };
    const repaired = { ...contended, steps: vModelSteps('P1', 1, 'src/main.ts', moduleTestPath) };
    const planner = new Planner(
      fakeLLM([JSON.stringify(contended), JSON.stringify(repaired)]),
      undefined,
      'typescript',
    );

    const plan = await planner.decomposePhase(
      { rawRequirement: requirementDigest, clarifications: [] },
      withDeliveryGates(phasePlan),
      'P1',
    );

    expect(plan.steps.find((step) => step.phase === 'CODE')?.outputs).not.toContain('README.md');
    expect(plan.steps.find((step) => step.phase === 'FUNCTIONAL_TEST')?.outputs).toContain('README.md');
  });

  // The repair loop keys on the failure being repairable. The router wraps every per-provider
  // failure in one aggregate error, so reading only the outer message matched nothing and the loop
  // rethrew immediately — a whole live build died at decompose with a plan the planner could have
  // fixed.
  it('修复轮次在 router 包装错误后仍然触发', async () => {
    const requirementDigest = 'Build a small TypeScript CLI.';
    const phasePlan = {
      requirementDigest,
      globalPrompt: '',
      projectType: 'application' as const,
      complexityAssessment: {
        level: 'simple' as const,
        rationale: 'one bounded CLI',
        splitRecommended: false,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core',
          objective: 'Deliver the CLI.',
          status: 'current' as const,
          scope: ['CLI'],
          deliverables: ['Runnable CLI'],
          dependsOn: [],
        },
      ],
    };
    const moduleTestPath = 'tests/modules/cli-contract.test.ts';
    const module = {
      id: 'M001',
      name: 'CLI',
      responsibility: 'Own command parsing and dispatch.',
      sourcePaths: ['src/main.ts'],
      testPaths: [moduleTestPath],
      dependencies: [],
    };
    const contendedSteps = vModelSteps('P1', 1, 'src/main.ts', moduleTestPath);
    contendedSteps[3] = {
      ...contendedSteps[3]!,
      outputs: [...contendedSteps[3]!.outputs, 'README.md'],
    };
    const contended = {
      requirementDigest,
      globalPrompt: '',
      dependencies: ['typescript', 'vitest'],
      architectureModules: [module],
      steps: contendedSteps,
    };
    const repaired = { ...contended, steps: vModelSteps('P1', 1, 'src/main.ts', moduleTestPath) };
    const planner = new Planner(
      routedLLM([JSON.stringify(contended), JSON.stringify(repaired)]),
      undefined,
      'typescript',
    );

    const plan = await planner.decomposePhase(
      { rawRequirement: requirementDigest, clarifications: [] },
      withDeliveryGates(phasePlan),
      'P1',
    );

    expect(plan.steps.find((step) => step.phase === 'CODE')?.outputs).not.toContain('README.md');
  });

  it('router 聚合的不完整 JSON 仍会进入 Planner 外层结构修复', async () => {
    const requirementDigest = 'Build a small TypeScript CLI.';
    const phasePlan = withDeliveryGates({
      requirementDigest,
      globalPrompt: '',
      projectType: 'application' as const,
      complexityAssessment: {
        level: 'simple' as const,
        rationale: 'One compact CLI.',
        splitRecommended: false,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [{
        id: 'P1',
        title: 'Core CLI',
        objective: requirementDigest,
        status: 'current' as const,
        scope: ['CLI'],
        deliverables: ['CLI'],
        dependsOn: [],
        verificationGate: {
          summary: 'Run all gates.',
          checks: ['npm test'],
          failurePolicy: 'Repair through the paired V-model phase.',
        },
      }],
    });
    const moduleTestPath = 'tests/modules/main.test.ts';
    const valid = {
      requirementDigest,
      globalPrompt: '',
      dependencies: ['typescript', 'vitest'],
      architectureModules: [{
        id: 'M001',
        name: 'main',
        responsibility: 'Parse CLI arguments and start the application workflow.',
        sourcePaths: ['src/main.ts'],
        assetPaths: [],
        testPaths: [moduleTestPath],
        dependencies: [],
      }],
      steps: vModelSteps('P1', 1, 'src/main.ts', moduleTestPath),
    };
    const planner = new Planner(
      routedLLM(['{"requirementDigest":"truncated"', JSON.stringify(valid)]),
      undefined,
      'typescript',
    );

    const plan = await planner.decomposePhase(
      { rawRequirement: requirementDigest, clarifications: [] },
      phasePlan,
      'P1',
    );

    expect(plan.steps).toHaveLength(8);
  });

  it('当前 phase 的架构规模门禁不被后续 planned phase 的 surface 误伤', async () => {
    const rawRequirement = '写一个 TypeScript CLI，每日抓取网上热点新闻并生成 Markdown 简报，后续支持定时调度。';
    const phasePlan = {
      requirementDigest: 'TypeScript news briefing CLI with scheduled daily execution planned in a later phase.',
      globalPrompt: '',
      projectType: 'application',
      complexityAssessment: {
        level: 'moderate',
        rationale: 'core CLI and scraping now, scheduler later',
        splitRecommended: true,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core news briefing',
          objective: 'Deliver a TypeScript CLI that fetches public news pages, filters categories, and writes a Markdown briefing.',
          status: 'current',
          scope: ['CLI entrypoint', 'public web scraping', 'category filtering', 'Markdown generation'],
          deliverables: ['Runnable TypeScript CLI', 'Markdown briefing output'],
          dependsOn: [],
          verificationGate: {
            summary: 'P1 core CLI can fetch, filter, and render a briefing.',
            checks: ['CLI starts', 'news items are fetched', 'Markdown contains titles and links'],
            failurePolicy: 'Feed failures to Debugger, roll back to the paired V-model phase, and rerun subsequent phases.',
          },
        },
        {
          id: 'P2',
          title: 'Scheduler',
          objective: 'Add daily scheduling and retry policy after P1.',
          status: 'planned',
          scope: ['workflow scheduler', 'retry policy'],
          deliverables: ['Configurable scheduler'],
          dependsOn: ['P1'],
          verificationGate: {
            summary: 'P2 scheduler works.',
            checks: ['scheduled run triggers'],
            failurePolicy: 'Feed failures to Debugger, roll back to the paired V-model phase, and rerun subsequent phases.',
          },
        },
      ],
    };
    const sourcePaths = ['src/cli.ts', 'src/fetcher.ts', 'src/filter.ts', 'src/brief.ts'];
    const testPaths = ['tests/cli.test.ts', 'tests/fetcher.test.ts', 'tests/filter.test.ts', 'tests/brief.test.ts'];
    const modules = sourcePaths.map((sourcePath, index) => ({
      id: `M${String(index + 1).padStart(3, '0')}`,
      name: ['CliEntrypoint', 'NewsFetcher', 'CategoryFilter', 'BriefRenderer'][index]!,
      responsibility: 'Own one P1 core news briefing boundary.',
      sourcePaths: [sourcePath],
      testPaths: [testPaths[index]!],
      dependencies: index === 0 ? ['M002', 'M003', 'M004'] : index === 1 ? ['cheerio'] : [],
    }));
    const steps = vModelSteps('P1', 1, sourcePaths[0], testPaths[0]);
    steps[3] = {
      ...steps[3]!,
      outputs: [...sourcePaths, 'docs/tests/unit-test-plan.md'],
      subTasks: modules.map((module) => ({
        id: module.id,
        title: `Implement ${module.name}`,
        description: module.responsibility,
        outputs: module.sourcePaths,
      })),
    };
    steps[6] = {
      ...steps[6]!,
      outputs: ['docs/07-module-test.md', ...testPaths],
      subTasks: modules.map((module) => ({
        id: module.id,
        title: `Test ${module.name}`,
        description: module.responsibility,
        outputs: module.testPaths,
      })),
    };
    const stepPlan = {
      requirementDigest: 'TypeScript CLI news briefing core with scheduled daily execution planned later.',
      globalPrompt: '',
      dependencies: ['typescript', 'tsx', 'vitest'],
      architectureModules: modules,
      steps,
    };

    const p = new Planner(fakeLLM([JSON.stringify(withDeliveryGates(phasePlan)), JSON.stringify(stepPlan)]), undefined, 'typescript');
    const plan = await p.decompose({ rawRequirement, clarifications: [] });

    expect(plan.architectureModules).toHaveLength(4);
    expect(plan.architectureModules?.[1]?.dependencies).toEqual([]);
    expect(plan.dependencies).toContain('cheerio');
    expect(plan.steps.every((step) => step.iterationId === 'P1')).toBe(true);
  });

  it('复杂需求缺少 HIGH_LEVEL_DESIGN 模块契约时拒绝 plan，让 fallback 重新生成', async () => {
    const requirementDigest = 'OpenAPI server with CLI import/export and SQLite persistence';
    const phasePlan = {
      requirementDigest,
      globalPrompt: '',
      projectType: 'application',
      complexityAssessment: {
        level: 'complex',
        rationale: 'multi-surface request',
        splitRecommended: true,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core functionality',
          objective: 'Deliver the core OpenAPI server, command line import/export, and SQLite database persistence.',
          status: 'current',
          scope: ['OpenAPI server endpoint', 'command line import/export', 'SQLite database persistence'],
          deliverables: ['Core application'],
          dependsOn: [],
        },
        {
          id: 'P2',
          title: 'Enhancements',
          objective: 'Follow-up enhancements after core delivery.',
          status: 'planned',
          scope: ['Enhancements'],
          deliverables: ['Deferred plan'],
          dependsOn: ['P1'],
        },
        {
          id: 'P3',
          title: 'Scale and operations',
          objective: 'Follow-up operational hardening after core delivery.',
          status: 'planned',
          scope: ['Operational hardening'],
          deliverables: ['Deferred plan'],
          dependsOn: ['P2'],
        },
      ],
    };
    const stepPlan = {
      requirementDigest,
      globalPrompt: '',
      dependencies: ['pytest'],
      steps: vModelSteps('P1', 1, 'src/main.py', 'tests/test_main.py'),
    };
    const p = new Planner(fakeLLM([JSON.stringify(withDeliveryGates(phasePlan)), JSON.stringify(stepPlan)]));
    await expect(
      p.decompose({ rawRequirement: requirementDigest, clarifications: [] }),
    ).rejects.toThrow(/omitted architectureModules/);
  });
});
