import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isPathPattern, type Tool, type ToolContext, type ToolFailureCode } from './types.js';
import type { StepType } from '../domain/steps/step.js';
import { detectNetworkApiFailureInExec } from '../core/network_api_gate.js';
import { normalizeTypeScriptTestArgs } from '../sandbox/test_args.js';
import { resolveTypeScriptProgramCommand } from '../sandbox/program_args.js';
import { resolveWorkspacePath } from './path_guard.js';
import { isExecutableTestPath } from '../core/test_assets.js';
import { buildDebugBrief } from '../core/debug_brief.js';

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

function extractVitestEvidence(stdout: string): string[] {
  const lines = stdout
    .replaceAll('\r', '')
    .split('\n');
  const evidence: string[] = [];
  const tests = lines.find((line) => /^\s*Tests\s+/u.test(line));
  if (tests) evidence.push(tests.trim().replaceAll(/\s+/gu, ' '));
  const coverage = lines.find((line) => /^\s*All files\s*\|/u.test(line));
  if (coverage) {
    const columns = coverage.split('|').map((value) => value.trim());
    if (columns.length >= 5) {
      evidence.push(
        `coverage statements=${columns[1]}% branches=${columns[2]}% functions=${columns[3]}% lines=${columns[4]}%`,
      );
    }
  }
  const lowCoverageFiles: string[] = [];
  let directory = '';
  for (const line of lines) {
    const columns = line.split('|').map((value) => value.trim());
    if (columns.length < 5 || !/^\d+(?:\.\d+)?$/u.test(columns[4] ?? '')) continue;
    const label = columns[0] ?? '';
    if (!label.includes('.')) {
      if (label.startsWith('src')) directory = label;
      continue;
    }
    const lineCoverage = Number(columns[4]);
    if (lineCoverage >= 80) continue;
    const file = directory && !label.startsWith('src/') ? `${directory}/${label}` : label;
    lowCoverageFiles.push(`${file}=${lineCoverage}%`);
  }
  if (lowCoverageFiles.length > 0) {
    evidence.push(`low-coverage files: ${lowCoverageFiles.slice(0, 8).join(', ')}`);
  }
  return evidence;
}

export const runProgramTool: Tool<
  { args: string[]; cwd?: string; timeoutMs?: number },
  { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
> = {
  name: 'run_program',
  description:
    '在沙盒内运行工程入口程序或常见项目命令。' +
    'Python：解释器由 Runtime 提供，args 直接从解释器之后写起（例如 ["-m", "py_compile", "x.py"] 或 ["src/main.py"]）；' +
    '多写一个 python 前缀会被忽略。TypeScript：默认 npx tsx <entry>，也支持 npm/npx/node/tsx/tsc 前缀。',
  argsSchema: { args: 'string[]', cwd: 'string?', timeoutMs: 'number?' },
  async run(args, ctx) {
    const cwd = await resolveSandboxCwd(ctx, args.cwd, 'run_program.cwd');
    if (!cwd.ok) return { ok: false, error: cwd.error };
    const r = await ctx.sandbox.runProgram(args.args, { cwd: cwd.abs, timeoutMs: args.timeoutMs });
    // What was executed decides, not which tool executed it. A Step that wants a specific invocation
    // runs the test runner through run_program, and a suite covering "the dependency is unreachable"
    // prints network-failure text on its way to passing — the same false failure `run_tests` was
    // fixed for, arriving by the other door because that fix keyed on the tool.
    const ranTests = isTestRunnerInvocation(args.args);
    const failed = r.exitCode !== 0 || r.timedOut;
    const networkFailure = ranTests && !failed ? null : detectNetworkApiFailureInExec(r);
    const ok = !failed && !networkFailure;
    const command = ctx.language === 'typescript' ? resolveTypeScriptProgramCommand(args.args).display : `python ${args.args.join(' ')}`.trim();
    const base = `${command} exit=${r.exitCode} ${r.timedOut ? '(timeout)' : ''}`.trim();
    return {
      ok,
      data: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut },
      summary: ok
        ? base
        : buildRunSummary(networkFailure ? `${base}\n${networkFailure.message}\nEvidence: ${networkFailure.evidence}` : base, r),
      ...(ok ? {} : await diagnoseSandboxFailure(ctx, base, r, 'program')),
    };
  },
};

