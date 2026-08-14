import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestPhaseValidator } from '../src/application/execution/test_phase_validator.js';
import type { Plan, Step } from '../src/core/plan.js';
import { Workspace } from '../src/workspace/workspace.js';
import {
  verificationSupplementRoot,
  verificationSupplementUpwardPrefix,
} from '../src/core/test_assets.js';

/** Hybrid ownership: S1-S4 author baselines; S5-S8 may add isolated risk supplements and run all. */
describe('external boundary contract per V-model level', () => {
  let root = '';
  let workspace: Workspace;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-external-boundary-'));
    workspace = new Workspace(root);
    await workspace.writeFile('src/scrapers/baidu.ts', [
      'export async function scrape() {',
      '  const response = await fetch("https://top.baidu.com/board?tab=realtime");',
      '  return parseHTML(await response.text());',
      '}',
      'export function parseHTML(html: string) { return []; }',
    ].join('\n'));
    await workspace.writeFile('docs/tests/unit-test-plan.md', '# unit test plan\n');
    await workspace.writeFile('docs/tests/functional-test-plan.md', '# functional test plan\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('accepts a mocked UNIT_TEST authored by CODE', async () => {
    await workspace.writeFile('tests/unit/scrapers.test.ts', [
      'import { describe, expect, it } from "vitest";',
      'import { parseHTML } from "../../src/scrapers/baidu.ts";',
      'describe("baidu", () => {',
      '  it("parses", () => {',
      '    const html = \'<a class="title" href="/i">title</a>\';',
      '    expect(parseHTML(html).length).toBe(1);',
      '  });',
      '});',
    ].join('\n'));

    const result = await new TestPhaseValidator(workspace)
      .inspect(networkPlan('UNIT_TEST', 'tests/unit/scrapers.test.ts'), stepFor('UNIT_TEST'));

    expect(result.ok).toBe(true);
  });

  it('accepts a UNIT_TEST that replays a captured response', async () => {
    await workspace.writeFile('tests/fixtures/network/baidu.html', '<html>real page</html>\n');
    await workspace.writeFile('tests/unit/scrapers.test.ts', [
      'import { readFileSync } from "node:fs";',
      'import { describe, expect, it } from "vitest";',
      'import { parseHTML } from "../../src/scrapers/baidu.ts";',
      'const html = readFileSync("tests/fixtures/network/baidu.html", "utf8");',
      'describe("baidu", () => {',
      '  it("parses the captured page", () => expect(parseHTML(html).length).toBeGreaterThan(0));',
      '});',
    ].join('\n'));

    const result = await new TestPhaseValidator(workspace)
      .inspect(networkPlan('UNIT_TEST', 'tests/unit/scrapers.test.ts'), stepFor('UNIT_TEST'));

    expect(result.invalid.join(' ')).not.toContain('captured from the');
  });

  it('accepts a captured response loaded by import, not only by reading the file', async () => {
    await workspace.writeFile('tests/fixtures/network/baidu.html', '<html>real page</html>\n');
    await workspace.writeFile('tests/unit/scrapers.test.ts', [
      'import html from "../fixtures/network/baidu.html?raw";',
      'import { describe, expect, it } from "vitest";',
      'import { parseHTML } from "../../src/scrapers/baidu.ts";',
      'describe("baidu", () => {',
      '  it("parses the captured page", () => expect(parseHTML(html).length).toBeGreaterThan(0));',
      '});',
    ].join('\n'));

    const result = await new TestPhaseValidator(workspace)
      .inspect(networkPlan('UNIT_TEST', 'tests/unit/scrapers.test.ts'), stepFor('UNIT_TEST'));

    expect(result.invalid.join(' ')).not.toContain('captured from the');
  });

  it('consumes the REQUIREMENT_ANALYSIS baseline suite in S008', async () => {
    await workspace.writeFile('tests/functional/cli.test.ts', [
      'import { describe, expect, it, vi } from "vitest";',
      'import { scrape } from "../../src/scrapers/baidu.ts";',
      'vi.stubGlobal("fetch", vi.fn());',
      'describe("cli", () => { it("runs", () => expect(scrape).toBeTypeOf("function")); });',
    ].join('\n'));

    const result = await new TestPhaseValidator(workspace)
      .inspect(networkPlan('FUNCTIONAL_TEST', 'tests/functional/cli.test.ts'), stepFor('FUNCTIONAL_TEST'));

    expect(result.ok).toBe(true);
    expect(result.testArgs).toEqual(['tests/functional/cli.test.ts']);
  });

  it('lets the source phase capture fixtures while keeping verification read-only', async () => {
    const { computeStepAllowedWrites } = await import('../src/application/execution/execution_context.js');
    const { pairedTestAssetPaths } = await import('../src/core/test_assets.js');
    const plan = networkPlan('UNIT_TEST', 'tests/unit/scrapers.test.ts');
    const unit = plan.steps.find((candidate) => candidate.phase === 'UNIT_TEST')!;

    // The exact paired suite a UNIT_TEST runs is owned by CODE.
    expect(pairedTestAssetPaths(plan.steps, unit, plan.language)).toContain('tests/unit/scrapers.test.ts');
    // And whoever owns paired tests may store the responses those tests replay.
    const code = plan.steps.find((candidate) => candidate.phase === 'CODE')!;
    expect(computeStepAllowedWrites(code)).toContain('tests/fixtures/network/');
  });

  it('still refuses a verification level that claims a test the paired phase does not own', async () => {
    await workspace.writeFile('tests/unit/scrapers.test.ts', [
      'import { readFileSync } from "node:fs";',
      'import { describe, expect, it } from "vitest";',
      'import { parseHTML } from "../../src/scrapers/baidu.ts";',
      'const html = readFileSync("tests/fixtures/network/baidu.html", "utf8");',
      'describe("baidu", () => { it("parses", () => expect(parseHTML(html)).toBeDefined()); });',
    ].join('\n'));
    await workspace.writeFile('tests/fixtures/network/baidu.html', '<html>real</html>\n');
    const plan = networkPlan('UNIT_TEST', 'tests/unit/scrapers.test.ts');
    const unit = { ...plan.steps.find((c) => c.phase === 'UNIT_TEST')!, outputs: ['tests/unit/invented.test.ts'] };

    const result = await new TestPhaseValidator(workspace).inspect(plan, unit);

    expect(result.invalid.join(' ')).toContain('may own supplements only under');
  });

  it('leaves a project that reaches nothing external alone', async () => {
    await workspace.writeFile('src/scrapers/baidu.ts', 'export function parseHTML() { return []; }\n');
    await workspace.writeFile('tests/unit/scrapers.test.ts', [
      'import { describe, expect, it } from "vitest";',
      'import { parseHTML } from "../../src/scrapers/baidu.ts";',
      'describe("baidu", () => { it("parses", () => expect(parseHTML()).toEqual([])); });',
    ].join('\n'));

    const result = await new TestPhaseValidator(workspace)
      .inspect(networkPlan('UNIT_TEST', 'tests/unit/scrapers.test.ts'), stepFor('UNIT_TEST'));

    expect(result.invalid.join(' ')).not.toContain('captured from the');
  });

  it('runs paired baselines plus isolated supplements and ignores undeclared siblings', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    await workspace.writeFile('tests/modules/scrapers.test.ts', 'declared\n');
    await workspace.writeFile('tests/modules/scrapers-live.test.ts', 'supplement\n');
    await workspace.writeFile(
      'tests/verification/p1/module-test/s007/network-risk.test.ts',
      'isolated supplement\n',
    );
    let ran: string[] = [];

    await runTestsTool.run({}, {
      ws: workspace,
      language: 'typescript',
      testGateArgs: ['tests/modules/scrapers.test.ts', '--coverage'],
      supplementalTestRoot: 'tests/verification/p1/module-test/s007/',
      sandbox: {
        runTests: async (a: string[]) => {
          ran = a;
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
      },
    } as never);

    expect(ran).toContain('tests/modules/scrapers.test.ts');
    expect(ran).toContain('tests/verification/p1/module-test/s007/network-risk.test.ts');
    expect(ran).not.toContain('tests/modules/scrapers-live.test.ts');
    // Flags are passed through, not treated as paths.
    expect(ran).toContain('--coverage');
  });

  // The root nests an iteration, a phase, and a Step id, so a supplement sits five directories down
  // with a UUID in the middle. A live UNIT_TEST spent all seven of its attempts writing
  // `../../../../src/...` — one level short — while every baseline case around it passed.
  it('names the prefix back to the product rather than leaving the depth to be counted', () => {
    const supplementRoot = verificationSupplementRoot({
      id: '019ff13f-d607-7bcc-a4c1-7a9563cd50c1',
      iterationId: 'P1',
      phase: 'UNIT_TEST',
    } as never);
    expect(supplementRoot).toBe('tests/verification/p1/unit-test/019ff13f-d607-7bcc-a4c1-7a9563cd50c1/');

    const prefix = verificationSupplementUpwardPrefix(supplementRoot);
    // The invariant that broke: the root followed by the prefix has to land back at the repository
    // root, whatever the segments happen to be.
    expect(path.posix.normalize(`${supplementRoot}${prefix}src/aggregator/merge.ts`))
      .toBe('src/aggregator/merge.ts');
  });
});

