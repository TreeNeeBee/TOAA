import { Command } from 'commander';
import {
  CompileExitError,
  XCOMPILER_VERSION,
  XCompilerRuntime,
  type ExecuteResult,
} from '../runtime.js';
import { runLs, runShow } from './inspect.js';
import { runDoctorCli } from './doctor.js';
import { setLocale, t } from '../i18n/index.js';
import { xcEnv } from '../config/env.js';
import { createCliRuntimeIO, isCliCancellation, runCliAbortable } from './runtime_adapter.js';
import { runAcpStdioServer } from '../acp/index.js';
import {
  localeFromArgv,
  configureLocalizedHelp,
  parseIntent,
  parseFixtureAction,
  parseLocale,
  parseNonNegativeInteger,
  parseRecordReplayMode,
  parseStepId,
} from './arguments.js';

// Resolve UI locale early — env var XC_LANG and the global --lang flag both work.
// CLI flag wins (parsed below by Commander preAction).
setLocale(localeFromArgv(process.argv) ?? xcEnv('LANG') ?? 'en');
const defaultBaseDir = xcEnv('DEFAULT_BASE_DIR') ?? '/tmp';
const runtime = new XCompilerRuntime({ io: createCliRuntimeIO() });

const program = new Command();
configureLocalizedHelp(program);
program
  .name('xcompiler')
  .description(t().cli.rootDescription)
  .option('--lang <code>', t().cli.optLang, parseLocale)
  .hook('preAction', (thisCmd) => {
    const lang = thisCmd.opts().lang as string | undefined;
    if (lang) setLocale(lang);
  })
  .version(XCOMPILER_VERSION, '-V, --version', t().cli.versionOption);
program.addHelpCommand('help [command]', t().cli.helpOption);

program
  .command('build')
  .alias('compile')
  .description(t().cli.compileDescription)
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

program
  .command('evolve')
  .description(t().cli.evolveDescription)
  .option('-o, --output <dir>', t().cli.optOutput)
  .option('-w, --workspace <dir>', t().cli.optWorkspace)
  .option('--base-dir <dir>', t().cli.optBaseDir, defaultBaseDir)
  .option('--name <name>', t().cli.optName)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('-i, --input <file>', t().cli.optInput)
  .option('-t, --topic <file>', t().cli.optTopic)
  .option('--intent <kind>', t().cli.optIntent, parseIntent, 'feature')
  .option('--baseline-plan <file>', t().cli.optBaselinePlan)
  .option('--plan-out <file>', t().cli.optPlanOut)
  .option('--project-file <file>', t().cli.optProjectFile)
  .option('--debug-wiki-path <dir>', t().cli.optDebugWikiPath)
  .option('--record-replay <mode>', t().cli.optRecordReplay, parseRecordReplayMode)
  .option('--record-replay-path <dir>', t().cli.optRecordReplayPath)
  .option('--yes', t().cli.optYes, false)
  .option('--force', t().cli.optForce, false)
  .action(async (opts) => {
    const result = await runtime.evolveCommand({
      output: opts.output,
      workspace: opts.workspace,
      baseDir: opts.baseDir,
      name: opts.name,
      configPath: opts.config,
      inputFile: opts.input,
      topicFile: opts.topic,
      intent: opts.intent,
      baselinePlanFile: opts.baselinePlan,
      planOut: opts.planOut,
      projectFilePath: opts.projectFile,
      debugWikiPath: opts.debugWikiPath,
      recordReplayMode: opts.recordReplay,
      recordReplayPath: opts.recordReplayPath,
      yes: !!opts.yes && (!!opts.input || !!opts.topic),
      force: !!opts.force,
      cwd: process.cwd(),
    });
    applyExecuteExitCode(result.execution);
  });

program
  .command('load')
  .description(t().cli.loadDescription)
  .argument('<project>', t().cli.argProjectFile)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('--dry-run', t().cli.optDryRun, false)
  .option('--force', t().cli.optForce, false)
  .option('--debug-wiki-path <dir>', t().cli.optDebugWikiPath)
  .option('--record-replay <mode>', t().cli.optRecordReplay, parseRecordReplayMode)
  .option('--record-replay-path <dir>', t().cli.optRecordReplayPath)
  .action(async (projectArg, opts) => {
    const result = await runtime.loadCommand({
      io: createCliRuntimeIO(),
      projectFile: projectArg,
      configPath: opts.config,
      dryRun: !!opts.dryRun,
      force: !!opts.force,
      debugWikiPath: opts.debugWikiPath,
      recordReplayMode: opts.recordReplay,
      recordReplayPath: opts.recordReplayPath,
    });
    applyExecuteExitCode(result);
  });

