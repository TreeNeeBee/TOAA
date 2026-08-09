import path from 'node:path';
import { loadPlanTarget } from '../core/storage.js';
import { topoSort } from '../core/lint.js';
import { AuditLogger } from '../audit/audit.js';
import { Workspace } from '../workspace/workspace.js';
import { ProjectContainer } from '../workspace/project_container.js';
import { GitService } from '../workspace/git.js';
import { loadConfigWithPath } from '../config/config.js';
import { LLMRouter } from '../llm/router.js';
import { reportRoleModelAdvice } from '../llm/role_advice.js';
import { ScoreStore, scoreStoreOptionsFromConfig } from '../llm/scores.js';
import { preflightProviders } from '../llm/preflight.js';
import { createSandbox } from '../sandbox/factory.js';
import { sandboxDownloadCachePath, sandboxEnvironmentPath } from '../sandbox/environment.js';
import {
  ProjectOrchestrator,
  type ProjectOrchestratorResult,
} from '../application/project_management/orchestrator.js';
import type { AttemptInput, ExecutionScope } from '../application/execution/attempt_runner.js';
import { TicketChangeSetService } from '../application/workspace/ticket_change_set_service.js';
import { MergeGateService } from '../application/workspace/merge_gate_service.js';
import { MergeIntegrationService } from '../application/workspace/merge_integration_service.js';
import { prepareScopeEnvironment } from '../application/execution/scope_environment.js';
import { runMergeGateChecks } from '../application/workspace/merge_gate_checks.js';
import { containerOwnershipRecord, GitRepositoryService } from '../infrastructure/git/git_repository_service.js';
import { acquireLock, LockError } from '../core/lock.js';
import { calibratePythonRequirements } from '../agents/calibration.js';
import { getLanguageProfile } from '../core/language.js';
import { runProjectAudit } from '../core/project_audit.js';
import {
  generateProjectDevelopmentReport,
} from '../core/project_report.js';
import { refreshProjectMemory } from '../core/project_memory.js';
import { updateProjectFile } from '../core/project_file.js';
import type { Language, PlanIntent } from '../core/plan.js';
import { setLocale, t } from '../i18n/index.js';
import { PluginHost } from '../plugins/host.js';
import type { XCompilerPlugin } from '../plugins/types.js';
import { hasXcEnv } from '../config/env.js';
import type { ProjectAuditResult } from '../core/project_audit.js';
import type { ToolExecutionEvent, ToolPermissionRequest } from '../tools/types.js';
import { DomainObjectRepository } from '../infrastructure/repository/domain_object_repository.js';
import { DomainAuditTrail } from '../application/observability/domain_audit_trail.js';
import { FileProjectProjectionWriter } from '../infrastructure/projections/index.js';
import {
  emitRuntimeEvent,
  runtimeLog,
  runtimeResult,
  silentRuntimeIO,
  runtimePermissionAuthorizer,
  type RuntimeIO,
} from './io.js';
import { createRuntimeRecordReplay } from './record_replay.js';
import { withRecordReplaySandbox } from '../infrastructure/record_replay/sandbox.js';
import { ProjectPermissionService } from '../application/project_management/permission_service.js';
import { PhaseMaterializationService } from '../application/project_management/phase_materialization_service.js';
import { PhaseProgressionService } from '../application/planning/phase_progression_service.js';
import type { RecordReplayMode } from '../application/record_replay/types.js';
import { isCancellationError } from '../core/cancellation.js';

export interface ExecuteOptions {
  planPath: string;
  workspace: string;
  configPath?: string;
  dryRun?: boolean;
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
  /** Override external-interaction fixture behavior for this invocation. */
  recordReplayMode?: RecordReplayMode;
  /** Workspace-relative fixture root override. */
  recordReplayPath?: string;
  /** Cancels active PM/Agent/provider work. */
  abortSignal?: AbortSignal;
}

export interface ExecuteResult {
  status: 'ok' | 'failed' | 'error' | 'dry-run' | 'cancelled';
  engine?: ProjectOrchestratorResult;
  audit?: ProjectAuditResult;
  message?: string;
  exitCode?: number;
  reportPath?: string;
}

