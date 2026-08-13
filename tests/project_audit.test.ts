import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { getLanguageProfile } from '../src/core/language.js';
import { runIterationGate, runProjectAudit, shouldRunProjectAudit } from '../src/core/project_audit.js';
import type { Plan } from '../src/core/plan.js';
import type { ExecExtra, ExecResult, Sandbox } from '../src/sandbox/types.js';

type SandboxHandler<TArgs extends unknown[]> = ExecResult | ((...args: TArgs) => ExecResult);

class FakeSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  constructor(
    private readonly handlers: Partial<{
      exec: SandboxHandler<[string, string[], ExecExtra?]>;
      runProgram: SandboxHandler<[string[], ExecExtra?]>;
      runTests: SandboxHandler<[string[]?, ExecExtra?]>;
    }>,
  ) {}
  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }
  async exec(cmd: string, argv: string[], extra?: ExecExtra): Promise<ExecResult> {
    return resolveHandler(this.handlers.exec, [cmd, argv, extra]);
  }
  async runProgram(args: string[], extra?: ExecExtra): Promise<ExecResult> {
    return resolveHandler(this.handlers.runProgram, [args, extra]);
  }
  async runTests(args?: string[], extra?: ExecExtra): Promise<ExecResult> {
    return resolveHandler(this.handlers.runTests, [args, extra]);
  }
  async installDeps(): Promise<ExecResult> {
    return okResult();
  }
}

function resolveHandler<TArgs extends unknown[]>(
  handler: SandboxHandler<TArgs> | undefined,
  args: TArgs,
): ExecResult {
  if (!handler) return okResult();
  return typeof handler === 'function' ? handler(...args) : handler;
}

function okResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 1,
    ...overrides,
  };
}

async function writeBaseDeliveryDocs(ws: Workspace): Promise<void> {
  await ws.writeFile('README.md', '# Audit app\n');
  await ws.writeFile('docs/quickstart.md', '# QuickStart\n');
  await ws.writeFile('docs/08-functional-test.md', '# Functional validation\n');
}

function tsPlan(): Plan {
  return {
    version: '1',
    language: 'typescript',
    intent: 'feature',
    projectType: 'application',
    requirementDigest: 'demo',
    globalPrompt: '',
    baselineSummary: '',
    userAddenda: '',
    dependencies: ['zod'],
    createdAt: new Date().toISOString(),
    steps: [],
  };
}

