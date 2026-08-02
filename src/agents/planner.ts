import {
  ArchitectureModuleSchema,
  ComplexityAssessmentSchema,
  ImplementationPhaseSchema,
  PHASES,
  REQUIRED_V_MODEL_PHASES,
  type ArchitectureModule,
  type ComplexityAssessment,
  type ImplementationPhase,
  type Plan,
  type Step,
  type Language,
  type PlanIntent,
  type ProjectType,
} from '../core/plan.js';
import { getLanguageProfile } from '../core/language.js';
import { withDefaultQualityGate } from '../core/quality_gate.js';
import {
  analyzeArchitectureDemand,
  architectureImplementationPaths,
  pathCoveredByOutputs,
  validateArchitectureContract,
} from '../core/architecture.js';
import type { LLMClient } from '../llm/types.js';
import type { AuditLogger } from '../audit/audit.js';
import { makeStreamReporter } from '../llm/stream.js';
import { t } from '../i18n/index.js';
import {
  calibrateDocPaths,
  calibratePythonRequirements,
  calibrateArchitectureStepMappings,
  calibrateVModelDependencies,
  calibrateStepIds,
  calibrateStepShape,
  calibratePlanCoverage,
  calibrateLanguageStepOwnership,
  calibrateArchitectureModuleDependencies,
  calibrateArchitectureModulePaths,
} from './calibration.js';

// NOTE: SYSTEM_PROMPT, clarify, and decompose user-prompt strings now live in
// src/i18n/{en,zh}.ts and are pulled at call time via t().prompts.*.
// They are intentionally lazy so the global --lang flag (parsed by Commander
// preAction) can switch language before the Planner is constructed/used.


export const CLARIFICATION_CATEGORIES = [
  'functionality',
  'data',
  'acceptance',
  'boundary',
  'quality',
  'extensibility',
] as const;
export type ClarificationCategory = (typeof CLARIFICATION_CATEGORIES)[number];

export const CLARIFICATION_OPTION_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;
export type ClarificationOptionLabel = (typeof CLARIFICATION_OPTION_LABELS)[number];

export interface ClarifyOption {
  label: ClarificationOptionLabel;
  answer: string;
}

export interface ClarifyQuestion {
  id: string;
  category: ClarificationCategory;
  question: string;
  why: string;
  options: ClarifyOption[];
}

export interface PlannerInput {
  rawRequirement: string;
  clarifications: Array<{
    question: string;
    answer: string;
    category?: ClarificationCategory;
    why?: string;
    options?: ClarifyOption[];
  }>;
  /** 用户在澄清问答后补充的自定义需求（可为空）。 */
  userAddenda?: string;
  /** 增量开发时，现有工程基线摘要（文档 / 计划 / 源码树）。 */
  baselineContext?: string;
  /** 计划意图：greenfield / feature / refactor / self。 */
  intent?: PlanIntent;
}

export interface DraftPlan {
  requirementDigest: string;
  globalPrompt: string;
  projectType?: ProjectType;
  complexityAssessment?: ComplexityAssessment;
  implementationPhases?: ImplementationPhase[];
  dependencies: string[];
  architectureModules?: ArchitectureModule[];
  steps: Step[];
}

export interface DraftPhasePlan {
  requirementDigest: string;
  globalPrompt: string;
  projectType: ProjectType;
  complexityAssessment: ComplexityAssessment;
  implementationPhases: ImplementationPhase[];
}

export class Planner {
  constructor(
    private readonly llm: LLMClient,
    private readonly audit?: AuditLogger,
    private readonly language: Language = 'python',
    private readonly streamOutput = false,
  ) {}

  async clarify(
    rawRequirement: string,
    opts: { intent?: PlanIntent; hasBaseline?: boolean; languageAmbiguous?: boolean } = {},
  ): Promise<ClarifyQuestion[]> {
    const demand = analyzeArchitectureDemand(
      { requirementDigest: rawRequirement, intent: opts.intent ?? 'greenfield' },
      this.language,
    );
    const projectShapeAmbiguous = isProjectShapeAmbiguous(rawRequirement);
    const externalApiRequired = hasExternalApiOrUrlRequirement(rawRequirement);
    const prompt = t().prompts.plannerClarify(rawRequirement, {
      intent: opts.intent ?? 'greenfield',
      hasBaseline: !!opts.hasBaseline,
      complex: demand.nonTrivial,
      projectShapeAmbiguous,
      languageAmbiguous: !!opts.languageAmbiguous,
    });
    const rep = makeStreamReporter('Planner.clarify', this.llm.name, { enabled: this.streamOutput });
    let provider: string | undefined;
    let text: string;
    try {
      text = await this.llm.chat(
        [
          { role: 'system', content: t().prompts.plannerClarifySystem },
          { role: 'user', content: prompt },
        ],
        {
          responseFormat: 'json',
          temperature: 0.2,
          onToken: rep.onToken,
          onProvider: (n) => { provider = n; },
          onProviderStart: (name, model) => {
            rep.reset();
            rep.setModel(`${name}/${model}`);
          },
          // 在 provider fallback 层校验问题集质量，避免“只有两三个泛泛问题”直接进入 Gate 1。
          validate: (t) => validateClarifyJson(t, demand.nonTrivial, {
            projectShapeAmbiguous,
            externalApiRequired,
            languageAmbiguous: !!opts.languageAmbiguous,
          }),
        },
      );
      rep.done();
    } catch (err) {
      rep.done('failed');
      throw err;
    }
    await this.audit?.plannerThought('clarify', text, { rawRequirement, provider });
    return parseClarifyJson(text);
  }

  async decompose(input: PlannerInput): Promise<DraftPlan> {
    const qa = formatClarificationTranscript(input.clarifications);
    const addenda = (input.userAddenda ?? '').trim();
    const parseContext = {
      language: this.language,
      rawRequirement: input.rawRequirement,
      userAddenda: addenda,
      baselineSummary: input.baselineContext ?? '',
      intent: input.intent ?? 'greenfield' as PlanIntent,
    };
    const intent = input.intent ?? 'greenfield';
    const phasePlan = await this.planPhasePlan(input);
    const currentPhase = phasePlan.implementationPhases.find((phase) => phase.status === 'current') ??
      phasePlan.implementationPhases[0];
    if (!currentPhase) {
      throw new Error('Planner phase plan has no current implementation phase.');
    }
    return this.decomposeCurrentPhase(input, qa, addenda, parseContext, intent, phasePlan, currentPhase);
  }

  /** Expand one approved PhasePlan goal without replanning the remaining iterations. */
  async decomposePhase(input: PlannerInput, phasePlan: DraftPhasePlan, phaseId: string): Promise<DraftPlan> {
    const currentPhase = phasePlan.implementationPhases.find(
      (phase) => phase.id === phaseId && phase.status === 'current',
    );
    if (!currentPhase) {
      throw new Error(`Planner cannot decompose ${phaseId}: the phase is not current in PhasePlan.`);
    }
    const qa = formatClarificationTranscript(input.clarifications);
    const addenda = (input.userAddenda ?? '').trim();
    const intent = input.intent ?? 'greenfield';
    const parseContext: DraftParseContext = {
      language: this.language,
      rawRequirement: input.rawRequirement,
      userAddenda: addenda,
      baselineSummary: input.baselineContext ?? '',
      intent,
      currentPhaseId: phaseId,
    };
    return this.decomposeCurrentPhase(input, qa, addenda, parseContext, intent, phasePlan, currentPhase);
  }

