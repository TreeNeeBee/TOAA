import chalk from 'chalk';
import { spinner as ora } from '../util/spinner.js';
import {
  PHASE_ORDER,
  V_MODEL_TEST_PHASES,
  V_MODEL_TEST_TO_SOURCE_PHASE,
  type Plan,
  type Step,
} from './plan.js';
import { topoSort } from './lint.js';
import { savePlan } from './storage.js';
import type { LLMRouter } from '../llm/router.js';
import type { Workspace } from '../workspace/workspace.js';
import type { GitService } from '../workspace/git.js';
import type { Sandbox } from '../sandbox/types.js';
import type { AuditLogger } from '../audit/audit.js';
import {
  buildDefaultRegistry,
  type WriteChunkBytes,
  type ToolRegistry,
  type ToolExecutionReporter,
  type ToolPermissionRequest,
  type ToolPermissionRequester,
} from '../tools/index.js';
import { verifyOutputs } from '../agents/executor.js';
import type { ExecutorRunMetrics } from '../agents/executor.js';
import { calibrateDebugSuggestions } from '../agents/calibration.js';
import { t } from '../i18n/index.js';
import { buildDefaultSkills, SkillRegistry } from '../skills/skill.js';
import { archiveIfExists } from '../workspace/doc_archive.js';
import {
  DebugCache,
} from './debug_cache.js';
import {
  DebugWiki,
  defaultDebugWikiPath,
} from './debug_wiki.js';
import { getLanguageProfile, type LanguageProfile } from './language.js';
import { missingArchitectureDocumentTokens } from './architecture.js';
import { DOC_NAMES } from './docs.js';
import {
  renderProjectAuditFailureLog,
  runIterationGate,
  type ProjectAuditResult,
} from './project_audit.js';
import {
  loadProjectMemory,
  refreshProjectMemory,
  type ProjectMemory,
} from './project_memory.js';
import { PluginHost } from '../plugins/host.js';
import {
  downstreamStepsForRerun,
  incompleteTransitiveDependencies,
  resetStepForRerun,
  stepStateSummary,
  stepTransitivelyDependsOn,
  transitionStep,
  validateExecutionSelection,
} from './workflow_state.js';
import {
  adjustDebugRetryWindow,
  classifyDebugFailure,
  cleanFailureLogForDebugContext,
  composeDebugRetryFailureLog,
  isNonDebuggableInfrastructureFailure,
  isReadOnlyProbeLoopFailure,
  latestActionableDebugAttempt,
  latestActionableSourceFailureLog,
  shouldRollbackTestPhaseFailure,
} from './debug_policy.js';
import {
  isDesignChangeRequestPhase,
  TicketStore,
  type BugTicket,
  type ChangeRequestTicket,
  type EnhanceTicket,
} from './ticket.js';
import {
  QualityAssessmentStore,
  emptyQualityAssessment,
  evaluateQualityGate,
  type StageQualityAssessment,
} from './quality_gate.js';
import {
  compactToolCallFailureDetail,
  hasFailedVerificationEvidence,
  hasSuccessfulRepairMutation,
  shouldRollbackTestPhaseFromToolFailures,
} from './engine/attempt_policy.js';
import {
  codeValidationCommand,
  collectRollbackRepairOutputs,
  extractFailedTestPaths,
  hasCodeValidationPrerequisites,
  inferCachedTestScopeArgs,
  sandboxBuildFailureReason,
  shouldRunCodeValidation,
} from './engine/v_model_policy.js';
import {
  computeDebugAllowedWrites,
  findOwningTestStepForFailure,
} from './engine/context.js';
import {
  buildAttemptEnvironment,
  type AttemptEnvironment,
} from './engine/attempt_environment.js';
import type {
  AttemptOptions,
  AttemptOutcome,
  DebugAttemptContext,
} from './engine/attempt_types.js';
import {
  auditRepairContextPaths,
  selectAuditRepairStep,
} from './engine/audit_repair.js';
import { DebugWikiFeedbackService } from './engine/debug_wiki_feedback.js';
import { buildDebugPromptPayload } from './engine/debug_prompt.js';
import { ChangeRequestLifecycle } from './engine/change_request_lifecycle.js';
import { ChangeRequestOpening } from './engine/change_request_opening.js';
import { BugLifecycle } from './engine/bug_lifecycle.js';
import { EnhancementLifecycle } from './engine/enhancement_lifecycle.js';
import { presentStepFailure } from './engine/failure_presenter.js';
import { RepairArtifactService } from './engine/repair_artifact.js';
import { TestPhaseValidator } from './engine/test_phase_validator.js';
import { WorkTicketLifecycle } from './engine/work_ticket_lifecycle.js';

export interface EngineOptions {
  ws: Workspace;
  git: GitService;
  sandbox: Sandbox;
  router: LLMRouter;
  audit: AuditLogger;
  planPath: string;
  registry?: ToolRegistry;
  skills?: SkillRegistry;
  /** 程序化插件入口；CLI 动态加载器后续只需向该 Host 注入插件。 */
  plugins?: PluginHost;
  /** 从指定 stepId 开始；仅允许之前所有必需 Step 已完成，禁止借此跳过失败或未完成阶段。 */
  fromStepId?: string;
  /** 仅执行指定 phase；该阶段的所有传递依赖仍必须已完成。 */
  onlyPhase?: string;
  /** 仅打印拓扑顺序，不执行。 */
  dryRun?: boolean;
  /** 单 Step 的 LLM 对话最大轮数。 */
  maxRoundsPerStep?: number;
  /** DEBUG 重试时的对话最大轮数（默认 = maxRoundsPerStep * 2，至少 8）。 */
  maxDebugRoundsPerStep?: number;
  /** Step 失败后最多自动调用 Debugger 重试的次数（基础窗口大小）。 */
  maxDebugRetries?: number;
  /** Debugger 重试的硬上限（滑动窗口最大值）。默认 = max(maxDebugRetries*4, 10)。 */
  maxDebugRetriesCap?: number;
  /** EditGuard 单 Step 累计行数上限；auto 按 Step 上下文动态估算。 */
  maxEditLinesPerStep?: number | 'auto';
  /** write_file / append_file 单次 content 字节预算；auto 按 Step 上下文动态估算。 */
  maxWriteChunkBytes?: WriteChunkBytes;
  /** Called whenever the engine persists Step progress to the current phase plan. */
  onPlanProgress?: (plan: Plan) => Promise<void>;
  /** Optional protocol/UI permission hook for sensitive tool operations. */
  requestPermission?: ToolPermissionRequester;
  /** Optional protocol/UI event hook for tool calls and changed files. */
  onToolEvent?: ToolExecutionReporter;
  /** Whether PhaseEngine may write human terminal progress directly. Defaults to false; CLI opts in. */
  terminalOutput?: boolean;
  /** Optional cross-run debug wiki root directory. Defaults to XCompiler's own .xcompiler/debug-wiki. */
  debugWikiPath?: string;
  /** If true, debug wiki read/write failures abort instead of only being audited. */
  debugWikiStrict?: boolean;
}

export interface EngineResult {
  totalSteps: number;
  executedSteps: number;
  failedStepId?: string;
  /** Internal continuation cursor used when a repaired upstream phase requires downstream V-model reruns. */
  restartIndex?: number;
  /** 失败 Step 的最终详细日志（reason + tool calls + 健康度）。 */
  failureLog?: string;
  failureReason?: string;
}

type TestPhaseValidationResult =
  | { status: 'passed'; commit: string }
  | { status: 'failed'; failureLog: string }
  | { status: 'incomplete'; failureLog: string; missingOutputs: string[] }
  | { status: 'denied'; failureLog: string };

type LastFailure = {
  reason: string;
  failureLog: string;
  rollbackTestStepId?: string;
};

/** Phase Engine：拓扑顺序执行 Plan 的每个 Step；失败时自动调用 Debugger 重试。 */
export class PhaseEngine {
  private readonly registry: ToolRegistry;
  private readonly skills: SkillRegistry;
  private readonly plugins: PluginHost;
  private pluginExtensionsApplied = false;
  /** 跨 xcompiler run 持久化的 debug 历史（`<workspace>/.xcompiler/debug_cache.json`）。 */
  private readonly debugCache: DebugCache;
  /** 跨项目 debug 知识库，记录错误摘要、解决方案和正/负反馈。 */
  private readonly debugWiki: DebugWikiFeedbackService;
  /** 当前 Plan 的语言 profile（在 run() 起始处按 plan.language 解析）。 */
  private profile: LanguageProfile = getLanguageProfile('python');
  /** 当前 workspace 的项目记忆，用于给执行阶段注入更稳定的跨轮上下文。 */
  private projectMemory: ProjectMemory | null = null;
  /** 最近一次 Step 终态失败时的详细日志（供 run() 汇总到 EngineResult）。 */
  private lastFailure?: LastFailure;
  /** Plan work, Bug evidence, Enhance findings, and CR propagation share one Ticket graph. */
  private readonly tickets: TicketStore;
  private readonly workTickets: WorkTicketLifecycle;
  private readonly enhancementLifecycle: EnhancementLifecycle;
  private readonly bugLifecycle: BugLifecycle;
  private readonly changeRequests: ChangeRequestLifecycle;
  private readonly changeRequestOpening: ChangeRequestOpening;
  private readonly repairArtifacts: RepairArtifactService;
  private readonly testPhases: TestPhaseValidator;
  private readonly qualityAssessments: QualityAssessmentStore;

  constructor(private readonly opts: EngineOptions) {
    this.registry = opts.registry ?? buildDefaultRegistry();
    this.skills = opts.skills ?? buildDefaultSkills();
    this.plugins = opts.plugins ?? new PluginHost();
    this.debugCache = new DebugCache(opts.ws.abs('.xcompiler/debug_cache.json'));
    const debugWiki = new DebugWiki(opts.debugWikiPath ?? defaultDebugWikiPath(opts.ws.root));
    this.debugWiki = new DebugWikiFeedbackService(
      debugWiki,
      opts.audit,
      opts.debugWikiStrict === true,
      () => this.profile.id,
    );
    this.tickets = new TicketStore(opts.ws);
    this.workTickets = new WorkTicketLifecycle(this.tickets);
    this.enhancementLifecycle = new EnhancementLifecycle(
      this.tickets,
      opts.audit,
      opts.router,
      this.workTickets,
    );
    this.bugLifecycle = new BugLifecycle(
      this.tickets,
      opts.ws,
      opts.audit,
      this.debugWiki,
      this.enhancementLifecycle,
      this.workTickets,
    );
    this.changeRequests = new ChangeRequestLifecycle(
      this.tickets,
      opts.git,
      opts.audit,
      opts.router,
      this.enhancementLifecycle,
      this.bugLifecycle,
    );
    this.changeRequestOpening = new ChangeRequestOpening(
      this.tickets,
      opts.git,
      opts.audit,
      this.enhancementLifecycle,
      this.bugLifecycle,
      this.changeRequests,
    );
    this.repairArtifacts = new RepairArtifactService(
      opts.ws,
      opts.git,
      opts.planPath,
    );
    this.testPhases = new TestPhaseValidator(
      opts.ws,
      opts.sandbox,
      opts.audit,
      (request) => this.requestEnginePermission(request),
      (message) => this.log(message),
    );
    this.qualityAssessments = new QualityAssessmentStore(opts.ws);
  }

  private get terminalOutput(): boolean {
    return this.opts.terminalOutput === true;
  }

  private log(...args: unknown[]): void {
    if (this.terminalOutput) console.log(...args);
  }

  private spin(text: string, options?: { animate?: boolean }) {
    return this.terminalOutput ? ora(text, options).start() : null;
  }

  private async requestEnginePermission(
    request: ToolPermissionRequest,
  ): Promise<{ approved: boolean; reason?: string }> {
    if (!this.opts.requestPermission) return { approved: true };
    const decision = await this.opts.requestPermission(request);
    await this.opts.audit.event(
      'note',
      `${request.operationType} ${decision.approved ? 'approved' : 'denied'}: ${request.target}`,
      {
        messageId: 'engine.permission_decision',
        operationType: request.operationType,
        target: request.target,
        approved: decision.approved,
        reason: decision.reason,
      },
    );
    return decision;
  }

  private async requireEnginePermission(request: ToolPermissionRequest): Promise<void> {
    const decision = await this.requestEnginePermission(request);
    if (!decision.approved) {
      throw new Error(`permission denied for ${request.operationType}: ${request.target}`);
    }
  }

