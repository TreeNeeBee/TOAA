import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  needsSrcBootstrap,
  injectSrcBootstrap,
  autoFixSrcImports,
  probeEntrypoint,
} from '../src/core/entry_gate.js';
import { getLanguageProfile } from '../src/core/language.js';
import { Workspace } from '../src/workspace/workspace.js';
import { AuditLogger } from '../src/audit/audit.js';
import type { Sandbox, ExecResult, ExecExtra } from '../src/sandbox/types.js';

async function tmpWs(): Promise<{ ws: Workspace; audit: AuditLogger; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-entrygate-'));
  const ws = new Workspace(dir);
  const audit = new AuditLogger({ root: dir, command: 'test' });
  await audit.start({ component: 'test' });
  return { ws, audit, dir };
}

class FakeSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  constructor(private readonly impl: (argv: string[]) => ExecResult) {}
  async build() { return { rebuilt: false, reason: 'stub' }; }
  async exec(_cmd: string, argv: string[]): Promise<ExecResult> {
    return this.impl(argv);
  }
  async runProgram(args: string[], _extra?: ExecExtra): Promise<ExecResult> {
    return this.impl(args);
  }
  async runTests(): Promise<ExecResult> { throw new Error('not used'); }
  async installDeps(): Promise<ExecResult> {
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 };
  }
}

describe('entry_gate sys.path bootstrap', () => {
  it('detects from src.* imports without bootstrap', () => {
    expect(needsSrcBootstrap('from src.foo import bar\n')).toBe(true);
    expect(needsSrcBootstrap('import src.foo\n')).toBe(true);
    expect(needsSrcBootstrap('from foo import bar\n')).toBe(false);
    expect(needsSrcBootstrap('# unrelated\nprint(1)\n')).toBe(false);
  });

  it('does not double-inject if marker already present', () => {
    const once = injectSrcBootstrap('from src.foo import bar\n');
    expect(once).toContain('xcompiler: sys.path bootstrap');
    const twice = injectSrcBootstrap(once);
    expect(twice).toBe(once);
  });

  it('preserves shebang on top when injecting', () => {
    const src = '#!/usr/bin/env python\nfrom src.x import y\n';
    const out = injectSrcBootstrap(src);
    expect(out.startsWith('#!/usr/bin/env python\n')).toBe(true);
    expect(out).toContain('_xcompiler_sys.path.insert');
    expect(out.indexOf('from src.x')).toBeGreaterThan(out.indexOf('_xcompiler_sys.path.insert'));
  });
});

describe('autoFixSrcImports', () => {
  it('rewrites src/main.py when it has from src. imports', async () => {
    const { ws, audit } = await tmpWs();
    await ws.ensure('src');
    await ws.writeFile('src/main.py', 'from src.lib import run\nrun()\n');
    const fixed = await autoFixSrcImports(ws, audit);
    expect(fixed).toEqual(['src/main.py']);
    const content = await ws.readFile('src/main.py');
    expect(content).toContain('_xcompiler_sys.path.insert');
    // running again must be a no-op
    const fixed2 = await autoFixSrcImports(ws, audit);
    expect(fixed2).toEqual([]);
  });

  it('rewrites src/<pkg>/__main__.py with from src. imports', async () => {
    const { ws, audit } = await tmpWs();
    await ws.ensure('src/toolpkg');
    await ws.writeFile('src/toolpkg/__main__.py', 'from src.toolpkg.parser import p\np()\n');
    const fixed = await autoFixSrcImports(ws, audit);
    expect(fixed).toEqual(['src/toolpkg/__main__.py']);
  });

  it('leaves files alone when no from src. import is present', async () => {
    const { ws, audit } = await tmpWs();
    await ws.ensure('src');
    await ws.writeFile('src/main.py', 'from lib import run\nrun()\n');
    const fixed = await autoFixSrcImports(ws, audit);
    expect(fixed).toEqual([]);
  });
});

