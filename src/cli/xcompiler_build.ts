import { Command } from 'commander';
import { CompileExitError, XCOMPILER_VERSION, XCompilerRuntime } from '../runtime.js';
import { setLocale, t } from '../i18n/index.js';
import {
  configureLocalizedHelp,
  localeFromArgv,
  parseIntent,
  parseLocale,
  parseRecordReplayMode,
} from './arguments.js';
import { xcEnv } from '../config/env.js';
import { createCliRuntimeIO } from './runtime_adapter.js';

setLocale(localeFromArgv(process.argv) ?? xcEnv('LANG') ?? 'en');
const defaultBaseDir = xcEnv('DEFAULT_BASE_DIR') ?? '/tmp';
const runtime = new XCompilerRuntime({ io: createCliRuntimeIO() });

const program = new Command();
configureLocalizedHelp(program);
program
  .name('xcompiler_build')
  .description(t().cli.compileDescription)
  .version(XCOMPILER_VERSION, '-V, --version', t().cli.versionOption)
  .option('--lang <code>', t().cli.optLang, parseLocale)
  .hook('preAction', (cmd) => { const l = cmd.opts().lang as string | undefined; if (l) setLocale(l); })
  .option('-o, --output <dir>', t().cli.optOutput)
  .option('-w, --workspace <dir>', t().cli.optWorkspace)
  .option('--base-dir <dir>', t().cli.optBaseDir, defaultBaseDir)
  .option('--name <name>', t().cli.optName)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('-i, --input <file>', t().cli.optInput)
  .option('-t, --topic <file>', t().cli.optTopic)
  .option('--intent <kind>', t().cli.optIntent, parseIntent, 'greenfield')
  .option('--baseline-plan <file>', t().cli.optBaselinePlan)
  .option('--plan-out <file>', t().cli.optPlanOut)
  .option('--project-file <file>', t().cli.optProjectFile)
  .option('--record-replay <mode>', t().cli.optRecordReplay, parseRecordReplayMode)
  .option('--record-replay-path <dir>', t().cli.optRecordReplayPath)
  .option('--yes', t().cli.optYes, false)
  .option('--force', t().cli.optForce, false)
  .action(async (opts) => {
    await runtime.buildCommand({
      output: opts.output,
      workspace: opts.workspace,
      baseDir: opts.baseDir,
      name: opts.name,
      configPath: opts.config,
      inputFile: opts.input,
      topicFile: opts.topic,
      intent: opts.intent,
      baselinePlanFile: opts.baselinePlan,
      outputFile: opts.planOut,
      projectFilePath: opts.projectFile,
      projectCommand: 'build',
      recordReplayMode: opts.recordReplay,
      recordReplayPath: opts.recordReplayPath,
      yes: !!opts.yes && (!!opts.input || !!opts.topic),
      force: !!opts.force,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof CompileExitError) {
    process.exitCode = err.exitCode;
    return;
  }
  console.error(t().system.unhandledError(err?.message ?? String(err)));
  process.exitCode = 1;
});
