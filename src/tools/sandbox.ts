import type { Tool, ToolContext } from './types.js';
import { detectNetworkApiFailureInExec } from '../core/network_api_gate.js';
import { normalizeTypeScriptTestArgs } from '../sandbox/test_args.js';
import { resolveTypeScriptProgramCommand } from '../sandbox/program_args.js';
import { resolveWorkspacePath } from './path_guard.js';

/** 截取多行文本最后 N 行，用于在 ToolResult.summary 里给 LLM 直接看的失败上下文。
 * 仅在失败时调用——成功路径上 stdout 通常很长且无价值，没必要塞回 prompt。 */
function tailLines(text: string, n: number): string {
  if (!text) return '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines.slice(-n).join('\n');
}

/** Build a compact failure summary for run_program / run_tests.
 * 把硬截断写成单字节计数避免极端 case 把 prompt 撑爆（默认 4KB）。 */
function buildRunSummary(
  base: string,
  r: { stdout: string; stderr: string },
  opts: { tailLines?: number; maxBytes?: number } = {},
): string {
  const N = opts.tailLines ?? 60;
  const MAX = opts.maxBytes ?? 6000;
  const errTail = tailLines(r.stderr ?? '', N).trim();
  const outTail = tailLines(r.stdout ?? '', N).trim();
  const parts = [base];
  if (errTail) parts.push('--- stderr (last lines) ---', errTail);
  if (outTail) parts.push('--- stdout (last lines) ---', outTail);
  let s = parts.join('\n');
  if (s.length > MAX) {
    const originalLength = s.length;
    const marker = `\n... [truncated, total ${originalLength}B] ...\n`;
    const available = Math.max(0, MAX - marker.length);
    const headLength = Math.ceil(available * 0.55);
    const tailLength = available - headLength;
    s = `${s.slice(0, headLength)}${marker}${s.slice(-tailLength)}`;
  }
  return s;
}

export const runProgramTool: Tool<
  { args: string[]; cwd?: string; timeoutMs?: number },
  { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
> = {
  name: 'run_program',
  description:
    '在沙盒内运行工程入口程序或常见项目命令（Python: python <args>；TypeScript: 默认 npx tsx <entry>，也支持 npm/npx/node/tsx/tsc 前缀）。',
  argsSchema: { args: 'string[]', cwd: 'string?', timeoutMs: 'number?' },
  async run(args, ctx) {
    const cwd = await resolveSandboxCwd(ctx, args.cwd, 'run_program.cwd');
    if (!cwd.ok) return { ok: false, error: cwd.error };
    const r = await ctx.sandbox.runProgram(args.args, { cwd: cwd.abs, timeoutMs: args.timeoutMs });
    const networkFailure = detectNetworkApiFailureInExec(r);
    const ok = r.exitCode === 0 && !r.timedOut && !networkFailure;
    const command = ctx.language === 'typescript' ? resolveTypeScriptProgramCommand(args.args).display : `python ${args.args.join(' ')}`.trim();
    const base = `${command} exit=${r.exitCode} ${r.timedOut ? '(timeout)' : ''}`.trim();
    return {
      ok,
      data: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut },
      summary: ok
        ? base
        : buildRunSummary(networkFailure ? `${base}\n${networkFailure.message}\nEvidence: ${networkFailure.evidence}` : base, r),
    };
  },
};

export const runTestsTool: Tool<
  { args?: string[]; cwd?: string; timeoutMs?: number },
  { exitCode: number; stdout: string; stderr: string; timedOut: boolean; passed: boolean }
> = {
  name: 'run_tests',
  description:
    '在沙盒内运行测试套件（Python: pytest；TypeScript: npm test / Vitest），可指定额外参数。' +
    '失败时 summary 自动附带 stderr/stdout 末尾若干行，调用方可直接据此修复。',
  argsSchema: { args: 'string[]?', cwd: 'string?', timeoutMs: 'number?' },
  async run(args, ctx) {
    const cwd = await resolveSandboxCwd(ctx, args.cwd, 'run_tests.cwd');
    if (!cwd.ok) return { ok: false, error: cwd.error };
    const requestedArgs = args.args ?? [];
    const requestedEffectiveArgs = ctx.language === 'typescript'
      ? normalizeTypeScriptTestArgs(requestedArgs)
      : requestedArgs;
    const hasExplicitTestSelector =
      ctx.language === 'typescript' && requestedEffectiveArgs.some((arg) => !arg.startsWith('-'));
    const runArgs =
      ctx.language === 'typescript' && ctx.defaultTestArgs?.length && !hasExplicitTestSelector
        ? [...ctx.defaultTestArgs, ...requestedEffectiveArgs]
        : requestedEffectiveArgs.length === 0 && ctx.defaultTestArgs?.length
          ? ctx.defaultTestArgs
          : requestedEffectiveArgs;
    const r = await ctx.sandbox.runTests(runArgs, { cwd: cwd.abs, timeoutMs: args.timeoutMs });
    const networkFailure = detectNetworkApiFailureInExec(r);
    const passed = r.exitCode === 0 && !r.timedOut && !networkFailure;
    const cmd = ctx.language === 'typescript' ? 'npm test' : 'pytest';
    const base = [
      `${cmd} exit=${r.exitCode}`,
      r.timedOut ? '(timeout)' : '',
      runArgs.length > 0 ? `args=${runArgs.join(' ')}` : '',
    ].filter(Boolean).join(' ');
    return {
      ok: passed,
      data: {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        passed,
      },
      summary: passed
        ? base
        : buildRunSummary(networkFailure ? `${base}\n${networkFailure.message}\nEvidence: ${networkFailure.evidence}` : base, r),
    };
  },
};

async function resolveSandboxCwd(
  ctx: ToolContext,
  cwd: string | undefined,
  operation: string,
): Promise<{ ok: true; abs?: string } | { ok: false; error: string }> {
  if (!cwd) return { ok: true };
  const resolved = await resolveWorkspacePath(ctx.ws, cwd, operation, { mustExist: true });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, abs: resolved.abs };
}

export const installDepsTool: Tool<{ packages: string[] }, { exitCode: number; stdout: string; stderr: string }> = {
  name: 'install_deps',
  description:
    '在沙盒内安装一组额外依赖（Python: pip install；TypeScript: npm install）。不会自动写回依赖清单。',
  argsSchema: { packages: 'string[]' },
  async run(args, ctx) {
    const r = await ctx.sandbox.installDeps(args.packages);
    const ok = r.exitCode === 0;
    const cmd = ctx.language === 'typescript' ? 'npm install' : 'pip install';
    const base = `${cmd} ${args.packages.join(' ')} exit=${r.exitCode}`;
    return {
      ok,
      data: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr },
      summary: ok ? base : buildRunSummary(base, r),
    };
  },
};