  async run(plan: Plan): Promise<EngineResult> {
    await this.plugins.initialize();
    await this.debugWiki.load();
    await this.tickets.load();
    await this.qualityAssessments.load();
    await this.workTickets.registerPlan(plan);
    if (!this.pluginExtensionsApplied) {
      this.plugins.applyExtensions({ tools: this.registry, skills: this.skills });
      this.pluginExtensionsApplied = true;
    }
    await this.plugins.emit('run.before', { plan });
    try {
      const result = await this.runCore(plan);
      await this.plugins.emit('run.after', { plan, result });
      return result;
    } catch (error) {
      await this.plugins.emit('run.error', { plan, error });
      throw error;
    }
  }

  async repairProjectAuditFailure(
    plan: Plan,
    auditResult: ProjectAuditResult,
    opts: { iterationId?: string; contextMode?: 'audit-repair' | 'iteration-gate' } = {},
  ): Promise<EngineResult> {
    const order = topoSort(plan.steps);
    const step = selectAuditRepairStep(plan, order, auditResult, opts.iterationId);
    const failureLog = renderProjectAuditFailureLog(auditResult);
    const reason = opts.iterationId
      ? `iteration ${opts.iterationId} gate failed (${auditResult.errors} error(s), ${auditResult.warnings} warning(s))`
      : `project audit failed (${auditResult.errors} error(s), ${auditResult.warnings} warning(s))`;
    if (!step) {
      this.lastFailure = { reason, failureLog };
      const bug = await this.bugLifecycle.recordBug(plan, undefined, {
        kind: opts.contextMode === 'iteration-gate' ? 'iteration-gate' : 'project-audit',
        reason,
        failureLog,
        evidence: { checks: auditResult.checks, iterationId: opts.iterationId },
      });
      await this.enhancementLifecycle.ensureForBug(bug, undefined);
      await this.bugLifecycle.markBugFailed(
        bug.id,
        'no completed phase can own this audit repair',
      );
      return {
        totalSteps: order.length,
        executedSteps: 0,
        failedStepId: 'PROJECT_AUDIT',
        failureReason: reason,
        failureLog,
      };
    }

    const bug = await this.bugLifecycle.recordBug(plan, step, {
      kind: opts.contextMode === 'iteration-gate' ? 'iteration-gate' : 'project-audit',
      reason,
      failureLog,
      evidence: { checks: auditResult.checks, iterationId: opts.iterationId },
    });
    await this.bugLifecycle.routeBug(
      bug,
      step,
      'audit gate selected this completed phase for repair',
    );

    await this.plugins.emit('step.before', { plan, step });
    let ok: boolean;
    try {
      ok = await this.executeStepWithDebug(plan, step, {
        initialDebug: {
          reason,
          failureLog,
          contextPaths: auditRepairContextPaths({
            plan,
            step,
            auditResult,
            writable: computeDebugAllowedWrites(plan, step, this.profile),
            manifestFile: this.profile.manifestFile,
          }),
          contextMode: opts.contextMode ?? (opts.iterationId ? 'iteration-gate' : 'audit-repair'),
          bugTicketId: bug.id,
          completedBeforeDebug: step.status === 'DONE',
        },
        skipOutputArchive: true,
      });
    } catch (error) {
      await this.plugins.emit('step.error', { plan, step, error });
      throw error;
    }
    await this.plugins.emit('step.after', { plan, step, ok });
    await this.persistPlan(plan);

    if (ok) {
      const repairedIndex = order.findIndex((candidate) => candidate.id === step.id);
      const downstream = downstreamStepsForRerun(order, step);
      if (downstream.length > 0) {
        for (const candidate of downstream) {
          resetStepForRerun(candidate, 'downstream-rerun');
          await this.workTickets.resetStep(candidate, 'downstream-rerun');
        }
        await this.persistPlan(plan);
        await this.opts.audit.event(
          'note',
          `audit repair in ${step.id} requires downstream V-model rerun`,
          {
            messageId: 'engine.audit_repair_downstream_reset',
            repairedStepId: step.id,
            repairedPhase: step.phase,
            downstream: downstream.map(stepStateSummary),
          },
        );
        return {
          totalSteps: order.length,
          executedSteps: 1,
          restartIndex: Math.max(0, repairedIndex),
        };
      }
      return { totalSteps: order.length, executedSteps: 1 };
    }
    return {
      totalSteps: order.length,
      executedSteps: 1,
      failedStepId: step.id,
      failureLog: this.lastFailure?.failureLog,
      failureReason: this.lastFailure?.reason,
    };
  }

  private async runCore(plan: Plan): Promise<EngineResult> {
    this.profile = getLanguageProfile(plan.language);
    await this.refreshCurrentProjectMemory(plan);
    const order = topoSort(plan.steps);
    const stepById = new Map(order.map((step) => [step.id, step] as const));
    const stopForInvalidTransition = async (
      failedStepId: string,
      reason: string,
      data: Record<string, unknown> = {},
    ): Promise<EngineResult> => {
      this.lastFailure = { reason, failureLog: reason };
      await this.opts.audit.event('note', reason, {
        messageId: 'engine.invalid_step_transition',
        failedStepId,
        ...data,
      });
      return {
        totalSteps: order.length,
        executedSteps: 0,
        failedStepId,
        failureReason: reason,
        failureLog: reason,
      };
    };
    if (this.opts.dryRun) {
      for (const s of order) {
        this.log(`  ${chalk.cyan(s.id.padEnd(5))} ${chalk.yellow(s.phase.padEnd(11))} ${s.title}`);
      }
      return { totalSteps: order.length, executedSteps: 0 };
    }
    const selection = validateExecutionSelection(order, {
      fromStepId: this.opts.fromStepId,
      onlyPhase: this.opts.onlyPhase,
    });
    if (!selection.ok) {
      return stopForInvalidTransition(
        selection.failedStepId,
        selection.reason,
        selection.data,
      );
    }
    const fromIndex = selection.fromIndex;

    await this.requireEnginePermission({
      operationType: 'git_operation',
      target: 'git init/snapshot/revert for XCompiler run rollback',
      reason: 'XCompiler uses git snapshots to make each V-model step reversible.',
      risk: 'This may initialize or update git metadata in the current workspace.',
      scope: 'current workspace',
      skippable: false,
      denyBehavior: 'Terminate the run because safe rollback cannot be guaranteed.',
    });
    await this.opts.git.ensureRepo();
    if (await this.opts.ws.exists(this.profile.manifestFile)) {
      await this.requireEnginePermission({
        operationType: 'build_command',
        target: `sandbox build ${this.profile.manifestFile}`,
        reason: 'Prepare the project sandbox before running code-generation steps.',
        risk: 'This may execute package manager or environment setup commands in the sandbox.',
        scope: 'current workspace sandbox',
        skippable: false,
        denyBehavior: 'Terminate the run because the sandbox is not ready.',
      });
      const spin = this.spin(t().engine.spinSandboxBuild(this.profile));
      try {
        const r = await this.opts.sandbox.build(this.profile.manifestFile);
        spin?.succeed(t().engine.sandboxReady(r.reason));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        spin?.fail(message);
        // 依赖安装属于基础设施失败（典型：npm/pip 网络超时）：返回结构化失败而非抛未处理异常，
        // 下一次 xcompiler run 会在启动时重新构建沙盒并从断点恢复。
        const failedStepId = order.find((s) => s.status !== 'DONE')?.id ?? order[0]?.id ?? 'S000';
        this.lastFailure = { reason: sandboxBuildFailureReason(message), failureLog: message };
        return {
          totalSteps: order.length,
          executedSteps: 0,
          failedStepId,
          failureLog: message,
          failureReason: this.lastFailure.reason,
        };
      }
    }

    let executed = 0;
    for (let index = 0; index < order.length; index += 1) {
      const step = order[index]!;
      if (index < fromIndex) continue;
      if (this.opts.onlyPhase && step.phase !== this.opts.onlyPhase) continue;
      const blockers = incompleteTransitiveDependencies(step, stepById);
      if (blockers.length > 0) {
        const reason =
          `cannot execute or accept ${step.id} ${step.phase}: dependency chain is incomplete: ` +
          blockers.map((dependency) => `${dependency.id}=${dependency.status}`).join(', ');
        this.lastFailure = { reason, failureLog: reason };
        await this.opts.audit.event('note', reason, {
          messageId: 'engine.step_blocked_incomplete_dependencies',
          stepId: step.id,
          phase: step.phase,
          dependencies: blockers.map(stepStateSummary),
        });
        return {
          totalSteps: order.length,
          executedSteps: executed,
          failedStepId: step.id,
          failureReason: reason,
          failureLog: reason,
        };
      }
      if (step.status === 'DONE') {
        this.log(chalk.gray(t().engine.stepSkipDone(step.id, step.phase)));
        continue;
      }

      const activeChangeRequest = this.tickets.activeChangeRequestForStep(step);
      await this.plugins.emit('step.before', { plan, step });
      let ok: boolean;
      try {
        ok = await this.executeStepWithDebug(plan, step, {
          changeRequest: activeChangeRequest,
          skipOutputArchive: !!activeChangeRequest,
        });
      } catch (error) {
        await this.plugins.emit('step.error', { plan, step, error });
        throw error;
      }
      await this.plugins.emit('step.after', { plan, step, ok });
      executed++;
      await this.persistPlan(plan);
      if (!ok) {
        const failedEnhance = this.tickets.activeQualityEnhanceForStep(step.id);
        if (failedEnhance && !this.opts.onlyPhase) {
          const rollback = await this.rollbackQualityEnhancement(
            plan,
            order,
            step,
            failedEnhance,
            activeChangeRequest,
          );
          executed += rollback.executedSteps;
          await this.persistPlan(plan);
          if (rollback.ok && rollback.restartIndex !== undefined) {
            index = rollback.restartIndex;
            continue;
          }
          return {
            totalSteps: order.length,
            executedSteps: executed,
            failedStepId: rollback.failedStepId ?? step.id,
            failureLog: rollback.failureLog ?? this.lastFailure?.failureLog,
            failureReason: rollback.failureReason ?? this.lastFailure?.reason,
          };
        }
        const failedBug = this.bugLifecycle.openBugForFailedStep(step.id);
        if (activeChangeRequest) {
          await this.changeRequests.recordFailure(activeChangeRequest, failedBug, step);
        }
        const failureRoute = classifyDebugFailure(
          this.isVModelTestPhase(step.phase) ? 'test' : 'development',
          this.lastFailure?.reason,
          this.lastFailure?.failureLog,
        );
        if (
          failureRoute === 'rollback-paired-source' &&
          !this.opts.onlyPhase &&
          this.isVModelTestPhase(step.phase)
        ) {
          const rollback = await this.rollbackFailedTestPhase(
            plan,
            order,
            step,
            failedBug,
            activeChangeRequest,
          );
          executed += rollback.executedSteps;
          await this.persistPlan(plan);
          if (rollback.ok && rollback.restartIndex !== undefined) {
            index = rollback.restartIndex;
            continue;
          }
          return {
            totalSteps: order.length,
            executedSteps: executed,
            failedStepId: rollback.failedStepId ?? step.id,
            failureLog: rollback.failureLog ?? this.lastFailure?.failureLog,
            failureReason: rollback.failureReason ?? this.lastFailure?.reason,
          };
        }
        return {
          totalSteps: order.length,
          executedSteps: executed,
          failedStepId: step.id,
          failureLog: this.lastFailure?.failureLog,
          failureReason: this.lastFailure?.reason,
        };
      }
      if (activeChangeRequest) {
        await this.changeRequests.maybeClose(plan, activeChangeRequest, step);
      }
      await this.bugLifecycle.resolveBugsVerifiedByStep(step);
      await this.enhancementLifecycle.resolveVerifiedByStep(step);

      if (step.phase === 'HIGH_LEVEL_DESIGN' && step.outputs.includes(this.profile.manifestFile)) {
        await this.requireEnginePermission({
          operationType: 'build_command',
          target: `sandbox rebuild ${this.profile.manifestFile}`,
          reason: 'Dependencies or project manifest changed after high-level design.',
          risk: 'This may execute package manager or environment setup commands in the sandbox.',
          scope: 'current workspace sandbox',
          skippable: false,
          denyBehavior: 'Terminate the run because dependent steps cannot be validated safely.',
        });
        const spin = this.spin(t().engine.spinSandboxRebuild(step.id, this.profile));
        try {
          const r = await this.opts.sandbox.build(this.profile.manifestFile);
          spin?.succeed(t().engine.sandboxStatus(r.reason));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          spin?.fail(message);
          // 同启动期 build：不把已 DONE 的 step 改回 FAILED（产物已验收），只以结构化失败结束本次 run；
          // 下次 run 启动时会重试沙盒构建并从下一个未完成 step 继续。
          this.lastFailure = { reason: sandboxBuildFailureReason(message), failureLog: message };
          return {
            totalSteps: order.length,
            executedSteps: executed,
            failedStepId: step.id,
            failureLog: message,
            failureReason: this.lastFailure.reason,
          };
        }
      }

      if (this.shouldRunIterationGate(plan, step)) {
        const gate = await this.runIterationGateWithRepair(plan, step);
        executed += gate.executedSteps;
        await this.persistPlan(plan);
        if (gate.failedStepId) {
          return {
            totalSteps: order.length,
            executedSteps: executed,
            failedStepId: gate.failedStepId,
            failureLog: gate.failureLog,
            failureReason: gate.failureReason,
          };
        }
        if (gate.restartIndex !== undefined) {
          index = gate.restartIndex;
          continue;
        }
      }
    }
    if (!this.opts.onlyPhase) {
      const incomplete = order.filter((step) => step.status !== 'DONE');
      if (incomplete.length > 0) {
        const reason =
          'execution order ended with incomplete required steps: ' +
          incomplete.map((step) => `${step.id}=${step.status}`).join(', ');
        this.lastFailure = { reason, failureLog: reason };
        await this.opts.audit.event('note', reason, {
          messageId: 'engine.plan_incomplete_after_run',
          steps: incomplete.map(stepStateSummary),
        });
        return {
          totalSteps: order.length,
          executedSteps: executed,
          failedStepId: incomplete[0]!.id,
          failureReason: reason,
          failureLog: reason,
        };
      }
    }
    return { totalSteps: order.length, executedSteps: executed };
  }

