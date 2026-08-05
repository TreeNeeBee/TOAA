import type { Workspace } from '../../workspace/workspace.js';
import { testPlanDocForIteration } from '../../core/docs.js';
import {
  V_MODEL_TEST_TO_SOURCE_PHASE,
  type Plan,
  type Step,
} from '../../core/plan.js';
import { inspectPairedSourceTests } from '../../core/paired_test_contract.js';
import { pairedTestAssetPaths } from '../../core/test_assets.js';
import {
  hasExecutableTestDeclaration,
  isTestFilePath,
  normalizeGitPath,
} from './v_model_policy.js';

export interface PairedTestAssetInspection {
  ok: boolean;
  testArgs: string[];
  testPlanPath?: string;
  missing: string[];
  invalid: string[];
  failureLog: string;
}

export class TestPhaseValidator {
  constructor(private readonly workspace: Workspace) {}

  testArgs(plan: Plan, step: Step): string[] {
    return pairedTestAssetPaths(plan.steps, step, plan.language)
      .map((testPath) => normalizeGitPath(testPath));
  }

  async inspect(plan: Plan, step: Step): Promise<PairedTestAssetInspection> {
    const testArgs = this.testArgs(plan, step);
    const iterationId = step.iterationId ?? 'P1';
    const testPlanPath = testPlanDocForIteration(step.phase, iterationId);
    const expected = dedup([
      ...(testPlanPath ? [testPlanPath] : []),
      ...testArgs,
    ]);
    const missing: string[] = [];
    const invalid: string[] = [];
    const illegallyOwnedTests = step.outputs
      .map((output) => normalizeGitPath(output))
      .filter(isTestFilePath);

    if (testArgs.length === 0) {
      invalid.push(`${step.phase} has no executable paired test asset`);
    }
    if (illegallyOwnedTests.length > 0) {
      invalid.push(
        `${step.phase} is validation-only but declares executable test outputs: ${illegallyOwnedTests.join(', ')}`,
      );
    }
    for (const file of expected) {
      if (!(await this.workspace.exists(file))) {
        missing.push(file);
        continue;
      }
      const content = await this.workspace.readFile(file).catch(() => '');
      if (!content.trim()) {
        invalid.push(`${file}: empty`);
      } else if (
        isTestFilePath(file) &&
        !hasExecutableTestDeclaration(content, plan.language)
      ) {
        invalid.push(`${file}: no executable test case declaration found`);
      }
    }
    for (const sourceStep of plan.steps.filter((candidate) =>
      (candidate.iterationId ?? 'P1') === iterationId &&
      candidate.phase === V_MODEL_TEST_TO_SOURCE_PHASE[
        step.phase as keyof typeof V_MODEL_TEST_TO_SOURCE_PHASE
      ])) {
      const sourceContract = await inspectPairedSourceTests(
        this.workspace,
        plan,
        sourceStep,
      );
      invalid.push(...sourceContract.invalid);
    }

    const ok = missing.length === 0 && invalid.length === 0;
    return {
      ok,
      testArgs,
      testPlanPath,
      missing,
      invalid,
      failureLog: ok
        ? ''
        : [
            `${step.id} ${step.phase} paired test completeness gate failed.`,
            `Paired source phase: ${V_MODEL_TEST_TO_SOURCE_PHASE[
              step.phase as keyof typeof V_MODEL_TEST_TO_SOURCE_PHASE
            ]}.`,
            testPlanPath ? `Required test plan: ${testPlanPath}` : '',
            testArgs.length > 0 ? `Executable tests: ${testArgs.join(', ')}` : '',
            missing.length > 0 ? `Missing: ${missing.join(', ')}` : '',
            invalid.length > 0 ? `Invalid: ${invalid.join(' | ')}` : '',
            'Create a Bug Ticket and route it to the paired source phase; the validation phase must not create or rewrite tests.',
          ].filter(Boolean).join('\n'),
    };
  }

}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