  /** Generate only the project-level PhasePlan so callers can persist a recovery checkpoint. */
  async planPhasePlan(input: PlannerInput): Promise<DraftPhasePlan> {
    const qa = formatClarificationTranscript(input.clarifications);
    const addenda = (input.userAddenda ?? '').trim();
    const intent = input.intent ?? 'greenfield';
    const parseContext: DraftParseContext = {
      language: this.language,
      rawRequirement: input.rawRequirement,
      userAddenda: addenda,
      baselineSummary: input.baselineContext ?? '',
      intent,
    };
    const prompt = t().prompts.plannerPhasePlan(input.rawRequirement, qa, addenda, {
      intent,
      baseline: input.baselineContext ?? '',
    });
    const { text, provider } = await this.chatWithStructuredValidationRetry({
      label: 'Planner.phasePlan',
      context: parseContext,
      messages: (feedback) => [
        {
          role: 'system',
          content:
            t().prompts.plannerPhasePlanSystem(getLanguageProfile(this.language)) +
            (intent === 'self' ? `\n\n${t().prompts.plannerSelfMode}` : ''),
        },
        { role: 'user', content: prompt + feedback },
      ],
      validate: (t) => parsePhasePlanJson(t, parseContext),
    });
    await this.audit?.plannerThought('phasePlan', text, { qaCount: input.clarifications.length, provider });
    return parsePhasePlanJson(text, parseContext);
  }