export async function runExecute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const io = opts.io ?? silentRuntimeIO;
  // 非交互式守则：xcompiler_run 不读任何 stdin。
  try {
    io.interaction?.pauseStdin?.();
  } catch {
    /* ignore */
  }
  // `-w <dir>` addresses the project container. Project state lives at <dir>/.xcompiler and the
  // working copy at <dir>/worktrees/<branch>, so a sandbox mounting the working copy cannot reach
  // XCompiler's own registry, audit trail, or fixtures.
  const container = new ProjectContainer(path.resolve(opts.workspace));
  const ws = container.canonical().workspace;
  const { config: cfg, path: cfgPath, missingEnv } = await loadConfigWithPath(opts.configPath);
  // AuditLogger 会立即创建过程日志，因此必须先应用配置语言。
  if (!hasXcEnv('LANG')) setLocale(cfg.locale);
  if (missingEnv.length > 0) {
    await runtimeLog(io, 'warning', t().system.configEnvMissing(missingEnv.join(', ')));
  }
  let lock;
  try {
    lock = await acquireLock(container.state.root, 'xcompiler_run', { force: !!opts.force });
  } catch (err) {
    if (err instanceof LockError) {
      await runtimeLog(io, 'error', t().system.unhandledError(err.message));
      await runtimeResult(io, 'run', 'error', { message: err.message, exitCode: 6 });
      return { status: 'error', message: err.message, exitCode: 6 };
    }
    throw err;
  }
  try {
  const audit = new AuditLogger({ root: ws.root, stateRoot: container.state.root, command: 'xcompiler_run' });
  await audit.start({
    workspace: ws.root,
    plan: opts.planPath,
    dryRun: !!opts.dryRun,
  });
  const pluginHost = new PluginHost({
    plugins: opts.plugins,
    strict: opts.pluginStrict,
    audit,
  });
  await pluginHost.initialize();

  let target = await loadPlanTarget(opts.planPath);
  let planAbs = target.planPath;
  let publicPlanPath = target.phasePlanPath ?? target.planPath;
  let plan = target.plan;
  const domainRepository = new DomainObjectRepository(container.state);
  await domainRepository.load();
  const domainAudit = new DomainAuditTrail(domainRepository);
  let domainProject = await domainRepository.findProject();
  if (!domainProject) {
    throw new Error('Canonical Project is missing; run xcompiler build before xcompiler run.');
  }
  let phaseObjects = await Promise.all(domainProject.phaseIds.map((id) => domainRepository.read(id)));
  let domainPhase = phaseObjects.find((object) =>
    object.objectType === 'phase' && object.name === plan.phaseId,
  );
  if (!domainPhase || domainPhase.objectType !== 'phase') {
    throw new Error(`Canonical Phase ${plan.phaseId} is missing from Project ${domainProject.name}`);
  }
  if (domainPhase.stepIds.length === 0) {
    await new PhaseMaterializationService(domainRepository).materialize({
      projectId: domainProject.id,
      phaseId: domainPhase.id,
      plan,
    });
    const materialized = await domainRepository.read(domainPhase.id);
    if (materialized.objectType !== 'phase') throw new Error(`Object ${domainPhase.id} is not a Phase`);
    domainPhase = materialized;
  }
  const recoverUnadvancedPhase = domainPhase.state === 'closed' &&
    domainProject.currentPhaseId !== undefined &&
    domainProject.currentPhaseId !== domainPhase.id;
  const projectCommand = opts.projectCommand ?? 'run';
  // --force only overrides a stale process lock; lifecycle state remains authoritative.
  if (opts.force) {
    await runtimeLog(io, 'warning', t().execute.forceLockOverride);
  }
  let projectFilePath = await updateProjectFile({
    workspace: ws.root,
    container: container.root,
    planPath: publicPlanPath,
    configPath: cfgPath,
    projectFilePath: opts.projectFilePath,
    command: projectCommand,
    intent: plan.intent,
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
  const recordReplay = createRuntimeRecordReplay(cfg, ws, {
    mode: opts.recordReplayMode,
    path: opts.recordReplayPath,
  });
  let unavailableProviders: Set<string>;
  try {
    unavailableProviders = new Set();
    if (recordReplay.mode !== 'replay') {
      const pf = await preflightProviders(cfg, scoreStore, audit);
      unavailableProviders = new Set(pf.unreachable);
      if (pf.zeroed.length > 0) {
        await runtimeLog(io, 'warning', t().execute.preflightModelMissing(pf.zeroed.join(', ')));
      }
      if (Object.keys(pf.autoAdded).length > 0) {
        await runtimeLog(io, 'warning', t().execute.preflightAutoAdded(Object.keys(pf.autoAdded).length));
      }
    }
  } catch (err) {
    await runtimeLog(io, 'error', t().system.unhandledError((err as Error).message));
    await audit.end({ status: 'error', message: (err as Error).message, stage: 'llm-preflight' });
    await scoreStore.flush();
    await runtimeResult(io, 'run', 'error', { message: (err as Error).message, exitCode: 7 });
    return { status: 'error', message: (err as Error).message, exitCode: 7 };
  }
  const router = new LLMRouter(
    cfg,
    audit,
    scoreStore,
    unavailableProviders,
    pluginHost,
    undefined,
    recordReplay,
  );
  const phaseProgression = new PhaseProgressionService(
    ws,
    container.state,
    router,
    audit,
    io.terminalOutput === true,
    opts.abortSignal,
  );
  await reportRoleModelAdvice(router, audit, (message) => runtimeLog(io, 'warning', message));
  if (recoverUnadvancedPhase) {
    if (!target.phasePlan || !target.phasePlanPath || !domainProject.currentPhaseId) {
      throw new Error(
        `Project ${domainProject.name} advanced beyond ${domainPhase.name}, but the PhasePlan recovery context is missing.`,
      );
    }
    const recovery = await phaseProgression.completeAndPrepareNext({
      phasePlan: target.phasePlan,
      phasePlanPath: target.phasePlanPath,
      currentPlanPath: planAbs,
      iterationDelivered: true,
    });
    if (!recovery.nextPlan) {
      throw new Error(`Project ${domainProject.name} points to a next Phase but PhasePlan has no next plan`);
    }
    await new PhaseMaterializationService(domainRepository).materialize({
      projectId: domainProject.id,
      phaseId: domainProject.currentPhaseId,
      plan: recovery.nextPlan,
    });
    target = await loadPlanTarget(target.phasePlanPath);
    planAbs = target.planPath;
    publicPlanPath = target.phasePlanPath ?? target.planPath;
    plan = target.plan;
    domainProject = await domainRepository.findProject();
    if (!domainProject) throw new Error('Canonical Project disappeared during Phase recovery');
    phaseObjects = await Promise.all(domainProject.phaseIds.map((id) => domainRepository.read(id)));
    const recoveredPhase = phaseObjects.find((object) =>
      object.objectType === 'phase' && object.name === plan.phaseId,
    );
    if (!recoveredPhase || recoveredPhase.objectType !== 'phase' || recoveredPhase.stepIds.length === 0) {
      throw new Error(`Canonical Phase ${plan.phaseId} recovery did not materialize its Step graph`);
    }
    domainPhase = recoveredPhase;
    await audit.event('plan.persist', `recovered and materialized ${domainPhase.name}`, {
      messageId: 'execute.phase_recovered',
      projectId: domainProject.id,
      phaseId: domainPhase.id,
      planPath: planAbs,
    });
    await runtimeLog(io, 'success', `recovered ${domainPhase.name} from the canonical Project state`);
    projectFilePath = await updateProjectFile({
      workspace: ws.root,
      container: container.root,
      planPath: publicPlanPath,
      configPath: cfgPath,
      projectFilePath,
      command: projectCommand,
      intent: plan.intent,
    });
  }
  const git = new GitService(ws);
  // Canonical, per-role CODE, and gate environments each install separately — that isolation is
  // about installed state. The archives they download are identical and immutable, so they share one
  // cache and fetch each package once for the whole project.
  const downloadCacheRoot = sandboxDownloadCachePath(container.state.root, domainProject.id);
  const canonicalEnvironmentRoot = sandboxEnvironmentPath(container.state.root, {
    scope: 'canonical',
    projectId: domainProject.id,
  });
  const sandbox = withRecordReplaySandbox(
    createSandbox(cfg, ws, canonicalEnvironmentRoot, audit, plan.language, downloadCacheRoot),
    recordReplay,
  );
  // The sandbox is a precondition, not something each Step discovers for itself. A run that
  // continues without one spends its whole budget on Steps whose every verification is going to
  // fail for a reason none of them owns, and reports those as defects in the generated project.
  try {
    await sandbox.build(profile.manifestFile);
  } catch (err) {
    const message =
      `sandbox is not ready, so execution cannot start: ${(err as Error).message}. ` +
      'Dependencies resolve through the registry configured for this language sandbox; ' +
      'set agent.sandboxes.<language>.local.registry if the default is unreachable here.';
    await audit.event('note', message, { messageId: 'execute.sandbox_not_ready' });
    await runtimeResult(io, 'run', 'error', { message, exitCode: 7 });
    return { status: 'error', message, exitCode: 7 };
  }

  const changeSets = new TicketChangeSetService(
    domainRepository,
    container,
    new GitRepositoryService(ws.root),
  );
  // CODE develops in its own worktree; every other Step works in the canonical copy, so the working
  // copy an attempt runs in is resolved per attempt rather than fixed here. Scopes are cached by
  // ChangeSet — or by the canonical copy itself, which they share — because rebuilding the Git and
  // sandbox bindings for every attempt would be pure overhead under serial execution.
  const scopeCache = new Map<string, ExecutionScope>();
  const resolveScope = async (input: AttemptInput): Promise<ExecutionScope> => {
    const resolved = await changeSets.ensureFor(input.ticket, input.domainStep);
    const scopeKey = resolved.changeSet?.id ?? 'canonical';
    const cached = scopeCache.get(scopeKey);
    if (cached) return cached;
    const scopeWorkspace = new Workspace(resolved.root);
    // Only CODE has concurrent workers, so only CODE takes a per-role environment.
    const environmentRoot = sandboxEnvironmentPath(
      container.state.root,
      input.domainStep.type === 'CODE'
        ? {
            scope: 'development',
            projectId: domainProject.id,
            phaseId: input.domainStep.phaseId,
            roleId: input.domainStep.role,
          }
        : { scope: 'canonical', projectId: domainProject.id },
    );
    const scope: ExecutionScope = {
      workspace: scopeWorkspace,
      git: new GitService(scopeWorkspace),
      sandbox: withRecordReplaySandbox(
        createSandbox(cfg, scopeWorkspace, environmentRoot, audit, plan.language, downloadCacheRoot),
        recordReplay,
      ),
    };
    await prepareScopeEnvironment({
      sandbox: scope.sandbox,
      manifestFile: profile.manifestFile,
      isolated: resolved.changeSet !== undefined,
      root: resolved.root,
      audit,
    });
    scopeCache.set(scopeKey, scope);
    return scope;
  };
  const repositoryGit = new GitRepositoryService(ws.root);
  const repositoryInfo = await repositoryGit.ensureRepository(
    undefined,
    {
      initialBranch: container.canonicalBranch,
      ownershipRecord: containerOwnershipRecord(container.state),
    },
  );
  const permissionService = new ProjectPermissionService(domainRepository, domainProject);
  const permissionAuthorizer = runtimePermissionAuthorizer(io);
  const requestPermission = (request: ToolPermissionRequest) => permissionService.request(
    request,
    permissionAuthorizer,
    (status) => emitRuntimeEvent(io, { type: 'permission', status, request }),
  );
  const mergeGates = new MergeGateService(
    domainRepository,
    container,
    repositoryGit,
    container.canonicalBranch,
  );
  const mergeIntegration = new MergeIntegrationService({
    repository: domainRepository,
    gates: mergeGates,
    git: repositoryGit,
    targetBranch: container.canonicalBranch,
    // A repository that already existed belongs to whoever created it, so a validated change waits
    // for explicit authorization rather than being written onto their mainline.
    mayMerge: repositoryInfo.ownership === 'xcompiler-created',
    authorizeMerge: (changeSet) => requestPermission({
          operationType: 'git_operation',
          target: `merge ${changeSet.sourceBranch} into ${container.canonicalBranch}`,
          reason: 'Land the validated CODE ChangeSet so downstream V-model Steps test the new code.',
          risk: 'Creates one squash commit on the canonical project branch.',
          scope: 'canonical project repository',
          skippable: false,
          denyBehavior: 'Keep the ChangeSet gate-passed and stop delivery before downstream testing.',
          metadata: {
            changeSetId: changeSet.id,
            rootTicketId: changeSet.rootTicketId,
            generation: changeSet.generation,
          },
        }),
    releaseChangeSet: async (changeSetId) => {
      await changeSets.release(changeSetId);
    },
    runChecks: async (root, scope) => {
      const candidate = new Workspace(root);
      const gateSandbox = withRecordReplaySandbox(
        createSandbox(
          cfg,
          candidate,
          sandboxEnvironmentPath(container.state.root, {
            scope: 'gate',
            projectId: domainProject.id,
            phaseId: domainPhase.id,
          }),
          audit,
          plan.language,
          downloadCacheRoot,
        ),
        recordReplay,
      );
      return runMergeGateChecks(gateSandbox, plan.language, recordReplay, scope);
    },
  });
  let finalProjectAudit: ProjectAuditResult | undefined;
  const engine = new ProjectOrchestrator({
    workspace: ws,
    git,
    sandbox,
    router,
    audit,
    repository: domainRepository,
    plugins: pluginHost,
    // Container state, not the working copy. The projection is XCompiler's own bookkeeping and is
    // rewritten constantly; written into the generated project it was tracked by Git, and the
    // squash merge refused a dirty working copy — XCompiler's own cache blocked XCompiler's merge.
    projectionWriter: new FileProjectProjectionWriter(new Workspace(container.state.root)),
    maxRoundsPerStep: cfg.agent.max_rounds_per_step,
    maxDebugRoundsPerStep: cfg.agent.max_debug_rounds_per_step,
    maxEditLinesPerStep: cfg.agent.max_edit_lines_per_step,
    terminalOutput: opts.terminalOutput ?? io.terminalOutput ?? false,
    debugWikiPath: opts.debugWikiPath ? path.resolve(opts.debugWikiPath) : undefined,
    projectDebugWikiPath: container.state.abs('debug-wiki'),
    recordReplay,
    requestPermission,
    resolveScope,
    integrateTicket: (rootTicketId) => mergeIntegration.integrateTicket(domainProject.id, rootTicketId),
    integratePhase: (phaseId) => mergeIntegration.integratePhase(domainProject.id, phaseId),
    integratePendingAuthorization: (phaseId) =>
      mergeIntegration.integratePendingAuthorization(domainProject.id, phaseId),
    abortSignal: opts.abortSignal,
    onToolEvent: async (event: ToolExecutionEvent) => {
      await emitRuntimeEvent(io, {
        type: 'tool_call',
        callId: event.callId,
        status: event.status,
        stepId: event.stepId,
        stepName: event.stepName,
        tool: event.tool,
        target: event.target,
        ok: event.ok,
        summary: event.summary,
        error: event.error,
      });
      if (event.patch && event.status === 'started') {
        await emitRuntimeEvent(io, {
          type: 'patch_proposed',
          callId: event.callId,
          stepId: event.stepId,
          stepName: event.stepName,
          tool: event.tool,
          patch: event.patch,
        });
      }
      if (event.status === 'completed' && event.ok && event.changedFiles) {
        for (const changed of event.changedFiles) {
          await emitRuntimeEvent(io, {
            type: 'file_changed',
            callId: event.callId,
            stepId: event.stepId,
            stepName: event.stepName,
            tool: event.tool,
            path: changed,
          });
        }
      }
    },
    onTransition: async (event) => {
      await emitRuntimeEvent(io, { type: 'workflow', ...event });
      await domainAudit.recordEvent({
        projectId: event.projectId,
        subject: event.ticketId
          ? { id: event.ticketId, objectType: 'ticket' }
          : event.stepId
            ? { id: event.stepId, objectType: 'step' }
            : { id: event.phaseId, objectType: 'phase' },
        kind: `workflow.${event.event}`,
        actor: 'xcompiler-runtime',
        correlationId: event.correlationId,
        causationId: event.causationId,
        payload: {
          phaseId: event.phaseId,
          stepId: event.stepId,
          stepName: event.stepName,
          ticketId: event.ticketId,
          ticketName: event.ticketName,
          ticketType: event.ticketType,
          creatorActorId: event.creatorActorId,
          creatorRole: event.creatorRole,
          assigneeActorId: event.assigneeActorId,
          assigneeRole: event.assigneeRole,
          assigneeAgent: event.assigneeAgent,
          message: event.message,
        },
      });
      projectFilePath = await updateProjectFile({
        workspace: ws.root,
        container: container.root,
        planPath: publicPlanPath,
        configPath: cfgPath,
        projectFilePath,
        command: projectCommand,
        intent: plan.intent,
      });
    },
    finalGate: async () => {
      if (requestPermission) {
        const decision = await requestPermission({
          operationType: 'test_command',
          target: 'project audit gate',
          reason: 'Run the phase delivery audit before closing its Epic.',
          risk: 'The audit may execute tests or the project entrypoint in the configured sandbox.',
          scope: 'current workspace sandbox',
          skippable: false,
          denyBehavior: 'Keep the phase open and return a failed run.',
        });
        if (!decision.approved) return { ok: false, reason: 'project audit permission denied' };
      }
      finalProjectAudit = await runProjectAudit({ ws, sandbox, plan, profile });
      await emitProjectAudit(io, finalProjectAudit);
      return {
        ok: finalProjectAudit.ok,
        reason: finalProjectAudit.ok
          ? undefined
          : `project audit failed (${finalProjectAudit.errors} error(s))`,
        failureLog: finalProjectAudit.checks
          .filter((check) => check.severity === 'error' && !check.ok)
          .map((check) => `${check.name}: ${check.summary}${check.detail ? `\n${check.detail}` : ''}`)
          .join('\n'),
      };
    },
  }, plan);

  try {
    const r = await engine.run(domainPhase.id);
    await persistProjectMemory(ws, container.state, audit, planAbs, plan.language, plan.intent);
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
    const iterationDelivered = true;
    const phaseAdvance = target.phasePlan && target.phasePlanPath && iterationDelivered
      ? await phaseProgression.completeAndPrepareNext({
          phasePlan: target.phasePlan,
          phasePlanPath: target.phasePlanPath,
          currentPlanPath: planAbs,
          iterationDelivered,
        })
      : undefined;
    if (phaseAdvance?.nextPlan && r.nextPhaseId) {
      await new PhaseMaterializationService(domainRepository).materialize({
        projectId: domainProject.id,
        phaseId: r.nextPhaseId,
        plan: phaseAdvance.nextPlan,
      });
    }
    const projectPlan = phaseAdvance?.nextPlan ?? plan;
    const reportPath = iterationDelivered
      ? await generateProjectDevelopmentReport({
          workspace: ws,
          plan,
          projectAudit: finalProjectAudit,
          finalDelivery: !phaseAdvance?.nextPlan,
          repository: domainRepository,
          recordReplay: recordReplay.evidence(),
        })
      : undefined;
    if (reportPath) {
      await audit.event('project.report.generated', `generated ${reportPath}`, {
        messageId: 'execute.project_report_generated',
        reportPath,
        finalDelivery: !phaseAdvance?.nextPlan,
        completedPhaseId: phaseAdvance?.completedPhaseId,
      });
    }
    if (phaseAdvance?.nextPlan) {
      await runtimeLog(
        io,
        'success',
        `iteration ${phaseAdvance.completedPhaseId} passed; prepared ${phaseAdvance.nextPlan.phaseId}`,
      );
    }
    await runtimeLog(io, 'success', t().execute.runAllDone(r.executedSteps, r.totalSteps));
    await audit.end({
      status: (finalProjectAudit?.warnings ?? 0) > 0 ? 'warn' : 'ok',
      executedSteps: r.executedSteps,
      totalSteps: r.totalSteps,
      qualityAuditWarnings: finalProjectAudit?.warnings ?? 0,
    });
    await updateProjectFile({
      workspace: ws.root,
      container: container.root,
      planPath: publicPlanPath,
      configPath: cfgPath,
      projectFilePath,
      command: projectCommand,
      intent: projectPlan.intent,
    });
    await runtimeResult(io, 'run', 'ok', {
      executedSteps: r.executedSteps,
      totalSteps: r.totalSteps,
      completedPhaseId: phaseAdvance?.completedPhaseId,
      nextPhaseId: phaseAdvance?.nextPlan?.phaseId,
      reportPath,
    });
    return { status: 'ok', engine: r, audit: finalProjectAudit, reportPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    if (isCancellationError(err, opts.abortSignal)) {
      await audit.end({ status: 'cancelled', message: msg });
      await updateProjectFile({
        workspace: ws.root,
        container: container.root,
        planPath: publicPlanPath,
        configPath: cfgPath,
        projectFilePath,
        command: projectCommand,
        intent: plan.intent,
      });
      await runtimeResult(io, 'run', 'cancelled', { message: msg, exitCode: 130 });
      return { status: 'cancelled', message: msg, exitCode: 130 };
    }
    await runtimeLog(io, 'error', t().system.unhandledError(msg));
    if (stack && stack !== msg) {
      await runtimeLog(io, 'dim', stack);
    }
    await persistProjectMemory(ws, container.state, audit, planAbs, plan.language, plan.intent);
    await audit.end({ status: 'error', message: msg, stack });
    await updateProjectFile({
      workspace: ws.root,
      container: container.root,
      planPath: publicPlanPath,
      configPath: cfgPath,
      projectFilePath,
      command: projectCommand,
      intent: plan.intent,
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

async function persistProjectMemory(
  ws: Workspace,
  state: Workspace,
  audit: AuditLogger,
  planPath: string,
  language: Language,
  intent: PlanIntent,
): Promise<void> {
  try {
    await refreshProjectMemory(ws, state, { planPath, language, intent });
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
