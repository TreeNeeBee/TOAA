import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

/**
 * EditGuard 给写类工具加一层守门：
 *  - 累计行数上限（保护免被失控大改写）
 *  - 写操作落审计日志
 *
 * 接口与 Tool 一致，可通过 wrap() 包裹任意工具。
 */

export interface EditRecord {
  ts: string;
  stepId: string;
  tool: string;
  args: unknown;
  ok: boolean;
  summary?: string;
  error?: string;
  approxLines?: number;
}

export interface EditGuardOptions {
  ws: Workspace;
  stepId: string;
  /**
   * 单 Step 内累计写入/修改行数上限，超过则后续写操作直接拒绝。
   * 传入数字时按固定值执行；传入/省略 auto 时按当前 Step 上下文估算。
   */
  maxLines?: number | 'auto';
  /** 用于 auto 行数预算的 Step/工具上下文。 */
  budgetContext?: EditGuardBudgetContext;
  /** edits 日志绝对路径；优先用于把运行证据放在产品树之外。 */
  logPath?: string;
  /** edits 日志相对 workspace 的路径，独立使用时默认 logs/edits-<stepId>.jsonl。 */
  logRelPath?: string;
}

const WRITE_TOOLS = new Set(['write_file', 'append_file', 'apply_patch', 'replace_in_file', 'add_dependency']);
const DEFAULT_EDIT_LINES_PER_STEP = 400;
const AUTO_EDIT_LINES_HARD_CAP = 2400;

export interface EditGuardBudgetContext {
  phase?: string;
  role?: string;
  debug?: boolean;
  tools?: readonly string[];
  outputs?: readonly string[];
  allowedWrites?: readonly string[];
  contextChars?: number;
}

export function resolveEditGuardMaxLines(
  maxLines: number | 'auto' | undefined,
  ctx: EditGuardBudgetContext = {},
): number {
  if (typeof maxLines === 'number') return maxLines;

  const tools = new Set(ctx.tools ?? []);
  const writeToolBonus =
    (tools.has('write_file') ? 160 : 0) +
    (tools.has('append_file') ? 120 : 0) +
    (tools.has('apply_patch') ? 120 : 0) +
    (tools.has('replace_in_file') ? 80 : 0) +
    (tools.has('add_dependency') ? 20 : 0);

  const phaseBonus: Record<string, number> = {
    REQUIREMENT_ANALYSIS: 100,
    HIGH_LEVEL_DESIGN: 220,
    DETAILED_DESIGN: 180,
    CODE: 300,
    UNIT_TEST: 420,
    INTEGRATION_TEST: 420,
    MODULE_TEST: 420,
    FUNCTIONAL_TEST: 360,
  };

  const writeTargets = [...(ctx.outputs ?? []), ...(ctx.allowedWrites ?? [])];
  const uniqueTargets = new Set(writeTargets.map((x) => x.replace(/\\/g, '/').replace(/\/+$/, '')));
  let targetBonus = 0;
  for (const target of uniqueTargets) {
    if (!target) continue;
    const looksLikeFile = /\.[A-Za-z0-9]+$/.test(target);
    targetBonus += looksLikeFile ? 120 : 70;
    if (target.startsWith('tests/') || target.includes('/tests/')) targetBonus += 80;
    if (target.startsWith('src/') || target.includes('/src/')) targetBonus += 60;
  }
  targetBonus = Math.min(targetBonus, 640);

  const contextBonus = Math.min(Math.ceil((ctx.contextChars ?? 0) / 1200) * 40, 480);
  const debugBonus = ctx.debug || ctx.role === 'Debugger' ? 260 : 0;
  const dynamic =
    DEFAULT_EDIT_LINES_PER_STEP +
    (phaseBonus[ctx.phase ?? ''] ?? 160) +
    writeToolBonus +
    targetBonus +
    contextBonus +
    debugBonus;

  return Math.min(Math.max(dynamic, DEFAULT_EDIT_LINES_PER_STEP), AUTO_EDIT_LINES_HARD_CAP);
}

export class EditGuard {
  private accumulatedLines = 0;
  private readonly logAbs: string;
  private readonly maxLines: number;

  constructor(private readonly opts: EditGuardOptions) {
    this.maxLines = resolveEditGuardMaxLines(opts.maxLines, opts.budgetContext);
    this.logAbs = opts.logPath ?? opts.ws.abs(opts.logRelPath ?? `logs/edits-${opts.stepId}.jsonl`);
  }

  get totalLines(): number {
    return this.accumulatedLines;
  }

  /** 用 EditGuard 包装一个 Tool；非写类工具透传，仅写类工具走 guard 路径。 */
  wrap<A, R>(t: Tool<A, R>): Tool<A, R> {
    if (!WRITE_TOOLS.has(t.name)) return t;
    return {
      name: t.name,
      description: t.description,
      argsSchema: t.argsSchema,
      run: async (args: A, ctx: ToolContext): Promise<ToolResult<R>> => {
        if (this.accumulatedLines > this.maxLines) {
          const r: ToolResult<R> = {
            ok: false,
            error: `EditGuard: max ${this.maxLines} lines per step exceeded (now ${this.accumulatedLines})`,
          };
          await this.record({ tool: t.name, args, ok: false, error: r.error });
          return r;
        }
        const approx = approxLineDelta(t.name, args);
        const r = await t.run(args, ctx);
        if (r.ok && toolResultChanged(r)) this.accumulatedLines += approx;
        await this.record({
          tool: t.name,
          args,
          ok: r.ok,
          summary: r.summary,
          error: r.error,
          approxLines: approx,
        });
        return r;
      },
    };
  }

  private async record(partial: Omit<EditRecord, 'ts' | 'stepId'>): Promise<void> {
    const rec: EditRecord = { ts: new Date().toISOString(), stepId: this.opts.stepId, ...partial };
    try {
      await fs.mkdir(path.dirname(this.logAbs), { recursive: true });
      await fs.appendFile(this.logAbs, JSON.stringify(rec) + '\n', 'utf8');
    } catch {
      /* swallow */
    }
  }
}

function toolResultChanged(result: ToolResult): boolean {
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) return true;
  return (result.data as { changed?: unknown }).changed !== false;
}

/** 粗略估计本次写操作影响的行数。 */
function approxLineDelta(tool: string, args: unknown): number {
  const a = args as Record<string, unknown>;
  if ((tool === 'write_file' || tool === 'append_file') && typeof a?.content === 'string') {
    return countLines(a.content as string);
  }
  if (tool === 'replace_in_file') {
    const find = typeof a?.find === 'string' ? countLines(a.find as string) : 1;
    const repl = typeof a?.replace === 'string' ? countLines(a.replace as string) : 1;
    return Math.max(find, repl);
  }
  if (tool === 'apply_patch' && typeof a?.patch === 'string') {
    let c = 0;
    for (const ln of (a.patch as string).split('\n')) {
      if (ln.startsWith('+') && !ln.startsWith('+++')) c++;
      else if (ln.startsWith('-') && !ln.startsWith('---')) c++;
    }
    return c;
  }
  if (tool === 'add_dependency') {
    return Array.isArray(a?.packages) ? (a.packages as unknown[]).length : 1;
  }
  return 1;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split('\n').length;
}
