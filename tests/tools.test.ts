import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { isAllowedWrite } from '../src/tools/types.js';
import {
  DEFAULT_WRITE_CHUNK_BYTES,
  appendFileTool,
  readFileTool,
  listDirTool,
  resolveWriteChunkBytes,
  writeFileTool,
} from '../src/tools/fs.js';
import { applyPatchTool, parseUnifiedDiff } from '../src/tools/patch.js';
import type { ToolContext } from '../src/tools/types.js';

let tmp: string;
let ws: Workspace;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-tools-'));
  ws = new Workspace(tmp);
  ctx = {
    ws,
    sandbox: undefined as never,
    allowedWrites: ['src/', 'tests/test_x.py', 'requirements.txt'],
    stepId: 'S001',
  };
});

describe('isAllowedWrite', () => {
  it('matches exact and prefix', () => {
    expect(isAllowedWrite('requirements.txt', ['requirements.txt'])).toBe(true);
    expect(isAllowedWrite('src/a/b.py', ['src/'])).toBe(true);
    expect(isAllowedWrite('src/a/b.py', ['src'])).toBe(true);
    expect(isAllowedWrite('docs/x.md', ['src/'])).toBe(false);
    expect(isAllowedWrite('./src/x.py', ['src/'])).toBe(true);
  });

  it('allows tests/fixtures/<f> when tests/fixtures is in whitelist (engine test/DEBUG augmentation)', () => {
    expect(isAllowedWrite('tests/fixtures/sample.fixture', ['tests/fixtures'])).toBe(true);
    expect(isAllowedWrite('tests/fixtures/nested/x.csv', ['tests/fixtures'])).toBe(true);
    // 不能影响 tests/ 同级其它文件
    expect(isAllowedWrite('tests/test_foo.py', ['tests/fixtures'])).toBe(false);
  });
});

