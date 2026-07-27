import path from 'node:path';
import { loadPlanTarget, savePhasePlan, savePlan } from '../core/storage.js';
import { assertPlanValid, topoSort } from '../core/lint.js';
import { AuditLogger } from '../audit/audit.js';
import { Workspace } from '../workspace/workspace.js';
import { GitService } from '../workspace/git.js';
import { loadConfigWithPath } from '../config/config.js';
import { LLMRouter } from '../llm/router.js';
import { reportRoleModelAdvice } from '../llm/role_advice.js';
import { ScoreStore, scoreStoreOptionsFromConfig } from '../llm/scores.js';
import { preflightProviders } from '../llm/preflight.js';
import { createSandbox } from '../sandbox/factory.js';
import { PhaseEngine } from '../core/engine.js';
import { acquireLock, LockError } from '../core/lock.js';
import {
  Planner,
  buildPlan,
  type DraftPhasePlan,
} from '../agents/planner.js';
import { calibratePythonRequirements } from '../agents/calibration.js';
import { getLanguageProfile } from '../core/language.js';
import { runProjectAudit, shouldRunProjectAudit } from '../core/project_audit.js';
import { refreshProjectMemory } from '../core/project_memory.js';
import { updateProjectFile } from '../core/project_file.js';
import { DOC_NAMES } from '../core/docs.js';
import { renderPlanMarkdown } from '../core/render.js';
import { advancePhasePlan, phasePlanFileName, type PhasePlan } from '../core/phase_plan.js';
import { DebugCache } from '../core/debug_cache.js';
import type { Language, Plan, PlanIntent } from '../core/plan.js';
import { setLocale, t } from '../i18n/index.js';
import { PluginHost } from '../plugins/host.js';
import type { XCompilerPlugin } from '../plugins/types.js';
import { hasXcEnv } from '../config/env.js';
import type { EngineResult } from '../core/engine.js';
import type { ProjectAuditResult } from '../core/project_audit.js';
import type { ToolExecutionEvent, ToolPermissionRequest } from '../tools/types.js';
import {
  runtimeLog,
  runtimeResult,
  silentRuntimeIO,
  type RuntimeIO,
} from './io.js';
import { resetStepForRerun } from '../core/workflow_state.js';

export interface ExecuteOptions {
  planPath: string;
  workspace: string;
  configPath?: string;
  dryRun?: boolean;
  fromStepId?: string;
  onlyPhase?: string;
  resetStatus?: boolean;
  force?: boolean;
  /** Optional XXX.xc project file to keep in sync with execution progress. */
  projectFilePath?: string;
  /** Optional debug wiki root directory. Defaults to XCompiler's own .xcompiler/debug-wiki. */
  debugWikiPath?: string;
  /** Project-file history command label; defaults to run. */
  projectCommand?: string;
  /** Whether to append a history row when execution starts; defaults to true. */
  recordProjectHistory?: boolean;
  /** 程序化插件入口；CLI 文件加载器后续基于该入口实现。 */
  plugins?: XCompilerPlugin[];
  pluginStrict?: boolean;
  /** Runtime event and interaction adapter. CLI supplies terminal rendering; SDKs may stay silent. */
  io?: RuntimeIO;
  /** Allow human terminal progress from lower-level engines. Defaults to false; CLI adapters opt in. */
  terminalOutput?: boolean;
}

export interface ExecuteResult {
  status: 'ok' | 'failed' | 'error' | 'dry-run';
  engine?: EngineResult;
  audit?: ProjectAuditResult;
  message?: string;
  exitCode?: number;
}

