import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import type { ToolContext } from '../src/tools/types.js';
import { replaceInFileTool, codeSearchTool, analyzeErrorTool } from '../src/tools/edit.js';
import { addDependencyTool } from '../src/tools/deps.js';

let tmp: string;
let ws: Workspace;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-edit-'));
  ws = new Workspace(tmp);
  ctx = {
    ws,
    sandbox: {
      build: async () => ({ reason: 'noop', sha: 'x' }),
    } as never,
    allowedWrites: ['src/', 'requirements.txt'],
    stepId: 'S001',
  };
});

describe('replace_in_file', () => {
  it('replaces exactly one occurrence', async () => {
    await ws.writeFile('src/a.py', 'x = 1\nprint(x)\n');
    const r = await replaceInFileTool.run(
      { path: 'src/a.py', find: 'x = 1', replace: 'x = 42' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(await ws.readFile('src/a.py')).toBe('x = 42\nprint(x)\n');
  });

  it('fails on wrong occurrence count', async () => {
    await ws.writeFile('src/b.py', 'a\na\n');
    const r = await replaceInFileTool.run({ path: 'src/b.py', find: 'a', replace: 'b' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expected 1.*found 2/);
  });

  it('rejects writes outside whitelist', async () => {
    await ws.writeFile('src/c.py', 'a\n');
    const r = await replaceInFileTool.run(
      { path: 'docs/c.py', find: 'a', replace: 'b' },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/write denied/);
  });

  it('canonicalizes a project-prefixed path before the allowlist check', async () => {
    await ws.writeFile('src/prefixed.py', 'x = 1\n');
    const r = await replaceInFileTool.run(
      {
        path: `${path.basename(ws.root)}/src/prefixed.py`,
        find: 'x = 1',
        replace: 'x = 2',
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('src/prefixed.py');
    expect(await ws.readFile('src/prefixed.py')).toBe('x = 2\n');
  });

  it('rejects a missing path before attempting workspace resolution', async () => {
    const r = await replaceInFileTool.run(
      { find: 'x', replace: 'y' } as never,
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('path must be a non-empty string');
  });

  it('rejects replacing a substantial file with an empty or tiny result', async () => {
    const original = `export class Pipeline {\n${'  run(): void { return; }\n'.repeat(40)}}\n`;
    await ws.writeFile('src/pipeline.ts', original);

    const r = await replaceInFileTool.run(
      { path: 'src/pipeline.ts', find: original, replace: '' },
      ctx,
    );

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/suspicious truncation/);
    expect(await ws.readFile('src/pipeline.ts')).toBe(original);
  });

  it('rejects empty replacement of a single-line token as an incomplete edit', async () => {
    const original = 'export function getNextExecution(): Date { return new Date(); }\n';
    await ws.writeFile('src/scheduler.ts', original);

    const r = await replaceInFileTool.run(
      { path: 'src/scheduler.ts', find: ' getNextExecution', replace: '' },
      ctx,
    );

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/truncated model response/);
    expect(await ws.readFile('src/scheduler.ts')).toBe(original);
  });
});

describe('code_search', () => {
  it('finds matches by substring', async () => {
    await ws.writeFile('src/m.py', 'def hello():\n    return "world"\n');
    await ws.writeFile('src/n.py', 'def goodbye():\n    return 1\n');
    const r = await codeSearchTool.run({ query: 'def ' }, ctx);
    expect(r.ok).toBe(true);
    const m = (r.data as { matches: Array<{ path: string; line: number; text: string }> }).matches;
    expect(m.length).toBeGreaterThanOrEqual(2);
    expect(m.some((x) => x.path === 'src/m.py' && x.text.includes('hello'))).toBe(true);
  });
});

describe('analyze_error', () => {
  it('detects ModuleNotFoundError', async () => {
    const r = await analyzeErrorTool.run(
      { text: 'Traceback...\nModuleNotFoundError: No module named \'requests\'' },
      ctx,
    );
    expect(r.ok).toBe(true);
    const d = r.data as { kind: string; missingModule?: string };
    expect(d.kind).toBe('ModuleNotFoundError');
    expect(d.missingModule).toBe('requests');
  });

  it('extracts pytest FAILED tests', async () => {
    const r = await analyzeErrorTool.run(
      { text: 'short test summary\nFAILED tests/test_a.py::test_x\nFAILED tests/test_b.py::test_y' },
      ctx,
    );
    const d = r.data as { kind: string; failedTests: string[] };
    expect(d.kind).toBe('TestFailure');
    expect(d.failedTests).toEqual(['tests/test_a.py::test_x', 'tests/test_b.py::test_y']);
  });

  it('finds last frame file/line', async () => {
    const r = await analyzeErrorTool.run(
      { text: 'File "/a/b.py", line 10, in foo\nFile "/c/d.py", line 99, in bar\nValueError: x' },
      ctx,
    );
    const d = r.data as { file?: string; line?: number };
    expect(d.file).toBe('/c/d.py');
    expect(d.line).toBe(99);
  });
});

describe('add_dependency', () => {
  it('returns a tool-contract error for missing package args instead of throwing', async () => {
    const r = await addDependencyTool.run({} as never, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid add_dependency args/);
  });

  it('appends new packages and dedupes', async () => {
    await ws.writeFile('requirements.txt', 'pytest\nrequests\n');
    let buildCalls = 0;
    ctx.sandbox = {
      build: async () => {
        buildCalls++;
        return { reason: 'rebuild', sha: 'y' };
      },
    } as never;
    const r = await addDependencyTool.run({ packages: ['requests', 'numpy'] }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { added: string[]; finalLines: string[] };
    expect(d.added).toEqual(['numpy']);
    expect(d.finalLines).toEqual(['numpy', 'pytest', 'requests']);
    expect(buildCalls).toBe(1);
    expect(await ws.readFile('requirements.txt')).toBe('numpy\npytest\nrequests\n');
  });

  it('manages the manifest even if it is not in step outputs whitelist', async () => {
    ctx.allowedWrites = ['src/'];
    const r = await addDependencyTool.run({ packages: ['x'] }, ctx);
    expect(r.ok).toBe(true);
    expect(await ws.readFile('requirements.txt')).toBe('x\n');
  });

  it('restores the dependency manifest when the sandbox rebuild fails', async () => {
    await ws.writeFile('requirements.txt', 'pytest\n');
    ctx.sandbox = {
      build: async () => {
        throw new Error('pip resolver rejected hallucinated-package');
      },
    } as never;

    const r = await addDependencyTool.run({ packages: ['hallucinated-package'] }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toContain('were restored');
    expect(await ws.readFile('requirements.txt')).toBe('pytest\n');
  });

  it('restores package.json and lockfiles when an npm rebuild fails', async () => {
    const packageJson = '{\n  "name": "fixture",\n  "dependencies": { "yaml": "^2.0.0" }\n}\n';
    await ws.writeFile('package.json', packageJson);
    await ws.writeFile('package-lock.json', '{"lockfileVersion":3}\n');
    ctx.language = 'typescript';
    ctx.sandbox = {
      build: async () => {
        await ws.writeFile('package-lock.json', '{"polluted":true}\n');
        await ws.writeFile('npm-shrinkwrap.json', '{"polluted":true}\n');
        throw new Error('npm 404 package not found');
      },
    } as never;

    const r = await addDependencyTool.run({ packages: ['cron-par'] }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toContain('were restored');
    expect(await ws.readFile('package.json')).toBe(packageJson);
    expect(await ws.readFile('package-lock.json')).toBe('{"lockfileVersion":3}\n');
    await expect(fs.stat(path.join(tmp, 'npm-shrinkwrap.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('parses scoped npm version selectors and refreshes the lockfile as a dev dependency', async () => {
    await ws.writeFile('package.json', JSON.stringify({
      name: 'fixture',
      dependencies: { yaml: '^2.0.0' },
      devDependencies: { vitest: '^1.2.0' },
    }, null, 2));
    ctx.language = 'typescript';
    let buildArgs: unknown[] = [];
    ctx.sandbox = {
      build: async (...args: unknown[]) => {
        buildArgs = args;
        return { rebuilt: true, reason: 'lockfile refreshed' };
      },
    } as never;

    const r = await addDependencyTool.run(
      { packages: ['@vitest/coverage-v8@1.6.1'], dev: true },
      ctx,
    );

    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ added: ['@vitest/coverage-v8'], updated: [] });
    expect(buildArgs).toEqual(['package.json', { refreshLockfile: true }]);
    const pkg = JSON.parse(await ws.readFile('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({ yaml: '^2.0.0' });
    expect(pkg.devDependencies['@vitest/coverage-v8']).toBe('1.6.1');
    expect(pkg.devDependencies['@vitest/coverage-v8@1.6.1']).toBeUndefined();
  });

  it('updates an existing npm dependency version without duplicating the package name', async () => {
    await ws.writeFile('package.json', JSON.stringify({
      name: 'fixture',
      devDependencies: {
        '@vitest/coverage-v8': '1.5.0',
        vitest: '1.6.1',
      },
    }, null, 2));
    ctx.language = 'typescript';

    const r = await addDependencyTool.run(
      { packages: ['@vitest/coverage-v8@1.6.1'], dev: true },
      ctx,
    );

    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ added: [], updated: ['@vitest/coverage-v8'] });
    const pkg = JSON.parse(await ws.readFile('package.json')) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies).toEqual({
      '@vitest/coverage-v8': '1.6.1',
      vitest: '1.6.1',
    });
  });

  it('skips sandbox rebuild when every requested dependency already exists', async () => {
    await ws.writeFile('requirements.txt', 'pytest\n');
    let buildCalls = 0;
    ctx.sandbox = {
      build: async () => {
        buildCalls++;
        return { rebuilt: false, reason: 'not expected' };
      },
    } as never;

    const r = await addDependencyTool.run({ packages: ['pytest'] }, ctx);

    expect(r.ok).toBe(true);
    expect(r.summary).toContain('rebuild skipped');
    expect(buildCalls).toBe(0);
  });
});