  private testGateArgsForStep(plan: Plan, step: Step): string[] {
    return this.testPhases.testArgs(plan, step);
  }

  private shouldRunIterationGate(plan: Plan, step: Step): boolean {
    if (this.opts.onlyPhase || this.opts.dryRun) return false;
    if (step.phase !== 'FUNCTIONAL_TEST') return false;
    const iterationId = step.iterationId ?? 'P1';
    const executablePhase = plan.implementationPhases
      ?.find((phase) => phase.id === iterationId && phase.status !== 'deferred');
    if (!executablePhase) return false;
    return plan.steps
      .filter((candidate) => (candidate.iterationId ?? 'P1') === iterationId)
      .every((candidate) => candidate.status === 'DONE');
  }

  private async runIterationGateWithRepair(plan: Plan, finalStep: Step): Promise<EngineResult> {
    const iterationId = finalStep.iterationId ?? 'P1';
    const gatePermission = await this.requestEnginePermission({
      operationType: 'test_command',
      target: `iteration gate ${iterationId}`,
      reason: 'Validate the completed iteration before moving on.',
      risk: 'The iteration gate may execute project tests or entrypoint commands in the sandbox.',
      scope: 'current workspace sandbox',
      skippable: true,
      denyBehavior: 'Mark the iteration gate as failed and report verification as incomplete.',
    });
    if (!gatePermission.approved) {
      const reason = `permission denied for iteration gate ${iterationId}`;
      const failureLog = `${reason}\n${gatePermission.reason ?? ''}`.trim();
      this.lastFailure = { reason, failureLog };
      return {
        totalSteps: plan.steps.length,
        executedSteps: 0,
        failedStepId: `ITERATION_GATE_${iterationId}`,
        failureReason: reason,
        failureLog,
      };
    }
    const spin = this.spin(`running iteration gate ${iterationId}`, { animate: false });
    let auditResult = await runIterationGate({
      ws: this.opts.ws,
      sandbox: this.opts.sandbox,
      plan,
      profile: this.profile,
      iterationId,
    });
    await this.opts.audit.event('note', `iteration gate ${iterationId}: ${auditResult.errors} error(s), ${auditResult.warnings} warning(s)`, {
      messageId: 'engine.iteration_gate_summary',
      iterationId,
      checks: auditResult.checks,
    });
    if (auditResult.ok) {
      spin?.succeed(`iteration gate ${iterationId} passed`);
      return { totalSteps: plan.steps.length, executedSteps: 0 };
    }

    spin?.fail(`iteration gate ${iterationId} failed; entering Debugger repair`);
    await this.opts.audit.event('note', `iteration gate ${iterationId} failed; entering Debugger repair`, {
      messageId: 'engine.iteration_gate_repair_start',
      iterationId,
      checks: auditResult.checks,
    });

    const repair = await this.repairProjectAuditFailure(plan, auditResult, {
      iterationId,
      contextMode: 'iteration-gate',
    });
    if (repair.failedStepId) return repair;
    if (repair.restartIndex !== undefined) return repair;

    auditResult = await runIterationGate({
      ws: this.opts.ws,
      sandbox: this.opts.sandbox,
      plan,
      profile: this.profile,
      iterationId,
    });
    await this.opts.audit.event('note', `iteration gate ${iterationId} after repair: ${auditResult.errors} error(s), ${auditResult.warnings} warning(s)`, {
      messageId: 'engine.iteration_gate_summary',
      iterationId,
      checks: auditResult.checks,
      afterRepair: true,
    });
    if (auditResult.ok) {
      return { totalSteps: plan.steps.length, executedSteps: repair.executedSteps };
    }
    const failureLog = renderProjectAuditFailureLog(auditResult);
    this.lastFailure = {
      reason: `iteration ${iterationId} gate still failed after Debugger repair`,
      failureLog,
    };
    return {
      totalSteps: plan.steps.length,
      executedSteps: repair.executedSteps,
      failedStepId: `ITERATION_GATE_${iterationId}`,
      failureReason: this.lastFailure.reason,
      failureLog,
    };
  }

  private isVModelTestPhase(phase: Step['phase']): phase is (typeof V_MODEL_TEST_PHASES)[number] {
    return (V_MODEL_TEST_PHASES as readonly string[]).includes(phase);
  }

  private qualityRemediationTarget(
    plan: Plan,
    failedStep: Step,
    mode: 'same-step' | 'paired-source' = this.isVModelTestPhase(failedStep.phase)
      ? 'paired-source'
      : 'same-step',
  ): Step {
    if (mode === 'same-step' || !this.isVModelTestPhase(failedStep.phase)) return failedStep;
    const sourcePhase =
      V_MODEL_TEST_TO_SOURCE_PHASE[failedStep.phase as keyof typeof V_MODEL_TEST_TO_SOURCE_PHASE];
    const order = topoSort(plan.steps);
    const byId = new Map(order.map((step) => [step.id, step] as const));
    const candidates = order.filter(
      (step) =>
        (step.iterationId ?? 'P1') === (failedStep.iterationId ?? 'P1') &&
        step.phase === sourcePhase,
    );
    return [...candidates].reverse().find(
      (step) => stepTransitivelyDependsOn(failedStep, step.id, byId),
    ) ?? candidates.at(-1) ?? failedStep;
  }

  /**
   * Keep failed right-side reports and tool evidence available to the paired
   * source-phase Debugger. Test assets already belong to the source phase.
   */
  private async preserveFailedValidationEvidence(step: Step, reason: string): Promise<void> {
    const snapshot = await this.opts.git.snapshot(
      step.id,
      step.retries,
      'failed validation evidence preserved',
    );
    await this.opts.audit.event(
      'note',
      `preserved failed validation evidence for ${step.id}`,
      {
        messageId: 'engine.failed_validation_evidence_preserved',
        stepId: step.id,
        phase: step.phase,
        reason,
        outputs: step.outputs,
        snapshot,
      },
    );
  }

  private async rollbackQualityEnhancement(
    plan: Plan,
    order: Step[],
    failedStep: Step,
    enhancement: EnhanceTicket,
    activeChangeRequest?: ChangeRequestTicket,
  ): Promise<EngineResult & { ok: boolean; restartIndex?: number }> {
    const target = order.find((step) => step.id === enhancement.targetStepId) ??
      this.qualityRemediationTarget(plan, failedStep);
    enhancement.targetStepId = target.id;
    enhancement.targetPhase = target.phase;
    enhancement.verificationStepId = failedStep.id;
    enhancement.verificationPhase = failedStep.phase;
    await this.tickets.persist(enhancement, 'quality-remediation-routed');

    const byId = new Map(order.map((step) => [step.id, step] as const));
    const affectedSteps: Step[] = [];
    for (const step of order) {
      if ((step.iterationId ?? 'P1') !== (target.iterationId ?? 'P1')) continue;
      const isTarget = step.id === target.id;
      const isLaterPhase = PHASE_ORDER[step.phase] > PHASE_ORDER[target.phase];
      const dependsOnTarget = stepTransitivelyDependsOn(step, target.id, byId);
      if (!isTarget && !isLaterPhase && !dependsOnTarget) continue;
      if (!isTarget) affectedSteps.push(step);
      if (step.status !== 'PENDING') {
        resetStepForRerun(step, 'quality-enhancement');
        await this.workTickets.resetStep(step, 'quality-enhancement');
      }
    }
    await this.persistPlan(plan);
    await this.opts.audit.event(
      'quality.gate.enhance',
      `${enhancement.id} incrementally remediates ${target.id} before ${failedStep.id} revalidation`,
      {
        messageId: 'engine.quality_enhance_remediation_started',
        enhanceTicketId: enhancement.id,
        targetStepId: target.id,
        targetPhase: target.phase,
        verificationStepId: failedStep.id,
        verificationPhase: failedStep.phase,
      },
    );

    await this.plugins.emit('step.before', { plan, step: target });
    const baselineCommit = await this.changeRequestOpening.headCommit();
    let ok: boolean;
    try {
      ok = await this.executeStepWithDebug(plan, target, {
        enhancement,
        skipOutputArchive: true,
        changeRequest: activeChangeRequest,
      });
    } catch (error) {
      await this.plugins.emit('step.error', { plan, step: target, error });
      throw error;
    }
    await this.plugins.emit('step.after', { plan, step: target, ok });
    await this.persistPlan(plan);
    if (!ok) {
      return {
        ok: false,
        totalSteps: order.length,
        executedSteps: 1,
        failedStepId: target.id,
        failureLog: this.lastFailure?.failureLog,
        failureReason: this.lastFailure?.reason,
      };
    }

    if (isDesignChangeRequestPhase(target.phase) && affectedSteps.length > 0) {
      await this.changeRequestOpening.establishQuality({
        plan,
        enhancement,
        sourceStep: target,
        verificationStep: failedStep,
        affectedSteps,
        baselineCommit,
        activeChangeRequest,
      });
    } else if (enhancement.verificationStepId === target.id) {
      await this.enhancementLifecycle.close(enhancement, target);
    }
    const targetIndex = order.findIndex((step) => step.id === target.id);
    return {
      ok: true,
      totalSteps: order.length,
      executedSteps: 1,
      restartIndex: Math.max(0, targetIndex),
    };
  }