  private async decomposeCurrentPhase(
    input: PlannerInput,
    qa: string,
    addenda: string,
    parseContext: DraftParseContext,
    intent: PlanIntent,
    phasePlan: DraftPhasePlan,
    currentPhase: ImplementationPhase,
  ): Promise<DraftPlan> {
    const prompt = t().prompts.plannerPhaseDecompose(input.rawRequirement, qa, addenda, {
      intent,
      baseline: input.baselineContext ?? '',
      phasePlan: JSON.stringify(phasePlan, null, 2),
      phaseId: currentPhase.id,
    });
    const { text, provider } = await this.chatWithStructuredValidationRetry({
      label: `Planner.decompose.${currentPhase.id}`,
      context: parseContext,
      messages: (feedback) => [
        {
          role: 'system',
          content:
            t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile(this.language)) +
            (intent === 'self' ? `\n\n${t().prompts.plannerSelfMode}` : ''),
        },
        { role: 'user', content: prompt + feedback },
      ],
      validate: (t) => parsePhaseStepPlanJson(t, parseContext, phasePlan, currentPhase),
    });
    await this.audit?.plannerThought('decompose', text, {
      qaCount: input.clarifications.length,
      provider,
      phaseId: currentPhase.id,
    });
    return parsePhaseStepPlanJson(text, parseContext, phasePlan, currentPhase);
  }

  private async chatWithStructuredValidationRetry(input: {
    label: string;
    context: DraftParseContext;
    messages: (feedback: string) => Array<{ role: 'system' | 'user'; content: string }>;
    validate: (text: string) => void;
  }): Promise<{ text: string; provider?: string }> {
    const maxAttempts = plannerStructuredRepairAttemptLimit(input.context);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const repairFeedback = formatPlannerValidationFeedback(lastError);
      const rep = makeStreamReporter(
        attempt === 1 ? input.label : `${input.label}.repair${attempt - 1}`,
        this.llm.name,
        { enabled: this.streamOutput },
      );
      let provider: string | undefined;
      try {
        const text = await this.llm.chat(
          input.messages(repairFeedback),
          {
            responseFormat: 'json',
            temperature: 0.1,
            onToken: rep.onToken,
            onProvider: (n) => { provider = n; },
            onProviderStart: (name, model) => {
              rep.reset();
              rep.setModel(`${name}/${model}`);
            },
            validate: input.validate,
          },
        );
        rep.done();
        return { text, provider };
      } catch (err) {
        rep.done('failed');
        lastError = err;
        if (attempt >= maxAttempts || !isPlannerStructuredValidationError(err)) {
          throw err;
        }
        await this.audit?.event('note', `${input.label} validation failed; retrying with contract feedback`, {
          messageId: 'planner.validation_retry',
          label: input.label,
          attempt,
          maxAttempts,
          error: errorMessage(err),
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Planner validation retry exhausted.');
  }
}

function plannerStructuredRepairAttemptLimit(context: DraftParseContext): number {
  const demand = analyzeArchitectureDemand(
    {
      requirementDigest: context.rawRequirement,
      rawRequirement: context.rawRequirement,
      userAddenda: context.userAddenda,
      baselineSummary: context.baselineSummary,
      intent: context.intent,
    },
    context.language,
  );
  return demand.nonTrivial || context.intent !== 'greenfield' ? 3 : 2;
}

function formatPlannerValidationFeedback(err: unknown): string {
  if (!err) return '';
  const message = errorMessage(err).slice(0, 1800);
  return [
    '',
    '',
    '上一次输出未通过 XCompiler 计划契约校验。请根据以下错误修正后重新输出完整、严格 JSON，禁止解释或 Markdown：',
    `校验错误：${message}`,
    '修正要求：',
    '- 保留已确认的 PhasePlan 约束；只生成当前 current phase 的内容。',
    '- architectureModules 必须满足 sourcePaths/testPaths 和 HIGH_LEVEL_DESIGN/CODE/MODULE_TEST 可追踪性；不要为凑数量拆散内聚模块。',
    '- architectureModules.testPaths 是 HIGH_LEVEL_DESIGN 创建、MODULE_TEST 消费的模块契约测试，不能同时出现在 CODE 的单元测试输出中。',
    '- 若一个 CODE 宏 Step 覆盖多个模块，必须在该 CODE Step 的 subTasks 中逐一列出对应模块。',
    '- 不要删除标准 V 模型 8 个宏 Step。',
  ].join('\n');
}

function isPlannerStructuredValidationError(err: unknown): boolean {
  const message = errorMessage(err);
  if (isPlannerTransportFailure(message)) return false;
  return /^Planner (?:architecture|phase|PhasePlan|JSON|draft|complexityAssessment|implementationPhases|iteration)/u.test(message);
}

function isPlannerTransportFailure(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('fetch failed') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('connection') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('socket') ||
    text.includes('terminated') ||
    text.includes('server closed')
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatClarificationTranscript(input: PlannerInput['clarifications']): string {
  return input
    .map((c, i) => {
      const optionBlock = c.options && c.options.length > 0
        ? `\n候选设定:\n${c.options.map((option) => `- ${option.label}. ${option.answer}`).join('\n')}`
        : '';
      return `Q${i + 1}${c.category ? ` [${c.category}]` : ''}: ${c.question}` +
        `${c.why ? `\n澄清目的: ${c.why}` : ''}${optionBlock}\nA${i + 1}: ${c.answer}`;
    })
    .join('\n\n');
}

export function buildPlan(
  draft: DraftPlan,
  opts: { userAddenda?: string; language?: Language; intent?: PlanIntent; baselineSummary?: string } = {},
): Plan {
  const language = opts.language ?? 'python';
  const projectType = draft.projectType ?? inferProjectType([
    draft.requirementDigest,
    draft.globalPrompt,
    opts.userAddenda ?? '',
    opts.baselineSummary ?? '',
  ].join('\n'));
  const complexityAssessment =
    draft.complexityAssessment ??
    inferComplexityAssessment({
      requirementDigest: draft.requirementDigest,
      globalPrompt: draft.globalPrompt,
      userAddenda: opts.userAddenda ?? '',
      baselineSummary: opts.baselineSummary ?? '',
      intent: opts.intent ?? 'greenfield',
      language,
    });
  const implementationPhases = normalizeImplementationPhases(
    draft.implementationPhases,
    complexityAssessment,
    draft.requirementDigest,
  );
  const phaseId = implementationPhases.find((phase) => phase.status === 'current')?.id ??
    draft.steps.find((step) => step.iterationId)?.iterationId ??
    'P1';
  const architectureDependencyCalibration = calibrateArchitectureModuleDependencies(
    calibrateArchitectureModulePaths(draft.architectureModules ?? [], language),
    draft.dependencies,
  );
  const architectureModules = architectureDependencyCalibration.architectureModules;
  const draftDependencies = architectureDependencyCalibration.dependencies;
  const iterated = normalizeStepIterations(draft.steps, implementationPhases);
  const shaped = calibrateLanguageStepOwnership(
    calibrateVModelDependencies(
      calibrateDocPaths(calibrateStepShape(calibrateStepIds(iterated)), projectType),
    ),
    {
      language,
      intent: opts.intent ?? 'greenfield',
      architectureModules,
    },
  );
  const mapped = calibrateArchitectureStepMappings(shaped, architectureModules);
  const contracted = injectArchitectureContractPrompts(mapped, architectureModules);
  const languageContracted = injectLanguageContractPrompts(contracted, language);
  // 兜底：若 LLM 漏写了 UNIT_TEST 阶段或部分 CODE 没人覆盖，由 calibrationPlanCoverage 自动追加。
  const steps = calibratePlanCoverage(languageContracted, language).map(withDefaultQualityGate);
  // Python 依赖需要校准（剥离版本锁 / 重写幻觉 PyPI 包名）；其他语言仅做去重清洗。
  const dependencies =
    language === 'python'
      ? calibratePythonRequirements(draftDependencies)
      : [...new Set((draftDependencies ?? []).map((d) => d.trim()).filter(Boolean))];
  return {
    version: '1',
    language,
    intent: opts.intent ?? 'greenfield',
    phaseId,
    projectType,
    requirementDigest: draft.requirementDigest,
    complexityAssessment,
    implementationPhases,
    architectureModules,
    globalPrompt: draft.globalPrompt,
    baselineSummary: opts.baselineSummary ?? '',
    dependencies,
    userAddenda: (opts.userAddenda ?? '').trim(),
    createdAt: new Date().toISOString(),
    steps,
  };
}

function injectLanguageContractPrompts(steps: Step[], language: Language): Step[] {
  if (language !== 'typescript') return steps;
  const contractBlock =
    '\n\nTypeScript runtime/test contract（强制，覆盖本 Step 其它相反描述）：\n' +
    '- 测试框架必须使用 Vitest：测试文件从 `vitest` 导入 `describe/it/expect/vi`，禁止 Jest API、`jest.fn`、`jest.spyOn`、`jest.mock`。\n' +
    '- `package.json` 必须使用 `"test": "vitest run"`，`"build": "tsc --noEmit"`，并包含 `type: "module"`。\n' +
    '- `tsconfig.json` 必须启用 `allowImportingTsExtensions: true`，并将产品 build/typecheck 的 include 限定为 `src/**/*.ts`、`src/**/*.tsx`；各阶段测试只由对应 Vitest 门禁执行，不得把未来阶段 tests 全量并入产品 build。\n' +
    '- greenfield 项目的 HIGH_LEVEL_DESIGN 必须输出 `package.json`、`tsconfig.json` 与模块测试；CODE 阶段输出产品源码、单元测试计划与可执行单元测试，不再补写基础工程配置。\n' +
    '- `devDependencies` 使用 `typescript`、`tsx`、`vitest`、`@vitest/coverage-v8`、`@types/node`，Vitest 与 coverage provider 使用兼容版本；禁止新增或要求 `jest`、`ts-jest`、`@types/jest`、`ts-node`、`nodemon`。\n' +
    '- 本地源码导入必须使用显式 `.ts` ESM specifier，代码需兼容 Node 原生 TypeScript type stripping。\n' +
    '- 时间相关测试必须冻结系统时钟或从当前时钟推导预期值；禁止一边调用 `new Date()` 一边硬编码年份。';
  return steps.map((step) => {
    if (step.systemPrompt.includes('TypeScript runtime/test contract')) return step;
    return { ...step, systemPrompt: `${step.systemPrompt}${contractBlock}` };
  });
}

function injectArchitectureContractPrompts(
  steps: Step[],
  modules: ArchitectureModule[],
): Step[] {
  if (modules.length === 0) return steps;
  const inventory = modules
    .map((module) =>
      `${module.id} ${module.name}: sources=[${module.sourcePaths.join(', ')}], assets=[${(module.assetPaths ?? []).join(', ')}], tests=[${module.testPaths.join(', ')}], deps=[${module.dependencies.join(', ') || 'none'}]`,
    )
    .join('\n');

  return steps.map((step) => {
    let contractBlock = '';
    if (step.phase === 'HIGH_LEVEL_DESIGN') {
      contractBlock =
        `\n\nHIGH_LEVEL_DESIGN 契约（强制）：docs/02-high-level-design.md 必须逐项写明本开发模块在整体系统中的定位、系统级对外接口、外部 API、第三方库选型、依赖确认，以及以下模块的职责、源码路径、测试路径和依赖；本阶段同时创建这些 testPaths 对应的可执行模块测试，不得推迟到 MODULE_TEST。每个模块测试必须导入或执行该模块声明的真实 sourcePaths 与公开接口，禁止在测试内复制一套业务实现来自测：\n${inventory}`;
    } else if (step.phase === 'DETAILED_DESIGN') {
      contractBlock =
        `\n\nDETAILED_DESIGN 契约（强制）：docs/03-detailed-design.md 必须定义模块内部具体功能实现、内部架构、数据结构/控制流，并为以下每个模块保留独立 CODE/INTEGRATION_TEST 任务及验收映射。每个集成测试必须导入或执行至少两个参与集成的真实 sourcePaths 与公开接口（Plan 仅声明一个源码时除外），禁止在测试内重写任一侧业务逻辑。测试可以引用将在 CODE 阶段实现、当前尚不存在的 sourcePaths；本阶段禁止创建 src/** stub、占位实现或产品代码：\n${inventory}`;
    } else if (step.phase === 'CODE') {
      const owned = modules.filter((module) =>
        architectureImplementationPaths(module).every((path) => pathCoveredByOutputs(path, step.outputs)),
      );
      if (owned.length > 0) {
        contractBlock =
          `\n\n本 CODE Step 仅实现架构模块：\n${owned.map((module) => `${module.id} ${module.name} — ${module.responsibility}; implementationPaths=${architectureImplementationPaths(module).join(', ')}`).join('\n')}`;
      }
    } else if (step.phase === 'MODULE_TEST') {
      const covered = modules.filter((module) =>
        module.testPaths.some((testPath) => pathCoveredByOutputs(testPath, step.inputs)),
      );
      if (covered.length > 0) {
        contractBlock =
          `\n\n本 MODULE_TEST Step 只检查并运行 HIGH_LEVEL_DESIGN 已创建的模块测试，不得改写测试或产品代码；验证架构模块：\n${covered.map((module) => `${module.id} ${module.name}; testPaths=${module.testPaths.join(', ')}`).join('\n')}`;
      }
    }
    return contractBlock ? { ...step, systemPrompt: `${step.systemPrompt}${contractBlock}` } : step;
  });
}

function parseClarifyJson(text: string): ClarifyQuestion[] {
  const data = safeJson(text);
  const arr = coerceClarifyArray(data);
  const seenQuestions = new Set<string>();
  const seenIds = new Set<string>();
  const questions: ClarifyQuestion[] = [];
  for (const [index, raw] of arr.entries()) {
    const question = typeof raw?.question === 'string' ? raw.question.trim() : '';
    if (!question) continue;
    const dedupKey = question.toLowerCase().replace(/[\s?？。.!！,，;；:：]+/gu, '');
    if (seenQuestions.has(dedupKey)) continue;
    seenQuestions.add(dedupKey);
    const candidateId = typeof raw?.id === 'string' && /^Q\d+$/iu.test(raw.id.trim())
      ? raw.id.trim().toUpperCase()
      : `Q${index + 1}`;
    let id = candidateId;
    let fallbackNumber = index + 1;
    while (seenIds.has(id)) {
      fallbackNumber += 1;
      id = `Q${fallbackNumber}`;
    }
    seenIds.add(id);
    questions.push({
      id,
      category: normalizeClarificationCategory(raw?.category),
      question,
      why: typeof raw?.why === 'string' ? raw.why.trim() : '',
      options: parseClarifyOptions(raw?.options),
    });
  }
  return questions;
}

/**
 * 宽容处理 LLM 可能的几种返回形式：
 *  - 数组：[{id,question}, ...]
 *  - 单个对象：{id,question}                  -> 包成长度 1 的数组
 *  - 包装对象：{questions:[...]} 或 {items:[...]} -> 取其中的数组
 *  - 其他：返回空数组（表示“无需澄清”）
 */
interface RawClarifyQuestion {
  id?: unknown;
  category?: unknown;
  question?: unknown;
  why?: unknown;
  options?: unknown;
}

function coerceClarifyArray(data: unknown): RawClarifyQuestion[] {
  if (Array.isArray(data)) return data as RawClarifyQuestion[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.questions)) return obj.questions as RawClarifyQuestion[];
    if (Array.isArray(obj.items)) return obj.items as RawClarifyQuestion[];
    if (typeof obj.question === 'string') return [obj as RawClarifyQuestion];
  }
  return [];
}

const CLARIFICATION_CATEGORY_ALIASES: Record<string, ClarificationCategory> = {
  functionality: 'functionality', functional: 'functionality', function: 'functionality', feature: 'functionality',
  data: 'data', input: 'data', output: 'data', 'input-output': 'data',
  acceptance: 'acceptance', correctness: 'acceptance', verification: 'acceptance',
  boundary: 'boundary', scope: 'boundary', edge: 'boundary',
  quality: 'quality', performance: 'quality', reliability: 'quality', security: 'quality',
  extensibility: 'extensibility', scalability: 'extensibility', evolution: 'extensibility', extension: 'extensibility',
};

function parseClarificationCategory(value: unknown): ClarificationCategory | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CLARIFICATION_CATEGORY_ALIASES[normalized];
}

