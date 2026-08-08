import type { Workspace } from '../workspace/workspace.js';
import type { Sandbox } from '../sandbox/types.js';
import type { AuditLogger } from '../audit/audit.js';
import type { Language } from '../core/plan.js';
import type { StepType } from '../domain/steps/step.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';

export type ToolPermissionOperation =
  | 'shell_command'
  | 'file_write'
  | 'file_delete'
  | 'install_dependency'
  | 'config_change'
  | 'git_operation'
  | 'network_access'
  | 'test_command'
  | 'build_command'
  | 'external_read'
  | 'external_write';

export interface ToolPermissionRequest {
  id?: string;
  operationType: ToolPermissionOperation;
  target: string;
  reason: string;
  risk: string;
  scope: string;
  skippable: boolean;
  denyBehavior: string;
  stepId?: string;
  tool?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolPermissionDecision {
  approved: boolean;
  reason?: string;
}

export type ToolPermissionRequester = (request: ToolPermissionRequest) => Promise<ToolPermissionDecision>;

export interface ToolExecutionEvent {
  /** Unique per invocation, including repeated calls to the same tool in one Step. */
  callId: string;
  status: 'started' | 'completed';
  stepId: string;
  /** Human-readable Step name for UI; stepId remains the canonical identity. */
  stepName?: string;
  tool: string;
  target?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  summary?: string;
  error?: string;
  changedFiles?: string[];
  patch?: string;
}

export type ToolExecutionReporter = (event: ToolExecutionEvent) => void | Promise<void>;

/** 工具调用的统一上下文。 */
export interface ToolContext {
  ws: Workspace;
  sandbox: Sandbox;
  audit?: AuditLogger;
  /** 当前 Step 的 outputs 白名单（写操作必须落在白名单内）。 */
  allowedWrites: string[];
  /** 当前 Step 的 id（仅用于审计）。 */
  stepId: string;
  /**
   * The V-model phase being executed.
   *
   * Some tools are owned by one phase: the dependency manifest is authored by HIGH_LEVEL_DESIGN so
   * that one design decides the whole dependency set, and a Step elsewhere that needs a package
   * raises a Change Request to it rather than editing the manifest under it.
   */
  phase?: StepType;
  /** 目标语言（决定依赖清单文件等）。默认 python。 */
  language?: Language;
  /** 当前 Step 的 write_file / append_file 单次 content 字节预算。 */
  writeChunkBytes?: number;
  /** 当前活动模型的 input+output context window。 */
  contextWindowTokens?: number;
  /** 当前模型调用可用于生成 JSON/tool actions 的响应 token 预算。 */
  responseTokenBudget?: number;
  /** 下一轮可回传给模型的工具详情字符预算。 */
  feedbackCharBudget?: number;
  /** read_file 单次读取并回传的动态字节预算。 */
  readChunkBytes?: number;
  /** run_tests 未提供有效过滤参数时使用的当前阶段默认测试范围。 */
  defaultTestArgs?: string[];
  /** Incremental Tickets may create files but must patch, rather than overwrite, accepted files. */
  preserveExistingFiles?: boolean;
  /** Optional protocol/UI permission hook for sensitive tool operations. */
  requestPermission?: ToolPermissionRequester;
  /** Optional protocol/UI event hook for tool calls and file changes. */
  onToolEvent?: ToolExecutionReporter;
  /** Generic external-interaction record/replay boundary. */
  recordReplay?: RecordReplayController;
}

/** Stable identifiers for failures other modules must recognise without reading the message. */
export type ToolFailureCode =
  | 'write_denied'
  /** The run could not happen: an artifact another Step owns does not exist yet. */
  | 'manifest_missing'
  /** The dependency manifest belongs to another phase; the need has to travel there. */
  | 'dependency_not_owned'
  /** The command needs product source that CODE has not written yet. */
  | 'product_not_implemented';

/**
 * Whether a failure describes a condition this Step does not own and cannot repair.
 *
 * Three separate places have to make this judgment — the verification-repeat breaker, the
 * unresolved-failure record, and the quality gate — and each one that holds an unownable failure
 * against a Step blocks a completion no role there can earn. Listing the codes at each site is how
 * the third one gets forgotten, which is exactly what happened when `manifest_missing` was added.
 */
export function isUnownedStepFailure(code: ToolFailureCode | undefined): boolean {
  return code === 'manifest_missing' || code === 'product_not_implemented';
}

/** 单次工具调用的结果统一结构。 */
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /**
   * Set when a caller has to branch on *why* this failed.
   *
   * Matching the message text instead is how a wording change silently alters control flow: the
   * executor's loop-breaker keyed on the old denial prose and switched behaviour the moment that
   * prose was improved.
   */
  code?: ToolFailureCode;
  /** 用于摘要展示。 */
  summary?: string;
}