describe('write_file tool', () => {
  it('auto-creates nested subdirectories (mkdir -p)', async () => {
    ctx.allowedWrites = ['tests/fixtures'];
    const r = await writeFileTool.run(
      { path: 'tests/fixtures/sub/dir/sample.fixture', content: 'fixture-content\n' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(await ws.exists('tests/fixtures/sub/dir/sample.fixture')).toBe(true);
  });
  it('writes within whitelist and rejects outside', async () => {
    const ok = await writeFileTool.run({ path: 'src/app.py', content: 'print(1)\n' }, ctx);
    expect(ok.ok).toBe(true);
    expect(await ws.readFile('src/app.py')).toBe('print(1)\n');

    const bad = await writeFileTool.run({ path: 'docs/leak.md', content: 'x' }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/write denied/);
  });

  it('uses explicit per-step chunk limits for write_file and append_file', async () => {
    ctx.writeChunkBytes = 16;
    const tooLarge = await writeFileTool.run({ path: 'src/big.py', content: 'x'.repeat(17) }, ctx);
    expect(tooLarge.ok).toBe(false);
    expect(tooLarge.error).toContain('chunk limit 16B');

    const ok = await writeFileTool.run({ path: 'src/big.py', content: 'x'.repeat(16) }, ctx);
    expect(ok.ok).toBe(true);

    const appendTooLarge = await appendFileTool.run({ path: 'src/big.py', content: 'y'.repeat(17) }, ctx);
    expect(appendTooLarge.ok).toBe(false);
    expect(appendTooLarge.error).toContain('chunk limit 16B');
  });

  it('rejects malformed write args with a clear tool error instead of throwing', async () => {
    const missingPath = await writeFileTool.run({ content: '# doc\n' } as never, ctx);
    expect(missingPath.ok).toBe(false);
    expect(missingPath.error).toContain('path must be a non-empty string');

    const missingContent = await appendFileTool.run({ path: 'src/x.py' } as never, ctx);
    expect(missingContent.ok).toBe(false);
    expect(missingContent.error).toContain('content must be a string');
  });

  it('canonicalizes project-prefixed and absolute in-workspace write paths', async () => {
    const projectName = path.basename(ws.root);
    const prefixed = await writeFileTool.run(
      { path: `${projectName}/src/prefixed.py`, content: 'x = 1\n' },
      ctx,
    );
    expect(prefixed.ok).toBe(true);
    expect(prefixed.summary).toContain('src/prefixed.py');
    expect(await ws.readFile('src/prefixed.py')).toBe('x = 1\n');
    expect(await ws.exists(`${projectName}/src/prefixed.py`)).toBe(false);

    const absolute = await writeFileTool.run(
      { path: ws.abs('src/absolute.py'), content: 'x = 2\n' },
      ctx,
    );
    expect(absolute.ok).toBe(true);
    expect(absolute.summary).toContain('src/absolute.py');
  });

  it('does not strip a legitimate source directory when the workspace itself is named src', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-path-name-'));
    const namedSrc = new Workspace(path.join(parent, 'src'));
    await fs.mkdir(namedSrc.root, { recursive: true });
    const namedCtx = { ...ctx, ws: namedSrc };
    const result = await writeFileTool.run(
      { path: 'src/app.py', content: 'x = 3\n' },
      namedCtx,
    );
    expect(result.ok).toBe(true);
    expect(await namedSrc.readFile('src/app.py')).toBe('x = 3\n');
  });

  it('uses the step allowlist to canonicalize project-prefixed custom directories', async () => {
    const customCtx = { ...ctx, allowedWrites: ['assets/generated/'] };
    const result = await writeFileTool.run(
      {
        path: `${path.basename(ws.root)}/assets/generated/report.txt`,
        content: 'ok\n',
      },
      customCtx,
    );
    expect(result.ok).toBe(true);
    expect(await ws.readFile('assets/generated/report.txt')).toBe('ok\n');
  });

  it('auto-scales write chunk budget by phase and step context', () => {
    expect(resolveWriteChunkBytes(1234, { phase: 'CODE' })).toBe(1234);
    const dynamic = resolveWriteChunkBytes('auto', {
      phase: 'CODE',
      tools: ['write_file', 'append_file'],
      outputs: ['src/a.ts', 'src/b.ts', 'tests/a.test.ts'],
      contextChars: 20_000,
    });
    expect(dynamic).toBeGreaterThan(DEFAULT_WRITE_CHUNK_BYTES);
    const smallerModel = resolveWriteChunkBytes('auto', {
      contextWindowTokens: 32 * 1024,
      contextChars: 20_000,
    });
    const largerModel = resolveWriteChunkBytes('auto', {
      contextWindowTokens: 256 * 1024,
      contextChars: 20_000,
    });
    expect(largerModel).toBeGreaterThan(smallerModel);
  });

  it('reduces the automatic write window as the current prompt consumes context', () => {
    const shortPrompt = resolveWriteChunkBytes('auto', {
      contextWindowTokens: 128 * 1024,
      contextChars: 3_000,
    });
    const longPrompt = resolveWriteChunkBytes('auto', {
      contextWindowTokens: 128 * 1024,
      contextChars: 340_000,
    });
    expect(shortPrompt).toBeGreaterThan(longPrompt);
  });
});

describe('read_file & list_dir', () => {
  it('reads back what was written and lists dir', async () => {
    await writeFileTool.run({ path: 'src/m.py', content: 'a' }, ctx);
    const r = await readFileTool.run({ path: 'src/m.py' }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { content: string }).content).toBe('a');
    const l = await listDirTool.run({ path: 'src' }, ctx);
    expect(l.ok).toBe(true);
    expect((l.data as { entries: string[] }).entries).toContain('m.py');
  });

  it('rejects a missing read path instead of treating it as the workspace directory', async () => {
    const r = await readFileTool.run({} as never, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('path must be a non-empty string');
  });

  it('reads large files incrementally using the active read window and nextOffset', async () => {
    await ws.writeFile('src/large.txt', '0123456789abcdefghij');
    ctx.readChunkBytes = 8;

    const first = await readFileTool.run({ path: 'src/large.txt', maxBytes: 100 }, ctx);
    expect(first.ok).toBe(true);
    expect(first.data).toMatchObject({
      offset: 0,
      bytes: 8,
      totalBytes: 20,
      truncated: true,
      nextOffset: 8,
    });
    expect(first.data?.content).toContain('01234567');

    const second = await readFileTool.run({ path: 'src/large.txt', offset: first.data?.nextOffset }, ctx);
    expect(second.ok).toBe(true);
    expect(second.data).toMatchObject({ offset: 8, bytes: 8, nextOffset: 16 });
    expect(second.data?.content).toContain('89abcdef');
  });

  it('rejects reads, writes, and listings outside the project directory', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret', 'utf8');

    const read = await readFileTool.run({ path: outsideFile }, ctx);
    expect(read.ok).toBe(false);
    expect(read.error).toContain('outside the project directory');

    const list = await listDirTool.run({ path: outsideDir }, ctx);
    expect(list.ok).toBe(false);
    expect(list.error).toContain('outside the project directory');

    ctx.allowedWrites = [outsideFile, 'src/'];
    const write = await writeFileTool.run({ path: outsideFile, content: 'leak' }, ctx);
    expect(write.ok).toBe(false);
    expect(write.error).toContain('outside the project directory');
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('secret');
  });

  it('rejects project-internal symlinks that resolve outside the project directory', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.py');
    await fs.writeFile(outsideFile, 'secret = True\n', 'utf8');
    await ws.ensure('src');
    await fs.symlink(outsideFile, ws.abs('src/link.py'));

    const read = await readFileTool.run({ path: 'src/link.py' }, ctx);
    expect(read.ok).toBe(false);
    expect(read.error).toContain('outside the project directory');

    const write = await writeFileTool.run({ path: 'src/link.py', content: 'secret = False\n' }, ctx);
    expect(write.ok).toBe(false);
    expect(write.error).toContain('outside the project directory');
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('secret = True\n');
  });
});

