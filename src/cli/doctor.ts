import chalk from 'chalk';
import {
  XCompilerRuntime,
  type CheckLevel,
  type RuntimeDoctorOptions,
} from '../runtime.js';
import { t } from '../i18n/index.js';

export type DoctorCliOptions = RuntimeDoctorOptions;

/** CLI adapter for `xcompiler doctor`. */
export async function runDoctorCli(opts: DoctorCliOptions = {}): Promise<void> {
  const M = t().doctor;
  console.log(chalk.bold(M.header));
  const { report, exitCode } = await new XCompilerRuntime().doctor(opts);
  for (const sec of report.sections) {
    console.log('\n' + chalk.bold(sec.title));
    for (const it of sec.items) {
      console.log(`  ${icon(it.level)} ${it.message}`);
    }
  }
  console.log('');
  if (report.fails > 0) {
    console.log(chalk.red(`✖ ${M.summaryFail(report.fails)}`));
    process.exitCode = exitCode;
    return;
  }
  if (report.warns > 0) {
    console.log(chalk.yellow(`! ${M.summaryWarn(report.warns)}`));
    if (exitCode !== 0) process.exitCode = exitCode;
    return;
  }
  console.log(chalk.green(`✔ ${M.summaryOk}`));
}

function icon(level: CheckLevel): string {
  if (level === 'ok') return chalk.green('✔');
  if (level === 'warn') return chalk.yellow('!');
  return chalk.red('✖');
}
