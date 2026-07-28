import chalk from 'chalk';
import type { AuditLogger } from '../../audit/audit.js';
import { t } from '../../i18n/index.js';
import type { Sandbox } from '../../sandbox/types.js';
import type {
  ToolPermissionRequest,
} from '../../tools/index.js';
import type { Workspace } from '../../workspace/workspace.js';
import { testPlanDocForIteration } from '../docs.js';
import type { LanguageProfile } from '../language.js';
import {
  V_MODEL_TEST_PHASES,
  V_MODEL_TEST_TO_SOURCE_PHASE,
  type Plan,
  type Step,
} from '../plan.js';
import { pairedTestAssetPaths } from '../test_assets.js';
import {
  hasExecutableTestDeclaration,
  isTestFilePath,
  normalizeGitPath,
  renderIncompleteTestPhaseFailure,
  renderTestValidationFailure,
} from './v_model_policy.js';

export interface PairedTestAssetInspection {
  ok: boolean;
  testArgs: string[];
  testPlanPath?: string;
  missing: string[];
  invalid: string[];
  failureLog: string;
}

export type ExistingTestValidationResult =
  | { status: 'passed' }
  | { status: 'failed'; failureLog: string }
  | { status: 'incomplete'; failureLog: string; missingOutputs: string[] }
  | { status: 'denied'; failureLog: string };

export class TestPhaseValidator {
  constructor(
    private readonly workspace: Workspace,
    private readonly sandbox: Sandbox,
    private readonly audit: AuditLogger,
    private readonly requestPermission: (
      request: ToolPermissionRequest,
    ) => Promise<{ approved: boolean; reason?: string }>,
    private readonly log: (message: string) => void,
  ) {}

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

  async validateExisting(
    plan: Plan,
    step: Step,
    profile: LanguageProfile,
  ): Promise<ExistingTestValidationResult> {
    if (!isVModelTestPhase(step.phase)) {
      return {
        status: 'denied',
        failureLog:
          `${step.id} ${step.phase} is not a V-model test phase and cannot run test revalidation.`,
      };
    }
    const completeness = await this.inspect(plan, step);
    const testArgs = completeness.testArgs;
    if (!completeness.ok) {
      await this.audit.event(
        'note',
        `rollback validation found incomplete paired tests for ${step.id}`,
        {
          messageId: 'engine.rollback_validation_test_cases_incomplete',
          stepId: step.id,
          phase: step.phase,
          testPlanPath: completeness.testPlanPath,
          testArgs,
          missing: completeness.missing,
          invalid: completeness.invalid,
        },
      );
      return { status: 'failed', failureLog: completeness.failureLog };
    }
    const missing: string[] = [];
    for (const output of step.outputs) {
      if (!output.endsWith('/') && !(await this.workspace.exists(output))) {
        missing.push(output);
      }
    }
    const missingTestOutputs = missing
      .map((output) => normalizeGitPath(output))
      .filter(isTestFilePath);
    if (missing.length > 0) {
      await this.audit.event(
        'note',
        `rollback validation found missing outputs for ${step.id}: ${missing.join(', ')}`,
        {
          messageId: 'engine.rollback_validation_missing_outputs',
          stepId: step.id,
          phase: step.phase,
          missing,
          missingTestOutputs,
          testGateRunnable: missingTestOutputs.length === 0,
        },
      );
      if (missingTestOutputs.length > 0) {
        const failureLog = renderIncompleteTestPhaseFailure(step, missing);
        this.log(chalk.yellow(t().engine.cachedTestArtifactsIncomplete(step.id, missing)));
        return { status: 'incomplete', failureLog, missingOutputs: missing };
      }
    }

    await profile.ensureTestBootstrap?.(this.workspace, this.audit);
    await profile.autoFixImports?.(this.workspace, this.audit);
    const testPermission = await this.requestPermission({
      operationType: 'test_command',
      target: `${profile.id} rollback validation for ${step.id}`,
      reason: 'Validate the repaired test phase outputs before regenerating them.',
      risk: 'Project test commands execute code in the configured sandbox.',
      scope: 'current workspace sandbox',
      skippable: true,
      denyBehavior: 'Regenerate the test phase through the normal V-model step.',
      stepId: step.id,
    });
    if (!testPermission.approved) {
      await this.audit.event('note', `rollback validation denied for ${step.id}`, {
        messageId: 'engine.rollback_validation_denied',
        stepId: step.id,
        phase: step.phase,
        reason: testPermission.reason,
      });
      return {
        status: 'denied',
        failureLog:
          `permission denied for test revalidation ${step.id}` +
          (testPermission.reason ? `: ${testPermission.reason}` : ''),
      };
    }

    this.log(chalk.gray(t().engine.cachedTestGateStart(step.id, testArgs)));
    await this.audit.event('note', `running current test gate for ${step.id}`, {
      messageId: 'engine.rollback_validation_started',
      stepId: step.id,
      phase: step.phase,
      testArgs,
      missingNonTestOutputs: missing,
    });
    const tests = await this.sandbox.runTests(testArgs, {});
    if (tests.exitCode !== 0 || tests.timedOut) {
      this.log(
        chalk.red(
          t().engine.cachedTestGateFailed(step.id, tests.exitCode, !!tests.timedOut),
        ),
      );
      await this.audit.event('note', `rollback validation failed for ${step.id}`, {
        messageId: 'engine.rollback_validation_failed',
        stepId: step.id,
        phase: step.phase,
        testArgs,
        exitCode: tests.exitCode,
        timedOut: tests.timedOut,
        stdout: tests.stdout,
        stderr: tests.stderr,
      });
      return {
        status: 'failed',
        failureLog: renderTestValidationFailure(step, testArgs, tests),
      };
    }
    this.log(chalk.green(t().engine.cachedTestGatePassed(step.id)));

    if (step.phase === 'FUNCTIONAL_TEST') {
      const functionalResult = await this.validateFunctionalProbe(step, profile);
      if (functionalResult) return functionalResult;
    }
    if (missing.length > 0) {
      const failureLog = renderIncompleteTestPhaseFailure(step, missing);
      this.log(chalk.yellow(t().engine.cachedTestArtifactsIncomplete(step.id, missing)));
      await this.audit.event(
        'note',
        `current test gate passed but ${step.id} outputs are incomplete`,
        {
          messageId: 'engine.rollback_validation_incomplete_outputs',
          stepId: step.id,
          phase: step.phase,
          testArgs,
          missing,
        },
      );
      return { status: 'incomplete', failureLog, missingOutputs: missing };
    }
    return { status: 'passed' };
  }

