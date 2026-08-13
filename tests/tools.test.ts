import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { isAllowedWrite } from '../src/tools/types.js';
import {
  appendFileTool,
  readFileTool,
  listDirTool,
  resolveWriteChunkBytes,
  writeFileTool,
} from '../src/tools/fs.js';
import { applyPatchTool, parseUnifiedDiff } from '../src/tools/patch.js';
import { runTestsTool } from '../src/tools/sandbox.js';
import { addDependencyTool } from '../src/tools/deps.js';
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

  it('reports a denial by code, so callers never branch on its wording', async () => {
    // The executor's loop-breaker keyed on the denial prose; improving that prose silently changed
    // control flow. The code is what callers match, and it is checked here so the two cannot drift.
    ctx.allowedWrites = ['src/'];
    const denied = await writeFileTool.run({ path: 'outside/x.py', content: 'x\n' }, ctx);
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe('write_denied');
    // The message still names what is writable, which is what lets a model correct itself.
    expect(denied.error).toContain('src/');
  });

  it('honours the glob outputs a Step actually declares', () => {
    // A planner writes `tests/modules/*.ts` before any of those files exist, and the same list is
    // shown to the model as its writable candidates. Matching it literally told the model a path was
    // writable and then refused every file under it — unfixable from the model's side.
    const step = ['docs/02-high-level-design.md', 'tests/modules/*.ts'];
    expect(isAllowedWrite('tests/modules/index.ts', step)).toBe(true);
    expect(isAllowedWrite('tests/modules/test_config.ts', step)).toBe(true);
    // `*` does not cross a separator, so a glob cannot silently widen into subdirectories.
    expect(isAllowedWrite('tests/modules/deep/nested.ts', step)).toBe(false);
    expect(isAllowedWrite('tests/modules/notes.md', step)).toBe(false);
    expect(isAllowedWrite('src/index.ts', step)).toBe(false);
  });

  it('crosses separators only for **, and matches the zero-directory case', () => {
    expect(isAllowedWrite('src/a/b/c.ts', ['src/**/*.ts'])).toBe(true);
    expect(isAllowedWrite('src/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(isAllowedWrite('src/a.py', ['src/**/*.ts'])).toBe(false);
    expect(isAllowedWrite('other/a.ts', ['src/**/*.ts'])).toBe(false);
  });

  it('treats a pattern as a path, never as a regular expression', () => {
    // Regex metacharacters in a declared output must match literally, or a Step could widen its own
    // allowlist by declaring an output that happens to look like a pattern.
    expect(isAllowedWrite('srcXa.ts', ['src.a.ts'])).toBe(false);
    expect(isAllowedWrite('src.a.ts', ['src.a.ts'])).toBe(true);
    expect(isAllowedWrite('anything', ['.*'])).toBe(false);
    expect(isAllowedWrite('a+b.ts', ['a+b.ts'])).toBe(true);
    expect(isAllowedWrite('aab.ts', ['a+b.ts'])).toBe(false);
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
    expect(ok.data).toMatchObject({ previousBytes: 0, changed: true });
    expect(await ws.readFile('src/app.py')).toBe('print(1)\n');

    const bad = await writeFileTool.run({ path: 'docs/leak.md', content: 'x' }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/write denied/);
  });

  it('rejects suspicious truncation of an existing source file without changing it', async () => {
    const original = `export class Service {\n${'  run(): void { return; }\n'.repeat(80)}}\n`;
    await ws.writeFile('src/service.ts', original);

    const result = await writeFileTool.run(
      { path: 'src/service.ts', content: 'export' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/suspicious truncation/);
    expect(result.error).toContain('existing');
    expect(await ws.readFile('src/service.ts')).toBe(original);
  });

  it('allows small new files and ordinary complete rewrites', async () => {
    const created = await writeFileTool.run({ path: 'src/new.ts', content: 'export' }, ctx);
    expect(created.ok).toBe(true);
    expect(created.data).toMatchObject({ previousBytes: 0, changed: true });

    const original = 'a'.repeat(1000);
    await ws.writeFile('src/normal.ts', original);
    const rewritten = await writeFileTool.run(
      { path: 'src/normal.ts', content: 'b'.repeat(800) },
      ctx,
    );
    expect(rewritten.ok).toBe(true);
    expect(rewritten.data).toMatchObject({ previousBytes: 1000, bytes: 800, changed: true });
  });

  it('reports identical rewrites as successful no-op operations', async () => {
    const content = 'export const value = 1;\n';
    await ws.writeFile('src/same.ts', content);

    const result = await writeFileTool.run({ path: 'src/same.ts', content }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      previousBytes: Buffer.byteLength(content),
      bytes: Buffer.byteLength(content),
      changed: false,
    });
    expect(result.summary).toContain('unchanged');
  });

  it('requires patch tools for existing files in incremental Ticket modes', async () => {
    await ws.writeFile('src/existing.ts', 'export const value = 1;\n');
    ctx.preserveExistingFiles = true;

    const denied = await writeFileTool.run(
      { path: 'src/existing.ts', content: 'export const value = 2;\n' },
      ctx,
    );
    const created = await writeFileTool.run(
      { path: 'src/new-increment.ts', content: 'export const value = 2;\n' },
      ctx,
    );

    expect(denied).toMatchObject({ ok: false });
    expect(denied.error).toContain('incremental write denied');
    expect(await ws.readFile('src/existing.ts')).toContain('value = 1');
    expect(created).toMatchObject({ ok: true });
  });

  it('allows a full rewrite only for an exact failure-evidence target', async () => {
    await ws.writeFile('src/failing.ts', 'export const value = 1;\n');
    await ws.writeFile('src/unrelated.ts', 'export const value = 1;\n');
    ctx.preserveExistingFiles = true;
    ctx.rewriteExistingFiles = ['src/failing.ts'];

    const rewritten = await writeFileTool.run(
      { path: 'src/failing.ts', content: 'export const value = 2;\n' },
      ctx,
    );
    const unrelated = await writeFileTool.run(
      { path: 'src/unrelated.ts', content: 'export const value = 2;\n' },
      ctx,
    );

    expect(rewritten).toMatchObject({ ok: true, data: { changed: true } });
    expect(unrelated).toMatchObject({ ok: false });
    expect(await ws.readFile('src/failing.ts')).toContain('value = 2');
    expect(await ws.readFile('src/unrelated.ts')).toContain('value = 1');
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
    const dynamic = resolveWriteChunkBytes(undefined, {
      phase: 'CODE',
      tools: ['write_file', 'append_file'],
      outputs: ['src/a.ts', 'src/b.ts', 'tests/a.test.ts'],
      contextChars: 20_000,
    });
    // 0.3 has no fixed byte baseline to compare against: the automatic budget is derived purely
    // from the active model context, so it must simply be a usable window.
    expect(dynamic).toBeGreaterThan(1024);
    const smallerModel = resolveWriteChunkBytes(undefined, {
      contextWindowTokens: 32 * 1024,
      contextChars: 20_000,
    });
    const largerModel = resolveWriteChunkBytes(undefined, {
      contextWindowTokens: 256 * 1024,
      contextChars: 20_000,
    });
    expect(largerModel).toBeGreaterThan(smallerModel);
  });

  it('reduces the automatic write window as the current prompt consumes context', () => {
    const shortPrompt = resolveWriteChunkBytes(undefined, {
      contextWindowTokens: 128 * 1024,
      contextChars: 3_000,
    });
    const longPrompt = resolveWriteChunkBytes(undefined, {
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

  it('rejects a patch that suspiciously truncates an existing file', async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`);
    const original = `${lines.join('\n')}\n`;
    await ws.writeFile('src/large.py', original);
    const deleted = lines.map((line) => `-${line}`).join('\n');
    const patch = `--- a/src/large.py\n+++ b/src/large.py\n@@ -1,40 +1,1 @@\n${deleted}\n+pass\n`;

    const r = await applyPatchTool.run({ patch }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/suspicious truncation/);
    expect(await ws.readFile('src/large.py')).toBe(original);
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
      testGateArgs: ['tests/unit/parser.test.ts'],
    };
    const r = await runTestsTool.run({ args: ['run'] }, fakeCtx);
    expect(r.ok).toBe(true);
    expect(seenArgs).toEqual(['tests/unit/parser.test.ts']);
    expect(r.summary).toBe('npm test exit=0 args=tests/unit/parser.test.ts');
  });

  it('freezes verification supplements into the Runtime-owned test gate', async () => {
    await ws.writeFile(
      'tests/verification/p1/unit-test/s005/network-risk.test.ts',
      'import { it } from "vitest";\nit("covers the risk", () => {});\n',
    );
    await ws.writeFile(
      'tests/verification/p1/unit-test/s005/notes.md',
      'not executable\n',
    );
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
      testGateArgs: ['tests/unit/parser.test.ts', '--coverage'],
      supplementalTestRoot: 'tests/verification/p1/unit-test/s005/',
    };

    const result = await runTestsTool.run({}, fakeCtx);

    expect(result.ok).toBe(true);
    expect(seenArgs).toEqual([
      'tests/unit/parser.test.ts',
      '--coverage',
      'tests/verification/p1/unit-test/s005/network-risk.test.ts',
    ]);
  });

  it('does not let explicit TypeScript selectors replace the Runtime-owned gate', async () => {
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
      testGateArgs: ['tests/module/parser.test.ts', '--coverage'],
    };
    const r = await runTestsTool.run({ args: ['run', 'tests/unit'] }, fakeCtx);
    expect(r.ok).toBe(true);
    expect(seenArgs).toEqual(['tests/module/parser.test.ts', '--coverage']);
    expect(r.summary).toBe('npm test exit=0 args=tests/module/parser.test.ts --coverage');
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
      testGateArgs: ['tests/unit/parser.test.ts'],
    };
    const r = await runTestsTool.run({ args: ['--reporter=verbose'] }, fakeCtx);
    expect(r.ok).toBe(true);
    expect(seenArgs).toEqual(['tests/unit/parser.test.ts', '--reporter=verbose']);
    expect(r.summary).toBe('npm test exit=0 args=tests/unit/parser.test.ts --reporter=verbose');
  });

  it('returns compact Vitest coverage evidence on a successful test run', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runTests() {
          return {
            exitCode: 0,
            stdout: [
              ' Test Files  2 passed (2)',
              '      Tests  5 passed (5)',
              'File | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s',
              'All files | 35.12 | 86.66 | 77.77 | 35.12 |',
              ' src | 0 | 0 | 0 | 0 |',
              '  cli.ts | 0 | 0 | 0 | 0 | 1-75',
              ' src/adapters | 0 | 0 | 0 | 0 |',
              '  rss-adapter.ts | 0 | 0 | 0 | 0 | 1-58',
            ].join('\n'),
            stderr: '',
            timedOut: false,
            durationMs: 1,
          };
        },
        async runProgram() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S005',
      language: 'typescript',
      testGateArgs: ['tests/unit/parser.test.ts', '--coverage'],
    };
    const r = await runTestsTool.run({}, fakeCtx);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('Tests 5 passed (5)');
    expect(r.summary).toContain('coverage statements=35.12% branches=86.66% functions=77.77% lines=35.12%');
    expect(r.summary).toContain('low-coverage files: src/cli.ts=0%, src/adapters/rss-adapter.ts=0%');
  });

  it('does not duplicate the unit gate coverage flag when the model also requests it', async () => {
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
      testGateArgs: ['tests/unit/parser.test.ts', '--coverage'],
    };
    const r = await runTestsTool.run({ args: ['--coverage'] }, fakeCtx);
    expect(r.ok).toBe(true);
    expect(seenArgs).toEqual(['tests/unit/parser.test.ts', '--coverage']);
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

describe('run_program missing-manifest diagnosis', () => {
  it('gives a Step reaching for the runner directly the same diagnosis run_tests gets', async () => {
    // From a live run: a Debugger at REQUIREMENT_ANALYSIS ran `npx vitest` through run_program, got
    // an opaque exit code because the diagnosis was only wired into run_tests, and spent its round
    // budget repairing a project whose manifest did not exist yet.
    const { runProgramTool } = await import('../src/tools/sandbox.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-run-program-'));
    const workspace = new Workspace(root);
    const failing = {
      ...ctx,
      ws: workspace,
      language: 'typescript' as const,
      sandbox: { runProgram: async () => ({ exitCode: 254, stdout: '', stderr: '', timedOut: false }) },
    } as unknown as typeof ctx;

    const noManifest = await runProgramTool.run({ args: ['npx', 'vitest', 'run'] }, failing);
    expect(noManifest.ok).toBe(false);
    expect(noManifest.error).toContain('No package.json');
    expect(noManifest.error).toContain('HIGH_LEVEL_DESIGN');
    expect(noManifest.code).toBe('manifest_missing');

    // An installed-but-empty toolchain stays the Step's own problem to fix.
    await workspace.writeFile('package.json', '{"scripts":{"test":"vitest run"}}\n');
    const missingRunner = await runProgramTool.run({ args: ['npx', 'vitest', 'run'] }, {
      ...failing,
      sandbox: { runProgram: async () => ({
        exitCode: 127, stdout: '', stderr: 'sh: vitest: command not found', timedOut: false,
      }) },
    } as unknown as typeof ctx);
    expect(missingRunner.error).toContain('install_deps');
    expect(missingRunner.code).toBeUndefined();

    // With the manifest present, an ordinary failure stays ordinary.
    const ordinary = await runProgramTool.run({ args: ['npx', 'tsx', 'src/cli.ts'] }, failing);
    expect(ordinary.ok).toBe(false);
    expect(ordinary.code).toBeUndefined();
  });
});

describe('design phases and a product that does not exist yet', () => {
  // From a live run: REQUIREMENT_ANALYSIS, HIGH_LEVEL_DESIGN and DETAILED_DESIGN ran `tsc --noEmit`
  // 43 times against a `src/` that CODE had not written, and converged on editing tsconfig.json to
  // point `files` at package.json so the compiler would stop complaining — corrupting the config the
  // next Step has to build with.
  const design = (phase: string, stderr: string) => ({
    ...ctx,
    language: 'typescript' as const,
    phase,
    sandbox: { runProgram: async () => ({ exitCode: 2, stdout: '', stderr, timedOut: false }) },
  } as unknown as typeof ctx);

  it('tells a design Step the missing sources are CODE\'s output, not its defect', async () => {
    const { runProgramTool } = await import('../src/tools/sandbox.js');
    for (const phase of ['REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN']) {
      const r = await runProgramTool.run(
        { args: ['npx', 'tsc', '--noEmit'] },
        design(phase, "error TS18003: No inputs were found in config file 'tsconfig.json'."),
      );
      expect(r.ok, phase).toBe(false);
      // The code is what stops it counting against the Step; the prose only explains it.
      expect(r.code, phase).toBe('product_not_implemented');
      expect(r.error, phase).toContain('CODE');
      expect(r.error, phase).toContain('Do not edit tsconfig.json');
    }
  });

  it('leaves it a real defect once CODE has run', async () => {
    const { runProgramTool } = await import('../src/tools/sandbox.js');
    for (const phase of ['CODE', 'UNIT_TEST', 'INTEGRATION_TEST']) {
      const r = await runProgramTool.run(
        { args: ['npx', 'tsc', '--noEmit'] },
        design(phase, "error TS18003: No inputs were found in config file 'tsconfig.json'."),
      );
      expect(r.ok, phase).toBe(false);
      expect(r.code, phase).not.toBe('product_not_implemented');
    }
  });

  it('does not excuse an ordinary compile error in a design phase', async () => {
    const { runProgramTool } = await import('../src/tools/sandbox.js');
    const r = await runProgramTool.run(
      { args: ['npx', 'tsc', '--noEmit'] },
      design('HIGH_LEVEL_DESIGN', "tests/modules/a.test.ts(3,1): error TS2304: Cannot find name 'foo'."),
    );
    expect(r.code).not.toBe('product_not_implemented');
  });
});

describe('run_tests missing-manifest diagnosis', () => {
  it('names the missing manifest instead of reporting a failing suite', async () => {
    // A TypeScript project's package.json is written by HIGH_LEVEL_DESIGN, so every earlier Step
    // runs npm test against a workspace that has none. Reported as a plain failure, the Step burns
    // its debug rounds repairing tests that were never collected.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-run-tests-'));
    const workspace = new Workspace(root);
    const workspaceForRunner = workspace;
    const failing = {
      ...ctx,
      ws: workspace,
      language: 'typescript' as const,
      sandbox: { runTests: async () => ({ exitCode: 254, stdout: '', stderr: '', timedOut: false }) },
    } as unknown as typeof ctx;

    // An installed-but-empty toolchain is a different condition, and one the Step can act on.
    await workspaceForRunner.writeFile('package.json', '{"scripts":{"test":"vitest run"}}\n');
    const missingRunner = await runTestsTool.run({}, {
      ...failing,
      ws: workspaceForRunner,
      sandbox: { runTests: async () => ({
        exitCode: 127, stdout: '', stderr: 'sh: vitest: command not found', timedOut: false,
      }) },
    } as unknown as typeof ctx);
    expect(missingRunner.error).toContain('install_deps');
    expect(missingRunner.code).toBeUndefined();
    await workspaceForRunner.remove('package.json');

    const noManifest = await runTestsTool.run({}, failing);
    expect(noManifest.ok).toBe(false);
    expect(noManifest.error).toContain('No package.json');
    expect(noManifest.error).toContain('HIGH_LEVEL_DESIGN');
    // The code is what stops this counting against the Step; the prose only explains it.
    expect(noManifest.code).toBe('manifest_missing');

    // Once the manifest exists, a failure is an ordinary test failure again.
    await workspace.writeFile('package.json', '{"scripts":{"test":"vitest run"}}\n');
    const withManifest = await runTestsTool.run({}, failing);
    expect(withManifest.ok).toBe(false);
    expect(withManifest.error).not.toContain('No package.json');
    expect(withManifest.code).toBeUndefined();
  });
});

describe('dependency manifest ownership', () => {
  const withPhase = (phase: string) => ({
    ...ctx, language: 'typescript' as const, phase,
    sandbox: { build: async () => ({ rebuilt: true, reason: 'ok' }) },
  } as unknown as typeof ctx);

  it('lets HIGH_LEVEL_DESIGN author the manifest', async () => {
    await ws.writeFile('package.json', '{"name":"a","version":"0.0.0"}\n');
    const r = await addDependencyTool.run({ packages: ['zod@3.22.0'] }, withPhase('HIGH_LEVEL_DESIGN'));
    expect(r.ok).toBe(true);
    expect(JSON.parse(await ws.readFile('package.json')).dependencies.zod).toBe('3.22.0');
  });

  // From a live run: HIGH_LEVEL_DESIGN's sandbox had no toolchain, so it called add_dependency for
  // packages already in its own manifest. It was told `+0 (none new; sandbox rebuild skipped)` and
  // left exactly as it was. "The manifest did not change" and "the environment needs nothing" are
  // different facts, and nothing a Step can do from the first one fixes the second.
  it('still prepares the environment when every package was already declared', async () => {
    const builds: string[] = [];
    const withBuildLog = {
      ...ctx, language: 'typescript' as const, phase: 'HIGH_LEVEL_DESIGN',
      sandbox: { build: async (manifest: string) => { builds.push(manifest); } },
    } as unknown as typeof ctx;
    await ws.writeFile('package.json', '{"name":"a","version":"0.0.0","dependencies":{"zod":"3.22.0"}}\n');

    const r = await addDependencyTool.run({ packages: ['zod@3.22.0'] }, withBuildLog);

    expect(r.ok).toBe(true);
    expect(builds).toEqual(['package.json']);
    expect(r.summary).toContain('environment matches the manifest');
  });

  it('says so when an unchanged manifest cannot be prepared, rather than reporting a skip', async () => {
    const failing = {
      ...ctx, language: 'typescript' as const, phase: 'HIGH_LEVEL_DESIGN',
      sandbox: { build: async () => { throw new Error('npm install timed out'); } },
    } as unknown as typeof ctx;
    await ws.writeFile('package.json', '{"name":"a","version":"0.0.0","dependencies":{"zod":"3.22.0"}}\n');

    const r = await addDependencyTool.run({ packages: ['zod@3.22.0'] }, failing);

    expect(r.ok).toBe(true);
    expect(r.summary).toContain('does not match the manifest');
    expect(r.summary).toContain('npm install timed out');
  });

  it('sends every other phase back through a change request', async () => {
    // One design decides the whole set. A Step editing the manifest under HIGH_LEVEL_DESIGN changes
    // what every other Step already resolved against, with nobody checking the result is consistent.
    for (const phase of ['REQUIREMENT_ANALYSIS', 'DETAILED_DESIGN', 'CODE', 'UNIT_TEST'] as const) {
      const r = await addDependencyTool.run({ packages: ['left-pad'] }, withPhase(phase));
      expect(r.ok, phase).toBe(false);
      expect(r.code, phase).toBe('dependency_not_owned');
      expect(r.error, phase).toContain('HIGH_LEVEL_DESIGN');
      expect(r.error, phase).toContain('left-pad');
    }
  });
});
