import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import {
  buildProjectMemory,
  PROJECT_MEMORY_PATH,
  loadProjectMemory,
  refreshProjectMemory,
  selectMemoryContractsForStep,
  selectMemorySnippetsForStep,
} from '../src/core/project_memory.js';
import type { Step } from '../src/core/plan.js';

const step = (overrides: Partial<Step> = {}): Step =>
  ({
    id: 'S200',
    iterationId: 'P1',
    phase: 'CODE',
    title: 'Extend reporting service',
    description: 'Add invoice export orchestration to the reporting service.',
    systemPrompt: 'Implement the step.',
    role: 'Coder',
    tools: ['write_file'],
    inputs: [],
    outputs: ['src/reporting/service.ts'],
    dependsOn: [],
    acceptance: 'reporting service supports invoice export',
    maxAttempts: 3,
    ...overrides,
  }) as Step;

describe('project memory', () => {
  it('captures docs, manifests and implementation snippets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-memory-'));
    const ws = new Workspace(root);
    const state = new Workspace(path.join(root, '.xcompiler'));
    await ws.writeFile('docs/topic.md', 'Invoice reporting with CSV export.');
    await ws.writeFile(
      'docs/02-high-level-design.md',
      [
        'ReportingService coordinates exporters and formatters.',
        'Must preserve CSV export compatibility for existing clients.',
        'Future extension point: add PDF export adapters without rewriting the service.',
      ].join('\n'),
    );
    await ws.writeFile('package.json', JSON.stringify({
      name: 'reporting-app',
      scripts: { test: 'vitest run' },
    }, null, 2));
    await ws.writeFile('src/main.ts', 'export const main = () => "ok";\n');
    await ws.writeFile('src/reporting/service.ts', 'export class ReportingService { exportCsv() { return "csv"; } }\n');
    await ws.writeFile('tests/reporting/service.test.ts', 'import { describe, it, expect } from "vitest";\n');

    const memory = await buildProjectMemory(ws, { language: 'typescript', intent: 'feature' });

    expect(memory.summary).toContain('## Project memory');
    expect(memory.summary).toContain('Invoice reporting with CSV export.');
    expect(memory.summary).toContain('ReportingService coordinates exporters');
    expect(memory.summary).toContain('## package.json');
    expect(memory.summary).toContain('## Module map');
    expect(memory.summary).toContain('## Contracts');
    expect(memory.summary).toContain('src/reporting/service.ts');
    expect(memory.modules.find((module) => module.path === 'src/reporting/service.ts')?.symbols).toContain('ReportingService');
    expect(memory.contracts.some((contract) => contract.kind === 'api' && contract.subject === 'src/reporting/service.ts')).toBe(true);
    expect(memory.contracts.some((contract) => contract.kind === 'invariant' && contract.detail.includes('preserve CSV export compatibility'))).toBe(true);
    expect(memory.keyFiles.map((file) => file.path)).toEqual(
      expect.arrayContaining(['docs/topic.md', 'package.json', 'src/reporting/service.ts']),
    );
  });

  it('persists and reloads project memory for later incremental runs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-memory-'));
    const ws = new Workspace(root);
    const state = new Workspace(path.join(root, '.xcompiler'));
    await ws.writeFile('docs/topic.md', 'Existing export workflow.');
    await ws.writeFile('src/exporter.ts', 'export function exportData() { return "done"; }\n');

    await refreshProjectMemory(ws, state, { language: 'typescript', intent: 'feature' });
    const loaded = await loadProjectMemory(state);

    expect(loaded?.summary).toContain('Existing export workflow.');
    expect(loaded?.keyFiles.some((file) => file.path === 'src/exporter.ts')).toBe(true);

    // It lands in the container state tier beside the PM projection, never in the code tree: a
    // worktree copy would diverge per worktree and would be lost whenever one is pruned.
    expect(await state.exists(PROJECT_MEMORY_PATH)).toBe(true);
    expect(await ws.exists(PROJECT_MEMORY_PATH)).toBe(false);
    expect(await ws.exists('.xcompiler/project_memory.json')).toBe(false);
  });

  it('loads the stable design contracts when planning a self-bootstrap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-memory-'));
    const ws = new Workspace(root);
    const state = new Workspace(path.join(root, '.xcompiler'));
    await ws.writeFile('docs/XCompiler_design.md', 'Stable runtime and V-model architecture.');
    await ws.writeFile('docs/self_bootstrap.md', 'Generation N builds N+1 in an isolated worktree.');
    await ws.writeFile('package.json', JSON.stringify({ name: '@xcompiler/cli' }));

    const memory = await buildProjectMemory(ws, { language: 'typescript', intent: 'self' });

    expect(memory.summary).toContain('Stable runtime and V-model architecture.');
    expect(memory.summary).toContain('Generation N builds N+1');
    expect(memory.keyFiles.map((file) => file.path)).toEqual(
      expect.arrayContaining(['docs/XCompiler_design.md', 'docs/self_bootstrap.md']),
    );
  });

  it('selects relevant snippets for the current step', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-memory-'));
    const ws = new Workspace(root);
    const state = new Workspace(path.join(root, '.xcompiler'));
    await ws.writeFile('src/reporting/service.ts', 'export class ReportingService { exportCsv() { return "csv"; } }\n');
    await ws.writeFile('src/auth/service.ts', 'export class AuthService { login() { return true; } }\n');

    const memory = await buildProjectMemory(ws, { language: 'typescript', intent: 'feature' });
    const snippets = selectMemorySnippetsForStep(memory, step());
    const contracts = selectMemoryContractsForStep(memory, step());

    expect(snippets[0]?.path).toBe('src/reporting/service.ts');
    expect(snippets.some((snippet) => snippet.content.includes('exportCsv'))).toBe(true);
    expect(contracts.some((contract) => contract.subject === 'src/reporting/service.ts')).toBe(true);
  });
});