describe('project quality audit', () => {
  it('skips final audit for partial executions', () => {
    const plan = {
      ...tsPlan(),
      steps: [
        { id: 'S001', phase: 'REQUIREMENT_ANALYSIS', title: 'a', description: 'a', systemPrompt: 'x'.repeat(30), role: 'Planner', tools: [], inputs: [], outputs: ['docs/01-requirement-analysis.md'], dependsOn: [], acceptance: 'ok', maxAttempts: 3 },
        { id: 'S002', phase: 'FUNCTIONAL_TEST', title: 'b', description: 'b', systemPrompt: 'x'.repeat(30), role: 'Tester', tools: [], inputs: [], outputs: ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'], dependsOn: ['S001'], acceptance: 'ok', maxAttempts: 3 },
      ],
    } as Plan;
    expect(shouldRunProjectAudit({ onlyPhase: 'CODE' }, false)).toBe(false);
    expect(shouldRunProjectAudit({ onlyPhase: undefined }, false)).toBe(false);
    plan.steps[1]!.status = 'DONE';
    expect(shouldRunProjectAudit({ onlyPhase: undefined }, true)).toBe(true);
  });

  it('passes when tests, entrypoint, build and lint succeed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-app',
      type: 'module',
      scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json', lint: 'eslint .' },
    }, null, 2));

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ exec: okResult({ stdout: 'usage: app\n' }), runTests: okResult() }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it('executes a declared Phase user scenario and captures its scene', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({ name: 'audit-app', type: 'module', scripts: {} }));
    const calls: string[] = [];
    let liveBoundaryCalls = 0;

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({
        exec: (command, args) => {
          calls.push([command, ...args].join(' '));
          return okResult({ stdout: '{"headline":"ok"}\n' });
        },
        runTests: okResult(),
      }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
      scenarios: [{
        name: 'fetch-latest-news',
        description: 'Use the application as an end user.',
        operation: 'Request the latest news and render one result.',
        environment: 'live',
        expected: 'A usable headline is rendered.',
        execution: { command: 'node', args: ['src/main.ts', '--limit', '1'] },
      }],
      runLiveScenario: async (operation) => {
        liveBoundaryCalls += 1;
        return operation();
      },
    });

    expect(liveBoundaryCalls).toBe(1);
    expect(calls).toContain('node src/main.ts --limit 1');
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'scenario:fetch-latest-news',
      ok: true,
      scene: expect.objectContaining({
        command: 'node src/main.ts --limit 1',
        exitCode: 0,
        stdoutTail: '{"headline":"ok"}',
      }),
    }));
  });

  it('fails a library project whose API guide is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-lib',
      type: 'module',
      scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json', lint: 'eslint .' },
    }, null, 2));

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ exec: okResult({ stdout: 'usage: app\n' }), runTests: okResult() }),
      plan: { ...tsPlan(), projectType: 'library' },
      profile: getLanguageProfile('typescript'),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'api-guide', severity: 'error', ok: false,
    }));
    expect(result.checks.find((check) => check.name === 'api-guide')?.finding).toMatchObject({
      category: 'deliverable-defect',
      target: 'current-step',
    });
  });

  it('checks iteration-scoped delivery docs for P2 gates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('docs/iterations/P2/08-functional-test.md', '# P2 Functional validation\n');
    await ws.writeFile('docs/iterations/P2/quickstart.md', '# P2 QuickStart\n');
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-app',
      type: 'module',
      scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json', lint: 'eslint .' },
    }, null, 2));

    const result = await runIterationGate({
      ws,
      sandbox: new FakeSandbox({ exec: okResult({ stdout: 'usage: app\n' }), runTests: okResult() }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
      iterationId: 'P2',
    });

    expect(result.ok).toBe(true);
    expect(result.scope).toBe('iteration');
    expect(result.iterationId).toBe('P2');
    expect(result.checks.some((check) => check.name === 'readme')).toBe(false);
    expect(result.checks.some((check) => check.name === 'doc:docs/iterations/P2/08-functional-test.md')).toBe(true);
  });

  it('fails a Python project that has no runnable entrypoint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('tests/test_app.py', 'def test_ok(): assert True\n');
    const plan = { ...tsPlan(), language: 'python' as const };

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ runTests: okResult() }),
      plan,
      profile: getLanguageProfile('python'),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'entrypoint', severity: 'error', ok: false,
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'test-files', severity: 'info', ok: true,
    }));
  });

  it('fails a Python project whose main.py is only imports/comments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.py', 'import argparse\nimport logging\n# placeholder\n');
    await ws.writeFile('tests/test_app.py', 'def test_ok(): assert True\n');
    const plan = { ...tsPlan(), language: 'python' as const };

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ runProgram: okResult({ stdout: '' }), runTests: okResult() }),
      plan,
      profile: getLanguageProfile('python'),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'entrypoint', severity: 'error', ok: false,
    }));
  });

  it('warns when TypeScript project has no build or lint script', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-app',
      type: 'module',
      scripts: { test: 'vitest run' },
    }, null, 2));

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ exec: okResult({ stdout: 'usage: app\n' }), runTests: okResult() }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toBe(2);
    expect(result.checks.some((check) => check.name === 'build-script' && !check.ok)).toBe(true);
    expect(result.checks.some((check) => check.name === 'lint-script' && !check.ok)).toBe(true);
  });

  it('fails when the build audit fails after execution', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-app',
      type: 'module',
      scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json' },
    }, null, 2));

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({
        runTests: okResult(),
        exec: (cmd, argv) => {
          if (cmd === 'node') return okResult({ stdout: 'usage: app\n' });
          if (cmd === 'npm' && argv.includes('build')) {
            return okResult({ exitCode: 1, stderr: 'build failed' });
          }
          return okResult();
        },
      }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.checks.some((check) => check.name === 'build' && !check.ok)).toBe(true);
    expect(result.checks.find((check) => check.name === 'build')?.finding).toMatchObject({
      category: 'product-defect',
      target: 'code',
    });
  });
});
