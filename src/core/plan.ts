import { z } from 'zod';

/**
 * Planned V-model phases.
 *
 * DEBUG deliberately does not belong here: it is an execution mode entered after
 * a failed gate and routed back to the paired source phase.
 */
export const V_MODEL_PAIRS = [
  ['REQUIREMENT_ANALYSIS', 'FUNCTIONAL_TEST'],
  ['HIGH_LEVEL_DESIGN', 'MODULE_TEST'],
  ['DETAILED_DESIGN', 'INTEGRATION_TEST'],
  ['CODE', 'UNIT_TEST'],
] as const;

export type VModelDevelopmentPhase = (typeof V_MODEL_PAIRS)[number][0];
export type VModelTestPhase = (typeof V_MODEL_PAIRS)[number][1];
export type Phase = VModelDevelopmentPhase | VModelTestPhase;

export const V_MODEL_DEVELOPMENT_PHASES = V_MODEL_PAIRS.map(
  ([phase]) => phase,
) as readonly VModelDevelopmentPhase[];
export const V_MODEL_TEST_PHASES = [...V_MODEL_PAIRS].reverse().map(
  ([, phase]) => phase,
) as readonly VModelTestPhase[];

export const PHASES = [
  ...V_MODEL_DEVELOPMENT_PHASES,
  ...V_MODEL_TEST_PHASES,
] as unknown as readonly [Phase, ...Phase[]];

export const EXECUTION_MODES = ['NORMAL', 'DEBUG'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** Core V-model phases that every executable iteration must cover. */
export const REQUIRED_V_MODEL_PHASES = PHASES;

/** Synchronous test-design mapping generated while executing the corresponding left-side phase. */
export const V_MODEL_SOURCE_TO_TEST_PHASE = Object.fromEntries(
  V_MODEL_PAIRS,
) as Record<VModelDevelopmentPhase, VModelTestPhase>;

/** Test failure rollback target: a failed test phase debugs from its paired source phase. */
export const V_MODEL_TEST_TO_SOURCE_PHASE = Object.fromEntries(
  V_MODEL_PAIRS.map(([source, test]) => [test, source]),
) as Record<VModelTestPhase, VModelDevelopmentPhase>;

export const PHASE_ORDER = Object.fromEntries(
  PHASES.map((phase, index) => [phase, index]),
) as Record<Phase, number>;

/** Supported target languages for generated projects. */
export const LANGUAGES = ['python', 'typescript'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Plan intent: greenfield generation, incremental work, or isolated self-bootstrap. */
export const PLAN_INTENTS = ['greenfield', 'feature', 'refactor', 'self'] as const;
export type PlanIntent = (typeof PLAN_INTENTS)[number];

/** Project shape determines delivery documentation requirements. */
export const PROJECT_TYPES = ['application', 'library', 'mixed'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

/** Planner's first-pass project complexity estimate. */
export const COMPLEXITY_LEVELS = ['simple', 'moderate', 'complex'] as const;
export type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];

/** Implementation phase status. Only `current` is materialized as executable Steps. */
export const IMPLEMENTATION_PHASE_STATUSES = ['current', 'planned', 'complete', 'deferred'] as const;
export type ImplementationPhaseStatus = (typeof IMPLEMENTATION_PHASE_STATUSES)[number];

export const STEP_STATUSES = [
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const ROLES = [
  'Planner',
  'Architect',
  'Coder',
  'Tester',
  'Debugger',
] as const;
export type Role = (typeof ROLES)[number];

/**
 * HIGH_LEVEL_DESIGN 阶段的结构化模块契约。
 *
 * Planner 在执行 V 模型前先声明本次要新增/修改的架构模块；HIGH_LEVEL_DESIGN Step 将其展开为
 * docs/02-high-level-design.md，后续 CODE / MODULE_TEST Step 则必须完整覆盖这里登记的路径。
 * 字段保持在 Plan 顶层，是为了让 lint 能在真正执行前发现“架构有模块、实现却漏文件”的问题。
 */
export const ArchitectureModuleSchema = z
  .object({
    id: z.string().regex(/^M\d{3,}$/u, 'Architecture module id must look like M001'),
    name: z.string().min(1),
    responsibility: z.string().min(10),
    sourcePaths: z.array(z.string().min(1)).default([]),
    assetPaths: z.array(z.string().min(1)).optional(),
    testPaths: z.array(z.string().min(1)).min(1),
    dependencies: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((module, ctx) => {
    if (module.sourcePaths.length === 0 && (module.assetPaths?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Architecture module must declare at least one sourcePath or assetPath',
      });
    }
  });

export type ArchitectureModule = z.infer<typeof ArchitectureModuleSchema>;

export interface StepSubtask {
  id: string;
  title: string;
  description: string;
  acceptance?: string;
  outputs?: string[];
  subTasks?: StepSubtask[];
}

export const StepSubtaskSchema: z.ZodType<StepSubtask> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      description: z.string().min(1),
      acceptance: z.string().min(1).optional(),
      outputs: z.array(z.string().min(1)).optional(),
      subTasks: z.array(StepSubtaskSchema).optional(),
    })
    .strict()
    .superRefine((task, ctx) => {
      if (maxSubtaskDepth(task) > 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Step subTasks may be nested at most 2 levels below the parent Step',
          path: ['subTasks'],
        });
      }
    }),
);