/**
 * Declared test selectors that have no file behind them yet.
 *
 * Selectors come from the plan, not the filesystem — `pairedTestAssetPaths` derives them from the
 * paired source Step's declared outputs — so nothing else reconciles the two. Only gate selectors
 * are checked: a caller's own extra arguments may legitimately be flags or patterns, and the
 * verification supplement root is created at runtime.
 */
async function unwrittenSelectors(ctx: ToolContext, gateSelectors: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const selector of gateSelectors) {
    // Flags are not paths, and a pattern names files that need not exist yet for the pattern itself
    // to be correct — refusing either would block invocations that are perfectly well formed.
    if (selector.startsWith('-')) continue;
    if (isPathPattern(selector)) continue;
    if (await ctx.ws.exists(selector)) continue;
    missing.push(selector);
  }
  return missing;
}

export const runTestsTool: Tool<
  { args?: string[]; cwd?: string; timeoutMs?: number },
  {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    passed: boolean;
    effectiveArgs: string[];
    failedTests: string[];
  }
> = {
  name: 'run_tests',
  description:
    '在沙盒内运行测试套件（Python: pytest；TypeScript: npm test / Vitest），可指定额外参数。' +
    'TypeScript UNIT_TEST 门禁会自动启用覆盖率采集，无需重复传 --coverage。' +
    '失败时 summary 自动附带 stderr/stdout 末尾若干行，调用方可直接据此修复。',
  argsSchema: { args: 'string[]?', cwd: 'string?', timeoutMs: 'number?' },
  async run(args, ctx) {
    const cwd = await resolveSandboxCwd(ctx, args.cwd, 'run_tests.cwd');
    if (!cwd.ok) return { ok: false, error: cwd.error };
    const requestedArgs = args.args ?? [];
    const requestedEffectiveArgs = ctx.language === 'typescript'
      ? normalizeTypeScriptTestArgs(requestedArgs)
      : requestedArgs;
    // Runtime owns the exact paired selectors. S005-S008 add only their isolated supplement root;
    // neighbouring undeclared tests remain an incomplete-suite Enhancement instead of leaking in.
    const gateArgs = await appendVerificationSupplements(ctx, ctx.testGateArgs ?? []);
    // A selector naming a file the Step has not written yet describes a run that cannot pass, and
    // the runner reports it as a usage error — `file or directory not found`, which reads as a
    // broken environment rather than as unfinished work. A live dbc3 CODE Step spent all ten of its
    // rounds re-issuing that same invocation while Runtime told it, correctly and repeatedly, which
    // five outputs it still owed; the run stopped on the non-convergence guard. Refusing here turns
    // those rounds into one refusal that names the files to write.
    const unwritten = await unwrittenSelectors(ctx, ctx.testGateArgs ?? []);
    if (unwritten.length > 0) {
      // Deliberately no `code`: those mark conditions a Step does not own, and this one it does —
      // the files are its own declared outputs, so the ordinary repairable path is correct.
      return {
        ok: false,
        error:
          `run_tests refused: this Step's declared test files do not exist yet: ${unwritten.join(', ')}. ` +
          'Write them first — the suite cannot run, let alone pass, until they exist. ' +
          'Author each file with its real assertions against the product module it verifies.',
      };
    }
    const runArgs = mergeTestGateArgs(gateArgs, requestedEffectiveArgs);
    const r = await ctx.sandbox.runTests(runArgs, { cwd: cwd.abs, timeoutMs: args.timeoutMs });
    // A test runner's verdict is its exit code. Network text inside a passing suite is the suite's
    // own subject matter — a project whose tests cover "the source is unreachable" prints exactly
    // that on the way to passing. The detector only explains a run that already failed.
    //
    // It used to override a green suite, and the guard meant to prevent that — skipping lines vitest
    // labels `stderr | ` as captured test output — does not apply under `--reporter=json`, where the
    // same content arrives inside the JSON payload unlabelled. A UNIT_TEST Step was failed five
    // times on `exit=0`, had nothing to repair, and each rejection carried a slightly different
    // signature, so the recurrence breaker never saw it as the same failure.
    const failed = r.exitCode !== 0 || r.timedOut;
    const networkFailure = failed ? detectNetworkApiFailureInExec(r) : null;
    const passed = !failed;
    const cmd = ctx.language === 'typescript' ? 'npm test' : 'pytest';
    const base = [
      `${cmd} exit=${r.exitCode}`,
      r.timedOut ? '(timeout)' : '',
      runArgs.length > 0 ? `args=${runArgs.join(' ')}` : '',
    ].filter(Boolean).join(' ');
    const successEvidence = ctx.language === 'typescript' ? extractVitestEvidence(r.stdout) : [];
    const failedTests = failed
      ? buildDebugBrief({ failureLog: `${r.stderr}\n${r.stdout}` }).failedTests
      : [];
    return {
      ok: passed,
      data: {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        passed,
        effectiveArgs: runArgs,
        failedTests,
      },
      summary: passed
        ? [base, ...successEvidence].join('\n')
        : buildRunSummary(networkFailure ? `${base}\n${networkFailure.message}\nEvidence: ${networkFailure.evidence}` : base, r),
      ...(passed ? await Promise.resolve({}) : await diagnoseSandboxFailure(ctx, base, r, 'tests')),
    };
  },
};