function stepFor(phase: Step['phase']): Step {
  return {
    id: phase === 'UNIT_TEST' ? 'S005' : 'S008',
    iterationId: 'P1',
    phase,
    title: phase,
    description: phase,
    systemPrompt: `Validate the paired ${phase} assets.`,
    role: 'Tester',
    tools: ['run_tests'],
    inputs: [],
    outputs: [],
    dependsOn: [],
    acceptance: 'Paired tests pass.',
    maxAttempts: 3,
  };
}

function networkPlan(phase: Step['phase'], testPath: string): Plan {
  const code: Step = {
    id: 'S004',
    iterationId: 'P1',
    phase: 'CODE',
    title: 'Implement the scrapers',
    description: 'Implement the scrapers.',
    systemPrompt: 'Implement the declared modules.',
    role: 'Coder',
    tools: ['write_file'],
    inputs: [],
    outputs: ['src/scrapers/baidu.ts', ...(phase === 'UNIT_TEST' ? [testPath] : [])],
    dependsOn: [],
    acceptance: 'The scrapers are implemented.',
    maxAttempts: 3,
  };
  return {
    version: '1',
    language: 'typescript',
    intent: 'greenfield',
    projectType: 'application',
    createdAt: new Date().toISOString(),
    requirementDigest: 'news',
    globalPrompt: '',
    baselineSummary: '',
    userAddenda: '',
    dependencies: [],
    architectureModules: [{
      id: 'M001',
      name: 'Scrapers',
      responsibility: 'Fetch and parse the upstream hot-search pages.',
      sourcePaths: ['src/scrapers/baidu.ts'],
      testPaths: [testPath],
      dependencies: [],
    }],
    steps: [
      // S001 owns the functional baseline; S008 independently accepts it with deterministic data.
      ...(phase === 'FUNCTIONAL_TEST' ? [{
        ...code,
        id: 'S001',
        phase: 'REQUIREMENT_ANALYSIS' as const,
        role: 'Planner',
        outputs: ['docs/01-requirement-analysis.md', testPath],
      }] : []),
      code,
      stepFor(phase),
    ],
  } as unknown as Plan;
}

// Naming the prefix in the delivery-gate entry inspection was not enough: a Step that writes a
// supplement never sees that message, it sees the test-gate failure. Two live runs burned every
// attempt a Ticket had on `../../../src/...` against a root needing `../../../../../`, with every
// baseline case beside it passing.
describe('executable test gate failure', () => {
  it('names the prefix a supplement needs, on the message the authoring Step actually reads', async () => {
    const { validationDefectFromTestFailure } = await import('../src/agents/executor.js');
    const supplement =
      'tests/verification/p1/unit-test/019ff69f-3feb-7f66-942b-fcf6188d6af5/supplement.test.ts';

    const defect = validationDefectFromTestFailure(
      'UNIT_TEST',
      { ok: false, error: 'Failed to load url ../../../src/scrapers/baidu.ts', tool: 'run_tests' },
      ['tests/unit/scrapers.test.ts', supplement],
    );

    expect(defect).toContain('../../../../../src/');
    // A run whose cases are all baselines has no supplement to explain.
    expect(validationDefectFromTestFailure(
      'UNIT_TEST',
      { ok: false, error: 'assertion failed', tool: 'run_tests' },
      ['tests/unit/scrapers.test.ts'],
    )).not.toContain('reach the product with');
  });
});
