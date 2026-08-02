import chalk from 'chalk';
import {
  runLsCommand,
  runShowCommand,
  type InspectStep,
  type LsOptions,
  type ShowOptions,
} from '../runtime/inspect.js';
import { t } from '../i18n/index.js';

export type { LsOptions, ShowOptions };

/** `xcompiler ls` CLI adapter. */
export async function runLs(opts: LsOptions): Promise<void> {
  const result = await runLsCommand(opts);
  if (result.plans.length === 0) {
    console.log(chalk.yellow(t().inspect.noPlanFound));
    return;
  }
  for (const plan of result.plans) {
    if (plan.error) {
      console.log(chalk.red('✖'), t().inspect.planReadFailed(plan.relativePath || plan.path, plan.error));
      continue;
    }
    const summary = plan.summary;
    if (!summary) continue;
    console.log(
      chalk.green('●'),
      t().inspect.planHeader(chalk.cyan(plan.relativePath || plan.path), plan.language ?? ''),
    );
    console.log('  ' + t().inspect.planStatusSummary(
      summary.total, summary.done, summary.ready, summary.blocked, summary.running,
    ));
    if (plan.requirementDigestLine) {
      console.log(`   ${chalk.gray(t().inspect.digestLabel)} ${plan.requirementDigestLine}`);
    }
  }
}

/** `xcompiler show <stepId>` CLI adapter. */
export async function runShow(opts: ShowOptions): Promise<void> {
  const result = await runShowCommand(opts);
  const step = result.step;
  if (!step) {
    console.error(chalk.red(t().inspect.stepNotFound(opts.stepId)));
    process.exitCode = result.exitCode;
    return;
  }

  console.log(t().inspect.stepHeader(
    chalk.cyan(`${step.name} (${step.id})`), chalk.yellow(step.type), chalk.bold(step.title), statusBadge(step.state), step.attempts, step.maxAttempts,
  ));
  console.log(t().inspect.stepRoleTools(step.role, step.tools.join(', ')));
  if (step.dependencyStepIds.length > 0) console.log(t().inspect.stepDependsOn(step.dependencyStepIds.join(', ')));
  console.log('');
  console.log(chalk.gray(t().inspect.secDescription));
  console.log(step.description);
  console.log('');
  console.log(chalk.gray(t().inspect.secAcceptance));
  console.log(step.acceptance.join('\n'));
  console.log(chalk.gray(t().inspect.secSystemPrompt));
  console.log(step.systemPrompt);
  console.log('');

  console.log(chalk.gray(t().inspect.secOutputs));
  for (const out of result.outputs) {
    console.log('  ' + t().inspect.outputStatus(out.exists, out.path));
  }
  console.log('');

  console.log(chalk.gray(t().inspect.secRecentAudit(result.auditEvents.length)));
  for (const ev of result.auditEvents) {
    console.log('  ' + t().inspect.auditEntry(ev.ts, chalk.cyan(ev.kind), ev.msg ?? ''));
  }
}

function statusBadge(status: InspectStep['state']): string {
  switch (status) {
    case 'closed':
    case 'delivered':
      return chalk.green(`[${status.toUpperCase()}]`);
    case 'pending':
      return chalk.red('[PENDING]');
    case 'in_progress':
      return chalk.yellow('[IN PROGRESS]');
    default:
      return chalk.gray(`[${status.toUpperCase()}]`);
  }
}