async function appendVerificationSupplements(
  ctx: ToolContext,
  gateArgs: readonly string[],
): Promise<string[]> {
  if (!ctx.supplementalTestRoot) return [...gateArgs];
  const supplements: string[] = [];
  await walkTestFiles(
    ctx.ws.abs(ctx.supplementalTestRoot),
    ctx.supplementalTestRoot.replace(/\/$/u, ''),
    ctx.language ?? 'python',
    supplements,
  );
  return [...new Set([...gateArgs, ...supplements.sort()])];
}

async function walkTestFiles(
  abs: string,
  rel: string,
  language: NonNullable<ToolContext['language']>,
  out: string[],
): Promise<void> {
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const childAbs = path.join(abs, entry.name);
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) await walkTestFiles(childAbs, childRel, language, out);
    else if (isExecutableTestPath(childRel, language)) out.push(childRel);
  }
}

/**
 * Says why a run could not happen at all, rather than reporting it as a failing suite.
 *
 * A TypeScript project's `package.json` is authored by HIGH_LEVEL_DESIGN, so every earlier Step runs
 * `npm test` against a workspace that has no manifest yet. npm exits with an opaque code, the
 * executor reads it as a test failure, and the Step burns its debug rounds trying to repair tests
 * that were never collected — a repair no role can make, because the manifest is another Step's
 * declared output.
 */
/**
 * Explains a failed sandbox command in terms of what the caller can do about it.
 *
 * Shared by `run_tests` and `run_program` because they hit the identical wall: the toolchain is not
 * there. It was only wired into `run_tests`, so a Step that reached for the runner directly —
 * `run_program npx vitest`, which is what a Debugger does — got an opaque exit code, none of the
 * `manifest_missing` guards fired, and it spent its whole round budget repairing a project that had
 * no way to run anything yet.
 */