  private async validateFunctionalProbe(
    step: Step,
    profile: LanguageProfile,
  ): Promise<ExistingTestValidationResult | undefined> {
    const permission = await this.requestPermission({
      operationType: 'shell_command',
      target: `${profile.id} rollback functional probe for ${step.id}`,
      reason: 'Validate the generated project entrypoint after rollback repair.',
      risk: 'This executes project code in the configured sandbox.',
      scope: 'current workspace sandbox',
      skippable: true,
      denyBehavior: 'Regenerate the functional test phase through the normal V-model step.',
      stepId: step.id,
    });
    if (!permission.approved) {
      await this.audit.event('note', `rollback functional probe denied for ${step.id}`, {
        messageId: 'engine.rollback_functional_probe_denied',
        stepId: step.id,
        phase: step.phase,
        reason: permission.reason,
      });
      return {
        status: 'denied',
        failureLog:
          `permission denied for functional probe revalidation ${step.id}` +
          (permission.reason ? `: ${permission.reason}` : ''),
      };
    }
    const probe = await profile.probeEntry(this.workspace, this.sandbox);
    if (probe.ok) return undefined;
    await this.audit.event('note', `rollback functional probe failed for ${step.id}`, {
      messageId: 'engine.rollback_functional_probe_failed',
      stepId: step.id,
      phase: step.phase,
      command: probe.command,
      exitCode: probe.exitCode,
      timedOut: probe.timedOut,
      stdoutTail: probe.stdoutTail,
      stderrTail: probe.stderrTail,
    });
    return {
      status: 'failed',
      failureLog: [
        `${step.phase} cached validation entrypoint probe failed for ${step.id}.`,
        `command: ${probe.command}`,
        `exit=${probe.exitCode} timedOut=${probe.timedOut}`,
        probe.stdoutTail ? `stdout:\n${probe.stdoutTail}` : '',
        probe.stderrTail ? `stderr:\n${probe.stderrTail}` : '',
      ].filter(Boolean).join('\n'),
    };
  }
}

function isVModelTestPhase(
  phase: Step['phase'],
): phase is (typeof V_MODEL_TEST_PHASES)[number] {
  return (V_MODEL_TEST_PHASES as readonly string[]).includes(phase);
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