describe('probeEntrypoint', () => {
  it('fails when no Python entrypoint exists', async () => {
    const { ws } = await tmpWs();
    const sb = new FakeSandbox(() => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 }));
    const probe = await probeEntrypoint(ws, sb);
    expect(probe.ok).toBe(false);
    expect(probe.stderrTail).toContain('entrypoint');
  });

  it('reports failure when src/main.py --help exits non-zero', async () => {
    const { ws } = await tmpWs();
    await ws.ensure('src');
    await ws.writeFile('src/main.py', 'def main():\n    raise SystemExit(2)\nif __name__ == "__main__":\n    main()\n');
    const sb = new FakeSandbox((argv) => {
      expect(argv).toEqual(['src/main.py', '--help']);
      return { exitCode: 2, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 };
    });
    const probe = await probeEntrypoint(ws, sb);
    expect(probe?.ok).toBe(false);
    expect(probe?.command).toBe('python src/main.py --help');
    expect(probe?.stderrTail).toContain('boom');
  });

  it('fails import-only src/main.py even when Python would exit 0', async () => {
    const { ws } = await tmpWs();
    await ws.ensure('src');
    await ws.writeFile('src/main.py', 'import argparse\nimport logging\n# placeholder\n');
    const sb = new FakeSandbox(() => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }));
    const probe = await probeEntrypoint(ws, sb);
    expect(probe.ok).toBe(false);
    expect(probe.stderrTail).toMatch(/placeholder|占位/);
  });

  it('fails when --help exits 0 but prints no usage/help text', async () => {
    const { ws } = await tmpWs();
    await ws.ensure('src');
    await ws.writeFile(
      'src/main.py',
      'def main():\n    print("hello")\nif __name__ == "__main__":\n    main()\n',
    );
    const sb = new FakeSandbox(() => ({ exitCode: 0, stdout: 'hello\n', stderr: '', timedOut: false, durationMs: 1 }));
    const probe = await probeEntrypoint(ws, sb);
    expect(probe.ok).toBe(false);
    expect(probe.stderrTail).toContain('help/usage');
  });

  it('passes when src/main.py has a real CLI structure and help output', async () => {
    const { ws } = await tmpWs();
    await ws.ensure('src');
    await ws.writeFile(
      'src/main.py',
      'import argparse\n\ndef main():\n    parser = argparse.ArgumentParser(description="demo")\n    parser.parse_args()\n\nif __name__ == "__main__":\n    main()\n',
    );
    const sb = new FakeSandbox(() => ({ exitCode: 0, stdout: 'usage: main.py [-h]\n', stderr: '', timedOut: false, durationMs: 1 }));
    const probe = await probeEntrypoint(ws, sb);
    expect(probe.ok).toBe(true);
  });

  it('falls back to src/cli.py when no standard Python main entry exists', async () => {
    const { ws } = await tmpWs();
    await ws.ensure('src');
    await ws.writeFile(
      'src/cli.py',
      'import argparse\n\ndef main():\n    argparse.ArgumentParser(description="demo").parse_args()\n\nif __name__ == "__main__":\n    main()\n',
    );
    const calls: string[][] = [];
    const sb = new FakeSandbox((argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: 'usage: cli.py [-h]\n', stderr: '', timedOut: false, durationMs: 1 };
    });
    const probe = await probeEntrypoint(ws, sb);
    expect(probe.ok).toBe(true);
    expect(probe.command).toBe('python src/cli.py --help');
    expect(calls).toEqual([['src/cli.py', '--help']]);
  });

  it('leaves semantic no-arg execution to the LLM-judged Phase scenario', async () => {
    const { ws } = await tmpWs();
    await ws.ensure('src');
    await ws.writeFile(
      'src/main.py',
      'import argparse\n\ndef main():\n    argparse.ArgumentParser(description="demo").parse_args()\n\nif __name__ == "__main__":\n    main()\n',
    );
    const calls: string[][] = [];
    const sb = new FakeSandbox((argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: 'usage: main.py [-h]\n', stderr: '', timedOut: false, durationMs: 1 };
    });
    const probe = await probeEntrypoint(ws, sb);
    expect(probe.ok).toBe(true);
    expect(probe.command).toBe('python src/main.py --help');
    expect(calls).toEqual([['src/main.py', '--help']]);
  });

  it('falls back to python -m src.<pkg> --help', async () => {
    const { ws } = await tmpWs();
    await ws.ensure('src/myapp');
    await ws.writeFile(
      'src/myapp/__main__.py',
      'import argparse\n\ndef main():\n    argparse.ArgumentParser(description="demo").parse_args()\n\nif __name__ == "__main__":\n    main()\n',
    );
    const sb = new FakeSandbox((argv) => {
      expect(argv).toEqual(['-m', 'src.myapp', '--help']);
      return { exitCode: 0, stdout: 'usage', stderr: '', timedOut: false, durationMs: 1 };
    });
    const probe = await probeEntrypoint(ws, sb);
    expect(probe?.ok).toBe(true);
    expect(probe?.command).toBe('python -m src.myapp --help');
  });

  it('fails TypeScript delivery probing when no standard entrypoint exists', async () => {
    const { ws } = await tmpWs();
    await ws.ensure('src');
    await ws.writeFile('src/app.ts', 'export const app = 1;\n');
    const sb = new FakeSandbox(() => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 }));
    const probe = await getLanguageProfile('typescript').probeEntry?.(ws, sb);
    expect(probe?.ok).toBe(false);
    expect(probe?.stderrTail).toContain('missing TypeScript entrypoint');
  });

  it('prefers package.json start script when probing TypeScript delivery', async () => {
    const { ws } = await tmpWs();
    await ws.writeFile('package.json', JSON.stringify({
      type: 'module',
      scripts: { start: 'tsx app/cli.ts' },
    }, null, 2));
    const sb: Sandbox = {
      kind: 'subprocess',
      async build() { return { rebuilt: false, reason: 'stub' }; },
      async exec(cmd: string, argv: string[]) {
        expect(cmd).toBe('npm');
        expect(argv).toEqual(['run', '--silent', 'start', '--', '--help']);
        return { exitCode: 0, stdout: 'usage', stderr: '', timedOut: false, durationMs: 1 };
      },
      async runProgram() { throw new Error('should not use runProgram'); },
      async runTests() { throw new Error('not used'); },
      async installDeps() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 }; },
    };
    const probe = await getLanguageProfile('typescript').probeEntry?.(ws, sb);
    expect(probe?.ok).toBe(true);
    expect(probe?.command).toBe('npm run --silent start -- --help');
  });

  it('prefers direct node src/main.ts when probing TypeScript source entries', async () => {
    const { ws } = await tmpWs();
    await ws.ensure('src');
    await ws.writeFile('src/main.ts', 'console.log("usage")\n');
    await ws.writeFile('package.json', JSON.stringify({
      type: 'module',
      scripts: { start: 'tsx src/main.ts' },
    }, null, 2));
    const sb: Sandbox = {
      kind: 'subprocess',
      async build() { return { rebuilt: false, reason: 'stub' }; },
      async exec(cmd: string, argv: string[]) {
        expect(cmd).toBe('node');
        expect(argv).toEqual(['src/main.ts', '--help']);
        return { exitCode: 0, stdout: 'usage', stderr: '', timedOut: false, durationMs: 1 };
      },
      async runProgram() { throw new Error('should not use runProgram'); },
      async runTests() { throw new Error('not used'); },
      async installDeps() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 }; },
    };
    const probe = await getLanguageProfile('typescript').probeEntry?.(ws, sb);
    expect(probe?.ok).toBe(true);
    expect(probe?.command).toBe('node src/main.ts --help');
  });

  it('uses package.json bin when probing TypeScript delivery', async () => {
    const { ws } = await tmpWs();
    await ws.writeFile('package.json', JSON.stringify({
      type: 'module',
      bin: { app: 'bin/app.ts' },
    }, null, 2));
    const sb: Sandbox = {
      kind: 'subprocess',
      async build() { return { rebuilt: false, reason: 'stub' }; },
      async exec(cmd: string, argv: string[]) {
        expect(cmd).toBe('node');
        expect(argv).toEqual(['bin/app.ts', '--help']);
        return { exitCode: 0, stdout: 'usage', stderr: '', timedOut: false, durationMs: 1 };
      },
      async runProgram() { throw new Error('should not use runProgram'); },
      async runTests() { throw new Error('not used'); },
      async installDeps() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 }; },
    };
    const probe = await getLanguageProfile('typescript').probeEntry?.(ws, sb);
    expect(probe?.ok).toBe(true);
    expect(probe?.command).toBe('node bin/app.ts --help');
  });
});
