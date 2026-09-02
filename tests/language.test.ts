import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { AuditLogger } from '../src/audit/audit.js';
import { getLanguageProfile } from '../src/core/language.js';
import { inspectLanguageProjectContract } from '../src/core/language_project_contract.js';

describe('TypeScript language profile', () => {
  it('splits known third-party type-only imports before entry probes', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-lang-'));
    const ws = new Workspace(tmp);
    const audit = new AuditLogger({ root: tmp, command: 'test' });
    await audit.start({});
    await ws.writeFile(
      'src/fetcher.ts',
      [
        'import axios, { AxiosInstance, AxiosError, isAxiosError } from "axios";',
        '',
        'function createClient(): AxiosInstance {',
        '  return axios.create();',
        '}',
        '',
        'export function isWrappedAxiosError(err: unknown): boolean {',
        '  return err instanceof AxiosError || isAxiosError(err);',
        '}',
        '',
        'export { createClient };',
        '',
      ].join('\n'),
    );

    const fixed = await getLanguageProfile('typescript').autoFixImports?.(ws, audit);

    expect(fixed).toEqual(['src/fetcher.ts']);
    await expect(ws.readFile('src/fetcher.ts')).resolves.toContain(
      'import axios, { AxiosError, isAxiosError } from "axios";\nimport type { AxiosInstance } from "axios";',
    );
  });
});

describe('test file naming reaches the planner', () => {
  // `vitest run` collects only `*.test.ts` / `*.spec.ts`. The profile has always encoded that in
  // testFileFor, but nothing told the planner — and the planner is what declares Step outputs, so a
  // Python-style `tests/test_x.ts` produced a suite no role could make runnable.
  const VITEST_DEFAULT_INCLUDE = /^.*\.(test|spec)\.(c|m)?[jt]sx?$/u;

  it('names generated TypeScript tests the way vitest discovers them', () => {
    const profile = getLanguageProfile('typescript');
    for (const [source, stepId] of [['src/scrapers.ts', 'S004'], ['src/a/b.ts', 'S004'], ['', 'S007']] as const) {
      const file = profile.testFileFor(source, stepId);
      expect(file, `${source || '(none)'} → ${file}`).toMatch(VITEST_DEFAULT_INCLUDE);
    }
  });

  it('states the naming rule in the planner prompt, since the planner declares the outputs', () => {
    const profile = getLanguageProfile('typescript');
    expect(profile.plannerPromptOverride).toContain('.test.ts');
    expect(profile.plannerPromptOverride).toContain('.spec.ts');
    // The counter-example is the mistake actually observed in a live run.
    expect(profile.plannerPromptOverride).toContain('tests/test_service.ts');
    // Python is unaffected: pytest collects `test_*.py`, so its profile needs no override.
    expect(getLanguageProfile('python').testFileFor('src/x.py', 'S004')).toMatch(/^tests\/test_.*\.py$/u);
    expect(getLanguageProfile('python').plannerPromptOverride).toBe('');
  });
});

describe('language project contract', () => {
  it('routes a TypeScript test entrypoint that hides baseline tests back to its manifest owner', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-language-contract-'));
    const ws = new Workspace(tmp);
    await ws.writeFile('package.json', JSON.stringify({
      scripts: { test: 'vitest run --exclude tests/functional.test.ts' },
    }));

    await expect(inspectLanguageProjectContract(ws, 'typescript')).resolves.toEqual([
      expect.objectContaining({
        category: 'deliverable-defect',
        code: 'language_test_entrypoint_contract_invalid',
        target: 'high-level-design',
        affectedArtifacts: ['package.json'],
      }),
    ]);
  });

  it('accepts the profile-owned test entrypoint and leaves Python manifests unaffected', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-language-contract-'));
    const ws = new Workspace(tmp);
    await ws.writeFile('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));

    await expect(inspectLanguageProjectContract(ws, 'typescript')).resolves.toEqual([]);
    await expect(inspectLanguageProjectContract(ws, 'python')).resolves.toEqual([]);
  });
});
