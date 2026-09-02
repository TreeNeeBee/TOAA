import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../../workspace/workspace.js';
import { testPlanDocForIteration } from '../../core/docs.js';
import {
  V_MODEL_TEST_TO_SOURCE_PHASE,
  type Plan,
  type Step,
} from '../../core/plan.js';
import {
  inspectPairedSourceTests,
  type PairedSourceTestInspection,
} from '../../core/paired_test_contract.js';
import {
  pairedTestAssetPaths,
  verificationSupplementRoot,
  verificationSupplementUpwardPrefix,
} from '../../core/test_assets.js';
import {
  hasExecutableTestDeclaration,
  isTestFilePath,
  normalizeGitPath,
} from './v_model_policy.js';

export interface PairedTestAssetInspection {
  ok: boolean;
  testArgs: string[];
  supplementalTestArgs: string[];
  testPlanPath?: string;
  missing: string[];
  invalid: string[];
  /** Structured baseline evidence retained for deterministic Runtime KPI measurement. */
  sourceContracts: PairedSourceTestInspection[];
  failureLog: string;
}

/** Enforces baseline ownership while allowing isolated, verification-owned risk supplements. */
export class TestPhaseValidator {
  constructor(private readonly workspace: Workspace) {}

  testArgs(plan: Plan, step: Step): string[] {
    return pairedTestAssetPaths(plan.steps, step, plan.language)
      .map((testPath) => normalizeGitPath(testPath));
  }

  supplementalRoot(step: Step): string {
    return verificationSupplementRoot(step);
  }

  /** The frozen execution set: paired baseline plus this Step's own supplements. */
  async executableTestArgs(plan: Plan, step: Step): Promise<string[]> {
    return dedup([
      ...this.testArgs(plan, step),
      ...await this.supplementalTestArgs(plan, step),
    ]);
  }

  async inspect(plan: Plan, step: Step): Promise<PairedTestAssetInspection> {
    const testArgs = this.testArgs(plan, step);
    const supplementalTestArgs = await this.supplementalTestArgs(plan, step);
    const iterationId = step.iterationId ?? 'P1';
    const testPlanPath = testPlanDocForIteration(step.phase, iterationId);
    const expected = dedup([...(testPlanPath ? [testPlanPath] : []), ...testArgs]);
    const missing: string[] = [];
    const invalid: string[] = [];
    const sourceContracts: PairedSourceTestInspection[] = [];
    const supplementalRoot = this.supplementalRoot(step);
    const illegallyOwnedTests = step.outputs
      .map((output) => normalizeGitPath(output))
      .filter((output) => isTestFilePath(output) && !output.startsWith(supplementalRoot));

    if (testArgs.length === 0) invalid.push(`${step.phase} has no executable paired baseline test`);
    if (illegallyOwnedTests.length > 0) {
      invalid.push(
        `${step.phase} may own supplements only under ${supplementalRoot}: ` +
        illegallyOwnedTests.join(', '),
      );
    }
    for (const file of expected) {
      if (!(await this.workspace.exists(file))) {
        missing.push(file);
        continue;
      }
      const content = await this.workspace.readFile(file).catch(() => '');
      if (!content.trim()) invalid.push(`${file}: empty`);
      else if (isTestFilePath(file) && !hasExecutableTestDeclaration(content, plan.language)) {
        invalid.push(`${file}: no executable test case declaration found`);
      }
    }
    for (const file of supplementalTestArgs) {
      const content = await this.workspace.readFile(file).catch(() => '');
      if (!content.trim()) invalid.push(`${file}: empty supplemental test`);
      else if (!hasExecutableTestDeclaration(content, plan.language)) {
        invalid.push(`${file}: no executable supplemental test case declaration found`);
      }
    }
    const sourcePhase = V_MODEL_TEST_TO_SOURCE_PHASE[
      step.phase as keyof typeof V_MODEL_TEST_TO_SOURCE_PHASE
    ];
    for (const sourceStep of plan.steps.filter((candidate) =>
      (candidate.iterationId ?? 'P1') === iterationId && candidate.phase === sourcePhase
    )) {
      const sourceContract = await inspectPairedSourceTests(this.workspace, plan, sourceStep);
      sourceContracts.push(sourceContract);
      invalid.push(...sourceContract.invalid);
    }

    const ok = missing.length === 0 && invalid.length === 0;
    return {
      ok,
      testArgs,
      supplementalTestArgs,
      testPlanPath,
      missing,
      invalid,
      sourceContracts,
      failureLog: ok ? '' : [
        `${step.id} ${step.phase} delivery-gate entry inspection failed.`,
        `Paired source phase: ${sourcePhase}.`,
        testPlanPath ? `Required baseline test plan: ${testPlanPath}` : '',
        testArgs.length > 0 ? `Baseline tests: ${testArgs.join(', ')}` : '',
        supplementalTestArgs.length > 0
          ? `Existing verification supplements: ${supplementalTestArgs.join(', ')}`
          : '',
        `Supplement ownership root: ${supplementalRoot}`,
        `From that root the product is ${verificationSupplementUpwardPrefix(supplementalRoot)}src/… ` +
          '— use exactly that prefix rather than counting the directories, which is where a Step ' +
          'spent every one of its attempts while the cases around it passed.',
        missing.length > 0 ? `Missing: ${missing.join(', ')}` : '',
        invalid.length > 0 ? `Invalid: ${invalid.join(' | ')}` : '',
        'Route each baseline incompleteness finding to its paired source owner. A verifier may only ' +
          'repair its own supplemental tests under the supplement root.',
      ].filter(Boolean).join('\n'),
    };
  }

  private async supplementalTestArgs(plan: Plan, step: Step): Promise<string[]> {
    const root = this.supplementalRoot(step);
    const files: string[] = [];
    await walk(this.workspace.abs(root), root.replace(/\/$/u, ''), files);
    return files
      .map((file) => normalizeGitPath(file))
      .filter((file) => isTestFilePath(file))
      .filter((file) => plan.language === 'typescript' ? /\.(?:test|spec)\.tsx?$/u.test(file) : true)
      .sort();
  }
}

async function walk(abs: string, rel: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const childAbs = path.join(abs, entry.name);
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) await walk(childAbs, childRel, out);
    else out.push(childRel);
  }
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