describe('parseUnifiedDiff', () => {
  it('parses single hunk with a/ b/ prefixes', () => {
    const patch = `--- a/src/m.py\n+++ b/src/m.py\n@@ -1,1 +1,2 @@\n a\n+b\n`;
    const fds = parseUnifiedDiff(patch);
    expect(fds).toHaveLength(1);
    expect(fds[0]?.target).toBe('src/m.py');
    expect(fds[0]?.hunks[0]?.lines).toEqual([' a', '+b']);
  });
  it('detects new file when source is /dev/null', () => {
    const patch = `--- /dev/null\n+++ b/src/n.py\n@@ -0,0 +1,1 @@\n+x\n`;
    const fds = parseUnifiedDiff(patch);
    expect(fds[0]?.isNewFile).toBe(true);
    expect(fds[0]?.target).toBe('src/n.py');
  });
});

describe('apply_patch tool', () => {
  it('creates a new file from /dev/null hunk', async () => {
    const patch = `--- /dev/null\n+++ b/src/n.py\n@@ -0,0 +1,2 @@\n+def f():\n+    return 1\n`;
    const r = await applyPatchTool.run({ patch }, ctx);
    expect(r.ok).toBe(true);
    expect(await ws.readFile('src/n.py')).toBe('def f():\n    return 1\n');
  });

  it('applies edits to existing file', async () => {
    await ws.writeFile('src/m.py', 'a\nb\nc\n');
    const patch = `--- a/src/m.py\n+++ b/src/m.py\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`;
    const r = await applyPatchTool.run({ patch }, ctx);
    expect(r.ok).toBe(true);
    expect(await ws.readFile('src/m.py')).toBe('a\nB\nc\n');
  });

  it('rejects patch targeting outside whitelist', async () => {
    const patch = `--- /dev/null\n+++ b/docs/leak.md\n@@ -0,0 +1,1 @@\n+x\n`;
    const r = await applyPatchTool.run({ patch }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/write denied/);
  });

  it('rejects patch targets outside the project directory before allowlist checks', async () => {
    ctx.allowedWrites = ['../escape.py'];
    const patch = `--- /dev/null\n+++ b/../escape.py\n@@ -0,0 +1,1 @@\n+x\n`;
    const r = await applyPatchTool.run({ patch }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('outside the project directory');
  });

  it('reports context mismatch instead of silently corrupting', async () => {
    await ws.writeFile('src/m.py', 'real\n');
    const patch = `--- a/src/m.py\n+++ b/src/m.py\n@@ -1,1 +1,1 @@\n-fake\n+changed\n`;
    const r = await applyPatchTool.run({ patch }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mismatch/);
  });
});

describe('runTestsTool / runPythonTool summary', () => {
  it('marks run_program failed when output shows a network API failure despite exit 0', async () => {
    const { runProgramTool } = await import('../src/tools/sandbox.js');
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runProgram() {
          return {
            exitCode: 0,
            stdout: 'Weather report unavailable\n',
            stderr: 'Weather API request failed: 503 Service Unavailable\n',
            timedOut: false,
            durationMs: 1,
          };
        },
        async runTests() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S001',
      language: 'python',
    };
    const r = await runProgramTool.run({ args: ['src/main.py'] }, fakeCtx);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Network API failure detected');
    expect(r.summary).toContain('503 Service Unavailable');
  });

  it('does not treat test assertion source frames containing HTTP status text as API failures', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runProgram() { throw new Error('not used'); },
        async runTests() {
          return {
            exitCode: 1,
            stdout: '',
            stderr: [
              'AssertionError: expected "S1: HTTP 500" to contain "S1: HTTP 500"',
              '57|     expect(errorsArg).toContain("S1: HTTP 500");',
              '58|   });',
            ].join('\n'),
            timedOut: false,
            durationMs: 1,
          };
        },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S005',
      language: 'typescript',
    };

    const r = await runTestsTool.run({ args: ['tests/app.unit.test.ts'] }, fakeCtx);
    expect(r.ok).toBe(false);
    expect(r.summary).not.toContain('Network API failure detected');
    expect(r.summary).toContain('npm test exit=1');
  });

  it('preserves both the first and last failure identities in a long test summary', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    const longMiddle = Array.from({ length: 80 }, (_, index) => `diagnostic line ${index} ${'x'.repeat(80)}`);
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runProgram() { throw new Error('not used'); },
        async runTests() {
          return {
            exitCode: 1,
            stdout: [...longMiddle, 'FAIL tests/last.test.ts > final contract'].join('\n'),
            stderr: 'FAIL tests/first.test.ts > first contract',
            timedOut: false,
            durationMs: 1,
          };
        },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S006',
      language: 'typescript',
    };

    const result = await runTestsTool.run({ args: ['tests/integration'] }, fakeCtx);
    expect(result.summary).toContain('first contract');
    expect(result.summary).toContain('final contract');
    expect(result.summary?.length).toBeLessThanOrEqual(6000);
  });

  it('reports TypeScript run_program project commands without wrapping npm/npx/node in tsx', async () => {
    const { runProgramTool } = await import('../src/tools/sandbox.js');
    let seenArgs: string[] = [];
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runProgram(args: string[]) {
          seenArgs = args;
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
        },
        async runTests() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S004',
      language: 'typescript',
    };

    const tsc = await runProgramTool.run({ args: ['npx', 'tsc', '--noEmit'] }, fakeCtx);
    expect(seenArgs).toEqual(['npx', 'tsc', '--noEmit']);
    expect(tsc.summary).toBe('npx tsc --noEmit exit=0');

    const entry = await runProgramTool.run({ args: ['src/index.ts', '--help'] }, fakeCtx);
    expect(entry.summary).toBe('npx tsx src/index.ts --help exit=0');
  });

  it('normalizes TypeScript run_program commands for sandbox execution', async () => {
    const { resolveTypeScriptProgramCommand } = await import('../src/sandbox/program_args.js');
    expect(resolveTypeScriptProgramCommand(['npx', 'tsc', '--noEmit'])).toEqual({
      cmd: 'npx',
      argv: ['tsc', '--noEmit'],
      display: 'npx tsc --noEmit',
    });
    expect(resolveTypeScriptProgramCommand(['tsc', '--noEmit'])).toEqual({
      cmd: 'npx',
      argv: ['tsc', '--noEmit'],
      display: 'npx tsc --noEmit',
    });
    expect(resolveTypeScriptProgramCommand(['src/index.ts', '--help'])).toEqual({
      cmd: 'npx',
      argv: ['tsx', 'src/index.ts', '--help'],
      display: 'npx tsx src/index.ts --help',
    });
  });

  it('embeds stderr/stdout tail in summary on failure (so LLM can see the real error)', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runTests() {
          return {
            exitCode: 1,
            stdout:
              'collected 1 item\n\n' +
              'tests/test_foo.py::test_x FAILED\n\n' +
              '=================================== FAILURES ===================================\n' +
              "________________________________ test_x _________________________________________\n" +
              "    def test_x():\n" +
              ">       assert add(1, 2) == 4\n" +
              "E       assert 3 == 4\n",
            stderr: '',
            timedOut: false,
          };
        },
        async runProgram() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S001',
      language: 'python',
    };
    const r = await runTestsTool.run({ args: ['-v', 'tests/'] }, fakeCtx);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/pytest exit=1/);
    expect(r.summary).toMatch(/assert 3 == 4/); // 真实失败行必须出现在 LLM 可见的 summary 里
    expect(r.summary).toMatch(/stdout/);
  });

  it('keeps summary terse on success (no stdout flood)', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runTests() {
          return { exitCode: 0, stdout: 'x'.repeat(50_000), stderr: '', timedOut: false };
        },
        async runProgram() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S001',
      language: 'python',
    };
    const r = await runTestsTool.run({}, fakeCtx);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('pytest exit=0');
  });

  it('uses scoped default test args when TypeScript run_tests receives only Vitest run tokens', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    let seenArgs: string[] = [];
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runTests(args = []) {
          seenArgs = args;
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
        },
        async runProgram() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S005',
      language: 'typescript',
      defaultTestArgs: ['tests/unit/parser.test.ts'],
    };
    const r = await runTestsTool.run({ args: ['run'] }, fakeCtx);
    expect(r.ok).toBe(true);
    expect(seenArgs).toEqual(['tests/unit/parser.test.ts']);
    expect(r.summary).toBe('npm test exit=0 args=tests/unit/parser.test.ts');
  });

  it('preserves explicit TypeScript test filters instead of replacing them with defaults', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    let seenArgs: string[] = [];
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runTests(args = []) {
          seenArgs = args;
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
        },
        async runProgram() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S007',
      language: 'typescript',
      defaultTestArgs: ['tests/module/parser.test.ts'],
    };
    const r = await runTestsTool.run({ args: ['run', 'tests/unit'] }, fakeCtx);
    expect(r.ok).toBe(true);
    expect(seenArgs).toEqual(['tests/unit']);
    expect(r.summary).toBe('npm test exit=0 args=tests/unit');
  });

  it('combines TypeScript runner flags with scoped default test args', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    let seenArgs: string[] = [];
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runTests(args = []) {
          seenArgs = args;
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
        },
        async runProgram() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S005',
      language: 'typescript',
      defaultTestArgs: ['tests/unit/parser.test.ts'],
    };
    const r = await runTestsTool.run({ args: ['--reporter=verbose'] }, fakeCtx);
    expect(r.ok).toBe(true);
    expect(seenArgs).toEqual(['tests/unit/parser.test.ts', '--reporter=verbose']);
    expect(r.summary).toBe('npm test exit=0 args=tests/unit/parser.test.ts --reporter=verbose');
  });

  it('resolves run_tests cwd inside the project and rejects external cwd', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    await ws.ensure('tests');
    let seenCwd = '';
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runTests(_args, extra) {
          seenCwd = extra?.cwd ?? '';
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
        },
        async runProgram() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S001',
      language: 'python',
    };

    const ok = await runTestsTool.run({ cwd: 'tests' }, fakeCtx);
    expect(ok.ok).toBe(true);
    expect(seenCwd).toBe(path.join(await fs.realpath(ws.root), 'tests'));

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-outside-'));
    const denied = await runTestsTool.run({ cwd: outsideDir }, fakeCtx);
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('outside the project directory');
  });
});
