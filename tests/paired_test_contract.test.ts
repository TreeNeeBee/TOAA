import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectPairedSourceTests,
  mergePairedSourceTestQuality,
} from '../src/core/paired_test_contract.js';
import type { Language, Plan, Step } from '../src/core/plan.js';
import { Workspace } from '../src/workspace/workspace.js';

describe('paired source test product-reference contract', () => {
  let root = '';
  let workspace: Workspace;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-paired-test-'));
    workspace = new Workspace(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a TypeScript test that reimplements business behavior locally', async () => {
    const plan = contractPlan('typescript', 'tests/modules/renderer.test.ts');
    await workspace.writeFile(
      'tests/modules/renderer.test.ts',
      [
        'import { describe, expect, it } from "vitest";',
        'function render(value: string): string { return `# ${value}`; }',
        'describe("renderer", () => {',
        '  it("renders", () => expect(render("news")).toBe("# news"));',
        '});',
      ].join('\n'),
    );

    const result = await inspectPairedSourceTests(
      workspace,
      plan,
      plan.steps[0]!,
    );

    expect(result.ok).toBe(false);
    expect(result.invalid[0]).toContain('exercises 0/1 required');
  });

  it('accepts a TypeScript value import from the planned product module', async () => {
    const plan = contractPlan('typescript', 'tests/modules/renderer.test.ts');
    await workspace.writeFile(
      'tests/modules/renderer.test.ts',
      [
        'import { describe, expect, it } from "vitest";',
        'import { render } from "../../src/renderer/render.ts";',
        'describe("renderer", () => {',
        '  it("renders", () => expect(render("news")).toContain("news"));',
        '});',
      ].join('\n'),
    );

    const result = await inspectPairedSourceTests(
      workspace,
      plan,
      plan.steps[0]!,
    );

    expect(result.ok).toBe(true);
    expect(result.references['tests/modules/renderer.test.ts']).toEqual([
      'src/renderer/render.ts',
    ]);
  });

  it('does not treat a TypeScript type-only import as product execution', async () => {
    const plan = contractPlan('typescript', 'tests/modules/renderer.test.ts');
    await workspace.writeFile(
      'tests/modules/renderer.test.ts',
      [
        'import { describe, expect, it } from "vitest";',
        'import type { RenderInput } from "../../src/renderer/render.ts";',
        'describe("renderer", () => {',
        '  it("declares a shape", () => expect({ title: "news" } satisfies RenderInput).toBeDefined());',
        '});',
      ].join('\n'),
    );

    const result = await inspectPairedSourceTests(
      workspace,
      plan,
      plan.steps[0]!,
    );

    expect(result.ok).toBe(false);
  });

  it('rejects an unused TypeScript value import added only to satisfy the gate', async () => {
    const plan = contractPlan('typescript', 'tests/modules/renderer.test.ts');
    await workspace.writeFile(
      'tests/modules/renderer.test.ts',
      [
        'import { describe, expect, it } from "vitest";',
        'import { render } from "../../src/renderer/render.ts";',
        '// render is the planned public API, but this test still uses a local stand-in.',
        'const localRender = (value: string) => value;',
        'describe("renderer", () => {',
        '  it("renders", () => expect(localRender("news")).toBe("news"));',
        '});',
      ].join('\n'),
    );

    const result = await inspectPairedSourceTests(
      workspace,
      plan,
      plan.steps[0]!,
    );

    expect(result.ok).toBe(false);
  });

  it('accepts a functional test that executes a planned CLI entry', async () => {
    const plan = contractPlan(
      'typescript',
      'tests/functional/cli.test.ts',
      'REQUIREMENT_ANALYSIS',
    );
    await workspace.writeFile(
      'tests/functional/cli.test.ts',
      [
        'import { execFileSync } from "node:child_process";',
        'const entry = "src/renderer/render.ts";',
        'execFileSync("node", [entry, "--help"]);',
      ].join('\n'),
    );

    const result = await inspectPairedSourceTests(
      workspace,
      plan,
      plan.steps[0]!,
    );

    expect(result.ok).toBe(true);
  });

  it('rejects a requirement baseline that drifts from required field contracts', async () => {
    const plan = contractPlan(
      'typescript',
      'tests/functional/acceptance.test.ts',
      'REQUIREMENT_ANALYSIS',
    );
    plan.steps[0]!.outputs.unshift('docs/01-requirements.md');
    await workspace.writeFile('docs/01-requirements.md', [
      '| Field | Type | Required |',
      '| --- | --- | --- |',
      '| title | string | yes |',
      '| summary | string | yes |',
      '| heatIndex | number | yes |',
      '| category | string | yes |',
    ].join('\n'));
    await workspace.writeFile('tests/functional/acceptance.test.ts', [
      'import { render } from "../../src/renderer/render.ts";',
      'interface NewsItem { title: string; summary: string; heatScore: number; tags: string[] }',
      'it("renders", () => expect(render({ title: "news", summary: "brief", heatScore: 1, tags: [] })).toBeTruthy());',
    ].join('\n'));

    const result = await inspectPairedSourceTests(workspace, plan, plan.steps[0]!);

    expect(result.ok).toBe(false);
    expect(result.invalid.join('\n')).toContain('heatIndex, category');
    expect(result.invalid.join('\n')).toContain('redeclares the product contract locally (NewsItem)');
  });

  it('rejects direct awaited product access when the baseline promises controlled fixtures', async () => {
    const plan = contractPlan(
      'typescript',
      'tests/functional/acceptance.test.ts',
      'REQUIREMENT_ANALYSIS',
    );
    plan.steps[0]!.outputs.unshift('docs/tests/functional-test-plan.md');
    await workspace.writeFile(
      'docs/tests/functional-test-plan.md',
      '# Test plan\nAll external responses use controlled fixtures and mocks.\n',
    );
    await workspace.writeFile('tests/functional/acceptance.test.ts', [
      'import { fetchNews } from "../../src/renderer/render.ts";',
      'it("loads", async () => expect(await fetchNews()).toBeTruthy());',
    ].join('\n'));

    const direct = await inspectPairedSourceTests(workspace, plan, plan.steps[0]!);
    expect(direct.ok).toBe(false);
    expect(direct.invalid.join('\n')).toContain('without an executable isolation mechanism');

    await workspace.writeFile('tests/functional/acceptance.test.ts', [
      'import { vi } from "vitest";',
      'import { fetchNews } from "../../src/renderer/render.ts";',
      'vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));',
      'it("loads", async () => expect(await fetchNews()).toBeTruthy());',
    ].join('\n'));
    const controlled = await inspectPairedSourceTests(workspace, plan, plan.steps[0]!);
    expect(controlled.ok).toBe(true);
  });

  it('requires a detailed-design integration test to exercise two product sources', async () => {
    const plan = contractPlan(
      'typescript',
      'tests/integration/renderer-pipeline.test.ts',
      'DETAILED_DESIGN',
    );
    plan.architectureModules!.push({
      id: 'M002',
      name: 'Pipeline',
      responsibility: 'Pass normalized news records into the configured output renderer.',
      sourcePaths: ['src/pipeline/run.ts'],
      testPaths: ['tests/modules/pipeline.test.ts'],
      dependencies: ['M001'],
    });
    await workspace.writeFile(
      'tests/integration/renderer-pipeline.test.ts',
      [
        'import { render } from "../../src/renderer/render.ts";',
        'const localPipeline = (value: string) => render(value);',
        'test("pipeline", () => expect(localPipeline("news")).toContain("news"));',
      ].join('\n'),
    );
    const oneSided = await inspectPairedSourceTests(
      workspace,
      plan,
      plan.steps[0]!,
    );
    expect(oneSided.ok).toBe(false);
    expect(oneSided.invalid[0]).toContain('1/2 required');

    await workspace.writeFile(
      'tests/integration/renderer-pipeline.test.ts',
      [
        'import { render } from "../../src/renderer/render.ts";',
        'import { run } from "../../src/pipeline/run.ts";',
        'test("pipeline", () => expect(run(render, "news")).toContain("news"));',
      ].join('\n'),
    );
    const integrated = await inspectPairedSourceTests(
      workspace,
      plan,
      plan.steps[0]!,
    );
    expect(integrated.ok).toBe(true);
  });

  it('rejects integration tests that copy orchestration and failure policy around product calls', async () => {
    const plan = contractPlan(
      'typescript',
      'tests/integration/renderer-pipeline.test.ts',
      'DETAILED_DESIGN',
    );
    plan.architectureModules!.push({
      id: 'M002',
      name: 'Pipeline',
      responsibility: 'Coordinate collaborators and render the resulting records.',
      sourcePaths: ['src/pipeline/run.ts'],
      testPaths: ['tests/modules/pipeline.test.ts'],
      dependencies: ['M001'],
    });
    await workspace.writeFile(
      'tests/integration/renderer-pipeline.test.ts',
      [
        'import { render } from "../../src/renderer/render.ts";',
        'import { run } from "../../src/pipeline/run.ts";',
        'test("pipeline", async () => {',
        '  const values: string[] = [];',
        '  for (const input of ["news"]) {',
        '    try { values.push(await run(render, input)); } catch { /* copied fallback */ }',
        '  }',
        '  expect(values).toHaveLength(1);',
        '});',
      ].join('\n'),
    );

    const result = await inspectPairedSourceTests(workspace, plan, plan.steps[0]!);

    expect(result.ok).toBe(false);
    expect(result.invalid.join('\n')).toContain('duplicates orchestration/failure-handling');
  });

  it('accepts a Python import and rejects a local-only stand-in', async () => {
    const plan = contractPlan('python', 'tests/test_renderer.py');
    await workspace.writeFile(
      'tests/test_renderer.py',
      'from renderer.render import render\n\n\ndef test_render():\n    assert render("news")\n',
    );
    const imported = await inspectPairedSourceTests(
      workspace,
      plan,
      plan.steps[0]!,
    );
    expect(imported.ok).toBe(true);

    await workspace.writeFile(
      'tests/test_renderer.py',
      'def render(value):\n    return value\n\n\ndef test_render():\n    assert render("news")\n',
    );
    const localOnly = await inspectPairedSourceTests(
      workspace,
      plan,
      plan.steps[0]!,
    );
    expect(localOnly.ok).toBe(false);
  });

  it('routes one actionable finding without duplicating it as KPI and remediation gaps', () => {
    const merged = mergePairedSourceTestQuality(
      {
        completion: 1,
        upstreamAlignment: 1,
        metrics: {},
        tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
        evidence: [],
        gaps: [],
      },
      {
        ok: false,
        testPaths: ['tests/integration/pipeline.test.ts'],
        valid: [],
        invalid: ['tests/integration/pipeline.test.ts: exercises 0/2 required'],
        references: {},
      },
    );

    expect(merged.completion).toBe(1);
    expect(merged.gaps).toEqual([]);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings?.[0]?.summary).toContain('exercises 0/2 required');
    expect(merged.findings?.[0]?.evidence.join('\n'))
      .toContain('imports may target planned source paths that do not exist yet');
    expect(merged.findings?.[0]?.evidence.join('\n')).toContain('Do not create src/** stubs');
  });
});