  private async rollbackFailedTestPhase(
    plan: Plan,
    order: Step[],
    failedTest: Step,
    bug?: BugTicket,
    activeChangeRequest?: ChangeRequestTicket,
  ): Promise<EngineResult & { ok: boolean; restartIndex?: number }> {
    const ownerStep = this.lastFailure?.rollbackTestStepId
      ? order.find((step) =>
          step.id === this.lastFailure?.rollbackTestStepId &&
          (step.iterationId ?? 'P1') === (failedTest.iterationId ?? 'P1') &&
          this.isVModelTestPhase(step.phase))
      : undefined;
    const routedTest = ownerStep ?? failedTest;
    const sourcePhase =
      V_MODEL_TEST_TO_SOURCE_PHASE[routedTest.phase as keyof typeof V_MODEL_TEST_TO_SOURCE_PHASE];
    const iterationId = routedTest.iterationId ?? 'P1';
    const stepById = new Map(order.map((step) => [step.id, step] as const));
    const sourceCandidates = order.filter(
      (step) => (step.iterationId ?? 'P1') === iterationId && step.phase === sourcePhase,
    );
    const sourceStep =
      [...sourceCandidates].reverse().find((step) => stepTransitivelyDependsOn(routedTest, step.id, stepById)) ??
      sourceCandidates.at(-1);
    const failureLog = this.lastFailure?.failureLog ?? `${routedTest.phase} failed.`;
    if (isNonDebuggableInfrastructureFailure(this.lastFailure?.reason, failureLog)) {
      const reason = this.lastFailure?.reason ?? `${routedTest.phase} failed due to a non-debuggable infrastructure failure.`;
      await this.bugLifecycle.markBugFailed(bug?.id, reason);
      return {
        ok: false,
        totalSteps: order.length,
        executedSteps: 0,
        failedStepId: failedTest.id,
        failureReason: reason,
        failureLog,
      };
    }
    const reason =
      `${routedTest.phase} failed; rolling back to paired ${sourcePhase} phase for Debugger repair, ` +
      `then rerunning subsequent V-model phases.`;

    if (!sourceStep) {
      this.lastFailure = {
        reason: `${routedTest.phase} failed but no paired ${sourcePhase} step exists in ${iterationId}.`,
        failureLog,
      };
      await this.bugLifecycle.markBugFailed(bug?.id, this.lastFailure.reason);
      return {
        ok: false,
        totalSteps: order.length,
        executedSteps: 0,
        failedStepId: failedTest.id,
        failureReason: this.lastFailure.reason,
        failureLog,
      };
    }

    await this.debugCache.load();
    const sourceFailureLog = latestActionableSourceFailureLog(this.debugCache.attempts(sourceStep.id));
    const debugFailureLog = [
      failureLog,
      sourceFailureLog
        ? `## paired source phase latest failure (${sourceStep.id})\n${cleanFailureLogForDebugContext(sourceFailureLog)}`
        : '',
    ].filter(Boolean).join('\n');

    this.log(chalk.yellow(
      t().engine.testRollbackNotice(routedTest.id, routedTest.phase, sourceStep.id, sourcePhase),
    ));
    await this.bugLifecycle.routeBug(bug, sourceStep, reason);
    if (bug) {
      bug.verificationStepId = routedTest.id;
      bug.verificationPhase = routedTest.phase;
      await this.bugLifecycle.persistBug(bug, 'verification-required', {
        verificationStepId: routedTest.id,
        verificationPhase: routedTest.phase,
      });
    }

    await this.opts.audit.event('note', reason, {
      messageId: 'engine.test_phase_rollback',
      iterationId,
      failedStepId: failedTest.id,
      failedPhase: failedTest.phase,
      routedTestStepId: routedTest.id,
      routedTestPhase: routedTest.phase,
      sourceStepId: sourceStep.id,
      sourcePhase,
    });

    const affectedSteps: Step[] = [];
    for (const step of order) {
      if ((step.iterationId ?? 'P1') !== iterationId) continue;
      if (step.id === sourceStep.id) continue;
      const isLaterPhase = PHASE_ORDER[step.phase] > PHASE_ORDER[sourcePhase];
      const dependsOnSource = stepTransitivelyDependsOn(step, sourceStep.id, stepById);
      if (!isLaterPhase && !dependsOnSource) continue;
      affectedSteps.push(step);
      if (step.status === 'PENDING') continue;
      resetStepForRerun(step, 'v-model-rollback');
      await this.workTickets.resetStep(step, 'v-model-rollback');
    }
    await this.persistPlan(plan);

    await this.plugins.emit('step.before', { plan, step: sourceStep });
    let ok: boolean;
    const sourceChangeRequest = activeChangeRequest && (
      activeChangeRequest.designSource.stepId === sourceStep.id ||
      activeChangeRequest.affectedSteps.some((affected) => affected.stepId === sourceStep.id)
    )
      ? activeChangeRequest
      : undefined;
    try {
      ok = await this.executeStepWithDebug(plan, sourceStep, {
        initialDebug: {
          reason,
          failureLog: debugFailureLog,
          contextPaths: dedup([
            ...sourceStep.inputs,
            ...sourceStep.outputs,
            ...routedTest.inputs,
            ...routedTest.outputs,
            ...failedTest.inputs,
            ...failedTest.outputs,
          ]),
          extraAllowedWrites: collectRollbackRepairOutputs(
            order,
            sourceStep,
            routedTest,
            this.profile.manifestFile,
          ),
          contextMode: 'test-rollback',
          testScopeArgs: this.testGateArgsForStep(plan, routedTest),
          bugTicketId: bug?.id,
          completedBeforeDebug: sourceStep.status === 'DONE',
        },
        skipOutputArchive: true,
        changeRequest: sourceChangeRequest,
      });
    } catch (error) {
      await this.plugins.emit('step.error', { plan, step: sourceStep, error });
      throw error;
    }
    await this.plugins.emit('step.after', { plan, step: sourceStep, ok });
    await this.persistPlan(plan);

    if (!ok) {
      return {
        ok: false,
        totalSteps: order.length,
        executedSteps: 1,
        failedStepId: sourceStep.id,
        failureLog: this.lastFailure?.failureLog,
        failureReason: this.lastFailure?.reason,
      };
    }

    if (bug && isDesignChangeRequestPhase(sourceStep.phase)) {
      await this.changeRequestOpening.establishDesign({
        plan,
        bug,
        sourceStep,
        failedTest: routedTest,
        affectedSteps,
        activeChangeRequest,
      });
    }

    await this.debugCache.markDone(routedTest.id);
    if (routedTest.id !== failedTest.id) await this.debugCache.markDone(failedTest.id);
    const sourceIndex = order.findIndex((step) => step.id === sourceStep.id);
    const routedTestIndex = order.findIndex((step) => step.id === routedTest.id);
    const interveningSteps = sourceIndex >= 0 && routedTestIndex > sourceIndex
      ? order
          .slice(sourceIndex + 1, routedTestIndex)
          .filter((step) => (step.iterationId ?? 'P1') === iterationId)
      : [];
    await this.opts.audit.event(
      'note',
      `deferred ${routedTest.id} acceptance to its complete V-model quality gate`,
      {
        messageId: 'engine.rollback_validation_deferred',
        sourceStepId: sourceStep.id,
        routedTestStepId: routedTest.id,
        reason:
          'The formal test phase must rerun to collect coverage, tolerance, and alignment evidence before closing Bug or Change Request tickets.',
        interveningSteps: interveningSteps.map(stepStateSummary),
      },
    );
    const restartIndex = Math.max(0, sourceIndex);
    return {
      ok: true,
      totalSteps: order.length,
      executedSteps: 1,
      restartIndex,
    };
  }

  private async validateTestPhaseWithoutRegeneration(
    plan: Plan,
    step: Step,
  ): Promise<TestPhaseValidationResult> {
    const validation = await this.testPhases.validateExisting(
      plan,
      step,
      this.profile,
    );
    if (validation.status !== 'passed') return validation;
    transitionStep(step, 'DONE', 'cached-gate-passed');
    step.retries = 0;
    await this.persistPlan(plan);
    await this.refreshCurrentProjectMemory(plan);
    const commit = await this.opts.git.snapshot(
      step.id,
      step.retries,
      'validated without test regeneration',
    );
    await this.opts.audit.event('phase.end', `${step.id} current test validation passed`, {
      messageId: 'engine.rollback_validation_passed',
      stepId: step.id,
      phase: step.phase,
    });
    return { status: 'passed', commit };
  }

