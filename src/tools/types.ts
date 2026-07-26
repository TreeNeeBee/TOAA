import type { Workspace } from '../workspace/workspace.js';
import type { Sandbox } from '../sandbox/types.js';
import type { AuditLogger } from '../audit/audit.js';
import type { Language } from '../core/plan.js';

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
  /** Optional protocol/UI permission hook for sensitive tool operations. */
  requestPermission?: ToolPermissionRequester;
  /** Optional protocol/UI event hook for tool calls and file changes. */
  onToolEvent?: ToolExecutionReporter;
}

/** 单次工具调用的结果统一结构。 */
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
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

/** 判断给定相对路径是否落在 allowedWrites 任何一项之下。 */
export function isAllowedWrite(rel: string, allowed: string[]): boolean {
  const norm = normalizeRel(rel);
  return allowed.some((a) => {
    const an = normalizeRel(a);
    if (norm === an) return true;
    if (an.endsWith('/')) return norm.startsWith(an);
    // 目录前缀（不含 / 的也按目录前缀匹配）
    return norm === an || norm.startsWith(an + '/');
  });
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