export async function runExecute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const io = opts.io ?? silentRuntimeIO;
  // 非交互式守则：xcompiler_run 不读任何 stdin。
  try {
    io.interaction?.pauseStdin?.();
  } catch {
    /* ignore */
  }
  const ws = new Workspace(path.resolve(opts.workspace));
  const { config: cfg, path: cfgPath, missingEnv } = await loadConfigWithPath(opts.configPath);
  // AuditLogger 会立即创建过程日志，因此必须先应用配置语言。
  if (!hasXcEnv('LANG')) setLocale(cfg.locale);
  if (missingEnv.length > 0) {
    await runtimeLog(io, 'warning', t().system.configEnvMissing(missingEnv.join(', ')));
  }
  let lock;
  try {
    lock = await acquireLock(ws.root, 'xcompiler_run', { force: !!opts.force });
  } catch (err) {
    if (err instanceof LockError) {
      await runtimeLog(io, 'error', t().system.unhandledError(err.message));
      await runtimeResult(io, 'run', 'error', { message: err.message, exitCode: 6 });
      return { status: 'error', message: err.message, exitCode: 6 };
    }
    throw err;
  }
  try {
  const audit = new AuditLogger({ root: ws.root, command: 'xcompiler_run' });
  await audit.start({
    workspace: ws.root,
    plan: opts.planPath,
    dryRun: !!opts.dryRun,
    fromStepId: opts.fromStepId ?? '',
    onlyPhase: opts.onlyPhase ?? '',
  });
  const pluginHost = new PluginHost({
    plugins: opts.plugins,
    strict: opts.pluginStrict,
    audit,
  });
  await pluginHost.initialize();

  const target = await loadPlanTarget(opts.planPath);
  const planAbs = target.planPath;
  const publicPlanPath = target.phasePlanPath ?? target.planPath;
  const plan = target.plan;
  const projectCommand = opts.projectCommand ?? 'run';
  // --force 隐含重置所有 Step 状态、覆写锁，让整个 Plan 从头执行。
  if (opts.force) {
    await runtimeLog(io, 'warning', t().execute.forceReset);
    opts.resetStatus = true;
  }

  if (opts.resetStatus) {
    for (const s of plan.steps) {
      resetStepForRerun(s, 'explicit-reset');
    }
    await savePlan(planAbs, plan);
    const debugCache = new DebugCache(ws.abs('.xcompiler/debug_cache.json'));
    await debugCache.clearAll();
    await audit.event('plan.persist', 'cleared debug cache because run reset was requested', {
      messageId: 'execute.debug_cache_reset',
    });
  }
  let recoveredRunning: Array<{ stepId: string; status: string; reason: string }> = [];
  if (!opts.resetStatus) {
    recoveredRunning = resetInterruptedRunningSteps(plan);
    if (recoveredRunning.length > 0) {
      await savePlan(planAbs, plan);
      const debugCache = new DebugCache(ws.abs('.xcompiler/debug_cache.json'));
      const recoveredDebugSteps: string[] = [];
      for (const recovered of recoveredRunning) {
        const marked = await debugCache.markInterrupted(
          recovered.stepId,
          `interrupted while ${recovered.reason}; resume the latest recorded Debugger attempt`,
        );
        if (marked) recoveredDebugSteps.push(recovered.stepId);
      }
      await audit.event('plan.persist', `recovered ${recoveredRunning.length} stale RUNNING step(s)`, {
        messageId: 'execute.plan_running_recovered',
        steps: recoveredRunning,
        recoveredDebugSteps,
      });
    }
  }
  let projectFilePath = await updateProjectFile({
    workspace: ws.root,
    planPath: publicPlanPath,
    configPath: cfgPath,
    projectFilePath: opts.projectFilePath,
    command: projectCommand,
    intent: plan.intent,
    plan,
    recordHistory: opts.recordProjectHistory ?? true,
  });

  // 将 xcompiler build 沉淀的依赖预写入依赖清单（仅当语言 profile 要求 runtime seeding 时，如 Python）。
  // Python 需要 calibration（剥离版本锁 / 重写幻觉包名）后再与现有内容对比：
  //  - 不存在 → 写入。
  //  - 已存在但内容与校准后不一致（例如 老运行遗留了无效版本约束）→ 重写为校准后版本。
  // 这能防止升级 XCompiler 后旧 sandbox 仍卡在幻觉依赖上。
  // TypeScript 等语言的 package.json 由 HIGH_LEVEL_DESIGN 步骤撰写，不在此 seeding。
  const profile = getLanguageProfile(plan.language);
  if (profile.seedManifestFromDeps && plan.dependencies && plan.dependencies.length > 0) {
    const reqRel = profile.manifestFile;
    const desired = [...calibratePythonRequirements(plan.dependencies)].sort().join('\n') + '\n';
    let existing = '';
    if (await ws.exists(reqRel)) {
      existing = await ws.readFile(reqRel);
    }
    if (existing !== desired) {
      await ws.writeFile(reqRel, desired);
      await audit.event(
        'plan.persist',
        existing ? t().execute.manifestRecalibrated(reqRel) : t().execute.manifestSeeded(reqRel),
        {
          messageId: existing ? 'execute.manifest_recalibrated' : 'execute.manifest_seeded',
          previousLines: existing.split('\n').length - 1,
          newLines: desired.split('\n').length - 1,
        },
      );
    }
  }

  const order = topoSort(plan.steps);
  await audit.event('plan.persist', t().execute.auditPlanLoaded(planAbs), {
    messageId: 'execute.plan_loaded',
    requestedPath: target.requestedPath,
    phasePlanPath: target.phasePlanPath,
    phaseId: plan.phaseId,
    steps: plan.steps.length,
    order: order.map((s) => s.id),
  });

  await runtimeLog(io, 'success', t().execute.planLoaded(planAbs));
  await runtimeLog(io, 'dim', t().execute.planSummary(plan.language, plan.steps.length));
  await runtimeLog(io, 'raw', '');

  if (opts.dryRun) {
    for (const s of order) {
      await runtimeLog(io, 'raw', `  ${s.id.padEnd(5)} ${s.phase.padEnd(17)} ${s.title}`);
    }
    await audit.end({ status: 'ok', mode: 'dry-run' });
    await runtimeResult(io, 'run', 'dry-run', { totalSteps: order.length });
    return { status: 'dry-run' };
  }

  const scoreStore = new ScoreStore(cfgPath, audit, scoreStoreOptionsFromConfig(cfg.llm));
  await scoreStore.load();
  let unavailableProviders: Set<string>;
  try {
    const pf = await preflightProviders(cfg, scoreStore, audit);
    unavailableProviders = new Set(pf.unreachable);
    if (pf.zeroed.length > 0) {
      await runtimeLog(io, 'warning', t().execute.preflightModelMissing(pf.zeroed.join(', ')));
    }
    if (Object.keys(pf.autoAdded).length > 0) {
      await runtimeLog(io, 'warning', t().execute.preflightAutoAdded(Object.keys(pf.autoAdded).length));
    }
  } catch (err) {
    await runtimeLog(io, 'error', t().system.unhandledError((err as Error).message));
    await audit.end({ status: 'error', message: (err as Error).message, stage: 'llm-preflight' });
    await scoreStore.flush();
    await runtimeResult(io, 'run', 'error', { message: (err as Error).message, exitCode: 7 });
    return { status: 'error', message: (err as Error).message, exitCode: 7 };
  }
  const router = new LLMRouter(cfg, audit, scoreStore, unavailableProviders, pluginHost);
  await reportRoleModelAdvice(router, audit, (message) => runtimeLog(io, 'warning', message));
  const git = new GitService(ws);
  const sandbox = createSandbox(cfg, ws, audit, plan.language);

  const engine = new PhaseEngine({
    ws,
    git,
    sandbox,
    router,
    audit,
    plugins: pluginHost,
    planPath: planAbs,
    fromStepId: opts.fromStepId,
    onlyPhase: opts.onlyPhase,
    maxRoundsPerStep: cfg.agent.max_rounds_per_step,
    maxDebugRoundsPerStep: cfg.agent.max_debug_rounds_per_step,
    maxDebugRetries: cfg.agent.max_debug_retries,
    maxDebugRetriesCap: cfg.agent.max_debug_retries_cap,
    maxEditLinesPerStep: cfg.agent.max_edit_lines_per_step,
    maxWriteChunkBytes: cfg.agent.max_write_chunk_bytes,
    terminalOutput: opts.terminalOutput ?? io.terminalOutput ?? false,
    debugWikiPath: opts.debugWikiPath ? path.resolve(opts.debugWikiPath) : undefined,
    debugWikiStrict: !!opts.debugWikiPath,
    requestPermission: io.requestPermission
      ? async (request: ToolPermissionRequest) => {
          await io.emit({ type: 'permission', status: 'requested', request });
          const decision = await io.requestPermission!(request);
          await io.emit({ type: 'permission', status: decision.approved ? 'approved' : 'denied', request });
          return decision;
        }
      : undefined,
    onToolEvent: async (event: ToolExecutionEvent) => {
      await io.emit({
        type: 'tool_call',
        callId: event.callId,
        status: event.status,
        stepId: event.stepId,
        tool: event.tool,
        target: event.target,
        ok: event.ok,
        summary: event.summary,
        error: event.error,
      });
      if (event.patch && event.status === 'started') {
        await io.emit({
          type: 'patch_proposed',
          callId: event.callId,
          stepId: event.stepId,
          tool: event.tool,
          patch: event.patch,
        });
      }
      if (event.status === 'completed' && event.ok && event.changedFiles) {
        for (const changed of event.changedFiles) {
          await io.emit({
            type: 'file_changed',
            callId: event.callId,
            stepId: event.stepId,
            tool: event.tool,
            path: changed,
          });
        }
      }
    },
    onPlanProgress: async (progressPlan) => {
      projectFilePath = await updateProjectFile({
        workspace: ws.root,
        planPath: publicPlanPath,
        configPath: cfgPath,
        projectFilePath,
        command: projectCommand,
        intent: progressPlan.intent,
        plan: progressPlan,
      });
    },
  });

  try {
    let r = await engine.run(plan);
    await persistProjectMemory(ws, audit, planAbs, plan.language, plan.intent);
    if (r.failedStepId) {
      await runtimeLog(io, 'error', t().execute.runInterrupted(r.failedStepId, r.executedSteps, r.totalSteps));
      if (r.failureReason) {
        await runtimeLog(io, 'error', `${t().execute.runReasonLabel}${r.failureReason}`);
      }
      if (r.failureLog) {
        const tail = r.failureLog.split('\n').slice(-40).join('\n');
        await runtimeLog(io, 'dim', t().execute.runFailureLogHeader);
        await runtimeLog(io, 'raw', tail);
      }
      await audit.end({
        status: 'failed',
        executedSteps: r.executedSteps,
        totalSteps: r.totalSteps,
        failedStepId: r.failedStepId,
        failureReason: r.failureReason,
      });
      await runtimeResult(io, 'run', 'failed', { failedStepId: r.failedStepId, exitCode: 4 });
      return { status: 'failed', engine: r, message: r.failureReason, exitCode: 4 };
    }
    const incompleteSteps = plan.steps.filter((step) => step.status !== 'DONE');
    if (!opts.onlyPhase && incompleteSteps.length > 0) {
      const failedStepId = incompleteSteps[0]!.id;
      const reason =
        'runtime refused to complete an incomplete plan: ' +
        incompleteSteps.map((step) => `${step.id}=${step.status}`).join(', ');
      r = {
        ...r,
        failedStepId,
        failureReason: reason,
        failureLog: reason,
      };
      await runtimeLog(io, 'error', t().execute.runInterrupted(failedStepId, r.executedSteps, r.totalSteps));
      await runtimeLog(io, 'error', `${t().execute.runReasonLabel}${reason}`);
      await audit.event('note', reason, {
        messageId: 'execute.incomplete_plan_blocked',
        steps: incompleteSteps.map(({ id, phase, status }) => ({ id, phase, status })),
      });
      await audit.end({
        status: 'failed',
        executedSteps: r.executedSteps,
        totalSteps: r.totalSteps,
        failedStepId,
        failureReason: reason,
      });
      await updateProjectFile({
        workspace: ws.root,
        planPath: publicPlanPath,
        configPath: cfgPath,
        projectFilePath,
        command: projectCommand,
        intent: plan.intent,
        plan,
      });
      await runtimeResult(io, 'run', 'failed', {
        failedStepId,
        incompleteSteps: incompleteSteps.map((step) => step.id),
        exitCode: 4,
      });
      return { status: 'failed', engine: r, message: reason, exitCode: 4 };
    }
    let auditWarnings = 0;
    if (shouldRunProjectAudit(plan, { onlyPhase: opts.onlyPhase })) {
      if (io.requestPermission) {
        const request: ToolPermissionRequest = {
          operationType: 'test_command',
          target: 'project audit gate',
          reason: 'Run the final project audit before returning the task result.',
          risk: 'The project audit may execute tests or entrypoint commands in the configured sandbox.',
          scope: 'current workspace sandbox',
          skippable: true,
          denyBehavior: 'Skip the project audit and fail the run as unverified.',
        };
        await io.emit({ type: 'permission', status: 'requested', request });
        const decision = await io.requestPermission(request);
        await io.emit({ type: 'permission', status: decision.approved ? 'approved' : 'denied', request });
        if (!decision.approved) {
          const message = `project audit permission denied${decision.reason ? `: ${decision.reason}` : ''}`;
          await runtimeLog(io, 'error', message);
          await runtimeResult(io, 'run', 'failed', { projectAuditSkipped: true, exitCode: 4 });
          return { status: 'failed', message, exitCode: 4 };
        }
      }
      let auditResult = await runProjectAudit({ ws, sandbox, plan, profile });
      await emitProjectAudit(io, auditResult);
      await audit.event('note', t().execute.projectAuditSummary(auditResult.errors, auditResult.warnings), {
        messageId: 'execute.project_audit_summary',
        checks: auditResult.checks,
      });
      if (!auditResult.ok) {
        await runtimeLog(io, 'warning', 'project audit failed; entering Debugger repair before final verdict');
        await audit.event('note', 'project audit failed; entering Debugger repair', {
          messageId: 'execute.project_audit_repair_start',
          checks: auditResult.checks,
        });
        let repair = await engine.repairProjectAuditFailure(plan, auditResult);
        await persistProjectMemory(ws, audit, planAbs, plan.language, plan.intent);
        if (!repair.failedStepId && repair.restartIndex !== undefined) {
          const rerun = await engine.run(plan);
          repair = {
            ...rerun,
            executedSteps: repair.executedSteps + rerun.executedSteps,
          };
          await persistProjectMemory(ws, audit, planAbs, plan.language, plan.intent);
        }
        if (repair.failedStepId) {
          await runtimeLog(
            io,
            'error',
            t().execute.runInterrupted(repair.failedStepId, r.executedSteps + repair.executedSteps, r.totalSteps),
          );
          if (repair.failureReason) {
            await runtimeLog(io, 'error', `${t().execute.runReasonLabel}${repair.failureReason}`);
          }
          if (repair.failureLog) {
            const tail = repair.failureLog.split('\n').slice(-40).join('\n');
            await runtimeLog(io, 'dim', t().execute.runFailureLogHeader);
            await runtimeLog(io, 'raw', tail);
          }
          await audit.end({
            status: 'failed',
            executedSteps: r.executedSteps + repair.executedSteps,
            totalSteps: r.totalSteps,
            failedStepId: repair.failedStepId,
            failureReason: repair.failureReason,
            qualityAuditErrors: auditResult.errors,
            qualityAuditWarnings: auditResult.warnings,
          });
          await updateProjectFile({
            workspace: ws.root,
            planPath: publicPlanPath,
            configPath: cfgPath,
            projectFilePath,
            command: projectCommand,
            intent: plan.intent,
            plan,
          });
          await runtimeResult(io, 'run', 'failed', { failedStepId: repair.failedStepId, exitCode: 4 });
          return { status: 'failed', engine: repair, audit: auditResult, message: repair.failureReason, exitCode: 4 };
        }
        r = {
          totalSteps: r.totalSteps,
          executedSteps: r.executedSteps + repair.executedSteps,
        };
        auditResult = await runProjectAudit({ ws, sandbox, plan, profile });
        await emitProjectAudit(io, auditResult);
        await audit.event('note', t().execute.projectAuditSummary(auditResult.errors, auditResult.warnings), {
          messageId: 'execute.project_audit_summary',
          checks: auditResult.checks,
          afterRepair: true,
        });
      }
      if (!auditResult.ok) {
        await audit.end({
          status: 'failed',
          executedSteps: r.executedSteps,
          totalSteps: r.totalSteps,
          qualityAuditErrors: auditResult.errors,
          qualityAuditWarnings: auditResult.warnings,
        });
        await updateProjectFile({
          workspace: ws.root,
          planPath: publicPlanPath,
          configPath: cfgPath,
          projectFilePath,
          command: projectCommand,
          intent: plan.intent,
          plan,
        });
        await runtimeResult(io, 'run', 'failed', { qualityAuditErrors: auditResult.errors, exitCode: 4 });
        return { status: 'failed', engine: r, audit: auditResult, exitCode: 4 };
      }
      auditWarnings = auditResult.warnings;
    }
    const allStepsDone = plan.steps.every((step) => step.status === 'DONE');
    const phaseAdvance = target.phasePlan && target.phasePlanPath && !opts.onlyPhase && allStepsDone
      ? await completeAndPrepareNextPhase({
          phasePlan: target.phasePlan,
          phasePlanPath: target.phasePlanPath,
          ws,
          router,
          audit,
          io,
          currentPlanPath: planAbs,
          currentPlan: plan,
        })
      : undefined;
    const projectPlan = phaseAdvance?.nextPlan ?? plan;
    if (phaseAdvance?.nextPlan) {
      await runtimeLog(
        io,
        'success',
        `iteration ${phaseAdvance.completedPhaseId} passed; prepared ${phaseAdvance.nextPlan.phaseId}`,
      );
    }
    if (allStepsDone) {
      await runtimeLog(io, 'success', t().execute.runAllDone(r.executedSteps, r.totalSteps));
    } else {
      await runtimeLog(io, 'warning', t().execute.runPartialDone(
        r.executedSteps,
        r.totalSteps,
        incompleteSteps.map((step) => step.id).join(', '),
      ));
    }
    await audit.end({
      status: auditWarnings > 0 ? 'warn' : 'ok',
      executedSteps: r.executedSteps,
      totalSteps: r.totalSteps,
      qualityAuditWarnings: auditWarnings,
    });
    await updateProjectFile({
      workspace: ws.root,
      planPath: publicPlanPath,
      configPath: cfgPath,
      projectFilePath,
      command: projectCommand,
      intent: projectPlan.intent,
      plan: projectPlan,
    });
    await runtimeResult(io, 'run', 'ok', {
      executedSteps: r.executedSteps,
      totalSteps: r.totalSteps,
      completedPhaseId: phaseAdvance?.completedPhaseId,
      nextPhaseId: phaseAdvance?.nextPlan?.phaseId,
    });
    return { status: 'ok', engine: r };
  } catch (err) {
    const msg = (err as Error).message;
    const stack = (err as Error).stack;
    await runtimeLog(io, 'error', t().system.unhandledError(msg));
    if (stack && stack !== msg) {
      await runtimeLog(io, 'dim', stack);
    }
    await persistProjectMemory(ws, audit, planAbs, plan.language, plan.intent);
    await audit.end({ status: 'error', message: msg, stack });
    await updateProjectFile({
      workspace: ws.root,
      planPath: publicPlanPath,
      configPath: cfgPath,
      projectFilePath,
      command: projectCommand,
      intent: plan.intent,
      plan,
    });
    await runtimeResult(io, 'run', 'error', { message: msg, exitCode: 5 });
    return { status: 'error', message: msg, exitCode: 5 };
  } finally {
    await scoreStore.flush();
  }
  } finally {
    await lock.release();
  }
}