function contractPlan(
  language: Language,
  testPath: string,
  phase: Step['phase'] = 'HIGH_LEVEL_DESIGN',
): Plan {
  const extension = language === 'typescript' ? 'ts' : 'py';
  const sourcePath = `src/renderer/render.${extension}`;
  const step: Step = {
    id: 'S001',
    iterationId: 'P1',
    phase,
    title: 'Define renderer contract',
    description: 'Define and test the renderer contract.',
    systemPrompt: 'Create the paired test for the declared renderer product module.',
    role: phase === 'REQUIREMENT_ANALYSIS' ? 'Planner' : 'Architect',
    tools: ['write_file'],
    inputs: [],
    outputs: [testPath],
    dependsOn: [],
    acceptance: 'The paired test exercises the product implementation.',
    maxAttempts: 3,
  };
  return {
    version: '1',
    language,
    intent: 'greenfield',
    projectType: 'application',
    createdAt: new Date().toISOString(),
    requirementDigest: 'renderer',
    globalPrompt: '',
    baselineSummary: '',
    userAddenda: '',
    dependencies: [],
    architectureModules: [{
      id: 'M001',
      name: 'Renderer',
      responsibility: 'Render normalized news records into the requested output format.',
      sourcePaths: [sourcePath],
      testPaths: [testPath],
      dependencies: [],
    }],
    complexityAssessment: {
      level: 'simple',
      rationale: 'Single product module.',
      splitRecommended: false,
      userForcedPhaseSplit: false,
    },
    implementationPhases: [{
      id: 'P1',
      title: 'Core',
      objective: 'Deliver renderer.',
      status: 'current',
      scope: ['renderer'],
      deliverables: [sourcePath],
      dependsOn: [],
    }],
    steps: [step],
  };
}
