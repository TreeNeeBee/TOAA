import { describe, expect, it } from 'vitest';
import { analyzeArchitectureDemand, missingArchitectureDocumentTokens } from '../src/core/architecture.js';
import { lintPlan } from '../src/core/lint.js';
import { PlanSchema, type ArchitectureModule, type Plan, type Step } from '../src/core/plan.js';
import { renderPlanMarkdown } from '../src/core/render.js';

const baseDeliveryDocs = ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'];

const moduleSpecs = [
  ['M001', 'entry', 'Application entry and top-level dependency composition.', 'src/main.py', 'tests/test_main.py'],
  ['M002', 'domain', 'Core domain rules independent from transport and storage.', 'src/domain.py', 'tests/test_domain.py'],
  ['M003', 'api', 'OpenAPI HTTP endpoints and request response adaptation.', 'src/api.py', 'tests/test_api.py'],
  ['M004', 'cli', 'Command line parsing and command dispatch boundaries.', 'src/cli.py', 'tests/test_cli.py'],
  ['M005', 'storage', 'SQLite persistence repository and transaction boundary.', 'src/storage.py', 'tests/test_storage.py'],
  ['M006', 'export', 'Import export conversion and report serialization.', 'src/exporter.py', 'tests/test_exporter.py'],
] as const;

function step(overrides: Partial<Step> & Pick<Step, 'id' | 'phase'>): Step {
  return {
    id: overrides.id,
    iterationId: overrides.iterationId ?? 'P1',
    phase: overrides.phase,
    title: overrides.title ?? `${overrides.phase} ${overrides.id}`,
    description: overrides.description ?? 'Execute one bounded V-model responsibility.',
    systemPrompt: overrides.systemPrompt ?? 'Limit this Step to its declared inputs, outputs, acceptance and forbidden writes.',
    role: overrides.role ?? 'Coder',
    tools: overrides.tools ?? [],
    inputs: overrides.inputs ?? [],
    outputs: overrides.outputs ?? [],
    dependsOn: overrides.dependsOn ?? [],
    acceptance: overrides.acceptance ?? 'Declared output exists and is independently verifiable.',
    maxAttempts: 3,
  };
}

