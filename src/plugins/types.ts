import type { ClarifyQuestion, PlannerInput } from '../agents/planner.js';
import type { AuditLogger } from '../audit/audit.js';
import type { Plan, PlanIntent, Role, Step } from '../core/plan.js';
import type { ChatMessage, ChatOptions } from '../llm/types.js';
import type { AgentSkillMetadata, SkillSource } from '../skills/types.js';
import type { Tool, ToolContext, ToolResult } from '../tools/types.js';

export interface EngineRunSummary {
  totalSteps: number;
  executedSteps: number;
  failedStepId?: string;
  failureLog?: string;
  failureReason?: string;
}

export interface StepAttemptOutcome {
  ok: boolean;
  failureLog: string;
  reason?: string;
}

/**
 * XCompiler 的公共生命周期 Hook。
 *
 * Context 对象会按顺序传给所有 handler；插件可以原位补充或调整字段，但不得替换
 * workspace / audit 等核心服务。涉及文件写入时仍必须通过 Tool 与 EditGuard。
 */
export interface HookContextMap {
  'compile.start': {
    workspace: string;
    intent: PlanIntent;
    topicMode: boolean;
  };
  'compile.afterClarify': {
    rawRequirement: string;
    questions: ClarifyQuestion[];
    clarifications: PlannerInput['clarifications'];
    userAddenda: string;
  };
  'compile.beforeDecompose': {
    input: PlannerInput;
  };
  'compile.afterPlan': {
    plan: Plan;
  };
  'compile.finish': {
    plan: Plan;
    planPath: string;
    phasePlanPath?: string;
    currentPlanPath?: string;
  };
  'run.before': {
    plan: Plan;
  };
  'run.after': {
    plan: Plan;
    result: EngineRunSummary;
  };
  'run.error': {
    plan: Plan;
    error: unknown;
  };
  'step.before': {
    plan: Plan;
    step: Step;
  };
  'step.after': {
    plan: Plan;
    step: Step;
    ok: boolean;
  };
  'step.error': {
    plan: Plan;
    step: Step;
    error: unknown;
  };
  'step.attempt.before': {
    plan: Plan;
    step: Step;
    role: Role;
    debug: boolean;
    retry: number;
  };
  'step.attempt.after': {
    plan: Plan;
    step: Step;
    role: Role;
    debug: boolean;
    retry: number;
    outcome: StepAttemptOutcome;
  };
  'tool.before': {
    stepId: string;
    tool: string;
    args: unknown;
    context: ToolContext;
  };
  'tool.after': {
    stepId: string;
    tool: string;
    args: unknown;
    context: ToolContext;
    result: ToolResult;
  };
  'tool.error': {
    stepId: string;
    tool: string;
    args: unknown;
    context: ToolContext;
    error: unknown;
  };
  'llm.before': {
    role: string;
    model: string;
    messages: ChatMessage[];
    options?: ChatOptions;
  };
  'llm.after': {
    role: string;
    model: string;
    messages: ChatMessage[];
    response: string;
    durationMs: number;
  };
  'llm.error': {
    role: string;
    model: string;
    messages: ChatMessage[];
    error: unknown;
    durationMs: number;
  };
}

export type HookName = keyof HookContextMap;
export type HookHandler<K extends HookName> = (
  context: HookContextMap[K],
) => void | Promise<void>;

export interface HookRegistrationOptions {
  /** 数值越大越先执行；相同优先级保持插件及注册顺序。 */
  priority?: number;
}

export interface PluginApi {
  /** 当前 XCompiler 核心版本。 */
  readonly xcompilerVersion: string;
  /** 当前插件 API 主版本；仅同一主版本兼容。 */
  readonly pluginApiVersion: number;
  on<K extends HookName>(
    hook: K,
    handler: HookHandler<K>,
    options?: HookRegistrationOptions,
  ): () => void;
  registerTool(tool: Tool): void;
  /** Register an Agent Skills Specification directory containing SKILL.md files. */
  registerSkillDirectory(directory: string): void;
}

/** 可序列化的插件清单；后续 registry / marketplace 不需要加载插件代码即可读取。 */
export interface XCompilerPluginManifest {
  /** 全局唯一且稳定的插件 ID，例如 `company.policy-checker`。 */
  id: string;
  /** 插件自身版本，必须是完整 SemVer。 */
  version: string;
  /** 插件编译时面向的 XCompiler Plugin API 主版本。 */
  apiVersion: number;
  /** 插件可运行的最低 XCompiler 核心版本；必填完整 SemVer。 */
  minXCompilerVersion: string;
  /** 以下字段用于插件目录展示，不参与运行时兼容判定。 */
  displayName?: string;
  description?: string;
  license?: string;
  homepage?: string;
  keywords?: string[];
  /** Agent Skills Specification directories, resolved relative to the plugin entry module. */
  skills?: string[];
}

export type PluginCompatibilityCode =
  | 'compatible'
  | 'invalid-runtime-version'
  | 'invalid-id'
  | 'invalid-plugin-version'
  | 'invalid-min-xcompiler-version'
  | 'api-version-mismatch'
  | 'xcompiler-version-too-old';

export interface PluginCompatibilityReport {
  compatible: boolean;
  code: PluginCompatibilityCode;
  pluginId: string;
  pluginVersion: string;
  xcompilerVersion: string;
  pluginApiVersion: number;
  message?: string;
}

export interface XCompilerPlugin {
  manifest: XCompilerPluginManifest;
  /** 默认 continue：记录错误但不拖垮核心流程。 */
  failureMode?: 'continue' | 'fail';
  setup(api: PluginApi): void | Promise<void>;
}

/** 插件磁盘来源；manifest 与可执行入口分离，兼容检查先于模块 import。 */
export interface PluginSource {
  manifestPath: string;
  entryPath: string;
  /** 模块导出名，默认 `default`。 */
  exportName?: string;
  /** Plugin root used to resolve manifest-declared Skill directories. Defaults to entry directory. */
  rootPath?: string;
}

export interface PluginLoadOptions {
  sources: PluginSource[];
  baseDir?: string;
  audit?: AuditLogger;
  xcompilerVersion?: string;
  pluginApiVersion?: number;
}

export interface PluginHostOptions {
  plugins?: XCompilerPlugin[];
  /** 强制所有插件错误中断主流程，适合 CI / 合规插件。 */
  strict?: boolean;
  audit?: AuditLogger;
  /** 嵌入式宿主可显式传入版本；一般应使用内置默认值。 */
  xcompilerVersion?: string;
  pluginApiVersion?: number;
}

export interface PluginExtensionTarget {
  tools: {
    get(name: string): Tool | undefined;
    register(tool: Tool): void;
  };
  skills: {
    get(name: string): AgentSkillMetadata | undefined;
    registerDirectory(directory: string, source: SkillSource): AgentSkillMetadata[];
  };
}
