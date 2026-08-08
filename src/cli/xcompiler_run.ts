import { Command } from 'commander';
import { XCOMPILER_VERSION, XCompilerRuntime, type ExecuteResult } from '../runtime.js';
import { setLocale, t } from '../i18n/index.js';
import { configureLocalizedHelp, localeFromArgv, parseLocale, parseRecordReplayMode } from './arguments.js';
import { xcEnv } from '../config/env.js';
import { createCliRuntimeIO, createNonInteractiveCliRuntimeIO } from './runtime_adapter.js';

setLocale(localeFromArgv(process.argv) ?? xcEnv('LANG') ?? 'en');
const runtime = new XCompilerRuntime({ io: createCliRuntimeIO() });

const program = new Command();
configureLocalizedHelp(program);
program
  .name('xcompiler_run')
  .description(t().cli.runDescription)
  .version(XCOMPILER_VERSION, '-V, --version', t().cli.versionOption)
  .option('--lang <code>', t().cli.optLang, parseLocale)
  .hook('preAction', (cmd) => { const l = cmd.opts().lang as string | undefined; if (l) setLocale(l); })
  .argument('[plan]', t().cli.argPlan)
  .option('-o, --output <dir>', t().cli.optOutput)
  .option('-w, --workspace <dir>', t().cli.optWorkspace)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('--dry-run', t().cli.optDryRun, false)
  .option('--force', t().cli.optForce, false)
  .option('--project-file <file>', t().cli.optProjectFile)
  .option('--debug-wiki-path <dir>', t().cli.optDebugWikiPath)
  .option('--record-replay <mode>', t().cli.optRecordReplay, parseRecordReplayMode)
  .option('--record-replay-path <dir>', t().cli.optRecordReplayPath)
  .action(async (planArg, opts) => {
    const result = await runtime.runCommand({
      // Execution asks nothing: the human gates all live in `build`.
      io: createNonInteractiveCliRuntimeIO(),
      planArg,
      output: opts.output,
      workspace: opts.workspace,
      configPath: opts.config,
      dryRun: !!opts.dryRun,
      force: !!opts.force,
      projectFilePath: opts.projectFile,
      debugWikiPath: opts.debugWikiPath,
      recordReplayMode: opts.recordReplay,
      recordReplayPath: opts.recordReplayPath,
      cwd: process.cwd(),
    });
    applyExecuteExitCode(result);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(t().system.unhandledError(err?.message ?? String(err)));
  process.exit(1);
});

function applyExecuteExitCode(result: ExecuteResult): void {
  const exitCode =
    typeof result.exitCode === 'number'
      ? result.exitCode
      : result.status === 'failed'
        ? 4
        : result.status === 'error'
          ? 5
          : 0;
  if (exitCode !== 0) process.exitCode = exitCode;
}