export interface Tool<A = unknown, R = unknown> {
  readonly name: string;
  readonly description: string;
  /** 简要 JSON Schema 描述参数（仅用于 prompt，不强校验）。 */
  readonly argsSchema: Record<string, unknown>;
  run(args: A, ctx: ToolContext): Promise<ToolResult<R>>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(t: Tool): void {
    this.tools.set(t.name, t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 仅返回白名单内可见的工具，供按 Step.tools 限定调用范围。 */
  pick(names: string[]): Tool[] {
    return names.map((n) => this.tools.get(n)).filter((x): x is Tool => !!x);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}

/**
 * 判断给定相对路径是否落在 allowedWrites 任何一项之下。
 *
 * Entries may be concrete paths, directory prefixes, or globs. Globs are not decoration: a Step
 * routinely declares outputs like `tests/modules/*.ts` before the individual files exist, and the
 * same list is shown to the model as its writable candidates. Matching them literally told the model
 * a path was writable and then refused every file under it, which is unfixable from the model's side
 * and burns a Step's whole round budget.
 *
 * Only decides *which* in-workspace path a Step may write; containment is enforced separately when
 * the path is resolved, so a pattern can never reach outside the workspace.
 */
export function isAllowedWrite(rel: string, allowed: string[]): boolean {
  const norm = normalizeRel(rel);
  return allowed.some((a) => {
    const an = normalizeRel(a);
    if (norm === an) return true;
    if (isGlob(an)) return globToRegExp(an).test(norm);
    if (an.endsWith('/')) return norm.startsWith(an);
    // 目录前缀（不含 / 的也按目录前缀匹配）
    return norm === an || norm.startsWith(an + '/');
  });
}

/**
 * Names what *is* writable, not merely that this path is not.
 *
 * A denial the model cannot act on costs a full round every time it guesses again; the allowlist is
 * in the system prompt but many rounds back and possibly trimmed, so it is repeated here.
 */
export function deniedWrite<T>(
  action: 'write' | 'append',
  rel: string,
  allowed: readonly string[],
): ToolResult<T> {
  const list = allowed.length > 0 ? allowed.join(', ') : '(none declared for this Step)';
  return {
    ok: false,
    code: 'write_denied',
    error: `${action} denied: ${rel} is not in this Step's writable allowlist=[${list}]. ` +
      'Write to one of those paths, or a path matching one of those patterns.',
  };
}

/** Whether a declared path is a pattern rather than one concrete file. */
export function isPathPattern(pattern: string): boolean {
  return isGlob(normalizeRel(pattern));
}

/** Matches a concrete workspace-relative path against a declared pattern. */
export function matchesPathPattern(rel: string, pattern: string): boolean {
  return globToRegExp(normalizeRel(pattern)).test(normalizeRel(rel));
}

function isGlob(pattern: string): boolean {
  return /[*?]/u.test(pattern);
}

/**
 * `**` crosses directory separators, `*` and `?` do not. Everything else is matched literally, so a
 * pattern cannot smuggle in regular-expression syntax.
 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `a/**/b` must also match `a/b`, so the separator that follows is absorbed here.
        const separator = pattern[index + 2] === '/';
        source += separator ? '(?:.*/)?' : '.*';
        index += separator ? 2 : 1;
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u');
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
