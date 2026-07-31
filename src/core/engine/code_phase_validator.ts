import type { AuditLogger } from '../../audit/audit.js';
import type { Sandbox } from '../../sandbox/types.js';
import type { ToolPermissionRequest } from '../../tools/index.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { LanguageProfile } from '../language.js';
import type { Plan, Step } from '../plan.js';
import {
  codeValidationCommand,
  hasCodeValidationPrerequisites,
  shouldRunCodeValidation,
} from './v_model_policy.js';

export type ExistingCodeValidationResult =
  | { status: 'passed'; reason: string; failureLog: string }
  | { status: 'failed'; reason: string; failureLog: string }
  | { status: 'denied'; reason: string; failureLog: string }
  | { status: 'skipped' };

export class CodePhaseValidator {
  constructor(
    private readonly workspace: Workspace,
    private readonly sandbox: Sandbox,
    private readonly audit: AuditLogger,
    private readonly requestPermission: (
      request: ToolPermissionRequest,
    ) => Promise<{ approved: boolean; reason?: string }>,
  ) {}

  async validateExisting(
    plan: Plan,
    step: Step,
    profile: LanguageProfile,
    isStepComplete: (candidate: Step) => boolean,
  ): Promise<ExistingCodeValidationResult> {
    if (
      step.phase !== 'CODE' ||
      !shouldRunCodeValidation(plan, step, isStepComplete) ||
      !(await hasCodeValidationPrerequisites(this.workspace, profile.id))
    ) {
      return { status: 'skipped' };
    }

    const command = codeValidationCommand(profile.id);
    const permission = await this.requestPermission({
      operationType: 'build_command',
      target: command.display,
      reason: 'Revalidate the current preserved CODE workspace before resuming a cached Debugger failure.',
      risk: 'This executes the language compiler in the configured project sandbox.',
      scope: 'current workspace sandbox',
      skippable: false,
      denyBehavior: 'Keep the CODE step failed because its current source state could not be revalidated.',
      stepId: step.id,
    });
    if (!permission.approved) {
      const reason = `permission denied for CODE revalidation ${step.id}`;
      return {
        status: 'denied',
        reason,
        failureLog: `${reason}${permission.reason ? `: ${permission.reason}` : ''}`,
      };
    }

    await this.audit.event('note', `running current CODE gate for ${step.id}`, {
      messageId: 'engine.code_revalidation_started',
      stepId: step.id,
      phase: step.phase,
      command: command.display,
    });
    const result = await this.sandbox.exec(command.cmd, command.args, {});
    if (result.exitCode !== 0 || result.timedOut) {
      const reason =
        `CODE revalidation failed: ${command.display} exit=${result.exitCode}` +
        (result.timedOut ? ' timedOut=true' : '');
      const failureLog = renderCodeValidationFailure(
        reason,
        command.display,
        result.stdout,
        result.stderr,
      );
      await this.audit.event('note', `current CODE gate failed for ${step.id}`, {
        messageId: 'engine.code_revalidation_failed',
        stepId: step.id,
        phase: step.phase,
        command: command.display,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      return { status: 'failed', reason, failureLog };
    }

    const reason = `CODE revalidation passed: ${command.display}`;
    await this.audit.event('note', `current CODE gate passed for ${step.id}`, {
      messageId: 'engine.code_revalidation_passed',
      stepId: step.id,
      phase: step.phase,
      command: command.display,
    });
    return {
      status: 'passed',
      reason,
      failureLog: `${reason}\nThe preserved source now passes the current static validation gate.`,
    };
  }
}

function renderCodeValidationFailure(
  reason: string,
  command: string,
  stdout: string,
  stderr: string,
): string {
  return [
    `Reason: ${reason}`,
    `Command: ${command}`,
    '--- stdout (last lines) ---',
    tailLines(stdout),
    '--- stderr (last lines) ---',
    tailLines(stderr),
  ].join('\n');
}

function tailLines(value: string, maxLines = 120): string {
  return value.split('\n').slice(-maxLines).join('\n');
}