function complexPlan(): Plan {
  const p1Modules: ArchitectureModule[] = moduleSpecs.map((spec, index) => ({
    id: spec[0],
    name: spec[1],
    responsibility: spec[2],
    sourcePaths: [spec[3]],
    testPaths: [spec[4]],
    dependencies: index === 0 ? moduleSpecs.slice(1).map((item) => item[0]) : index >= 2 ? ['M002'] : [],
  }));
  const architectureModules: ArchitectureModule[] = p1Modules;
  const codeSteps = moduleSpecs.map((spec, index) =>
    step({
      id: `S${String(index + 4).padStart(3, '0')}`,
      phase: 'CODE',
      outputs:
        index === 0
          ? [spec[3], 'docs/tests/unit-test-plan.md', 'tests/test_unit.py']
          : [spec[3]],
      inputs: ['docs/02-high-level-design.md', 'docs/03-detailed-design.md'],
      dependsOn: ['S003'],
    }),
  );
  const moduleTestStep = step({
    id: 'S012',
    phase: 'MODULE_TEST',
    role: 'Tester',
    outputs: ['docs/07-module-test.md'],
    inputs: [
      ...moduleSpecs.map((spec) => spec[3]),
      ...moduleSpecs.map((spec) => spec[4]),
    ],
    dependsOn: ['S011', ...codeSteps.map((item) => item.id)],
  });
  return {
    version: '1',
    language: 'python',
    intent: 'greenfield',
    projectType: 'application',
    requirementDigest: 'Build an OpenAPI server with CLI import/export commands and SQLite persistence.',
    complexityAssessment: {
      level: 'complex',
      rationale: 'multi-surface architecture contract fixture',
      splitRecommended: true,
      userForcedPhaseSplit: false,
    },
    implementationPhases: [
      {
        id: 'P1',
        title: 'Core functionality',
        objective: 'Deliver the traceable OpenAPI, CLI, storage, and export core.',
        status: 'current',
        scope: ['Core architecture modules', 'Primary tests', 'Delivery docs'],
        deliverables: ['Runnable core application'],
        dependsOn: [],
        verificationGate: {
          summary: 'P1 gate',
          checks: ['tests pass', 'entrypoint runs', 'delivery docs exist'],
          failurePolicy: 'Repair P1 before continuing.',
        },
      },
      {
        id: 'P2',
        title: 'Enhancements',
        objective: 'Extend operational hardening after the core is stable.',
        status: 'planned',
        scope: ['Operational polish'],
        deliverables: ['Deferred enhancement plan'],
        dependsOn: ['P1'],
        verificationGate: {
          summary: 'P2 gate',
          checks: ['tests pass', 'iteration docs exist'],
          failurePolicy: 'Repair P2 before continuing.',
        },
      },
      {
        id: 'P3',
        title: 'Scale and operations',
        objective: 'Plan scale and operational hardening after enhancement work.',
        status: 'planned',
        scope: ['Scale testing', 'Operational observability'],
        deliverables: ['Deferred scale and operations plan'],
        dependsOn: ['P2'],
        verificationGate: {
          summary: 'P3 gate',
          checks: ['tests pass', 'iteration docs exist'],
          failurePolicy: 'Repair P3 before continuing.',
        },
      },
    ],
    globalPrompt: '',
    baselineSummary: '',
    userAddenda: '',
    architectureModules,
    dependencies: ['pytest'],
    createdAt: '2026-06-22T00:00:00.000Z',
    steps: [
      step({
        id: 'S001',
        phase: 'REQUIREMENT_ANALYSIS',
        role: 'Planner',
        outputs: [
          'docs/01-requirement-analysis.md',
          'docs/tests/functional-test-plan.md',
          'tests/test_functional.py',
        ],
      }),
      step({
        id: 'S002',
        phase: 'HIGH_LEVEL_DESIGN',
        role: 'Architect',
        outputs: [
          'docs/02-high-level-design.md',
          'docs/tests/module-test-plan.md',
          ...moduleSpecs.map((spec) => spec[4]),
        ],
        dependsOn: ['S001'],
      }),
      step({
        id: 'S003',
        phase: 'DETAILED_DESIGN',
        role: 'Architect',
        outputs: [
          'docs/03-detailed-design.md',
          'docs/tests/integration-test-plan.md',
          'tests/test_integration.py',
        ],
        dependsOn: ['S002'],
      }),
      ...codeSteps,
      step({
        id: 'S010',
        phase: 'UNIT_TEST',
        role: 'Tester',
        inputs: ['tests/test_unit.py'],
        outputs: ['docs/05-unit-test.md'],
        dependsOn: codeSteps.map((item) => item.id),
      }),
      step({
        id: 'S011',
        phase: 'INTEGRATION_TEST',
        role: 'Tester',
        inputs: ['tests/test_integration.py'],
        outputs: ['docs/06-integration-test.md'],
        dependsOn: ['S010'],
      }),
      moduleTestStep,
      step({
        id: 'S013',
        phase: 'FUNCTIONAL_TEST',
        inputs: ['tests/test_functional.py'],
        outputs: [...baseDeliveryDocs],
        dependsOn: ['S012'],
      }),
    ],
  };
}