function normalizeClarificationCategory(value: unknown): ClarificationCategory {
  return parseClarificationCategory(value) ?? 'functionality';
}

function parseClarifyOptions(value: unknown): ClarifyOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: ClarifyOption[] = [];
  for (const item of value) {
    const rawAnswer = extractClarifyOptionAnswer(item);
    const answer = stripOptionLabel(rawAnswer).trim();
    if (!answer) continue;
    const dedupKey = answer.toLowerCase().replace(/[\s?？。.!！,，;；:：]+/gu, '');
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const label = CLARIFICATION_OPTION_LABELS[options.length];
    if (!label) break;
    options.push({ label, answer });
  }
  return options;
}

function extractClarifyOptionAnswer(item: unknown): string {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const obj = item as Record<string, unknown>;
  for (const key of ['answer', 'text', 'value', 'setting', 'title', 'label']) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function stripOptionLabel(value: string): string {
  return value.replace(/^\s*[A-Ea-e]\s*[).\]、:：-]\s*/u, '');
}

function validateClarifyJson(
  text: string,
  complex: boolean,
  opts: {
    projectShapeAmbiguous?: boolean;
    externalApiRequired?: boolean;
    languageAmbiguous?: boolean;
  } = {},
): ClarifyQuestion[] {
  const data = safeJson(text);
  const raw = coerceClarifyArray(data);
  if (raw.length === 0) {
    throw new Error('clarify returned no questions; interactive intake requires a multi-dimensional question set');
  }
  for (const [index, question] of raw.entries()) {
    if (typeof question.question !== 'string' || question.question.trim().length < 6) {
      throw new Error(`clarify question ${index + 1} is missing or too short`);
    }
    if (!parseClarificationCategory(question.category)) {
      throw new Error(`clarify question ${index + 1} is missing a valid category`);
    }
    if (typeof question.why !== 'string' || question.why.trim().length < 4) {
      throw new Error(`clarify question ${index + 1} is missing a concise why field`);
    }
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const options = parseClarifyOptions(question.options);
    if (rawOptions.length < 2 || rawOptions.length > 5 || options.length !== rawOptions.length) {
      throw new Error(`clarify question ${index + 1} must include 2-5 prioritized answer options`);
    }
  }

  const parsed = parseClarifyJson(text);
  if (parsed.length !== raw.length) {
    throw new Error(`clarify contains duplicate or empty questions (${raw.length} raw, ${parsed.length} unique)`);
  }
  const minQuestions = complex ? 8 : 7;
  if (parsed.length < minQuestions || parsed.length > 10) {
    throw new Error(`clarify expected ${minQuestions}-10 unique questions, got ${parsed.length}`);
  }
  const count = (category: ClarificationCategory): number =>
    parsed.filter((question) => question.category === category).length;
  const functionalCount = count('functionality') + count('data') + count('acceptance');
  const minFunctional = complex ? 5 : 4;
  if (functionalCount < minFunctional) {
    throw new Error(`clarify requires at least ${minFunctional} function-focused questions, got ${functionalCount}`);
  }
  for (const required of ['boundary', 'quality', 'extensibility'] as const) {
    if (count(required) === 0) {
      throw new Error(`clarify missing required ${required} question`);
    }
  }
  if (opts.projectShapeAmbiguous && !parsed.some(isProjectShapeClarification)) {
    throw new Error(
      'clarify missing required project shape question: ask whether this should be an API library, runnable application, or mixed deliverable',
    );
  }
  if (opts.externalApiRequired && !parsed.some(isExternalApiCredentialClarification)) {
    throw new Error(
      'clarify missing required external API credential question: ask whether the user has an API/key/token; if not, default to open no-key APIs',
    );
  }
  if (opts.languageAmbiguous && !parsed.some(isDevelopmentLanguageClarification)) {
    throw new Error(
      'clarify missing required development language question: ask whether the project should use Python or TypeScript/Node.js, with Python as the default option',
    );
  }
  return parsed;
}

