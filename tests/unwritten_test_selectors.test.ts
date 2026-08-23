import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A selector that names a file nobody wrote describes a run that cannot pass.
 *
 * Selectors come from the plan — `pairedTestAssetPaths` derives them from the paired source Step's
 * declared outputs — and nothing reconciles them against the filesystem. The runner then reports a
 * usage error, `file or directory not found`, which reads as a broken environment while the real
 * cause is unfinished work. A live dbc3 CODE Step spent all ten of its rounds re-issuing that same
 * invocation, was told 69 times which five outputs it still owed, and the run stopped at 11/8.
 */
describe('run_tests refuses selectors nobody has written', () => {
  let root = '';
  const ctxFor = async (testGateArgs: string[]) => {
    const { Workspace } = await import('../src/workspace/workspace.js');
    return {
      ws: new Workspace(root),
      sandbox: {
        runTests: async () => {
          throw new Error('the suite must not be started when a selector is missing');
        },
      },
      allowedWrites: ['tests/'],
      stepId: 'S004',
      language: 'python' as const,
      testGateArgs,
    } as never;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-selectors-'));
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('names every unwritten file instead of letting the runner report a usage error', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    const result = await runTestsTool.run({}, await ctxFor([
      'tests/test_dbc_parser.py',
      'tests/test_main.py',
    ]));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('tests/test_dbc_parser.py');
    expect(result.error).toContain('tests/test_main.py');
    // The action, not only the fault.
    expect(result.error).toMatch(/[Ww]rite them first/u);
  });

  it('runs normally once the declared files exist', async () => {
    await fs.writeFile(path.join(root, 'tests/test_main.py'), 'def test_x():\n    assert True\n');
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    let started = false;
    const ctx = await ctxFor(['tests/test_main.py']);
    (ctx as unknown as { sandbox: { runTests: () => Promise<unknown> } }).sandbox.runTests = async () => {
      started = true;
      return { exitCode: 0, stdout: '1 passed', stderr: '', timedOut: false };
    };
    const result = await runTestsTool.run({}, ctx);
    expect(started).toBe(true);
    expect(result.ok).toBe(true);
  });

  // Flags are not paths; refusing them would block every legitimate invocation.
  it('ignores flag arguments when deciding', async () => {
    await fs.writeFile(path.join(root, 'tests/test_main.py'), 'def test_x():\n    assert True\n');
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    const ctx = await ctxFor(['tests/test_main.py', '--coverage', '-v']);
    (ctx as unknown as { sandbox: { runTests: () => Promise<unknown> } }).sandbox.runTests = async () =>
      ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false });
    const result = await runTestsTool.run({}, ctx);
    expect(result.ok).toBe(true);
  });
});

/**
 * The runner's own words, on the live path.
 *
 * These signatures used to drive a static rule table that nothing called. What answers them now is
 * the classifier plus the Debug Wiki, so that is what these assert — a rule with no reader is worth
 * nothing, whichever file it sits in.
 */
describe('runner-cannot-find-test reaches the live repair path', () => {
  const brief = async (failureLog: string) => {
    const { buildDebugBrief } = await import('../src/core/debug_brief.js');
    return buildDebugBrief({ failureLog, phase: 'CODE' });
  };

  it('classifies pytest exit=4 as unwritten outputs and retrieves the entry', async () => {
    const { DebugWiki, bundledDebugWikiPath } = await import('../src/core/debug_wiki.js');
    const b = await brief('pytest exit=4 args=tests/test_dbc_parser.py\nERROR: file or directory not found: tests/test_dbc_parser.py');
    expect(b.category).toBe('missing_output');
    expect(b.debugDemand).toMatch(/Create or repair the declared output files/u);
    const matches = await new DebugWiki(bundledDebugWikiPath()).search(b, { limit: 3 });
    expect(matches[0]?.entry.id).toBe('agent.calibration.unwritten-test-file');
  });

  it('does the same for vitest finding nothing', async () => {
    const { DebugWiki, bundledDebugWikiPath } = await import('../src/core/debug_wiki.js');
    const b = await brief('npm test exit=1\nNo test files found, exiting with code 1');
    expect(b.category).toBe('missing_output');
    const matches = await new DebugWiki(bundledDebugWikiPath()).search(b, { limit: 3 });
    expect(matches[0]?.entry.id).toBe('agent.calibration.unwritten-test-file');
  });

  // A suite that ran and failed is ordinary work, and must not be pulled into this path.
  it('leaves a genuinely failing suite alone', async () => {
    const b = await brief('pytest exit=1\n1 failed, 3 passed\nE   assert 2 == 3');
    expect(b.category).toBe('test_failure');
  });
});