export const ComplexityAssessmentSchema = z
  .object({
    level: z.enum(COMPLEXITY_LEVELS),
    rationale: z.string().min(1),
    splitRecommended: z.boolean().default(false),
    userForcedPhaseSplit: z.boolean().default(false),
  })
  .strict();

export type ComplexityAssessment = z.infer<typeof ComplexityAssessmentSchema>;

export const IterationVerificationGateSchema = z
  .object({
    summary: z.string().min(1),
    checks: z.array(z.string().min(1)).min(1),
    failurePolicy: z.string().min(1),
  })
  .strict();

export type IterationVerificationGate = z.infer<typeof IterationVerificationGateSchema>;

export const ImplementationPhaseSchema = z
  .object({
    id: z.string().regex(/^P\d{1,3}$/u, 'Implementation phase id must look like P1'),
    title: z.string().min(1),
    objective: z.string().min(1),
    status: z.enum(IMPLEMENTATION_PHASE_STATUSES).default('deferred'),
    scope: z.array(z.string().min(1)).default([]),
    deliverables: z.array(z.string().min(1)).default([]),
    dependsOn: z.array(z.string()).default([]),
    verificationGate: IterationVerificationGateSchema.optional(),
  })
  .strict();

export type ImplementationPhase = z.infer<typeof ImplementationPhaseSchema>;

function maxSubtaskDepth(task: StepSubtask): number {
  const children = task.subTasks ?? [];
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map(maxSubtaskDepth));
}

export const StepSchema = z
  .object({
    id: z.string().regex(/^S\d{3,}$/u, 'Step id must look like S001'),
    iterationId: z.string().regex(/^P\d{1,3}$/u, 'Step iterationId must look like P1').default('P1'),
    phase: z.enum(PHASES),
    title: z.string().min(1),
    description: z.string().min(1),
    /**
     * 本 Step 专属的系统提示词。xcompiler_build 需为每个 Step 给出明确的范围、输入、产出、验收与禁令，
     * xcompiler_run 会拼接到 Executor 的通用 system prompt 后，以防止 LLM 发散。
     */
    systemPrompt: z.string().min(1, 'systemPrompt must be non-empty (xcompiler_build must populate)'),
    role: z.enum(ROLES),
    tools: z.array(z.string()).default([]),
    inputs: z.array(z.string()).default([]),
    outputs: z.array(z.string()).default([]),
    subTasks: z.array(StepSubtaskSchema).optional(),
    dependsOn: z.array(z.string()).default([]),
    acceptance: z.string().min(1),
    status: z.enum(STEP_STATUSES).default('PENDING'),
    retries: z.number().int().nonnegative().default(0),
    maxRetries: z.number().int().positive().default(3),
  })
  .strict();

export type Step = z.infer<typeof StepSchema>;

export const PlanSchema = z
  .object({
    version: z.literal('1'),
    language: z.enum(LANGUAGES).default('python'),
    intent: z.enum(PLAN_INTENTS).default('greenfield'),
    /** Materialized implementation phase for this phase-specific plan file. */
    phaseId: z.string().regex(/^P\d{1,3}$/u, 'Plan phaseId must look like P1').default('P1'),
    projectType: z.enum(PROJECT_TYPES).default('application'),
    requirementDigest: z.string().min(1),
    complexityAssessment: ComplexityAssessmentSchema,
    implementationPhases: z.array(ImplementationPhaseSchema).min(1),
    /**
     * Structured architecture modules. Non-trivial plans must populate this contract.
     */
    architectureModules: z.array(ArchitectureModuleSchema).optional(),
    /** 全局开发约束（项目背景、语言与依赖策略），会拼接到每个 Step 的 system prompt 中。 */
    globalPrompt: z.string().default(''),
    /** 增量开发时的基线工程摘要（由 xcompiler_build 从现有 workspace 文档/源码树汇总）。 */
    baselineSummary: z.string().default(''),
    /** HIGH_LEVEL_DESIGN 阶段决定的依赖初始集（Python 写入 requirements.txt；TypeScript 写入 package.json）。 */
    dependencies: z.array(z.string()).optional(),
    /**
     * 需求澄清阶段用户补充的自定义需求（预留位）。
     * 不在 Planner 问题列表中的额外约束 / 补充说明 都会在这里原样保留，
     * 并拼接到 Planner.decompose 与每个 Step 的 system prompt。为空字符串代表"无补充需求"。
     */
    userAddenda: z.string().default(''),
    createdAt: z.string().min(1),
    steps: z.array(StepSchema).min(1),
  }).strict();

export type Plan = z.infer<typeof PlanSchema>;