interface DraftParseContext {
  language: Language;
  rawRequirement: string;
  userAddenda: string;
  baselineSummary: string;
  intent: PlanIntent;
  /** When expanding one implementation phase, scope architecture-demand gates to that phase. */
  phaseDemandText?: string;
  /** Materialized implementation phase. Initial planning defaults to P1. */
  currentPhaseId?: string;
}

function parsePhasePlanJson(text: string, context: DraftParseContext): DraftPhasePlan {
  const data = safeJson(text);
  if (!data || typeof data !== 'object') {
    throw new Error('Planner did not return a JSON object for phase planning.');
  }
  const root = data as Record<string, unknown>;
  const obj =
    root.phasePlan && typeof root.phasePlan === 'object'
      ? root.phasePlan as Record<string, unknown>
      : root;
  const digest = obj.requirementDigest;
  if (typeof digest !== 'string' || !digest.trim()) {
    throw new Error('Planner PhasePlan missing requirementDigest.');
  }
  const globalPrompt = typeof obj.globalPrompt === 'string' ? obj.globalPrompt : '';
  const projectType = parseProjectType(obj.projectType);
  if (!projectType) {
    throw new Error('Planner PhasePlan missing valid projectType; project shape must be classified by the LLM.');
  }
  const complexityAssessment = parseComplexityAssessment(obj.complexityAssessment);
  if (!complexityAssessment) {
    throw new Error('Planner PhasePlan missing valid complexityAssessment; complexity must be assessed before Step planning.');
  }
  const parsedImplementationPhases = parseImplementationPhases(obj.implementationPhases);
  if (!parsedImplementationPhases || parsedImplementationPhases.length === 0) {
    throw new Error('Planner PhasePlan missing valid implementationPhases; P1 current phase must be explicit.');
  }
  const phaseIssue = validateImplementationPhaseDraft(parsedImplementationPhases, complexityAssessment);
  if (phaseIssue) {
    throw new Error(`Planner PhasePlan implementationPhases invalid: ${phaseIssue}`);
  }
  const implementationPhases = normalizeImplementationPhases(
    parsedImplementationPhases,
    complexityAssessment,
    digest,
  );
  const demand = analyzeArchitectureDemand(
    {
      requirementDigest: digest,
      rawRequirement: context.rawRequirement,
      userAddenda: context.userAddenda,
      globalPrompt,
      baselineSummary: context.baselineSummary,
      intent: context.intent,
    },
    context.language,
  );
  const forcedPhaseSplit = hasForcedPhaseSplit([
    digest,
    context.rawRequirement,
    context.userAddenda,
  ].join('\n'));
  if (demand.nonTrivial && !complexityAssessment.splitRecommended) {
    throw new Error(
      `Planner PhasePlan underestimates a non-trivial request (${demand.reasonLabel}); ` +
      'splitRecommended must be true and additional planned iterations must be listed in PhasePlan.',
    );
  }
  if (forcedPhaseSplit && !complexityAssessment.userForcedPhaseSplit) {
    throw new Error('Planner PhasePlan missed the user-forced phase split request.');
  }
  return {
    requirementDigest: digest,
    globalPrompt,
    projectType,
    complexityAssessment,
    implementationPhases,
  };
}

function parsePhaseStepPlanJson(
  text: string,
  context: DraftParseContext,
  phasePlan: DraftPhasePlan,
  currentPhase: ImplementationPhase,
): DraftPlan {
  const data = safeJson(text);
  if (!data || typeof data !== 'object') {
    throw new Error('Planner did not return a JSON object for phase Step planning.');
  }
  const obj = data as Record<string, unknown>;
  const rawDeps = Array.isArray(obj.dependencies) ? obj.dependencies : [];
  const draft = {
    requirementDigest:
      typeof obj.requirementDigest === 'string' && obj.requirementDigest.trim()
        ? obj.requirementDigest
        : currentPhase.objective || phasePlan.requirementDigest,
    globalPrompt:
      typeof obj.globalPrompt === 'string' && obj.globalPrompt.trim()
        ? obj.globalPrompt
        : phasePlan.globalPrompt,
    projectType: phasePlan.projectType,
    complexityAssessment: phasePlan.complexityAssessment,
    implementationPhases: phasePlan.implementationPhases,
    dependencies: (rawDeps as unknown[]).filter((s): s is string => typeof s === 'string'),
    architectureModules: obj.architectureModules,
    steps: obj.steps,
  };
  const parsed = parseDraftPlanJson(JSON.stringify(draft), {
    ...context,
    phaseDemandText: phaseDemandText(currentPhase),
    currentPhaseId: currentPhase.id,
  });
  const currentIterationId = currentPhase.id;
  const wrongIteration = parsed.steps.find((step) => (step.iterationId ?? 'P1') !== currentIterationId);
  if (wrongIteration) {
    throw new Error(
      `Planner phase StepPlan must materialize only ${currentIterationId}; ` +
      `${wrongIteration.id} references ${wrongIteration.iterationId ?? 'P1'}. ` +
      'Future planned phases must stay in PhasePlan until they are loaded as the current phase.',
    );
  }
  return parsed;
}