async function diagnoseSandboxFailure(
  ctx: ToolContext,
  base: string,
  result: { exitCode: number; stderr: string },
  intent: 'tests' | 'program',
): Promise<{ error: string; code?: ToolFailureCode }> {
  if (ctx.language !== 'typescript' || result.exitCode === 0) return { error: base };
  // Distinct from a missing manifest and, unlike it, repairable here: the manifest names the command
  // but nothing has installed it. Reported as an opaque exit code, no Step reaches for the tool that
  // fixes it — a whole live run went by without `install_deps` being called once.
  if (/\bcommand not found\b|\bENOENT\b.*\bvitest\b/iu.test(result.stderr)) {
    return {
      error: `${base}\nThe command is named in package.json but is not installed in this sandbox. ` +
        'Run install_deps for the devDependencies it declares, then run it again.',
    };
  }
  // `tsc` found no inputs because the sources it is configured to compile do not exist yet. Before
  // CODE runs, that is the V-model working as intended, not a defect in the design Step that ran it
  // — and left as a plain exit code it is one the Step tries to repair. Three design Steps in a live
  // run spent 43 rounds on it, and the repair they converged on was editing `tsconfig.json` to point
  // at a file that is not source, which corrupts the project the next Step has to build.
  if (isProductAuthoringPending(ctx.phase) && /\bTS18003\b/u.test(result.stderr)) {
    return {
      code: 'product_not_implemented',
      error: `${base}\nThe configured source files do not exist yet; they are the CODE Step's output. ` +
        'This is expected before CODE runs and is not this Step\'s to repair. Do not edit tsconfig.json ' +
        'to make the compiler quiet — leave the configuration describing the source layout it will have.',
    };
  }
  if (await ctx.ws.exists('package.json')) return { error: base };
  return {
    code: 'manifest_missing',
    error: `${base}\nNo package.json in ${ctx.ws.root}, so nothing declares ${
      intent === 'tests' ? 'a test script' : 'this command'
    } or the packages it needs. ` +
      'This project\'s manifest is written by the HIGH_LEVEL_DESIGN Step; a Step running before it ' +
      'cannot execute anything here and must not try to repair it.',
  };
}

/**
 * Whether the product source is still someone else's future output.
 *
 * True for the development-side design phases, which by construction run before CODE. After CODE has
 * run, the same failure is a real defect and must stay one.
 */
function isProductAuthoringPending(phase: StepType | undefined): boolean {
  return phase === 'REQUIREMENT_ANALYSIS' ||
    phase === 'HIGH_LEVEL_DESIGN' ||
    phase === 'DETAILED_DESIGN';
}

/**
 * Whether this command hands the verdict to a test runner.
 *
 * A runner reports its own result in its exit code, and everything it prints on the way is the
 * suite's subject matter. Running the product is different: there, output describing a failed
 * request describes the product's own behaviour, which is what the network detector exists for.
 */
export function isTestRunnerInvocation(args: readonly string[]): boolean {
  const flat = args.join(' ');
  return /\b(?:vitest|jest|mocha|pytest|ava|tap)\b/u.test(flat) ||
    /\bnpm\s+(?:run\s+)?test\b/u.test(flat) ||
    /\b(?:python\s+)?-m\s+(?:pytest|unittest)\b/u.test(flat);
}

function isCoverageArgument(arg: string): boolean {
  return arg === '--coverage' || arg.startsWith('--coverage.');
}

function mergeTestGateArgs(gateArgs: readonly string[], requestedArgs: readonly string[]): string[] {
  if (gateArgs.length === 0) return [...requestedArgs];
  const merged = [...gateArgs];
  for (const arg of requestedArgs) {
    // The Runtime owns selectors. The model may add runner flags, but it cannot replace the exact
    // paired gate with a smaller or unrelated test scope.
    if (!arg.startsWith('-')) continue;
    if (isCoverageArgument(arg) && merged.some(isCoverageArgument)) continue;
    if (!merged.includes(arg)) merged.push(arg);
  }
  return merged;
}

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