describe('V-model architecture contract', () => {
  it('scales Chinese multi-surface requirements beyond three modules', () => {
    const demand = analyzeArchitectureDemand(
      { requirementDigest: '构建带命令行、HTTP 接口、SQLite 持久化和 Excel 导出的完整系统' },
      'python',
    );
    expect(demand.surfaces).toEqual(expect.arrayContaining(['api', 'cli', 'persistence', 'io']));
    expect(demand.minModules).toBeGreaterThanOrEqual(demand.surfaces.length + 2);
    expect(demand.reasonLabel).toContain('moduleDemand=');
  });

  it('treats domain-heavy platform requirements as complex without infrastructure keywords', () => {
    const demand = analyzeArchitectureDemand(
      { requirementDigest: '开发完整电商平台，包含商品库存、订单履约、支付退款和消息通知' },
      'typescript',
    );
    expect(demand.nonTrivial).toBe(true);
    expect(demand.surfaces).toEqual(expect.arrayContaining(['catalog', 'ordering', 'billing', 'notification']));
    expect(demand.minModules).toBeGreaterThanOrEqual(6);
  });

  it('does not count explicitly excluded infrastructure as architecture surfaces', () => {
    const demand = analyzeArchitectureDemand(
      {
        requirementDigest: '创建一个最小 Python 包，提供 hello.greet 函数和 pytest 测试。',
        rawRequirement: '不使用网络服务、数据库或额外第三方运行时依赖。',
        globalPrompt:
          '规划深度约束示例：API/CLI 接口、持久化、外部集成、流程编排、通知都可能需要拆分。',
      },
      'python',
    );
    expect(demand.surfaces).toEqual([]);
    expect(demand.nonTrivial).toBe(false);
    expect(demand.minModules).toBe(1);
  });

  it('keeps positive surfaces while excluding a negated surface in the same requirement', () => {
    const demand = analyzeArchitectureDemand(
      { requirementDigest: '提供 HTTP API，但不使用数据库；提供 CLI 命令。' },
      'typescript',
    );
    expect(demand.surfaces).toEqual(expect.arrayContaining(['api', 'cli']));
    expect(demand.surfaces).not.toContain('persistence');
    expect(demand.minModules).toBeGreaterThanOrEqual(demand.surfaces.length + 2);
  });

  it('uses topic answers without treating clarification questions as required surfaces', () => {
    const topic = [
      '# Project Topic',
      '',
      '## 原始需求',
      '',
      '写一个 python 脚本，获取当前日期到节假日剩余天数，并把芜湖本周天气整理到终端窗口打印。',
      '',
      '## 澄清记录',
      '',
      '- **Q1 · data** 节假日来源是否调用第三方 API？',
      '  - **Why** 决定是否实现外部 API 调用。',
      '  - **A** 调用第三方API',
      '- **Q2 · functionality** 天气城市是否写入本地配置文件？',
      '  - **Why** 影响是否需要存储配置。',
      '  - **A** 指定城市芜湖',
      '- **Q3 · acceptance** 是否需要复杂的字符串格式化逻辑？',
      '  - **Why** 消除视觉验收主观性。',
      '  - **A** 带emoji的列表',
      '- **Q4 · extensibility** 未来是否计划扩展为邮件或钉钉机器人通知？',
      '  - **Why** 决定输出层是否抽象。',
      '  - **A** 不计划',
    ].join('\n');
    const demand = analyzeArchitectureDemand(
      { requirementDigest: 'Python 终端脚本，调用第三方节假日与天气 API，带 emoji 输出。', rawRequirement: topic },
      'python',
    );
    expect(demand.surfaces).toEqual(expect.arrayContaining(['cli', 'integration']));
    expect(demand.surfaces).not.toContain('persistence');
    expect(demand.surfaces).not.toContain('notification');
    expect(demand.surfaces).not.toContain('api');
    expect(demand.minModules).toBeGreaterThanOrEqual(demand.surfaces.length + 2);
  });

  it('does not overcount API credentials or email suitability as app surfaces for news scraping topics', () => {
    const topic = [
      '# Project Topic',
      '',
      '## 原始需求',
      '',
      '帮我写一个ts程序，每日抓取网上最新的热点新闻信息并生成简报',
      '',
      '## 澄清记录',
      '',
      '- **Q1 · data** 抓取目标的数据源类型与访问凭证情况如何？',
      '  - **Options**',
      '    - A. 使用公开免鉴权的新闻聚合API或RSS Feed，本期默认优先采用',
      '    - B. 用户已提供特定新闻网站的API Key/Token，需集成私有鉴权',
      '    - C. 直接爬取公开网页HTML，需处理反爬策略（如验证码/频率限制）',
      '  - **A** C. 直接爬取公开网页HTML，需处理反爬策略（如验证码/频率限制）',
      '- **Q3 · functionality** 生成的简报采用何种格式与内容结构？',
      '  - **Options**',
      '    - A. 纯文本Markdown格式，包含标题、摘要、原文链接，适合直接粘贴或邮件发送',
      '    - B. 结构化JSON格式，包含元数据、文章列表及分类标签，供下游系统调用',
      '  - **A** A. 纯文本Markdown格式，包含标题、摘要、原文链接，适合直接粘贴或邮件发送',
      '- **Q4 · acceptance** 每日抓取任务的触发时机与执行方式如何定义？',
      '  - **A** C. 支持手动触发与定时调度双模式，通过配置文件切换',
      '- **Q6 · boundary** 本项目的交付形态与运行边界是什么？',
      '  - **A** A. 独立可运行的CLI命令行工具，通过参数触发抓取并输出结果',
      '- **Q7 · boundary** 本期明确不纳入开发范围的功能有哪些？',
      '  - **Options**',
      '    - A. 本期仅聚焦单次抓取与简报生成，不包含用户权限管理、历史简报归档与订阅功能',
      '  - **A** A. 本期仅聚焦单次抓取与简报生成，不包含用户权限管理、历史简报归档与订阅功能',
      '- **Q9 · extensibility** 未来最可能新增的业务能力或扩展维度是什么？',
      '  - **Options**',
      '    - A. 未来可能增加多语言简报生成与用户偏好订阅，需预留配置化数据源与模板接口',
      '    - C. 暂无明确扩展规划，本期以稳定交付核心功能为主，架构保持紧凑',
      '  - **A** C. 暂无明确扩展规划，本期以稳定交付核心功能为主，架构保持紧凑',
    ].join('\n');

    const demand = analyzeArchitectureDemand(
      {
        requirementDigest:
          'TypeScript CLI tool to scrape public HTML news sources without API keys, support manual/scheduled execution, and generate Markdown briefings suitable for email copy-paste.',
        rawRequirement: topic,
      },
      'typescript',
    );

    expect(demand.surfaces).toEqual(expect.arrayContaining(['cli', 'integration', 'workflow']));
    expect(demand.surfaces).not.toContain('api');
    expect(demand.surfaces).not.toContain('auth');
    expect(demand.surfaces).not.toContain('notification');
    expect(demand.minModules).toBe(5);
  });

  it('raises module demand for incremental work on an existing baseline without a fixed cap', () => {
    const requirementDigest = 'Extend the existing API and auth workflow with reporting export support.';
    const greenfield = analyzeArchitectureDemand({ requirementDigest }, 'typescript');
    const incremental = analyzeArchitectureDemand(
      {
        requirementDigest,
        intent: 'feature',
        baselineSummary: [
          '## Existing project memory',
          '## Module map',
          '- src/api/server.ts: source module',
          '- src/auth/service.ts: source module',
          '- src/reporting/service.ts: source module',
          '- src/persistence/store.ts: source module',
        ].join('\n'),
      },
      'typescript',
    );
    expect(incremental.minModules).toBeGreaterThan(greenfield.minModules);
    expect(incremental.reasonLabel).toContain('intent:');
  });

  it('accepts a fully traceable HIGH_LEVEL_DESIGN → CODE → MODULE_TEST plan and renders its contract', () => {
    const plan = complexPlan();
    expect(() => PlanSchema.parse(plan)).not.toThrow();
    expect(lintPlan(plan).filter((issue) => issue.level === 'error')).toEqual([]);
    const markdown = renderPlanMarkdown(plan);
    expect(markdown).toContain('## Architecture contract');
    expect(markdown).toContain('M006 export');
  });

  it('accepts cohesive modules without enforcing the heuristic module-count estimate', () => {
    const plan = complexPlan();
    const demand = analyzeArchitectureDemand(plan, plan.language);
    plan.architectureModules = plan.architectureModules!
      .filter((module) => ['M003', 'M004', 'M005', 'M006'].includes(module.id))
      .map((module) => ({ ...module, dependencies: [] }));
    plan.steps = plan.steps
      .filter((item) => !['S004', 'S005'].includes(item.id))
      .map((item) => ({
        ...item,
        outputs: item.id === 'S006'
          ? [...item.outputs, 'docs/tests/unit-test-plan.md', 'tests/test_unit.py']
          : item.outputs,
        dependsOn: item.dependsOn.filter((dependency) => !['S004', 'S005'].includes(dependency)),
      }));

    expect(plan.architectureModules).toHaveLength(4);
    expect(demand.minModules).toBeGreaterThan(plan.architectureModules.length);
    expect(lintPlan(plan).filter((issue) => issue.level === 'error')).toEqual([]);
  });

  it('rejects a shared CODE macro step when module subtasks are missing', () => {
    const plan = complexPlan();
    const entryStep = plan.steps.find((step) => step.outputs.includes('src/main.py'))!;
    entryStep.outputs = ['src/main.py', 'src/domain.py'];
    plan.steps = plan.steps.filter((step) => !step.outputs.includes('src/domain.py') || step.id === entryStep.id);
    const errors = lintPlan(plan).filter((issue) => issue.level === 'error');
    expect(errors.some((issue) => issue.message.includes('owns 2 architecture modules'))).toBe(true);
  });

  it('rejects planned phase Steps materialized in the current phase plan', () => {
    const plan = complexPlan();
    plan.steps.push(
      step({
        id: 'S014',
        iterationId: 'P2',
        phase: 'CODE',
        outputs: ['src/ops.py', 'docs/iterations/P2/tests/unit-test-plan.md'],
        dependsOn: ['S013'],
      }),
    );
    const errors = lintPlan(plan).filter((issue) => issue.level === 'error');
    expect(errors.some((issue) => issue.message.includes('non-current implementation phase P2'))).toBe(true);
  });

  it('detects a HIGH_LEVEL_DESIGN document that silently omits module paths', () => {
    const modules = complexPlan().architectureModules!;
    const content = modules
      .map((module) => `${module.id} ${module.name}\n${module.sourcePaths.join('\n')}`)
      .join('\n');
    const missing = missingArchitectureDocumentTokens(content, modules);
    expect(missing).toContain('tests/test_api.py');
    expect(missing).not.toContain('M003');
  });

  it('requires runtime asset paths in the HIGH_LEVEL_DESIGN document', () => {
    const modules: ArchitectureModule[] = [
      {
        id: 'M001',
        name: 'Template',
        responsibility: 'Own the product runtime template used by the renderer.',
        sourcePaths: [],
        assetPaths: ['src/templates/brief.md.hbs'],
        testPaths: ['tests/brief-template.test.ts'],
        dependencies: [],
      },
    ];
    expect(missingArchitectureDocumentTokens('M001\nTemplate', modules)).toContain(
      'src/templates/brief.md.hbs',
    );
  });
});