function parseDraftPlanJson(text: string, context?: DraftParseContext): DraftPlan {
  const data = safeJson(text);
  if (!data || typeof data !== 'object') {
    throw new Error('Planner did not return a JSON object.');
  }
  const obj = data as Record<string, unknown>;
  const digest = obj.requirementDigest;
  const steps = obj.steps;
  if (typeof digest !== 'string' || !Array.isArray(steps)) {
    throw new Error('Planner JSON missing requirementDigest or steps.');
  }
  const globalPrompt = typeof obj.globalPrompt === 'string' ? obj.globalPrompt : '';
  const parsedProjectType = parseProjectType(obj.projectType);
  if (context && !parsedProjectType) {
    throw new Error(
      'Planner JSON missing valid projectType; project shape must be classified by the LLM after clarification.',
    );
  }
  const projectType = parsedProjectType ?? inferProjectType([
    typeof digest === 'string' ? digest : '',
    globalPrompt,
    context?.rawRequirement ?? '',
    context?.userAddenda ?? '',
    context?.baselineSummary ?? '',
  ].join('\n'));
  const rawDeps = Array.isArray(obj.dependencies) ? obj.dependencies : [];
  let dependencies = (rawDeps as unknown[]).filter((s): s is string => typeof s === 'string');
  if (context) {
    const validPhaseNames = new Set<string>(PHASES);
    const nonCanonical = (steps as unknown[])
      .map((rawStep, index) => {
        const step = rawStep && typeof rawStep === 'object' ? rawStep as Record<string, unknown> : {};
        return {
          id: typeof step.id === 'string' ? step.id : `#${index + 1}`,
          phase: typeof step.phase === 'string' ? step.phase : '',
        };
      })
      .filter((step) => !validPhaseNames.has(step.phase));
    if (nonCanonical.length > 0) {
      throw new Error(
        `Planner draft uses non-canonical phase(s): ` +
        `${nonCanonical.map((step) => `${step.id}:${step.phase || '(missing)'}`).join(', ')}. ` +
        `V-model phases must be exactly ${REQUIRED_V_MODEL_PHASES.join(' -> ')} ` +
        `DEBUG is a runtime repair mode and must never be emitted as a Step; ` +
        `do not emit REQUIREMENT, ARCH, TASK, TEST, REFACTOR, or DELIVERY aliases.`,
      );
    }
  }
  const normalizedDraftStepsForValidation = calibrateStepShape(calibrateStepIds(steps as Step[]));
  // 强制 V 模型骨架完整性：必须覆盖核心阶段。LLM 在 token loop / 截断时常见症状
  // 是只输出前 1-2 个 Step（如用户回放：仅 REQUIREMENT_ANALYSIS+HIGH_LEVEL_DESIGN 两步），这种残缺 plan
  // 后续重试也救不回，应在 validate 层直接拒绝，让 FallbackClient 切换 provider
  // 重新生成完整 plan。
  const phases = new Set<string>();
  for (const s of normalizedDraftStepsForValidation) {
    const p = typeof s?.phase === 'string' ? s.phase : '';
    if (p) phases.add(p);
  }
  const required = [...REQUIRED_V_MODEL_PHASES];
  const missing = required.filter((p) => !phases.has(p));
  if (steps.length < required.length || missing.length > 0) {
    throw new Error(
      `Planner draft incomplete (likely token-loop / truncation): ` +
      `got ${steps.length} step(s), phases=[${[...phases].join(',') || '(none)'}], ` +
      `missing=[${missing.join(',') || '(none)'}]. V-model requires core phases: ${required.join('/')}.`,
    );
  }
  const architectureResult = ArchitectureModuleSchema.array().safeParse(obj.architectureModules ?? []);
  if (!architectureResult.success) {
    throw new Error(`Planner architectureModules invalid: ${architectureResult.error.issues.map((i) => i.message).join('; ')}`);
  }
  const architectureDependencyCalibration = calibrateArchitectureModuleDependencies(
    calibrateArchitectureModulePaths(architectureResult.data, context?.language ?? 'python'),
    dependencies,
  );
  const architectureModules = architectureDependencyCalibration.architectureModules;
  dependencies = architectureDependencyCalibration.dependencies;
  const moduleTestPaths = new Set(architectureModules.flatMap((module) => module.testPaths));
  const codeOwnedModuleTests = normalizedDraftStepsForValidation
    .filter((step) => step.phase === 'CODE')
    .flatMap((step) => step.outputs)
    .filter((output) => moduleTestPaths.has(output));
  if (codeOwnedModuleTests.length > 0) {
    throw new Error(
      `Planner architecture test ownership invalid: architectureModules.testPaths are module contract tests ` +
      `authored by HIGH_LEVEL_DESIGN and consumed by MODULE_TEST; CODE must author separate unit tests. ` +
      `Remove these paths from CODE outputs or replace architectureModules.testPaths with the corresponding ` +
      `HIGH_LEVEL_DESIGN module-contract test paths: ${[...new Set(codeOwnedModuleTests)].join(', ')}.`,
    );
  }
  const parsedComplexityAssessment = parseComplexityAssessment(obj.complexityAssessment);
  if (context && !parsedComplexityAssessment) {
    throw new Error('Planner JSON missing valid complexityAssessment; complexity must be assessed during plan decomposition.');
  }
  const complexityAssessment =
    parsedComplexityAssessment ??
    inferComplexityAssessment({
      requirementDigest: digest,
      globalPrompt,
      rawRequirement: context?.rawRequirement ?? '',
      userAddenda: context?.userAddenda ?? '',
      baselineSummary: context?.baselineSummary ?? '',
      intent: context?.intent ?? 'greenfield',
      language: context?.language ?? 'python',
    });
  const parsedImplementationPhases = parseImplementationPhases(obj.implementationPhases);
  if (context && (!parsedImplementationPhases || parsedImplementationPhases.length === 0)) {
    throw new Error('Planner JSON missing valid implementationPhases; the materialized current phase must be explicit.');
  }
  const phaseIssue = parsedImplementationPhases
    ? validateImplementationPhaseDraft(
        parsedImplementationPhases,
        complexityAssessment,
        context?.currentPhaseId ?? 'P1',
      )
    : undefined;
  if (context && phaseIssue) {
    throw new Error(`Planner implementationPhases invalid: ${phaseIssue}`);
  }
  const implementationPhases = normalizeImplementationPhases(
    parsedImplementationPhases,
    complexityAssessment,
    digest,
  );
  const stepsWithIterations = normalizeStepIterations(normalizedDraftStepsForValidation, implementationPhases);
  const iterationIssue = validateIterationVModelDraft(stepsWithIterations, implementationPhases);
  if (context && iterationIssue) {
    throw new Error(`Planner iteration V-model invalid: ${iterationIssue}`);
  }
  if (context) {
    const demand = analyzeArchitectureDemand(
      architectureDemandInputForDraft(context, digest, globalPrompt),
      context.language,
    );
    const forcedPhaseSplit = hasForcedPhaseSplit([
      digest,
      context.rawRequirement,
      context.userAddenda,
    ].join('\n'));
    if (demand.nonTrivial && !complexityAssessment.splitRecommended) {
      throw new Error(
        `Planner complexityAssessment underestimates a non-trivial request (${demand.reasonLabel}); ` +
        'splitRecommended must be true and additional executable iterations must be planned.',
      );
    }
    if (forcedPhaseSplit && !complexityAssessment.userForcedPhaseSplit) {
      throw new Error('Planner complexityAssessment missed the user-forced phase split request.');
    }
    if (demand.nonTrivial && architectureModules.length === 0) {
      throw new Error(
        `Planner omitted architectureModules for a non-trivial request (${demand.reasonLabel}); ` +
        'the architecture contract must provide HIGH_LEVEL_DESIGN/CODE/MODULE_TEST traceability.',
      );
    }
    if (architectureModules.length > 0) {
      const ownedSteps = calibrateLanguageStepOwnership(
        calibrateVModelDependencies(
          calibrateDocPaths(calibrateStepShape(calibrateStepIds(stepsWithIterations)), projectType),
        ),
        {
          language: context.language,
          intent: context.intent,
          architectureModules,
        },
      );
      const normalizedSteps = calibratePlanCoverage(
        calibrateArchitectureStepMappings(ownedSteps, architectureModules),
        context.language,
      ).map(withDefaultQualityGate);
      const contractIssues = validateArchitectureContract(
        architectureModules,
        normalizedSteps,
        context.language,
        demand,
      );
      if (contractIssues.length > 0) {
        throw new Error(
          `Planner architecture contract incomplete: ${contractIssues.map((issue) => issue.message).join(' | ')}`,
        );
      }
    }
  }
  // Step shape will be validated by zod / lint downstream.
  return {
    requirementDigest: digest,
    globalPrompt,
    projectType,
    complexityAssessment,
    implementationPhases,
    dependencies,
    architectureModules,
    steps: stepsWithIterations,
  };
}

