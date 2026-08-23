import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}

describe('Runtime architecture boundary', () => {
  it('public runtime exports build/run from runtime modules, not CLI adapters', async () => {
    const runtime = await read('src/runtime.ts');
    expect(runtime).toContain("./runtime/build.js");
    expect(runtime).toContain("./runtime/run.js");
    expect(runtime).toContain("./runtime/bootstrap.js");
    expect(runtime).toContain("./runtime/doctor.js");
    expect(runtime).toContain("./runtime/inspect.js");
    expect(runtime).not.toContain("./cli/compile.js");
    expect(runtime).not.toContain("./cli/execute.js");
    expect(runtime).not.toContain("./cli/bootstrap.js");
  });

  it('build/run CLI files are thin Runtime adapters and do not import business internals', async () => {
    const build = await read('src/cli/xcompiler_build.ts');
    const run = await read('src/cli/xcompiler_run.ts');
    const cli = `${build}\n${run}`;

    expect(build).toContain("../runtime.js");
    expect(run).toContain("../runtime.js");
    expect(cli).toContain('XCompilerRuntime');
    expect(cli).not.toMatch(/\.\.\/agents\/planner|Planner|buildPlan/u);
    expect(cli).not.toMatch(/\.\.\/core\/engine|PhaseEngine/u);
    expect(cli).not.toMatch(/\.\.\/llm\/router|LLMRouter/u);
    expect(cli).not.toMatch(/\.\.\/plugins\/host|PluginHost/u);
    expect(cli).not.toMatch(/\.\.\/tools\/|buildDefaultRegistry/u);
  });

  it('command-line entrypoints delegate command orchestration to runtime commands', async () => {
    const main = await read('src/cli/xcompiler.ts');
    const build = await read('src/cli/xcompiler_build.ts');
    const run = await read('src/cli/xcompiler_run.ts');
    const doctor = await read('src/cli/doctor.ts');
    const inspect = await read('src/cli/inspect.ts');
    const entrypoints = `${main}\n${build}\n${run}`;

    expect(entrypoints).toContain("../runtime.js");
    expect(entrypoints).not.toMatch(/loadXCompilerProject|resolveCompileWorkspace|resolveEvolveWorkspace/u);
    expect(entrypoints).not.toMatch(/from '\.\/compile\.js'|from '\.\/execute\.js'|from '\.\/workspace\.js'/u);
    expect(entrypoints).not.toMatch(/runCompile\(|runExecute\(/u);
    expect(doctor).toContain("../runtime.js");
    expect(inspect).toContain("../runtime.js");
    expect(`${doctor}\n${inspect}`).not.toMatch(/from '\.\.\/core\//u);
  });

  it('runtime build/run modules do not own terminal rendering or process exit codes', async () => {
    const build = await read('src/runtime/build.ts');
    const run = await read('src/runtime/run.ts');
    const bootstrap = await read('src/runtime/bootstrap.ts');
    const doctor = await read('src/runtime/doctor.ts');
    const inspect = await read('src/runtime/inspect.ts');
    const runtimeCommands = `${build}\n${run}\n${bootstrap}\n${doctor}\n${inspect}`;

    expect(runtimeCommands).not.toMatch(/from '@inquirer\/prompts'|from 'chalk'|spinner as ora/u);
    expect(runtimeCommands).not.toMatch(/console\.(log|error|warn)/u);
    expect(runtimeCommands).not.toMatch(/process\.(exitCode|stdin|stdout|stderr)/u);
  });

  it('configuration and router internals do not write directly to the terminal', async () => {
    const config = await read('src/config/config.ts');
    const router = await read('src/llm/router.ts');
    expect(`${config}\n${router}`).not.toMatch(/console\.(log|error|warn)|process\.(stdout|stderr)\.write/u);
  });
});

/**
 * A hook with no caller is the same as no hook.
 *
 * `ensureTestBootstrap` sat on the language profile from the day the layer was written, fully
 * implemented and never invoked, so `tests/conftest.py` was never created and every Python project's
 * tests failed to import `src/`. Asserted at the call site rather than on the profile, because the
 * profile method was always correct — it was the absence of the call that cost two live runs their
 * Tickets.
 */
it('runs the language test bootstrap before executing a plan', async () => {
  const { readFile } = await import('node:fs/promises');
  const run = await readFile(new URL('../src/runtime/run.ts', import.meta.url), 'utf8');
  expect(run).toMatch(/ensureTestBootstrap\?\.\(/u);
  // Before the Steps run, or the first suite still executes without it.
  const bootstrapAt = run.indexOf('ensureTestBootstrap');
  const executeAt = run.indexOf('topoSort(plan.steps)');
  expect(bootstrapAt).toBeGreaterThan(0);
  expect(bootstrapAt).toBeLessThan(executeAt);
});