program
  .command('append')
  .description(t().cli.appendDescription)
  .argument('<project>', t().cli.argProjectFile)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('-i, --input <file>', t().cli.optInput)
  .option('-t, --topic <file>', t().cli.optTopic)
  .option('--intent <kind>', t().cli.optIntent, parseIntent, 'feature')
  .option('--plan-out <file>', t().cli.optPlanOut)
  .option('--debug-wiki-path <dir>', t().cli.optDebugWikiPath)
  .option('--record-replay <mode>', t().cli.optRecordReplay, parseRecordReplayMode)
  .option('--record-replay-path <dir>', t().cli.optRecordReplayPath)
  .option('--yes', t().cli.optYes, false)
  .option('--force', t().cli.optForce, false)
  .action(async (projectArg, opts) => {
    const result = await runtime.appendCommand({
      projectFile: projectArg,
      configPath: opts.config,
      inputFile: opts.input,
      topicFile: opts.topic,
      intent: opts.intent,
      planOut: opts.planOut,
      debugWikiPath: opts.debugWikiPath,
      recordReplayMode: opts.recordReplay,
      recordReplayPath: opts.recordReplayPath,
      yes: !!opts.yes && (!!opts.input || !!opts.topic),
      force: !!opts.force,
    });
    applyExecuteExitCode(result.execution);
  });

program
  .command('bootstrap')
  .description(t().cli.bootstrapDescription)
  .option('-r, --repository <dir>', t().cli.optRepository)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('-i, --input <file>', t().cli.optInput)
  .option('-t, --topic <file>', t().cli.optTopic)
  .option('--yes', t().cli.optYes, false)
  .option('--force', t().cli.optForce, false)
  .option('--promote', t().cli.optPromote, false)
  .option('--cleanup', t().cli.optCleanup, false)
  .option('--docker-qualification', t().cli.optDockerQualification, false)
  .action(async (opts) => {
    const result = await runtime.bootstrap({
      repository: opts.repository,
      configPath: opts.config,
      inputFile: opts.input,
      topicFile: opts.topic,
      yes: !!opts.yes,
      force: !!opts.force,
      promote: !!opts.promote,
      cleanup: !!opts.cleanup,
      dockerQualification: !!opts.dockerQualification,
    });
    if (!['qualified', 'promoted'].includes(result.status)) process.exitCode = 4;
  });

program
  .command('run')
  .description(t().cli.runDescription)
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
    const result = await runCliAbortable((abortSignal) => runtime.runCommand({
      io: createCliRuntimeIO(),
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
      abortSignal,
      cwd: process.cwd(),
    }));
    applyExecuteExitCode(result);
  });

program
  .command('ls')
  .description(t().cli.lsDescription)
  .option('-o, --output <dir>', t().cli.optOutput)
  .option('-w, --workspace <dir>', t().cli.optWorkspace, process.cwd())
  .option('-d, --max-depth <n>', t().cli.optMaxDepth, parseNonNegativeInteger, 4)
  .action(async (opts) => {
    const ws = opts.output ?? opts.workspace;
    await runLs({ workspace: ws, maxDepth: opts.maxDepth });
  });

program
  .command('show')
  .description(t().cli.showDescription)
  .argument('<stepId>', t().cli.argStepId, parseStepId)
  .option('-o, --output <dir>', t().cli.optOutput)
  .option('-w, --workspace <dir>', t().cli.optWorkspace, process.cwd())
  .option('-p, --plan <file>', t().cli.optPlan)
  .option('-n, --tail <n>', t().cli.optTail, parseNonNegativeInteger, 10)
  .action(async (stepId, opts) => {
    await runShow({
      workspace: opts.output ?? opts.workspace,
      stepId,
      planPath: opts.plan,
      auditTail: opts.tail,
    });
  });

program
  .command('doctor')
  .description(t().doctor.cliDescription)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('--strict', t().doctor.optStrict, false)
  .action(async (opts) => {
    await runDoctorCli({ configPath: opts.config, strict: !!opts.strict });
  });

program
  .command('fixtures')
  .description('Prepare, inspect, verify, or refresh deterministic external-interaction fixtures')
  .argument('<action>', 'prepare | inspect | verify | refresh', parseFixtureAction)
  .argument('[plan]', t().cli.argPlan)
  .option('-w, --workspace <dir>', t().cli.optWorkspace, process.cwd())
  .option('-c, --config <file>', t().cli.optConfig)
  .option('--record-replay-path <dir>', t().cli.optRecordReplayPath)
  .option('--force', t().cli.optForce, false)
  .action(async (action, planArg, opts) => {
    const result = await runtime.fixtures({
      action,
      workspace: opts.workspace,
      configPath: opts.config,
      path: opts.recordReplayPath,
      planArg,
      force: !!opts.force,
    });
    if (result.inspection) {
      console.log(JSON.stringify(result.inspection, null, 2));
      if (!result.inspection.ok) process.exitCode = 4;
    }
    applyExecuteExitCode(result.execution);
  });

program
  .command('acp')
  .description('Start XCompiler in ACP Code Agent mode over stdio JSON-RPC')
  .action(async () => {
    await runAcpStdioServer();
  });

program.parseAsync(process.argv).catch((err) => {
  if (isCliCancellation(err)) {
    process.exitCode = 130;
    return;
  }
  if (err instanceof CompileExitError) {
    process.exitCode = err.exitCode;
    return;
  }
  console.error(t().system.unhandledError(err?.message ?? String(err)));
  process.exitCode = 1;
});

function applyExecuteExitCode(result: ExecuteResult | undefined): void {
  if (!result) return;
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