function architectureDemandInputForDraft(
  context: DraftParseContext,
  digest: string,
  globalPrompt: string,
): Parameters<typeof analyzeArchitectureDemand>[0] {
  if (!context.phaseDemandText) {
    return {
      requirementDigest: digest,
      rawRequirement: context.rawRequirement,
      userAddenda: context.userAddenda,
      globalPrompt,
      baselineSummary: context.baselineSummary,
      intent: context.intent,
    };
  }
  return {
    requirementDigest: context.phaseDemandText,
    baselineSummary: context.baselineSummary,
    intent: context.intent,
  };
}

function phaseDemandText(currentPhase: ImplementationPhase): string {
  const gate = currentPhase.verificationGate;
  return [
    currentPhase.title,
    currentPhase.objective,
    currentPhase.scope.join('\n'),
    currentPhase.deliverables.join('\n'),
    gate?.summary ?? '',
    gate?.checks.join('\n') ?? '',
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

function parseComplexityAssessment(value: unknown): ComplexityAssessment | undefined {
  const result = ComplexityAssessmentSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function parseImplementationPhases(value: unknown): ImplementationPhase[] | undefined {
  const result = ImplementationPhaseSchema.array().safeParse(value);
  return result.success ? result.data : undefined;
}

function validateImplementationPhaseDraft(
  phases: ImplementationPhase[],
  assessment: ComplexityAssessment,
  expectedCurrentPhaseId = 'P1',
): string | undefined {
  const requiredCount = requiredImplementationPhaseCount(assessment);
  const executable = phases.filter((phase) => phase.status !== 'deferred');
  if (executable.length < requiredCount) {
    return `complexityAssessment.level=${assessment.level} requires at least ${requiredCount} executable implementation iteration(s)`;
  }
  if (
    assessment.level === 'simple' &&
    !assessment.splitRecommended &&
    !assessment.userForcedPhaseSplit &&
    executable.length !== 1
  ) {
    return 'simple complexity without splitRecommended must use exactly one executable implementation iteration';
  }
  const current = phases.filter((phase) => phase.status === 'current');
  if (current.length !== 1 || current[0]?.id !== expectedCurrentPhaseId) {
    return `exactly one current phase is required and it must be ${expectedCurrentPhaseId}`;
  }
  if (phases[0]?.id !== 'P1') {
    return 'P1 must be the first implementation phase';
  }
  if (assessment.userForcedPhaseSplit && !assessment.splitRecommended) {
    return 'userForcedPhaseSplit=true requires splitRecommended=true';
  }
  if (assessment.level !== 'simple' && !assessment.splitRecommended) {
    return 'moderate/complex complexity requires splitRecommended=true';
  }
  if (assessment.splitRecommended && executable.filter((phase) => phase.id !== 'P1').length === 0) {
    return 'splitRecommended=true requires at least one planned executable iteration after P1';
  }
  return undefined;
}

function validateIterationVModelDraft(
  steps: Step[],
  phases: ImplementationPhase[],
): string | undefined {
  const current = phases.filter((phase) => phase.status === 'current');
  const materializedIds = new Set(current.map((phase) => phase.id));
  for (const step of steps) {
    const iterationId = step.iterationId ?? 'P1';
    if (!materializedIds.has(iterationId)) {
      return `${step.id} references non-current iteration ${iterationId}; planned phases are PhasePlan goals and must not contain executable Steps yet`;
    }
  }
  for (const iteration of current) {
    const iterationSteps = steps.filter((step) => (step.iterationId ?? 'P1') === iteration.id);
    const phaseSet = new Set(iterationSteps.map((step) => step.phase));
    for (const required of REQUIRED_V_MODEL_PHASES) {
      if (!phaseSet.has(required)) {
        return `${iteration.id} is missing ${required}; every iteration must be a complete V-model cycle`;
      }
    }
  }
  return undefined;
}

function parseProjectType(value: unknown): ProjectType | undefined {
  return value === 'application' || value === 'library' || value === 'mixed'
    ? value
    : undefined;
}

function isProjectShapeAmbiguous(text: string): boolean {
  const signals = projectShapeSignals(text);
  if (signals.genericApi && !signals.libraryLike && !signals.appLike) return true;
  return !signals.libraryLike && !signals.appLike;
}

function isProjectShapeClarification(question: ClarifyQuestion): boolean {
  const text = `${question.question}\n${question.why}\n${question.options.map((option) => option.answer).join('\n')}`.toLowerCase();
  return (
    /api[- ]?library|public api|reusable api|client library|sdk|package|library|runnable app|application|cli|service|mixed/u.test(text) ||
    /api\s*(库|客户端|能力)|公共\s*api|可复用接口|库项目|软件包|开发包|可运行|应用|命令行|服务|混合/u.test(text)
  );
}

function hasExternalApiOrUrlRequirement(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b(external|third[- ]party|provider|remote|public|open)\s+(api|url|endpoint|service)\b/u.test(lower) ||
    /\b(fetch|request|call|consume|access|query)\s+(?:an?\s+)?(?:external|third[- ]party|remote|public|open)\s+(api|url|endpoint|service)\b/u.test(lower) ||
    /\bhttps?:\/\//iu.test(text) ||
    /(?:外部|第三方|公开|开放|远程|联网|网络).{0,12}(?:api|接口|url|地址|服务|数据源)/iu.test(text) ||
    /(?:天气|节假日|假日|地图|汇率|股票|新闻|物流).{0,18}(?:api|接口|查询|获取|请求|调用|数据)/iu.test(text) ||
    /(?:获取|查询|请求|调用).{0,18}(?:天气|节假日|假日|地图|汇率|股票|新闻|物流).{0,18}(?:数据|接口|api)?/iu.test(text)
  );
}

function isExternalApiCredentialClarification(question: ClarifyQuestion): boolean {
  const text = `${question.question}\n${question.why}\n${question.options.map((option) => option.answer).join('\n')}`.toLowerCase();
  const asksCredential = /\b(api key|apikey|token|credential|secret|auth|authorization|provider key)\b/u.test(text) ||
    /(?:api\s*)?(?:key|token)|密钥|令牌|凭证|鉴权|授权/u.test(text);
  const mentionsNoKeyFallback =
    /\b(no[- ]?key|without key|no token|free public|open api|public api|no authentication)\b/u.test(text) ||
    /免\s*(?:key|token|密钥|鉴权)|无需\s*(?:key|token|密钥|鉴权)|公开接口|开放接口|免费接口/u.test(text);
  const externalApiContext =
    /\b(api|url|endpoint|provider|external|third[- ]party|fetch|request)\b/u.test(text) ||
    /外部|第三方|接口|数据源|天气|节假日|联网/u.test(text);
  return externalApiContext && asksCredential && mentionsNoKeyFallback;
}

function isDevelopmentLanguageClarification(question: ClarifyQuestion): boolean {
  const text = `${question.question}\n${question.why}\n${question.options.map((option) => option.answer).join('\n')}`.toLowerCase();
  const mentionsPython = /\bpython\b/u.test(text) || /python\s*脚本|python\s*项目/u.test(text);
  const mentionsTypeScript =
    /\btypescript\b|\btype\s*script\b|\bnode(?:\.js)?\b/u.test(text) ||
    /type\s*script|ts\s*(程序|工程|项目|脚本|语言|实现)|typescript\s*项目/u.test(text);
  const asksLanguage =
    /\b(language|runtime|implementation stack|programming language)\b/u.test(text) ||
    /开发语言|编程语言|实现语言|运行时|技术栈/u.test(text);
  return asksLanguage && mentionsPython && mentionsTypeScript;
}

function projectShapeSignals(text: string): { libraryLike: boolean; appLike: boolean; genericApi: boolean } {
  const lower = text.toLowerCase();
  const libraryLike =
    /\b(api[- ]?library|library|sdk|package|npm package|pypi package|client library|api client|reusable module|public api)\b/u.test(lower) ||
    /api\s*(库|客户端)|公共\s*api|可复用接口|公共库|库项目|软件包|客户端库|开发包/u.test(text);
  const appLike =
    /\b(cli|command|command line|web app|server|service|dashboard|software|script|tool|terminal|application|app|api[- ]?server|api[- ]?service|rest api|http api|web api|api endpoint)\b/u.test(lower) ||
    /命令行|服务|应用|脚本|工具|控制台|后台|仪表盘|软件/u.test(text);
  const explicitApiSurface =
    /\b(api[- ]?server|api[- ]?service|rest api|http api|web api|api endpoint|api client|api[- ]?library)\b/u.test(lower) ||
    /api\s*(服务|网关|端点|客户端|库)/u.test(text);
  const genericApi = (/\bapi\b/u.test(lower) || /接口/u.test(text)) && !explicitApiSurface;
  return { libraryLike, appLike, genericApi };
}

function inferComplexityAssessment(input: {
  requirementDigest: string;
  rawRequirement?: string;
  globalPrompt?: string;
  userAddenda?: string;
  baselineSummary?: string;
  intent: PlanIntent;
  language: Language;
}): ComplexityAssessment {
  const text = [
    input.requirementDigest,
    input.rawRequirement ?? '',
    input.userAddenda ?? '',
    input.baselineSummary ?? '',
  ].join('\n');
  const demand = analyzeArchitectureDemand(input, input.language);
  const forced = hasForcedPhaseSplit(text);
  const level: ComplexityAssessment['level'] =
    demand.nonTrivial || forced
      ? 'complex'
      : demand.surfaces.length > 0 || demand.baselineModules > 0
        ? 'moderate'
        : 'simple';
  return {
    level,
    rationale: demand.reasonLabel,
    splitRecommended: forced || level !== 'simple',
    userForcedPhaseSplit: forced,
  };
}

function normalizeImplementationPhases(
  phases: ImplementationPhase[] | undefined,
  assessment: ComplexityAssessment,
  requirementDigest: string,
): ImplementationPhase[] {
  const requiredCount = requiredImplementationPhaseCount(assessment);
  const hasCurrent = (phases ?? []).some((phase) => phase.status === 'current');
  const sanitized: ImplementationPhase[] = (phases ?? [])
    .filter((phase) => phase.id && phase.title && phase.objective)
    .map((phase, index) => ({
      ...phase,
      id: phase.id || `P${index + 1}`,
      status: hasCurrent
        ? phase.status
        : index === 0
          ? 'current' as const
          : phase.status === 'deferred'
            ? 'deferred' as const
            : 'planned' as const,
      dependsOn: index === 0 ? [] : phase.dependsOn.length > 0 ? phase.dependsOn : [`P${index}`],
      verificationGate: phase.verificationGate ?? defaultVerificationGate(phase.id || `P${index + 1}`),
    }));
  if (sanitized.length > 0) {
    while (sanitized.filter((phase) => phase.status !== 'deferred').length < requiredCount) {
      sanitized.push(plannedIterationPhase(requirementDigest, sanitized.length + 1));
    }
    return sanitized;
  }
  const p1: ImplementationPhase = {
    id: 'P1',
    title: 'Core functionality',
    objective: `Deliver the smallest complete core slice for: ${requirementDigest}`,
    status: 'current',
    scope: ['Core domain behaviour', 'Runnable entrypoint', 'Primary tests', 'Functional validation documentation'],
    deliverables: ['Complete V-model iteration for the highest-priority core slice.'],
    dependsOn: [],
    verificationGate: defaultVerificationGate('P1'),
  };
  const out = [p1];
  while (out.length < requiredCount) {
    out.push(plannedIterationPhase(requirementDigest, out.length + 1));
  }
  return out;
}

function requiredImplementationPhaseCount(assessment: ComplexityAssessment): number {
  if (assessment.level === 'complex') return 3;
  if (assessment.level === 'moderate' || assessment.splitRecommended || assessment.userForcedPhaseSplit) return 2;
  return 1;
}

function plannedIterationPhase(requirementDigest: string, index: number): ImplementationPhase {
  return {
    id: `P${index}`,
    title: `Iteration ${index} enhancements`,
    objective: `Deliver the next highest-priority iteration after P${index - 1}: ${requirementDigest}`,
    status: 'planned',
    scope: ['Next prioritized workflows', 'Extended integrations', 'Quality hardening', 'Functional validation update'],
    deliverables: ['Complete V-model iteration with requirement analysis, high-level design, detailed design, code, unit test, integration test, module test, and functional test steps.'],
    dependsOn: [`P${Math.max(1, index - 1)}`],
    verificationGate: defaultVerificationGate(`P${index}`),
  };
}

function defaultVerificationGate(iterationId: string) {
  return {
    summary: `${iterationId} iteration gate: documentation, automated tests, runnable entrypoint, and language quality checks must pass.`,
    checks: [
      'Declared functional validation documentation exists for this iteration.',
      'Automated test suite passes with no detected network API failure.',
      'Runnable entrypoint or public API probe succeeds.',
      'Language-specific build/lint checks pass when configured.',
    ],
    failurePolicy:
      'If any check fails, feed the full gate failure log into Debugger and repair the same iteration through the paired V-model rollback phase before rerunning subsequent phases.',
  };
}

function normalizeStepIterations(steps: Step[], _phases: ImplementationPhase[]): Step[] {
  return steps.map((step) => {
    const iterationId = step.iterationId ?? 'P1';
    return {
      ...step,
      iterationId,
    };
  });
}

function hasForcedPhaseSplit(text: string): boolean {
  return /\b(?:phase\s*\d+|multi[- ]phase|phase split|staged rollout)\b|分阶段|多阶段|分期|阶段拆分|一期|二期|第一阶段|第二阶段|后续阶段/iu.test(text);
}

function inferProjectType(text: string): ProjectType {
  const { libraryLike, appLike } = projectShapeSignals(text);
  if (libraryLike && appLike) return 'mixed';
  if (libraryLike) return 'library';
  return 'application';
}

function safeJson(text: string): unknown {
  // Strip ```json fences if present.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // attempt to find first JSON-looking substring
    const start = cleaned.indexOf('{');
    const lastObj = cleaned.lastIndexOf('}');
    const startArr = cleaned.indexOf('[');
    const lastArr = cleaned.lastIndexOf(']');
    const candidates: string[] = [];
    if (start >= 0 && lastObj > start) candidates.push(cleaned.slice(start, lastObj + 1));
    if (startArr >= 0 && lastArr > startArr) candidates.push(cleaned.slice(startArr, lastArr + 1));
    for (const c of candidates) {
      try {
        return JSON.parse(c);
      } catch {
        /* keep trying */
      }
    }
    throw new Error(`Planner returned non-JSON content:\n${text.slice(0, 500)}`);
  }
}