  /** 主入口：先正常执行；若失败则进入 Debugger 重试循环（滑动窗口式自适应）。
   *  跨 xcompiler run 记忆：若普通 step 上次以 FAILED 结束，本次首轮直接进入 Debugger 模式。
   *  V 模型测试阶段的历史失败先复验当前门禁，仍失败才回退到配对左侧阶段。 */
  private async executeStepWithDebug(
    plan: Plan,
    step: Step,
    opts: {
      initialDebug?: Omit<DebugAttemptContext, 'asDebugger'>;
      skipOutputArchive?: boolean;
      changeRequest?: ChangeRequestTicket;
      enhancement?: EnhanceTicket;
    } = {},
  ): Promise<boolean> {
    await this.debugCache.load();
    const initialDebug = opts.initialDebug;
    const inheritedExtraAllowedWrites = initialDebug?.extraAllowedWrites;
    const inheritedContextMode = initialDebug?.contextMode;
    const inheritedTestScopeArgs = initialDebug?.testScopeArgs;
    const completedBeforeDebug = initialDebug?.completedBeforeDebug ?? step.status === 'DONE';
    const rootDebugFailureLog = initialDebug
      ? cleanFailureLogForDebugContext(initialDebug.failureLog)
      : undefined;
    const includeRootDebugFailureLog = (failureLog: string, reason: string): string =>
      rootDebugFailureLog
        ? composeDebugRetryFailureLog(rootDebugFailureLog, failureLog, reason)
        : failureLog;
    const hadUnresolved = this.debugCache.hasUnresolvedFailure(step.id);
    let activeBugTicketId = initialDebug?.bugTicketId;
    if (!activeBugTicketId && hadUnresolved) {
      activeBugTicketId = this.bugLifecycle.openBugForFailedStep(step.id)?.id;
    }
    const preserveCachedTestOutputs =
      !initialDebug && hadUnresolved && this.isVModelTestPhase(step.phase);
    // 归档属于一次尝试的工作区事务：快照必须先于归档。若该尝试回滚，
    // 下一次 Debugger 尝试会重新归档恢复后的旧产物；保留增量修复时则不重复归档。
    let archiveOutputsOnNextAttempt =
      !opts.skipOutputArchive && !preserveCachedTestOutputs;
    const runAttempt = async (debug?: DebugAttemptContext): Promise<AttemptOutcome> => {
      const archiveOutputs = archiveOutputsOnNextAttempt;
      const hadArchivableOutput = archiveOutputs && (
        await Promise.all(
          step.outputs.map(async (output) => {
            const normalized = output.replaceAll('\\', '/');
            return (
              normalized.startsWith('docs/') &&
              !normalized.startsWith('docs/history/') &&
              await this.opts.ws.exists(normalized)
            );
          }),
        )
      ).some(Boolean);
      archiveOutputsOnNextAttempt = false;
      const outcome = await this.runOneAttempt(plan, step, debug, {
        archiveOutputs,
        changeRequest: opts.changeRequest,
        enhancement: opts.enhancement,
      });
      if (hadArchivableOutput && outcome.workspaceReverted) {
        archiveOutputsOnNextAttempt = true;
      }
      return outcome;
    };
    // Test phases and explicit DEBUG mode share the language-specific test bootstrap.
    if (this.isVModelTestPhase(step.phase) || initialDebug) {
      await this.profile.ensureTestBootstrap?.(this.opts.ws, this.opts.audit);
    }
    if (this.isVModelTestPhase(step.phase) || initialDebug) {
      const fixed = (await this.profile.autoFixImports?.(this.opts.ws, this.opts.audit)) ?? [];
      if (fixed.length > 0) {
        this.log(
          chalk.yellow(t().engine.autoFixedSrcImports(fixed.length, fixed.join(', '))),
        );
      }
    }
    // 每轮新 xcompiler run 都重置本 Step 的 retries 计数，避免历史失败累计后显示成 "retry 31/3" 这种误导。
    step.retries = 0;

    // 跨会话记忆：上次以 FAILED 结束 → 首轮直接用 Debugger 模式，告诉它历史尝试
    let priorPrompt = this.debugCache.renderPriorAttemptsForPrompt(step.id);
    let initial: Awaited<ReturnType<PhaseEngine['runOneAttempt']>>;
    try {
      if (initialDebug) {
        initial = await runAttempt({
          asDebugger: true,
          failureLog: rootDebugFailureLog ?? initialDebug.failureLog,
          reason: initialDebug.reason,
          priorAttemptsPrompt: priorPrompt,
          contextPaths: initialDebug.contextPaths,
          extraAllowedWrites: inheritedExtraAllowedWrites,
          contextMode: inheritedContextMode,
          testScopeArgs: inheritedTestScopeArgs,
          bugTicketId: activeBugTicketId,
          completedBeforeDebug,
        });
      } else if (hadUnresolved) {
        const attempts = this.debugCache.attempts(step.id);
        const last = attempts.slice(-1)[0]!;
        const resume = latestActionableDebugAttempt(attempts) ?? last;
        const resumeFailureLog = cleanFailureLogForDebugContext(resume.failureLogTail);
        const cachedTestScopeArgs = inferCachedTestScopeArgs(resume);
        const cachedContextMode = resume.contextMode ?? (cachedTestScopeArgs.length > 0 ? 'test-rollback' : undefined);
        if (isNonDebuggableInfrastructureFailure(resume.reason, resumeFailureLog)) {
          // 上一次会话只留下 LLM provider 断连/限流等基础设施错误，没有任何可修复的代码线索。
          // 不能拿陈旧的断连记录直接判死本次 run（否则只有手删 debug_cache.json 才能恢复）；
          // 清掉被污染的缓存条目，按正常流程重新执行该 Step。若 LLM 仍不可用，
          // 本次尝试会现场失败并走既有的基础设施失败退出路径，而不会持续累积。
          this.log(chalk.yellow(t().engine.debugResumeInfraRetry(step.id, attempts.length)));
          await this.debugCache.markDone(step.id);
          priorPrompt = '';
          initial = await runAttempt();
        } else {
          if (this.isVModelTestPhase(step.phase)) {
            if (!shouldRollbackTestPhaseFailure(resume.reason, resumeFailureLog)) {
              this.log(chalk.yellow(t().engine.debugResumeNotice(step.id, attempts.length)));
              initial = await runAttempt({
                asDebugger: true,
                failureLog: resumeFailureLog,
                reason: resume.reason,
                priorAttemptsPrompt: priorPrompt,
                extraAllowedWrites: inheritedExtraAllowedWrites,
                contextMode: cachedContextMode,
                testScopeArgs: cachedTestScopeArgs,
                bugTicketId: activeBugTicketId,
                completedBeforeDebug,
              });
            } else {
              this.log(chalk.yellow(t().engine.cachedTestRevalidationNotice(step.id, attempts.length)));
              const validation = await this.validateTestPhaseWithoutRegeneration(plan, step);
              if (validation.status === 'passed') {
                await this.debugCache.markDone(step.id);
                priorPrompt = '';
                initial = await runAttempt();
              } else if (validation.status === 'incomplete') {
                const reason =
                  `${step.phase} required artifacts are incomplete; ` +
                  'repairing the current test phase without rolling back source implementation.';
                await this.debugCache.markDone(step.id);
                priorPrompt = '';
                initial = await runAttempt({
                  asDebugger: true,
                  failureLog: validation.failureLog,
                  reason,
                  extraAllowedWrites: inheritedExtraAllowedWrites,
                  testScopeArgs: this.testGateArgsForStep(plan, step),
                  bugTicketId: activeBugTicketId,
                  completedBeforeDebug,
                });
              } else if (validation.status === 'denied') {
                const reason = `${step.phase} cached failure could not be revalidated because permission was denied.`;
                initial = {
                  ok: false,
                  failureLog: validation.failureLog,
                  reason,
                  bugKind: 'infrastructure',
                  evidence: {
                    stage: 'cached-test-revalidation',
                    permissionDenied: true,
                    attempts: attempts.length,
                  },
                };
              } else {
                const reason =
                  `${step.phase} cached failure was reproduced by the current test gate; ` +
                  'rolling back to the paired V-model source phase.';
                const currentFailureLog = validation.failureLog;
                const ownerTestStep = findOwningTestStepForFailure(plan, step, currentFailureLog);
                initial = {
                  ok: false,
                  failureLog: [t().engine.reasonLine(reason), currentFailureLog, priorPrompt].filter(Boolean).join('\n'),
                  reason,
                  rollbackToPairedSource: true,
                  rollbackTestStepId: ownerTestStep?.id,
                  bugKind: step.phase === 'FUNCTIONAL_TEST' ? 'functional-gate' : 'test-gate',
                  evidence: {
                    stage: 'cached-test-failure',
                    role: 'Debugger',
                    attempts: attempts.length,
                    rollbackTestStepId: ownerTestStep?.id,
                  },
                };
              }
            }
          } else {
            this.log(chalk.yellow(t().engine.debugResumeNotice(step.id, attempts.length)));
            initial = await runAttempt({
              asDebugger: true,
              failureLog: resumeFailureLog,
              reason: resume.reason,
              priorAttemptsPrompt: priorPrompt,
              extraAllowedWrites: inheritedExtraAllowedWrites,
              contextMode: cachedContextMode,
              testScopeArgs: cachedTestScopeArgs,
              bugTicketId: activeBugTicketId,
              completedBeforeDebug,
            });
          }
        }
      } else {
        initial = await runAttempt();
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      initial = {
        ok: false,
        failureLog: err instanceof Error ? (err.stack ?? reason) : reason,
          reason,
          bugKind: 'exception',
        evidence: {
          stage: initialDebug || hadUnresolved ? 'initial-debug-attempt' : 'initial-attempt',
          role: initialDebug || hadUnresolved ? 'Debugger' : step.role,
        },
      };
    }
    if (initial.ok) {
      await this.debugCache.markDone(step.id);
      if (hadUnresolved && activeBugTicketId) {
        await this.bugLifecycle.closeBug(
          activeBugTicketId,
          step,
          undefined,
          initial.bugResolutionPlan ??
            'Restore the failed execution dependency or provider, retry the same Step, and accept it only after its declared outputs pass.',
        );
      }
      await this.workTickets.completeStep(step);
      return true;
    }
    if (initial.qualityGap) {
      const target = this.qualityRemediationTarget(
        plan,
        step,
        initial.qualityGap.remediationTarget,
      );
      const enhancement = await this.enhancementLifecycle.recordQualityGap(
        step,
        target,
        initial.qualityGap,
        initial.metrics?.providers ?? [],
      );
      transitionStep(step, 'FAILED', 'quality-gate-failed');
      this.lastFailure = {
        reason: initial.reason ?? `${step.phase} quality gate failed`,
        failureLog: initial.failureLog,
        rollbackTestStepId: this.isVModelTestPhase(step.phase) ? step.id : undefined,
      };
      await this.opts.audit.event(
        'quality.gate.enhance',
        `${step.id} routed to ${target.id} through ${enhancement.id}`,
        {
          messageId: 'engine.quality_enhance_routed',
          enhanceTicketId: enhancement.id,
          failedStepId: step.id,
          targetStepId: target.id,
          targetPhase: target.phase,
        },
      );
      return false;
    }
    const nonDebuggableInfrastructureFailure = isNonDebuggableInfrastructureFailure(
      initial.reason,
      initial.failureLog,
    );
    if (!activeBugTicketId) {
      const bug = await this.bugLifecycle.recordBug(plan, step, {
        kind: this.bugLifecycle.classifyBugKind(step, initial),
        reason: initial.reason ?? 'failed',
        failureLog: initial.failureLog,
        metrics: initial.metrics,
        evidence: initial.evidence,
      });
      activeBugTicketId = bug.id;
      if (opts.changeRequest) {
        await this.changeRequests.recordFailure(opts.changeRequest, bug, step);
      }
      if (
        !nonDebuggableInfrastructureFailure &&
        !(initial.rollbackToPairedSource && this.isVModelTestPhase(step.phase))
      ) {
        await this.bugLifecycle.routeBug(bug, step, 'same phase Debugger repair');
      }
    }
    // 记录首轮失败
    const initialReason = initial.reason ?? 'failed';
    const initialFailureLogForRecord = includeRootDebugFailureLog(initial.failureLog, initialReason);
    await this.debugCache.recordAttempt(step.id, {
      attempt: 0,
      reason: initialReason,
      failureLogTail: initialFailureLogForRecord,
      suggestions: calibrateDebugSuggestions(cleanFailureLogForDebugContext(initialFailureLogForRecord), initialReason).map(
        (s) => `[${s.code}] ${s.hint}`,
      ),
      contextMode: inheritedContextMode,
      testScopeArgs: inheritedTestScopeArgs,
      metrics: initial.metrics
        ? {
            healthScore: initial.metrics.healthScore,
            parseFailures: initial.metrics.parseFailures,
            repeatedTurns: initial.metrics.repeatedTurns,
            progressRatio: initial.metrics.progressRatio,
            rounds: initial.metrics.rounds,
          }
        : undefined,
    });
    if (nonDebuggableInfrastructureFailure) {
      const reason = initial.reason ?? 'infrastructure failure';
      transitionStep(step, 'FAILED', 'attempt-failed');
      this.lastFailure = {
        reason,
        failureLog: initial.failureLog,
      };
      await this.debugCache.markFailed(step.id, reason);
      await this.bugLifecycle.markBugFailed(activeBugTicketId, reason);
      if (this.terminalOutput) {
        presentStepFailure(this.log.bind(this), step, {
          attempts: 0,
          budget: 0,
          cap: 0,
          earlyAbort: true,
          reason,
          failureLog: initial.failureLog,
          metrics: initial.metrics,
        });
      }
      return false;
    }
    if (initial.rollbackToPairedSource && this.isVModelTestPhase(step.phase)) {
      transitionStep(step, 'FAILED', 'cached-gate-failed');
      this.lastFailure = {
        reason: initial.reason ?? 'test phase failed',
        failureLog: initial.failureLog,
        rollbackTestStepId: initial.rollbackTestStepId,
      };
      await this.debugCache.markFailed(step.id, this.lastFailure.reason);
      return false;
    }
    priorPrompt = this.debugCache.renderPriorAttemptsForPrompt(step.id);

    const baseMax = this.opts.maxDebugRetries ?? step.maxRetries ?? 3;
    const absoluteCap = Math.max(this.opts.maxDebugRetriesCap ?? Math.max(baseMax * 4, 10), baseMax);
    // 滑动窗口：budget 从 baseMax 起步，可在 [attempt+1, absoluteCap] 区间动态伸缩。
    let budget = baseMax;
    let consecutiveBad = 0;
    let lastReason = initial.reason ?? 'failed';
    let lastFailureLog = initial.failureLog;
    let lastActionableFailureLog = isReadOnlyProbeLoopFailure(initial.reason)
      ? undefined
      : initial.failureLog;
    let lastResult: { reason?: string; failureLog: string; metrics?: ExecutorRunMetrics; rollbackTestStepId?: string } = {
      reason: initial.reason,
      failureLog: initialFailureLogForRecord,
      rollbackTestStepId: initial.rollbackTestStepId,
    };
    let attempt = 0;
    let earlyAbort = false;
    while (attempt < budget) {
      attempt++;
      step.retries = attempt;
      await this.persistPlan(plan);
      const spin = this.spin(
        t().engine.spinDebugRetry(step.id, attempt, budget, absoluteCap, lastReason),
        { animate: false },
      );
      let r: Awaited<ReturnType<PhaseEngine['runOneAttempt']>>;
      try {
        const retryBaseLog = isReadOnlyProbeLoopFailure(lastReason) && lastActionableFailureLog
          ? composeDebugRetryFailureLog(lastActionableFailureLog, lastFailureLog, lastReason)
          : lastFailureLog;
        const retryFailureLog = rootDebugFailureLog
          ? composeDebugRetryFailureLog(rootDebugFailureLog, retryBaseLog, lastReason)
          : retryBaseLog;
        r = await runAttempt({
          asDebugger: true,
          failureLog: retryFailureLog,
          reason: lastReason,
          priorAttemptsPrompt: priorPrompt,
          extraAllowedWrites: inheritedExtraAllowedWrites,
          contextMode: inheritedContextMode,
          testScopeArgs: inheritedTestScopeArgs,
          bugTicketId: activeBugTicketId,
          completedBeforeDebug,
        });
      } catch (err) {
        const msg = (err as Error).message;
        spin?.fail(t().engine.retryException(attempt, budget, msg));
        await this.bugLifecycle.markBugFailed(activeBugTicketId, msg);
        if (isNonDebuggableInfrastructureFailure(msg, msg)) {
          lastReason = msg;
          lastFailureLog = msg;
          lastResult = { reason: msg, failureLog: includeRootDebugFailureLog(msg, msg) };
          earlyAbort = true;
          break;
        }
        consecutiveBad++;
        // 异常视为最严重的不健康信号：立即半窗，连续 2 次直接终止。
        budget = Math.max(attempt + 1, Math.ceil(budget / 2));
        lastReason = msg;
        lastFailureLog = msg;
        lastResult = { reason: msg, failureLog: includeRootDebugFailureLog(msg, msg) };
        if (consecutiveBad >= 2) {
          earlyAbort = true;
          break;
        }
        continue;
      }
      if (r.ok) {
        spin?.succeed(t().engine.fixSucceeded(step.id, attempt));
        await this.debugCache.markDone(step.id);
        await this.workTickets.completeStep(step);
        return true;
	      }
      if (isNonDebuggableInfrastructureFailure(r.reason, r.failureLog)) {
        const infraReason = r.reason ?? lastReason;
        spin?.fail(t().engine.retryStillFailed(attempt, budget, '', infraReason));
        lastReason = infraReason;
        lastFailureLog = r.failureLog;
        lastResult = {
          reason: r.reason,
          failureLog: includeRootDebugFailureLog(r.failureLog, infraReason),
          metrics: r.metrics,
          rollbackTestStepId: r.rollbackTestStepId,
        };
        earlyAbort = true;
        break;
      }
      if (r.rollbackToPairedSource && this.isVModelTestPhase(step.phase)) {
        const rollbackReason = r.reason ?? `${step.phase} failed`;
        const recordedFailureLog = includeRootDebugFailureLog(r.failureLog, rollbackReason);
        spin?.fail(t().engine.retryStillFailed(attempt, budget, '', rollbackReason));
        await this.debugCache.recordAttempt(step.id, {
          attempt,
          reason: rollbackReason,
          failureLogTail: recordedFailureLog,
          suggestions: calibrateDebugSuggestions(cleanFailureLogForDebugContext(recordedFailureLog), rollbackReason).map(
            (s) => `[${s.code}] ${s.hint}`,
          ),
          contextMode: inheritedContextMode,
          testScopeArgs: inheritedTestScopeArgs,
          metrics: r.metrics
            ? {
                healthScore: r.metrics.healthScore,
                parseFailures: r.metrics.parseFailures,
                repeatedTurns: r.metrics.repeatedTurns,
                progressRatio: r.metrics.progressRatio,
                rounds: r.metrics.rounds,
              }
            : undefined,
        });
        transitionStep(step, 'FAILED', 'attempt-failed');
        this.lastFailure = {
          reason: rollbackReason,
          failureLog: recordedFailureLog,
          rollbackTestStepId: r.rollbackTestStepId,
        };
        await this.debugCache.markFailed(step.id, rollbackReason);
        return false;
      }
      const m = r.metrics;
      const retryDecision = adjustDebugRetryWindow({
        attempt,
        budget,
        cap: absoluteCap,
        consecutiveBad,
        reason: r.reason,
        metrics: m,
      });
      const before = budget;
      budget = retryDecision.budget;
      consecutiveBad = retryDecision.consecutiveBad;
      if (retryDecision.quality === 'healthy') {
        spin?.fail(
          t().engine.retryHealthyButFailed(
            attempt,
            before,
            budget,
            retryDecision.metricsTag,
            r.reason ?? '',
          ),
        );
      } else if (retryDecision.quality === 'bad') {
        spin?.fail(
          t().engine.retryLowQuality(
            attempt,
            before,
            budget,
            retryDecision.metricsTag,
            r.reason ?? '',
          ),
        );
        if (retryDecision.earlyAbort) {
          this.log(
            chalk.yellow(
              t().engine.earlyAbortLowQuality(step.id, consecutiveBad),
            ),
          );
          lastReason = r.reason ?? lastReason;
          lastFailureLog = r.failureLog;
          lastResult = {
            reason: r.reason,
            failureLog: includeRootDebugFailureLog(r.failureLog, r.reason ?? lastReason),
            metrics: m,
            rollbackTestStepId: r.rollbackTestStepId,
          };
          earlyAbort = true;
          break;
        }
      } else {
        spin?.fail(
          t().engine.retryStillFailed(
            attempt,
            budget,
            retryDecision.metricsTag,
            r.reason ?? '',
          ),
        );
      }
      lastReason = r.reason ?? lastReason;
      lastFailureLog = r.failureLog;
      const recordedFailureLog = includeRootDebugFailureLog(r.failureLog, r.reason ?? lastReason);
      lastResult = { reason: r.reason, failureLog: recordedFailureLog, metrics: m, rollbackTestStepId: r.rollbackTestStepId };
      if (!isReadOnlyProbeLoopFailure(r.reason)) {
        lastActionableFailureLog = r.failureLog;
      }
      // 记录本轮 retry 到跨会话缓存，并刷新 priorPrompt 以供下一轮 LLM 看到
      await this.debugCache.recordAttempt(step.id, {
        attempt,
        reason: r.reason ?? lastReason,
        failureLogTail: recordedFailureLog,
        suggestions: calibrateDebugSuggestions(cleanFailureLogForDebugContext(recordedFailureLog), r.reason ?? '').map(
          (s) => `[${s.code}] ${s.hint}`,
        ),
        contextMode: inheritedContextMode,
        testScopeArgs: inheritedTestScopeArgs,
        metrics: m
          ? {
              healthScore: m.healthScore,
              parseFailures: m.parseFailures,
              repeatedTurns: m.repeatedTurns,
              progressRatio: m.progressRatio,
              rounds: m.rounds,
            }
          : undefined,
      });
      priorPrompt = this.debugCache.renderPriorAttemptsForPrompt(step.id);
    }
    transitionStep(step, 'FAILED', 'attempt-failed');
    this.lastFailure = {
      reason: lastResult.reason ?? lastReason,
      failureLog: lastResult.failureLog ?? lastFailureLog,
      rollbackTestStepId: lastResult.rollbackTestStepId,
    };
    await this.debugCache.markFailed(step.id, this.lastFailure.reason);
    await this.bugLifecycle.markBugFailed(activeBugTicketId, this.lastFailure.reason);
    if (this.terminalOutput) {
      presentStepFailure(this.log.bind(this), step, {
        attempts: attempt,
        budget,
        cap: absoluteCap,
        earlyAbort,
        reason: this.lastFailure.reason,
        failureLog: this.lastFailure.failureLog,
        metrics: lastResult.metrics,
      });
    }
    return false;
  }

  /** 一次执行尝试：可选 debug 模式（使用 Debugger 角色 + 注入失败日志）。 */
  private async runOneAttempt(
    plan: Plan,
    step: Step,
    debug?: DebugAttemptContext,
    attemptOpts: AttemptOptions = {},
  ): Promise<AttemptOutcome> {
    const role = debug ? 'Debugger' : step.role;
    await this.plugins.emit('step.attempt.before', {
      plan,
      step,
      role,
      debug: !!debug,
      retry: step.retries,
    });
    try {
      const outcome = await this.runOneAttemptCore(plan, step, debug, attemptOpts);
      if (debug && !outcome.ok) {
        await this.bugLifecycle.recordDebugWikiFailure(step, debug, outcome);
      }
      await this.plugins.emit('step.attempt.after', {
        plan,
        step,
        role,
        debug: !!debug,
        retry: step.retries,
        outcome,
      });
      return outcome;
    } catch (error) {
      const outcome = {
        ok: false,
        failureLog: error instanceof Error ? (error.stack ?? error.message) : String(error),
        reason: error instanceof Error ? error.message : String(error),
      };
      if (debug) {
        await this.bugLifecycle.recordDebugWikiFailure(step, debug, outcome);
      }
      await this.plugins.emit('step.attempt.after', {
        plan,
        step,
        role,
        debug: !!debug,
        retry: step.retries,
        outcome,
      });
      throw error;
    }
  }

  private async runOneAttemptCore(
    plan: Plan,
    step: Step,
    debug?: DebugAttemptContext,
    attemptOpts: AttemptOptions = {},
  ): Promise<AttemptOutcome> {
    if (this.isVModelTestPhase(step.phase)) {
      const completeness = await this.testPhases.inspect(plan, step);
      if (!completeness.ok) {
        const reason = `${step.phase} paired test cases are incomplete or invalid`;
        const assessment: StageQualityAssessment = {
          ...emptyQualityAssessment(),
          evidence: [
            completeness.testPlanPath ?? '',
            ...completeness.testArgs,
          ].filter(Boolean),
          gaps: [
            ...completeness.missing.map((item) => `missing test asset: ${item}`),
            ...completeness.invalid.map((item) => `invalid test asset: ${item}`),
          ],
        };
        const evaluation = evaluateQualityGate(step, assessment);
        await this.qualityAssessments.record(step, step.retries, assessment, evaluation);
        await this.opts.audit.event('phase.end', `${step.id} ${reason}`, {
          messageId: 'engine.test_case_completeness_failed',
          stepId: step.id,
          phase: step.phase,
          pairedSourcePhase:
            V_MODEL_TEST_TO_SOURCE_PHASE[step.phase as keyof typeof V_MODEL_TEST_TO_SOURCE_PHASE],
          testPlanPath: completeness.testPlanPath,
          testArgs: completeness.testArgs,
          missing: completeness.missing,
          invalid: completeness.invalid,
          rollbackToPairedSource: true,
        });
        return {
          ok: false,
          failureLog: completeness.failureLog,
          reason,
          workspaceReverted: false,
          rollbackToPairedSource: true,
          evidence: {
            stage: 'test-case-completeness',
            testPlanPath: completeness.testPlanPath,
            testArgs: completeness.testArgs,
            missing: completeness.missing,
            invalid: completeness.invalid,
          },
          qualityGap: { assessment, evaluation },
        };
      }
    }
    const role = debug ? 'Debugger' : step.role;
    let environment: AttemptEnvironment;
    let sha = '';
    try {
      environment = await buildAttemptEnvironment({
        workspace: this.opts.ws,
        sandbox: this.opts.sandbox,
        audit: this.opts.audit,
        router: this.opts.router,
        registry: this.registry,
        skills: this.skills,
        plugins: this.plugins,
        tickets: this.tickets,
        projectMemory: this.projectMemory,
        profile: this.profile,
        plan,
        step,
        role,
        debug,
        changeRequest: attemptOpts.changeRequest,
        terminalOutput: this.terminalOutput,
        maxRoundsPerStep: this.opts.maxRoundsPerStep,
        maxDebugRoundsPerStep: this.opts.maxDebugRoundsPerStep,
        maxEditLinesPerStep: this.opts.maxEditLinesPerStep,
        maxWriteChunkBytes: this.opts.maxWriteChunkBytes,
        requestPermission: this.opts.requestPermission,
        onToolEvent: this.opts.onToolEvent,
      });

      transitionStep(step, 'RUNNING', 'attempt-started');
      await this.workTickets.startStep(step);
      await this.persistPlan(plan);
      sha = await this.opts.git.snapshot(step.id, step.retries, debug ? 'debug retry' : 'before');
      if (attemptOpts.archiveOutputs) {
        for (const out of step.outputs) {
          await archiveIfExists(this.opts.ws, out, this.opts.audit);
        }
      }
      await this.opts.audit.event('phase.start', t().engine.phaseStart(step.id, debug ? 'DEBUG' : step.phase, step.title), {
        messageId: 'engine.phase_start',
        ticketId: this.tickets.workForStep(step.id)?.id,
        bugTicketId: debug?.bugTicketId,
        changeRequestTicketId: attemptOpts.changeRequest?.id,
        enhanceTicketId: attemptOpts.enhancement?.id,
        role,
        tools: environment.toolNames,
        snapshot: sha,
        retry: step.retries,
      });
    } catch (err) {
      const msg = (err as Error).message;
      const stack = (err as Error).stack ?? msg;
      let workspaceReverted = false;
      let rollbackError: string | undefined;
      if (sha) {
        try {
          await this.opts.git.revertTo(sha);
          workspaceReverted = true;
        } catch (rollbackErr) {
          rollbackError = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        }
      }
      const failureLog = rollbackError
        ? `${stack}\nGit rollback failed: ${rollbackError}`
        : stack;
      await this.opts.audit.event('phase.end', t().engine.phaseException(step.id, msg), {
        messageId: 'engine.phase_exception',
        error: msg,
        stack,
        rollbackError,
        stage: 'attempt-preparation',
        role,
        retry: step.retries,
      });
      return {
        ok: false,
        failureLog,
        reason: msg,
        workspaceReverted,
        bugKind: 'exception',
        evidence: { stage: 'attempt-preparation', role },
      };
    }
    const {
      executor,
      tools: guardedTools,
      context: ctx,
      contextSnippets: ctxSnippets,
      skillHints: hints,
    } = environment;

    const spin = debug
      ? null
      : this.spin(
          t().engine.spinStepRunning(step.id, step.phase, chalk.bold(step.title)),
          { animate: false },
        );
    const debugFailureLog = debug ? cleanFailureLogForDebugContext(debug.failureLog) : undefined;
    const debugPayload = debug
      ? await buildDebugPromptPayload({
          step,
          debug,
          failureLog: debugFailureLog ?? debug.failureLog,
          tickets: this.tickets,
          debugWiki: this.debugWiki,
          audit: this.opts.audit,
          language: this.profile.id,
        })
      : undefined;
    try {
      const r = await executor.run({
        step,
        executionRole: role,
        tools: guardedTools,
        ctx,
        contextSnippets: ctxSnippets,
        ticket: this.tickets.workForStep(step.id),
        changeRequest: attemptOpts.changeRequest,
        enhancement: attemptOpts.enhancement,
        skillHints: hints,
        debugContext: debug
          ? {
              bugTicketId: debug.bugTicketId,
              reason: debug.reason,
              failureLog: debugPayload?.failureLog ?? debugFailureLog ?? debug.failureLog,
              debugBrief: debugPayload?.debugBrief,
              repairRequired: !debug.completedBeforeDebug,
              suggestions: [
                debugPayload?.suggestions,
                debug.priorAttemptsPrompt,
              ].filter(Boolean).join('\n\n'),
            }
          : undefined,
        globalPrompt: plan.globalPrompt,
        languageProfile: this.profile,
      });
      const verify = await verifyOutputs({ step, tools: guardedTools, ctx });
      if (
        this.isVModelTestPhase(step.phase) &&
        shouldRollbackTestPhaseFromToolFailures(r.toolCalls)
      ) {
        const reason = `${step.phase} tool verification failed; rolling back to paired V-model source phase.`;
        const failureLog = [
          t().engine.reasonLine(reason),
          t().engine.roundsLine(r.rounds),
          t().engine.toolCallsHeader,
          ...r.toolCalls.map((c) =>
            t().engine.toolCallLine(c.tool, c.ok, compactToolCallFailureDetail(c)),
          ),
        ].join('\n');
        spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
        await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, !!debug, reason), {
          messageId: 'engine.phase_failed',
          rounds: r.rounds,
          reason,
          retry: step.retries,
          metrics: r.metrics,
          rollbackToPairedSource: true,
        });
        await this.preserveFailedValidationEvidence(step, reason);
        return {
          ok: false,
          failureLog,
          reason,
          workspaceReverted: false,
          metrics: r.metrics,
          rollbackToPairedSource: true,
          bugKind: step.phase === 'FUNCTIONAL_TEST' ? 'functional-gate' : 'test-gate',
          evidence: { toolCalls: r.toolCalls },
        };
      }
      if (this.isVModelTestPhase(step.phase) && r.validationDefect) {
        const reason =
          `${step.phase} found an incomplete or inconsistent paired test contract; ` +
          'rolling back to the paired V-model source phase.';
        const failureLog = [
          t().engine.reasonLine(reason),
          `Validation defect: ${r.validationDefect}`,
          t().engine.roundsLine(r.rounds),
          t().engine.toolCallsHeader,
          ...r.toolCalls.map((call) =>
            t().engine.toolCallLine(call.tool, call.ok, compactToolCallFailureDetail(call)),
          ),
        ].join('\n');
        spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
        await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, !!debug, reason), {
          messageId: 'engine.validation_defect_reported',
          stepId: step.id,
          phase: step.phase,
          validationDefect: r.validationDefect,
          rounds: r.rounds,
          retry: step.retries,
          metrics: r.metrics,
          rollbackToPairedSource: true,
        });
        await this.preserveFailedValidationEvidence(step, reason);
        return {
          ok: false,
          failureLog,
          reason,
          workspaceReverted: false,
          metrics: r.metrics,
          rollbackToPairedSource: true,
          bugKind: step.phase === 'FUNCTIONAL_TEST' ? 'functional-gate' : 'test-gate',
          evidence: {
            stage: 'semantic-test-validation',
            validationDefect: r.validationDefect,
            toolCalls: r.toolCalls,
          },
        };
      }
      if (r.success && verify.ok) {
        // HIGH_LEVEL_DESIGN 阶段强制验收门：概要设计文档必须逐项覆盖 Plan 的结构化模块契约。
        if (step.phase === 'HIGH_LEVEL_DESIGN' && (plan.architectureModules?.length ?? 0) > 0) {
          const architecture = await this.opts.ws.readFile(DOC_NAMES.highLevelDesign);
          const missingTokens = missingArchitectureDocumentTokens(
            architecture,
            plan.architectureModules ?? [],
          );
          if (missingTokens.length > 0) {
            const reason = t().engine.archGateReason(missingTokens.length);
            const assessment: StageQualityAssessment = {
              completion: Math.max(
                0,
                1 - missingTokens.length /
                  Math.max(1, missingTokens.length + (plan.architectureModules?.length ?? 0)),
              ),
              upstreamAlignment: 1,
              metrics: {},
              tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
              evidence: [DOC_NAMES.highLevelDesign],
              gaps: missingTokens.map((token) => `missing architecture contract token: ${token}`),
            };
            const evaluation = evaluateQualityGate(step, assessment);
            await this.qualityAssessments.record(step, step.retries, assessment, evaluation);
            const failureLog = [
              t().engine.reasonLine(reason),
              t().engine.roundsLine(r.rounds),
              t().engine.archGateMissing(missingTokens.join(', ')),
              t().engine.archGateInstruction(DOC_NAMES.highLevelDesign),
            ].join('\n');
            spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
            await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, !!debug, reason), {
              messageId: 'engine.phase_failed',
              rounds: r.rounds,
              reason,
              retry: step.retries,
            });
            return {
              ok: false,
              failureLog,
              reason,
              workspaceReverted: false,
              metrics: r.metrics,
              evidence: { missingTokens },
              qualityGap: {
                assessment,
                evaluation,
                remediationTarget: 'same-step',
              },
            };
          }
        }

        // CODE 阶段先通过语言级静态校验再进入右侧测试链，避免语法/类型错误
        // 延迟到集成测试后才暴露。失败产物会保留，供同阶段 Debugger 修复。
        if (
          step.phase === 'CODE' &&
          shouldRunCodeValidation(plan, step) &&
          await hasCodeValidationPrerequisites(this.opts.ws, this.profile.id)
        ) {
          const command = codeValidationCommand(this.profile.id);
          const permission = await this.requestEnginePermission({
            operationType: 'build_command',
            target: command.display,
            reason: 'Validate generated source syntax and type contracts before completing the CODE phase.',
            risk: 'This executes the language compiler in the configured project sandbox.',
            scope: 'current workspace sandbox',
            skippable: false,
            denyBehavior: 'Fail the CODE phase because invalid source cannot safely enter the V-model test chain.',
            stepId: step.id,
          });
          if (!permission.approved) {
            const reason = `permission denied for CODE validation ${step.id}`;
            const failureLog = [t().engine.reasonLine(reason), permission.reason ?? ''].filter(Boolean).join('\n');
            spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
            await this.opts.git.snapshot(step.id, step.retries, 'code validation denied preserved');
            return {
              ok: false,
              failureLog,
              reason,
              workspaceReverted: false,
              metrics: r.metrics,
              bugKind: 'infrastructure',
              evidence: { stage: 'code-validation', permissionDenied: true, command: command.display },
            };
          }
          const validation = await this.opts.sandbox.exec(command.cmd, command.args, {});
          if (validation.exitCode !== 0 || validation.timedOut) {
            const tail = (value: string) => value.split('\n').slice(-40).join('\n');
            const reason =
              `CODE validation failed: ${command.display} exit=${validation.exitCode}` +
              (validation.timedOut ? ' timedOut=true' : '');
            const failureLog = [
              t().engine.reasonLine(reason),
              t().engine.commandLine(command.display),
              t().engine.stdoutTailHeader,
              tail(validation.stdout),
              t().engine.stderrTailHeader,
              tail(validation.stderr),
            ].join('\n');
            spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
            await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, !!debug, reason), {
              messageId: 'engine.code_validation_failed',
              rounds: r.rounds,
              reason,
              retry: step.retries,
              command: command.display,
              exitCode: validation.exitCode,
              timedOut: validation.timedOut,
            });
            await this.opts.git.snapshot(step.id, step.retries, 'code validation failed preserved');
            return {
              ok: false,
              failureLog,
              reason,
              workspaceReverted: false,
              metrics: r.metrics,
              bugKind: 'phase',
              evidence: {
                stage: 'code-validation',
                command: command.display,
                exitCode: validation.exitCode,
                timedOut: validation.timedOut,
                stdout: validation.stdout,
                stderr: validation.stderr,
              },
            };
          }
        }

        // 测试阶段强制验收门：必须测试退出码 0，否则按 V 模型映射回退到对应左侧阶段。
        if (this.isVModelTestPhase(step.phase)) {
          const permission = await this.requestEnginePermission({
            operationType: 'test_command',
            target: `${this.profile.id} test gate for ${step.id}`,
            reason: 'Validate the test phase before marking the V-model step complete.',
            risk: 'Project test commands execute code in the configured sandbox.',
            scope: 'current workspace sandbox',
            skippable: true,
            denyBehavior: 'Fail this test gate, create a Bug Ticket, and route it through normal V-model debug handling.',
            stepId: step.id,
          });
          if (!permission.approved) {
            const reason = `permission denied for test gate ${step.id}`;
            const failureLog = [
              t().engine.reasonLine(reason),
              permission.reason ?? '',
            ].filter(Boolean).join('\n');
            spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
            await this.preserveFailedValidationEvidence(step, reason);
            return {
              ok: false,
              failureLog,
              reason,
              workspaceReverted: false,
              metrics: r.metrics,
              rollbackToPairedSource: true,
              bugKind: step.phase === 'FUNCTIONAL_TEST' ? 'functional-gate' : 'test-gate',
              evidence: { permissionDenied: true },
            };
          }
          const testArgs = this.testGateArgsForStep(plan, step);
          const pt = await this.opts.sandbox.runTests(testArgs, {});
          if (pt.exitCode !== 0 || pt.timedOut) {
            const tail = (s: string) => s.split('\n').slice(-30).join('\n');
            const reason = t().engine.testGateReason(pt.exitCode, !!pt.timedOut);
            const ownerTestStep = findOwningTestStepForFailure(
              plan,
              step,
              `${pt.stdout}\n${pt.stderr}`,
            );
            const failedTestPaths = extractFailedTestPaths(`${pt.stdout}\n${pt.stderr}`);
            const failureLog = [
              t().engine.reasonLine(reason),
              t().engine.roundsLine(r.rounds),
              t().engine.testStdoutTailHeader,
              tail(pt.stdout),
              t().engine.testStderrTailHeader,
              tail(pt.stderr),
            ].join('\n');
            spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
            await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, !!debug, reason), {
              messageId: 'engine.phase_failed',
              rounds: r.rounds,
              reason,
              retry: step.retries,
            });
            await this.preserveFailedValidationEvidence(step, reason);
            return {
              ok: false,
              failureLog,
              reason,
              workspaceReverted: false,
              metrics: r.metrics,
              rollbackToPairedSource: true,
              rollbackTestStepId: ownerTestStep?.id,
              bugKind: step.phase === 'FUNCTIONAL_TEST' ? 'functional-gate' : 'test-gate',
              evidence: {
                exitCode: pt.exitCode,
                timedOut: pt.timedOut,
                testArgs,
                failedTestPaths,
                rollbackTestStepId: ownerTestStep?.id,
                stdout: pt.stdout,
                stderr: pt.stderr,
              },
            };
          }
        }

        // FUNCTIONAL_TEST 阶段强制验收门：必须能运行入口 `--help` 退出码 0。
        // 配合 autoFixImports 已经把常见 import 错误自动修掉，这里只兜底真实业务错误。
        if (step.phase === 'FUNCTIONAL_TEST') {
          // gate 前重跑 auto-fix，覆盖上游修复后遗留的导入路径变化。
          await this.profile.autoFixImports?.(this.opts.ws, this.opts.audit);
          const permission = await this.requestEnginePermission({
            operationType: 'shell_command',
            target: `${this.profile.id} functional entry probe`,
            reason: 'Validate the generated project entrypoint before final delivery.',
            risk: 'This executes project code in the configured sandbox.',
            scope: 'current workspace sandbox',
            skippable: true,
            denyBehavior: 'Fail the functional gate, create a Bug Ticket, and route it through normal V-model debug handling.',
            stepId: step.id,
          });
          if (!permission.approved) {
            const reason = `permission denied for functional probe ${step.id}`;
            const failureLog = [
              t().engine.reasonLine(reason),
              permission.reason ?? '',
            ].filter(Boolean).join('\n');
            spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
            await this.preserveFailedValidationEvidence(step, reason);
            return {
              ok: false,
              failureLog,
              reason,
              workspaceReverted: false,
              metrics: r.metrics,
              rollbackToPairedSource: true,
              bugKind: 'functional-gate',
              evidence: { permissionDenied: true },
            };
          }
          const probe = await this.profile.probeEntry(this.opts.ws, this.opts.sandbox);
          if (!probe.ok) {
            const reason = t().engine.deliveryGateReason(probe.command, probe.exitCode, !!probe.timedOut);
            const fixHints = t().engine.deliveryFixHints(this.profile.id);
            const failureLog = [
              t().engine.reasonLine(reason),
              t().engine.roundsLine(r.rounds),
              t().engine.commandLine(probe.command),
              t().engine.stdoutTailHeader,
              probe.stdoutTail,
              t().engine.stderrTailHeader,
              probe.stderrTail,
              '',
              ...fixHints,
            ].join('\n');
            spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
            await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, !!debug, reason), {
              messageId: 'engine.phase_failed',
              rounds: r.rounds,
              reason,
              retry: step.retries,
            });
            await this.preserveFailedValidationEvidence(step, reason);
            return {
              ok: false,
              failureLog,
              reason,
              workspaceReverted: false,
              metrics: r.metrics,
              rollbackToPairedSource: true,
              bugKind: 'functional-gate',
              evidence: {
                command: probe.command,
                exitCode: probe.exitCode,
                timedOut: probe.timedOut,
                stdoutTail: probe.stdoutTail,
                stderrTail: probe.stderrTail,
              },
            };
          }
        }
        if (debug?.completedBeforeDebug) {
          const reason = await this.repairArtifacts.violation(r.toolCalls);
          if (reason) {
            const failureLog = [
              t().engine.reasonLine(reason),
              t().engine.roundsLine(r.rounds),
              t().engine.toolCallsHeader,
              ...r.toolCalls.map((c) =>
                t().engine.toolCallLine(c.tool, c.ok, compactToolCallFailureDetail(c)),
              ),
            ].join('\n');
            spin?.fail(t().engine.phaseFailed(step.id, true, reason));
            await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, true, reason), {
              messageId: 'engine.phase_failed',
              rounds: r.rounds,
              reason,
              retry: step.retries,
            });
            await this.opts.git.revertTo(sha);
            return {
              ok: false,
              failureLog,
              reason,
              workspaceReverted: true,
              metrics: r.metrics,
              bugKind: 'phase',
              evidence: { completedBeforeDebug: true, repairRequired: true },
            };
          }
        }
        const qualityAssessment = r.qualityAssessment ?? emptyQualityAssessment();
        const qualityEvaluation = evaluateQualityGate(step, qualityAssessment);
        await this.qualityAssessments.record(
          step,
          step.retries,
          qualityAssessment,
          qualityEvaluation,
        );
        await this.opts.audit.event(
          qualityEvaluation.passed
            ? 'quality.gate.passed'
            : qualityEvaluation.bugFailures.length > 0
              ? 'quality.gate.bug'
              : 'quality.gate.enhance',
          `${step.id} ${step.phase} quality gate ${qualityEvaluation.passed ? 'passed' : 'failed'}`,
          {
            messageId: 'engine.quality_gate',
            stepId: step.id,
            phase: step.phase,
            policy: step.qualityGate,
            assessment: qualityAssessment,
            evaluation: qualityEvaluation,
          },
        );
        if (qualityEvaluation.bugFailures.length > 0) {
          const reason = `${step.phase} test execution exceeded tolerance`;
          return {
            ok: false,
            reason,
            failureLog: qualityEvaluation.bugFailures.join('\n'),
            workspaceReverted: false,
            metrics: r.metrics,
            rollbackToPairedSource: this.isVModelTestPhase(step.phase),
            bugKind: this.isVModelTestPhase(step.phase)
              ? step.phase === 'FUNCTIONAL_TEST' ? 'functional-gate' : 'test-gate'
              : 'phase',
            evidence: {
              stage: 'quality-tolerance',
              assessment: qualityAssessment,
              failures: qualityEvaluation.bugFailures,
            },
          };
        }
        if (qualityEvaluation.enhancementFailures.length > 0) {
          const reason = `${step.phase} quality targets are incomplete`;
          return {
            ok: false,
            reason,
            failureLog: qualityEvaluation.enhancementFailures.join('\n'),
            workspaceReverted: false,
            metrics: r.metrics,
            rollbackToPairedSource: this.isVModelTestPhase(step.phase),
            evidence: {
              stage: 'quality-gate',
              assessment: qualityAssessment,
              failures: qualityEvaluation.enhancementFailures,
            },
            qualityGap: {
              assessment: qualityAssessment,
              evaluation: qualityEvaluation,
            },
          };
        }
        if (attemptOpts.enhancement && r.metrics.providers.length > 0) {
          await this.tickets.recordModelAttribution(attemptOpts.enhancement, {
            providers: r.metrics.providers,
            role,
            contribution: 'author',
            outcome: 'repair-verified',
            stepId: step.id,
            phase: step.phase,
          });
          this.opts.router.recordTicketOutcome?.(
            r.metrics.providers,
            'repair-verified',
            attemptOpts.enhancement.id,
          );
        }
        const workTicket = this.tickets.workForStep(step.id);
        if (workTicket && r.metrics.providers.length > 0) {
          await this.tickets.recordModelAttribution(workTicket, {
            providers: r.metrics.providers,
            role,
            contribution: debug
              ? 'debugger'
              : this.isVModelTestPhase(step.phase)
                ? 'validator'
                : 'author',
            outcome: debug ? 'repair-verified' : 'produced',
            stepId: step.id,
            phase: step.phase,
          });
        }
        if (debug?.bugTicketId && r.metrics.providers.length > 0) {
          const bug = this.tickets.findBug(debug.bugTicketId);
          if (bug) {
            await this.tickets.recordModelAttribution(bug, {
              providers: r.metrics.providers,
              role: 'Debugger',
              contribution: 'debugger',
              outcome: 'repair-verified',
              stepId: step.id,
              phase: step.phase,
            });
          }
        }
        if (attemptOpts.changeRequest && r.metrics.providers.length > 0) {
          await this.tickets.recordModelAttribution(attemptOpts.changeRequest, {
            providers: r.metrics.providers,
            role,
            contribution: 'change-applier',
            outcome: 'change-applied',
            stepId: step.id,
            phase: step.phase,
          });
        }
        transitionStep(step, 'DONE', 'attempt-passed');
        await this.refreshCurrentProjectMemory(plan);
        const repair = debug?.bugTicketId
          ? await this.repairArtifacts.create(
              debug.bugTicketId,
              step,
              sha,
              !!debug.completedBeforeDebug,
              r.toolCalls,
            )
          : undefined;
        const completionCommit = await this.opts.git.snapshot(
          step.id,
          step.retries,
          attemptOpts.changeRequest
            ? `${attemptOpts.changeRequest.id} ${debug ? 'debug done' : 'done'}`
            : debug ? 'debug done' : 'done',
        );
        if (repair) {
          repair.baselineCommit = sha;
          repair.commit = completionCommit;
        }
        if (attemptOpts.changeRequest) {
          await this.changeRequests.recordApplicationFromAttempt(
            attemptOpts.changeRequest,
            step,
            !!debug,
            sha,
            completionCommit,
            r.bugResolutionPlan ?? r.finalThought,
          );
        }
        if (debug?.bugTicketId) {
          if (debug.contextMode === 'test-rollback') {
            await this.bugLifecycle.recordBugRepairReady(
              debug.bugTicketId,
              step,
              repair,
              r.bugResolutionPlan,
            );
          } else {
            await this.bugLifecycle.closeBug(
              debug.bugTicketId,
              step,
              repair,
              r.bugResolutionPlan,
            );
          }
        }
        spin?.succeed(t().engine.phaseDone(step.id, r.rounds));
        await this.opts.audit.event('phase.end', t().engine.phaseDone(step.id, r.rounds), {
          messageId: 'engine.phase_done', rounds: r.rounds, retry: step.retries,
        });
        // 不在这里调 markDone：executeStepWithDebug 中统一处理（避免 retry-loop 里双写）。
        return {
          ok: true,
          failureLog: '',
          bugResolutionPlan: r.bugResolutionPlan,
          metrics: r.metrics,
        };
      }
      let reason = r.error ?? t().engine.outputsMissing(verify.missing.join(', '));
      if (
        debug?.completedBeforeDebug &&
        !hasSuccessfulRepairMutation(r.toolCalls) &&
        hasFailedVerificationEvidence(r.toolCalls)
      ) {
        reason = 'completed phase debug finished with failed verification but without a successful repair mutation';
      }
      const m = r.metrics;
      const metricsLine = m
        ? t().engine.metricsLine(m.healthScore.toFixed(2), m.parseFailures, m.repeatedTurns, m.toolFailRatio.toFixed(2), m.progressRatio.toFixed(2))
        : t().engine.metricsUnavailable;
      const failureLog =
        [
          t().engine.reasonLine(reason),
          t().engine.roundsLine(r.rounds),
          metricsLine,
          t().engine.toolCallsHeader,
          ...r.toolCalls.map((c) =>
            t().engine.toolCallLine(c.tool, c.ok, compactToolCallFailureDetail(c)),
          ),
        ].join('\n');
      spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
      await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, !!debug, reason), {
        messageId: 'engine.phase_failed',
        rounds: r.rounds,
        reason,
        retry: step.retries,
        metrics: m,
      });
      const completionGap =
        !debug &&
        verify.missing.length > 0 &&
        r.toolCalls.every((call) => call.ok);
      if (completionGap) {
        const assessment: StageQualityAssessment = {
          completion: step.outputs.length === 0
            ? 0
            : Math.max(0, 1 - verify.missing.length / step.outputs.length),
          upstreamAlignment: 1,
          metrics: r.qualityAssessment?.metrics ?? {},
          tolerance: r.qualityAssessment?.tolerance ?? {
            failedTests: 0,
            skippedTests: 0,
            warnings: 0,
          },
          evidence: step.outputs.filter((output) => !verify.missing.includes(output)),
          gaps: verify.missing.map((output) => `missing required output: ${output}`),
        };
        const evaluation = evaluateQualityGate(step, assessment);
        await this.qualityAssessments.record(step, step.retries, assessment, evaluation);
        await this.opts.git.snapshot(step.id, step.retries, 'quality completion gap preserved');
        return {
          ok: false,
          failureLog,
          reason,
          workspaceReverted: false,
          metrics: m,
          evidence: {
            stage: 'stage-completion',
            missingOutputs: verify.missing,
          },
          qualityGap: {
            assessment,
            evaluation,
            remediationTarget: 'same-step',
          },
        };
      }
      // 普通阶段失败应回退到本次尝试起点；Debugger 失败则保留已提交的修复进展，
      // 否则下一轮 retry 会丢失上一轮 patch/rewrite，真实项目会在同一错误上反复打转。
      if (debug) {
        await this.opts.audit.event('note', `debug attempt failed; preserving workspace changes for next retry`, {
          messageId: 'engine.debug_failed_attempt_preserved',
          stepId: step.id,
          phase: step.phase,
          retry: step.retries,
          reason,
          metrics: m,
          previousSnapshot: sha,
        });
        await this.opts.git.snapshot(step.id, step.retries, 'debug failed preserved');
      } else {
        await this.opts.git.revertTo(sha);
      }
      return {
        ok: false,
        failureLog,
        reason,
        workspaceReverted: !debug,
        metrics: m,
        bugKind: 'phase',
        bugResolutionPlan: r.bugResolutionPlan,
      };
    } catch (err) {
      const msg = (err as Error).message;
      const stack = (err as Error).stack ?? msg;
      spin?.fail(t().engine.phaseException(step.id, msg));
      await this.opts.audit.event('phase.end', t().engine.phaseException(step.id, msg), {
        messageId: 'engine.phase_exception', error: msg, stack,
      });
      let workspaceReverted = false;
      let rollbackError: string | undefined;
      try {
        await this.opts.git.revertTo(sha);
        workspaceReverted = true;
      } catch (rollbackErr) {
        rollbackError = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        await this.opts.audit.event('phase.end', `Git rollback failed for ${step.id}: ${rollbackError}`, {
          messageId: 'engine.git_rollback_failed',
          stepId: step.id,
          snapshot: sha,
          rollbackError,
        });
      }
      return {
        ok: false,
        failureLog: rollbackError ? `${stack}\nGit rollback failed: ${rollbackError}` : stack,
        reason: msg,
        workspaceReverted,
        bugKind: 'exception',
      };
    }
  }

  private async persistPlan(plan: Plan): Promise<void> {
    await savePlan(this.opts.planPath, plan);
    await this.opts.onPlanProgress?.(plan);
  }

  private async refreshCurrentProjectMemory(plan: Plan): Promise<void> {
    try {
      this.projectMemory = await refreshProjectMemory(this.opts.ws, {
        planPath: this.opts.planPath,
        language: plan.language,
        intent: plan.intent,
      });
    } catch (err) {
      this.projectMemory = await loadProjectMemory(this.opts.ws);
      await this.opts.audit.event('note', t().engine.projectMemoryRefreshFailed((err as Error).message), {
        messageId: 'engine.project_memory_refresh_failed',
        planPath: this.opts.planPath,
      });
    }
  }

}

function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export {
  codeValidationCommand,
  collectRollbackRepairOutputs,
  shouldRunCodeValidation,
};