/**
 * A persisted RUNNING state proves that the phase did not finish its acceptance
 * gates. Existing output files are useful resume context, but are not completion
 * evidence: they may be partial, inconsistent, or fail compilation.
 */
export function resetInterruptedRunningSteps(
  plan: Pick<Plan, 'steps'>,
): Array<{ stepId: string; status: 'PENDING'; reason: string }> {
  const recovered: Array<{ stepId: string; status: 'PENDING'; reason: string }> = [];
  for (const step of plan.steps) {
    if (step.status !== 'RUNNING') continue;
    resetStepForRerun(step, 'interrupted');
    recovered.push({
      stepId: step.id,
      status: 'PENDING',
      reason: 'interrupted before acceptance gates completed; revalidation required',
    });
  }
  return recovered;
}

async function completeAndPrepareNextPhase(args: {
  phasePlan: PhasePlan;
  phasePlanPath: string;
  ws: Workspace;
  router: LLMRouter;
  audit: AuditLogger;
  io: RuntimeIO;
  currentPlanPath: string;
  currentPlan: Plan;
}): Promise<{ completedPhaseId: string; nextPlan?: Plan }> {
  const incomplete = args.currentPlan.steps.filter((step) => step.status !== 'DONE');
  if (incomplete.length > 0) {
    throw new Error(
      `cannot advance implementation phase with incomplete steps: ` +
      incomplete.map((step) => `${step.id}=${step.status}`).join(', '),
    );
  }
  const transition = advancePhasePlan(args.phasePlan);
  const next = transition.nextPhase;
  if (!next) {
    await savePhasePlan(args.phasePlanPath, transition.phasePlan);
    await args.audit.event('plan.persist', `completed final implementation phase ${transition.completedPhaseId}`, {
      messageId: 'execute.phase_completed',
      phaseId: transition.completedPhaseId,
      phasePlanPath: args.phasePlanPath,
    });
    return { completedPhaseId: transition.completedPhaseId };
  }

  next.planPath ??= phasePlanFileName(next.id);
  const nextPlanPath = path.resolve(path.dirname(args.phasePlanPath), next.planPath);
  assertWorkspacePath(args.ws.root, nextPlanPath);
  const topic = await args.ws.exists(DOC_NAMES.topic)
    ? await args.ws.readFile(DOC_NAMES.topic)
    : transition.phasePlan.requirementDigest;
  let baselineSummary = transition.phasePlan.baselineSummary;
  try {
    const memory = await refreshProjectMemory(args.ws, {
      planPath: args.currentPlanPath,
      language: transition.phasePlan.language,
      intent: transition.phasePlan.intent,
    });
    baselineSummary = memory.summary;
  } catch (err) {
    await args.audit.event('note', `could not refresh phase baseline: ${(err as Error).message}`, {
      messageId: 'execute.phase_baseline_refresh_failed',
      phaseId: next.id,
    });
  }

  const draftPhasePlan: DraftPhasePlan = {
    requirementDigest: transition.phasePlan.requirementDigest,
    globalPrompt: transition.phasePlan.globalPrompt,
    projectType: transition.phasePlan.projectType,
    complexityAssessment: transition.phasePlan.complexityAssessment,
    implementationPhases: transition.phasePlan.phases.map(({ planPath: _planPath, ...phase }) => phase),
  };
  const planner = new Planner(
    args.router.for('Planner'),
    args.audit,
    transition.phasePlan.language,
    args.io.terminalOutput === true,
  );
  const draft = await planner.decomposePhase(
    {
      rawRequirement: topic,
      clarifications: [],
      userAddenda: transition.phasePlan.userAddenda,
      baselineContext: baselineSummary,
      intent: transition.phasePlan.intent,
    },
    draftPhasePlan,
    next.id,
  );
  const nextPlan = buildPlan(draft, {
    language: transition.phasePlan.language,
    intent: transition.phasePlan.intent,
    userAddenda: transition.phasePlan.userAddenda,
    baselineSummary,
  });
  if (nextPlan.phaseId !== next.id) {
    throw new Error(`materialized plan phase ${nextPlan.phaseId} does not match activated phase ${next.id}`);
  }
  assertPlanValid(nextPlan);

  // Persist the materialized plan first. A crash cannot point phasePlan.json at a missing file.
  await savePlan(nextPlanPath, nextPlan);
  await savePhasePlan(args.phasePlanPath, transition.phasePlan);
  await args.ws.writeFile(DOC_NAMES.plan, renderPlanMarkdown(nextPlan));
  await refreshProjectMemory(args.ws, {
    planPath: nextPlanPath,
    language: nextPlan.language,
    intent: nextPlan.intent,
  });
  await args.audit.event('plan.persist', `prepared implementation phase ${next.id}`, {
    messageId: 'execute.phase_prepared',
    completedPhaseId: transition.completedPhaseId,
    nextPhaseId: next.id,
    nextPlanPath,
    phasePlanPath: args.phasePlanPath,
  });
  return { completedPhaseId: transition.completedPhaseId, nextPlan };
}

function assertWorkspacePath(workspace: string, target: string): void {
  const relative = path.relative(path.resolve(workspace), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`phase plan path escapes workspace: ${target}`);
  }
}

async function persistProjectMemory(
  ws: Workspace,
  audit: AuditLogger,
  planPath: string,
  language: Language,
  intent: PlanIntent,
): Promise<void> {
  try {
    await refreshProjectMemory(ws, { planPath, language, intent });
  } catch (err) {
    await audit.event('note', t().execute.projectMemoryRefreshFailed((err as Error).message), {
      messageId: 'execute.project_memory_refresh_failed',
      planPath,
    });
  }
}

async function emitProjectAudit(
  io: RuntimeIO,
  result: Awaited<ReturnType<typeof runProjectAudit>>,
): Promise<void> {
  const failing = result.checks.filter((check) => !check.ok);
  if (failing.length === 0) return;
  for (const check of failing) {
    await runtimeLog(
      io,
      check.severity === 'error' ? 'error' : 'warning',
      t().execute.projectAuditCheck(check.name, check.summary),
    );
    if (check.detail) await runtimeLog(io, 'dim', check.detail);
  }
}
