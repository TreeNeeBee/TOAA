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
      summary.total, summary.done, summary.pending, summary.failed, summary.running,
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
    chalk.cyan(step.id), chalk.yellow(step.phase), chalk.bold(step.title), statusBadge(step.status), step.retries, step.maxRetries,
  ));
  console.log(t().inspect.stepRoleTools(step.role, step.tools.join(', ')));
  if (step.dependsOn.length > 0) console.log(t().inspect.stepDependsOn(step.dependsOn.join(', ')));
  console.log('');
  console.log(chalk.gray(t().inspect.secDescription));
  console.log(step.description);
  console.log('');
  console.log(chalk.gray(t().inspect.secAcceptance));
  console.log(step.acceptance);
  console.log('');
  if ((step.subTasks?.length ?? 0) > 0) {
    console.log(chalk.gray(t().inspect.secSubtasks));
    for (const line of renderSubTasks(step.subTasks ?? [], 0)) console.log(line);
    console.log('');
  }
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

function statusBadge(status: InspectStep['status']): string {
  switch (status) {
    case 'DONE':
      return chalk.green('[DONE]');
    case 'FAILED':
      return chalk.red('[FAILED]');
    case 'RUNNING':
      return chalk.yellow('[RUNNING]');
    default:
      return chalk.gray('[PENDING]');
  }
}

function renderSubTasks(tasks: NonNullable<InspectStep['subTasks']>, depth: number): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  for (const task of tasks) {
    const outputs = task.outputs && task.outputs.length > 0 ? ` [${task.outputs.join(', ')}]` : '';
    lines.push(`${indent}- ${task.id}: ${task.title}${outputs}`);
    lines.push(`${indent}  ${task.description}`);
    if (task.acceptance) lines.push(`${indent}  acceptance: ${task.acceptance}`);
    if (task.subTasks && task.subTasks.length > 0) {
      lines.push(...renderSubTasks(task.subTasks, depth + 1));
    }
  }
  return lines;
}
