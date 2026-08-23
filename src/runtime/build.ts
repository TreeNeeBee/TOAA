import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { loadConfigWithPath } from '../config/config.js';
import { LLMRouter } from '../llm/router.js';
import { reportRoleModelAdvice } from '../llm/role_advice.js';
import { ScoreStore, scoreStoreOptionsFromConfig } from '../llm/scores.js';
import { preflightProviders } from '../llm/preflight.js';
import { ProjectContainer } from '../workspace/project_container.js';
import { archiveIfExists } from '../workspace/doc_archive.js';
import {
  Planner,
  buildPlan,
  type ClarificationCategory,
  type ClarifyOption,
  type ClarifyQuestion,
  type DraftPhasePlan,
  type PlannerInput,
} from '../agents/planner.js';
import { PlanSchema } from '../core/plan.js';
import { DOC_NAMES } from '../core/docs.js';
import { loadIncrementalBaseline, isIncrementalIntent } from '../core/incremental.js';
import { lintPlan } from '../core/lint.js';
import { refreshProjectMemory } from '../core/project_memory.js';
import { renderPlanMarkdown } from '../core/render.js';
import { loadPhasePlan, savePhasePlan, savePlan } from '../core/storage.js';
import {
  buildPhasePlanCheckpoint,
  buildPhasePlanFromCurrentPlan,
  defaultPhasePlanPath,
  defaultPhasePlanStepPath,
} from '../core/phase_plan.js';
import { updateProjectFile } from '../core/project_file.js';
import {
  compileProjectExtension,
  compileProjectGraph,
  rebaseDraftPlanPhases,
  type CompiledProjectExtension,
  type CompiledProjectGraph,
} from '../domain/planning/compiler.js';
import { DomainAuditTrail } from '../application/observability/domain_audit_trail.js';
import { DomainObjectRepository } from '../infrastructure/repository/domain_object_repository.js';
import { AuditLogger } from '../audit/audit.js';
import { acquireLock, LockError } from '../core/lock.js';
import { setLocale, t } from '../i18n/index.js';
import type { Language, PlanIntent } from '../core/plan.js';
import { PluginHost } from '../plugins/host.js';
import type { XCompilerPlugin } from '../plugins/types.js';
import { hasXcEnv, xcEnv } from '../config/env.js';
import {
  requireRuntimeInteraction,
  emitRuntimeEvent,
  runtimeLog,
  runtimeResult,
  silentRuntimeIO,
  type RuntimeIO,
} from './io.js';
import { createRuntimeRecordReplay } from './record_replay.js';
import type { RecordReplayMode } from '../application/record_replay/types.js';
import { ProjectGraphPersistenceService } from '../application/planning/project_graph_persistence_service.js';
import { ProjectPlanningGovernanceService } from '../application/planning/project_planning_governance_service.js';
import { FileProjectProjectionWriter } from '../infrastructure/projections/index.js';
import { Workspace } from '../workspace/workspace.js';
import { defaultRoleTemplatePath, loadRoleTemplates } from '../infrastructure/roles/role_template_store.js';
import {
  formatClarificationQuestion,
  resolveClarificationAnswer,
  resolveCompileLanguage,
} from '../application/planning/requirement_intake.js';
import { buildRuntimeCapabilities } from '../application/capabilities/runtime_capabilities.js';
import { validateImplementationPhaseDraft } from '../agents/planning/phase_strategy.js';

export {
  formatClarificationQuestion,
  inferCompileLanguageFromText,
  resolveClarificationAnswer,
  resolveCompileLanguage,
} from '../application/planning/requirement_intake.js';
export type {
  CompileLanguageResolution,
  CompileLanguageResolutionInput,
} from '../application/planning/requirement_intake.js';

export interface CompileOptions {
  workspace: string;
  /**
   * The Project's name.
   *
   * Carried as data rather than recovered from `workspace`. A name that round-trips through a
   * directory path cannot be read back reliably: which component is the name depends on the layout,
   * and under the container split the last component is the canonical branch, not the project.
   */
  name?: string;
  configPath?: string;
  inputFile?: string;
  /**
   * 已澄清的 topic.md 直接输入：跳过 intake / clarify / Addenda / Gate 1，把该文件
   * 内容当作冻结后的项目选题书，直接进入 decompose。常用于：
   *   - 用户上次已澄清并保留了 topic.md，重新跑 decompose 不想再问一遍
   *   - 离线编辑了 topic.md 想直接拿来出 phasePlan.json 与当前阶段计划
   * 与 --input 互斥；同时给则 --topic 优先并打印警告。
   */
  topicFile?: string;
  outputFile?: string;
  intent?: PlanIntent;
  baselinePlanFile?: string;
  yes?: boolean;
  force?: boolean;
  /** Optional XXX.xc project file to create/update with config, plan, and progress. */
  projectFilePath?: string;
  /** Project-file history command label; defaults to build. */
  projectCommand?: string;
  /** 程序化插件入口；动态插件加载将在后续版本基于它实现。 */
  plugins?: XCompilerPlugin[];
  pluginStrict?: boolean;
  /** Runtime event and interaction adapter. CLI supplies a terminal implementation; SDKs may stay silent. */
  io?: RuntimeIO;
  /** Override external-interaction fixture behavior for this invocation. */
  recordReplayMode?: RecordReplayMode;
  /** Workspace-relative fixture root override. */
  recordReplayPath?: string;
  /** Cancels active planning/provider requests. */
  abortSignal?: AbortSignal;
  /** Carried by evolve/append into their Run task; Build itself has no project tool permission loop. */
  permissionMode?: import('./io.js').RuntimePermissionPolicy;
}

/** CLI 可映射为退出码、程序化调用方可捕获并安全收尾的编译终止。 */
export class CompileExitError extends Error {
  constructor(public readonly exitCode: number, message: string) {
    super(message);
    this.name = 'CompileExitError';
  }
}

export async function runCompile(opts: CompileOptions): Promise<{ planPath?: string }> {
  const io = opts.io ?? silentRuntimeIO;
  // `-w <dir>` addresses the project container. Project state lives at <dir>/.xcompiler and the
  // working copy at <dir>/worktrees/<branch>, so a sandbox mounting the working copy cannot reach
  // XCompiler's own registry, audit trail, or fixtures.
  const container = new ProjectContainer(path.resolve(opts.workspace));
  const ws = container.canonical().workspace;
  const { config: cfg, path: cfgPath, missingEnv } = await loadConfigWithPath(opts.configPath);
  // Locale 必须在第一条输出之前生效，确保终端与审计文件从头到尾使用同一语言。
  if (!hasXcEnv('LANG')) setLocale(cfg.locale);
  if (missingEnv.length > 0) {
    await runtimeLog(io, 'warning', t().system.configEnvMissing(missingEnv.join(', ')));
  }
  await runtimeLog(io, 'success', t().compile.workspaceReady(ws.root));

  let lock;
  try {
    lock = await acquireLock(container.state.root, 'xcompiler_build', { force: !!opts.force });
  } catch (err) {
    if (err instanceof LockError) {
      await runtimeLog(io, 'error', t().system.unhandledError(err.message));
      throw new CompileExitError(6, err.message);
    }
    throw err;
  }
  if (opts.force) {
    await runtimeLog(io, 'warning', t().compile.forceOverride);
  }

  let scoreStore: ScoreStore | undefined;
  try {
  const M = t();
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'xcompiler_build' });
  await audit.start({
    workspace: ws.root,
    config: opts.configPath ?? '(default)',
    inputFile: opts.inputFile ?? '(stdin)',
    intent: opts.intent ?? 'greenfield',
    baselinePlanFile: opts.baselinePlanFile ?? '',
    yes: !!opts.yes,
    roles: cfg.llm.roles,
  });
  const pluginHost = new PluginHost({
    plugins: opts.plugins,
    strict: opts.pluginStrict,
    audit,
  });
  const capabilities = await buildRuntimeCapabilities(pluginHost);
  if (opts.topicFile && opts.inputFile) {
    await runtimeLog(io, 'warning', M.compile.topicInputConflict);
  }
  const topicMode = !!opts.topicFile;
  const intent = opts.intent ?? 'greenfield';
  await pluginHost.emit('compile.start', { workspace: ws.root, intent, topicMode });
  scoreStore = new ScoreStore(cfgPath, audit, scoreStoreOptionsFromConfig(cfg.llm));
  await scoreStore.load();
  const recordReplay = createRuntimeRecordReplay(cfg, container.control, {
    mode: opts.recordReplayMode,
    path: opts.recordReplayPath,
  });
  let unavailableProviders = new Set<string>();
  try {
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
    throw new CompileExitError(7, (err as Error).message);
  }
  const router = new LLMRouter(
    cfg,
    audit,
    scoreStore,
    unavailableProviders,
    pluginHost,
    undefined,
    recordReplay,
    cfgPath,
  );
  await reportRoleModelAdvice(router, audit, (message) => runtimeLog(io, 'warning', message));
  const baseline =
    isIncrementalIntent(intent)
      ? await loadIncrementalBaseline(ws, container.state, {
          planPath: opts.baselinePlanFile ?? container.phasePlanPath(),
        })
      : { summary: '', sources: [] };
  if (isIncrementalIntent(intent) && !baseline.summary) {
    const msg = M.compile.baselineMissing(ws.root);
    await runtimeLog(io, 'error', msg);
    await audit.end({ status: 'aborted', reason: 'incremental baseline missing', workspace: ws.root });
    throw new CompileExitError(8, msg);
  }
  if (baseline.summary) {
    await runtimeLog(io, 'success', M.compile.baselineLoaded(intent, baseline.sources.join(', ')));
  }
  const plannerClient = router.for('Planner');
  // Everything the user is asked or told comes from PM. It owns the project's conversation with
  // its owner; a Step-executing role talking to the user is that role negotiating its own scope.
  const pmClient = router.for('ProjectManager');

  const trace = (msg: string) => {
    if (xcEnv('TRACE') === '1') {
      void runtimeLog(io, 'dim', t().audit.traceLine('xcompiler-trace', msg));
    }
  };

  // 1. Intake — topic 模式下读取已有 topic.md 直接当作 raw
  let rawRequirement: string;
  if (topicMode) {
    trace('topic.read');
    rawRequirement = await fs.readFile(path.resolve(opts.topicFile!), 'utf8');
    if (!rawRequirement.trim()) {
      await runtimeLog(io, 'error', M.compile.topicEmptyExit);
      await audit.end({ status: 'aborted', reason: 'empty topic file' });
      throw new CompileExitError(1, M.compile.topicEmptyExit);
    }
    await audit.userInput(M.compile.auditTopicInput, rawRequirement);
    await runtimeLog(io, 'success', M.compile.topicLoaded(path.resolve(opts.topicFile!)));
  } else {
    trace('intake.start');
    rawRequirement = await intake(opts.inputFile, io);
    trace(`intake.done len=${rawRequirement.length}`);
    if (!rawRequirement.trim()) {
      await runtimeLog(io, 'error', M.compile.requirementEmptyExit);
      await audit.end({ status: 'aborted', reason: 'empty requirement' });
      throw new CompileExitError(1, M.compile.requirementEmptyExit);
    }
    trace('audit.userInput.intake');
    await audit.userInput(M.compile.auditOriginalRequirement, rawRequirement);
    trace('audit.userInput.intake.done');
  }

  const initialLanguage = resolveCompileLanguage({
    rawRequirement,
    intent,
    baseline,
  });

  // 2. Clarify — topic 模式跳过（topic.md 已经是冻结后的选题书）
  trace('clarify.section.enter');
  const clarifications: Array<{
    question: string;
    answer: string;
    category?: ClarificationCategory;
    why?: string;
    options?: ClarifyOption[];
  }> = [];
  let clarificationQuestions: ClarifyQuestion[] = [];
  trace(`clarify.section.flag yes=${opts.yes} topicMode=${topicMode}`);
  if (!opts.yes && !topicMode) {
    const clarifyPlanner = new Planner(
      pmClient,
      audit,
      initialLanguage.language,
      io.terminalOutput === true,
      opts.abortSignal,
      capabilities.skills,
    );
    trace('ora.clarify.start');
    const spin = io.progress(M.compile.spinClarify, { animate: false });
    trace('ora.clarify.started');
    try {
      trace('planner.clarify.call');
      clarificationQuestions = await clarifyPlanner.clarify(rawRequirement, {
        intent,
        hasBaseline: !!baseline.summary,
        languageAmbiguous: initialLanguage.ambiguous,
      });
      trace(`planner.clarify.return n=${clarificationQuestions.length}`);
      spin.succeed(M.compile.clarifySucceed(clarificationQuestions.length));
    } catch (err) {
      spin.fail(M.compile.clarifyFail);
      throw err;
    }
    const interaction = requireRuntimeInteraction(io, 'clarification questions');
    for (const q of clarificationQuestions) {
      const rawAnswer = await interaction.input({ message: formatClarificationQuestion(q) });
      const ans = resolveClarificationAnswer(q, rawAnswer);
      clarifications.push({ question: q.question, answer: ans, category: q.category, why: q.why, options: q.options });
      await audit.userInput(M.compile.auditClarifyAnswer(q.id, q.question), ans);
    }
  }

  // 2.5 用户自定义补充需求（预留位，可为空）— topic 模式下也跳过（topic.md 应已自含全部上下文）
  let userAddenda = '';
  if (!opts.yes && !topicMode) {
    const interaction = requireRuntimeInteraction(io, 'user addenda');
    const want = await interaction.confirm({
      message: M.compile.addendaConfirm,
      default: false,
    });
    if (want) {
      userAddenda = (
        await interaction.editor({
          message: M.compile.addendaEditorMsg,
          default: '',
          postfix: '.md',
        })
      ).trim();
      if (userAddenda) {
        await audit.userInput(M.compile.auditUserAddenda, userAddenda);
      }
    }
  }
  const clarifyContext = {
    rawRequirement,
    questions: clarificationQuestions,
    clarifications,
    userAddenda,
  };
  await pluginHost.emit('compile.afterClarify', clarifyContext);
  rawRequirement = clarifyContext.rawRequirement;
  clarificationQuestions = clarifyContext.questions;
  userAddenda = clarifyContext.userAddenda;

  // 3. Draft topic.md + 确认门 1
  //   topic.md 是“需求澄清后的项目选题书”，作为后续 V 模型拆解的唯一输入。
  //   topic 模式下：rawRequirement 就是用户传入的 topic.md 全文，直接落盘，不再 render/Gate 1。
  const draftWs = container.state;
  const draftDir = 'drafts/build';
  const draftTopic = `${draftDir}/topic.md`;
  trace('state.ensure.draftDir');
  await draftWs.ensure(draftDir);
  let topicMd: string;
  if (topicMode) {
    topicMd = rawRequirement;
    await draftWs.writeFile(draftTopic, topicMd);
  } else {
    trace('renderTopicDraft');
    topicMd = renderTopicDraft(rawRequirement, clarifications, userAddenda);
    trace('ws.writeFile.draftTopic');
    await draftWs.writeFile(draftTopic, topicMd);
    trace('ws.writeFile.draftTopic.done');

    if (!opts.yes) {
      await runtimeLog(io, 'accent', `\n${M.compile.topicPreviewHeader}`);
      await runtimeLog(io, 'raw', topicMd);
      await runtimeLog(io, 'accent', M.compile.topicPreviewFooter);
      const interaction = requireRuntimeInteraction(io, 'topic confirmation gate');
      const decision = await interaction.select({
        message: M.compile.gate1Confirm,
        choices: [
          { name: M.compile.gate1ChoiceConfirm, value: 'confirm' },
          { name: M.compile.gate1ChoiceEdit, value: 'edit' },
          { name: M.compile.gate1ChoiceCancel, value: 'cancel' },
        ],
      });
      await audit.userDecision(M.compile.gate1AuditLabel, decision);
      if (decision === 'cancel') {
        await draftWs.remove(draftDir);
        await runtimeLog(io, 'warning', M.compile.gate1Cancelled);
        await audit.end({ status: 'cancelled', gate: 1 });
        await runtimeResult(io, 'build', 'cancelled', { gate: 1 });
        return {};
      }
      if (decision === 'edit') {
        const edited = await interaction.editor({ message: M.compile.editTopicMsg, default: topicMd, postfix: '.md' });
        await draftWs.writeFile(draftTopic, edited);
        await audit.userInput(M.compile.auditEditedTopic, edited);
      }
    }
  }

  // 3.5 立即把 topic.md 写到最终位置（docs/topic.md），不再等到第 7 步。
  //   这样即使后续 decompose / lint 失败，已澄清的 topic 仍然落盘，
  //   下次可用 `xcompiler build --topic docs/topic.md` 直接重跑而不必再澄清一次。
  trace('ws.readFile.finalTopic');
  const finalTopicMd = await draftWs.readFile(draftTopic);
  const languageResolution = resolveCompileLanguage({
    rawRequirement: finalTopicMd,
    clarifications,
    userAddenda,
    intent,
    baseline,
  });
  const language = languageResolution.language;
  await audit.event('note', `target language resolved: ${language}`, {
    messageId: 'compile.language_resolved',
    language,
    source: languageResolution.source,
    ambiguous: languageResolution.ambiguous,
  });
  await archiveIfExists(ws, DOC_NAMES.topic, audit, container.state);
  await ws.writeFile(DOC_NAMES.topic, finalTopicMd);
  await audit.event('topic.persist', M.compile.auditTopicPersisted(ws.abs(DOC_NAMES.topic)), {
    messageId: 'compile.topic_persisted',
    topicPath: ws.abs(DOC_NAMES.topic),
    mode: topicMode ? 'topic-input' : 'clarified',
  });
  await runtimeLog(io, 'success', M.compile.topicWritten(ws.abs(DOC_NAMES.topic)));

  // 4. Decompose — with topic.md as the V-model input
  const phasePlanPath = opts.outputFile
    ? assertControlFilePath(container, path.resolve(opts.outputFile), 'PhasePlan')
    : defaultPhasePlanPath(container.control.root);
  const phasePlanSourceDigest = buildPhasePlanSourceDigest({
    topic: finalTopicMd,
    language,
    intent,
    baselineSummary: baseline.summary,
    userAddenda,
  });
  let existingPhasePlan = await tryLoadPhasePlan(phasePlanPath);
  const phasePlanBaseline = existingPhasePlan;
  trace('ora.spin2.start');
  const spin2 = io.progress(M.compile.spinDecompose, { animate: false });
  trace('ora.spin2.started');
  let draft;
  try {
    const planner = new Planner(
      plannerClient,
      audit,
      language,
      io.terminalOutput === true,
      opts.abortSignal,
      capabilities.skills,
    );
    const plannerInput: PlannerInput = {
      rawRequirement: finalTopicMd,
      clarifications,
      userAddenda,
      baselineContext: baseline.summary,
      intent,
    };
    const decomposeContext = { input: plannerInput };
    await pluginHost.emit('compile.beforeDecompose', decomposeContext);
    const checkpointValidationIssue = existingPhasePlan
      ? validateImplementationPhaseDraft(
          existingPhasePlan.phases.map(({ planPath: _planPath, ...phase }) => phase),
          existingPhasePlan.complexityAssessment,
          {
            language,
            expectedCurrentPhaseId: existingPhasePlan.currentPhaseId,
          },
        )
      : undefined;
    const reusableCheckpoint =
      !opts.force &&
      existingPhasePlan?.sourceDigest === phasePlanSourceDigest &&
      existingPhasePlan.language === language &&
      existingPhasePlan.intent === intent &&
      !checkpointValidationIssue;
    if (checkpointValidationIssue && existingPhasePlan) {
      await audit.event('note', `rejecting invalid PhasePlan checkpoint: ${checkpointValidationIssue}`, {
        messageId: 'compile.phase_plan_checkpoint_rejected',
        phasePlanPath,
        reason: checkpointValidationIssue,
      });
    }
    let draftPhasePlan: DraftPhasePlan;
    if (reusableCheckpoint && existingPhasePlan) {
      draftPhasePlan = {
        requirementDigest: existingPhasePlan.requirementDigest,
        globalPrompt: existingPhasePlan.globalPrompt,
        projectType: existingPhasePlan.projectType,
        complexityAssessment: existingPhasePlan.complexityAssessment,
        implementationPhases: existingPhasePlan.phases.map(({ planPath: _planPath, ...phase }) => phase),
      };
      await audit.event('note', `reusing PhasePlan checkpoint: ${phasePlanPath}`, {
        messageId: 'compile.phase_plan_checkpoint_reused',
        phasePlanPath,
        sourceDigest: phasePlanSourceDigest,
        currentPhaseId: existingPhasePlan.currentPhaseId,
      });
    } else {
      draftPhasePlan = await planner.planPhasePlan(decomposeContext.input);
      existingPhasePlan = buildPhasePlanCheckpoint({
        language,
        intent,
        projectType: draftPhasePlan.projectType,
        requirementDigest: draftPhasePlan.requirementDigest,
        complexityAssessment: draftPhasePlan.complexityAssessment,
        implementationPhases: draftPhasePlan.implementationPhases,
        globalPrompt: draftPhasePlan.globalPrompt,
        baselineSummary: baseline.summary,
        userAddenda,
        sourceDigest: phasePlanSourceDigest,
        existing: existingPhasePlan,
      });
      await savePhasePlan(phasePlanPath, existingPhasePlan);
      await audit.event('plan.persist', `PhasePlan checkpoint persisted: ${phasePlanPath}`, {
        messageId: 'compile.phase_plan_checkpoint_persisted',
        phasePlanPath,
        sourceDigest: phasePlanSourceDigest,
        currentPhaseId: existingPhasePlan.currentPhaseId,
      });
    }
    const currentPhase = draftPhasePlan.implementationPhases.find((phase) => phase.status === 'current') ??
      draftPhasePlan.implementationPhases[0];
    if (!currentPhase) throw new Error('PhasePlan checkpoint has no current phase.');
    draft = await planner.decomposePhase(
      decomposeContext.input,
      draftPhasePlan,
      currentPhase.id,
    );
  } catch (err) {
    spin2.fail(M.compile.decomposeFail);
    const msg = (err as Error).message ?? String(err);
    await runtimeLog(io, 'error', `${M.compile.plannerInvalidPlan} ${msg}`);
    const hints = isPlannerTransportFailure(msg)
      ? [M.compile.plannerTransportFailureHint1, M.compile.plannerTransportFailureHint2]
      : [M.compile.plannerInvalidPlanHint1, M.compile.plannerInvalidPlanHint2];
    for (const hint of hints) await runtimeLog(io, 'dim', hint);
    await audit.event('llm.error', M.compile.auditDecomposeFailed, {
      messageId: 'compile.decompose_failed', stage: 'decompose', error: msg,
    });
    await audit.end({ status: 'error', stage: 'decompose', error: msg });
    throw new CompileExitError(4, msg);
  }
  spin2.succeed(M.compile.decomposeSucceed(draft.steps.length));

  // 5. 构建并校验 plan
  let plan = buildPlan(draft, {
    userAddenda,
    language,
    intent,
    baselineSummary: baseline.summary,
  });
  capabilities.skills.validateRefs(plan.steps.flatMap((step) => step.tools));
  const planContext = { plan };
  await pluginHost.emit('compile.afterPlan', planContext);
  plan = planContext.plan;
  capabilities.skills.validateRefs(plan.steps.flatMap((step) => step.tools));
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) {
    await runtimeLog(io, 'error', M.compile.schemaFail);
    await runtimeLog(io, 'raw', JSON.stringify(parsed.error.format(), null, 2));
    await draftWs.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    await runtimeLog(io, 'dim', M.compile.schemaInvalidSavedAt(draftWs.abs(`${draftDir}/plan.invalid.json`)));
    throw new CompileExitError(2, M.compile.schemaFail);
  }
  const issues = lintPlan(parsed.data).filter((i) => i.level === 'error');
  if (issues.length > 0) {
    await runtimeLog(io, 'error', M.compile.lintFail(issues.length));
    for (const i of issues) await runtimeLog(io, 'raw', M.compile.lintIssue(i.stepId ?? '*', i.message));
    // 落到 draft 便于排查
    await draftWs.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    throw new CompileExitError(3, M.compile.lintFail(issues.length));
  }

  const repository = new DomainObjectRepository(container.state);
  await repository.load();
  const graphPersistence = new ProjectGraphPersistenceService(repository);
  const previousProject = await repository.findProject();
  let persistedPlan = parsed.data;
  if (isIncrementalIntent(intent)) {
    if (!previousProject) {
      throw new CompileExitError(
        8,
        'Incremental build requires a canonical Project in this workspace; run a greenfield build first.',
      );
    }
    if (previousProject.state !== 'closed') {
      throw new CompileExitError(
        8,
        `Incremental build requires the current Project to be closed; ${previousProject.name} is ${previousProject.state}.`,
      );
    }
    const previousPhases = await Promise.all(previousProject.phaseIds.map((id) => repository.read(id)));
    persistedPlan = PlanSchema.parse(rebaseDraftPlanPhases(
      parsed.data,
      previousPhases
        .filter((object) => object.objectType === 'phase')
        .map((phase) => phase.name),
    ));
    const rebasedIssues = lintPlan(persistedPlan).filter((issue) => issue.level === 'error');
    if (rebasedIssues.length > 0) {
      throw new CompileExitError(3, `Incremental Phase rebasing failed: ${rebasedIssues.map((issue) => issue.message).join('; ')}`);
    }
  }

  const planMd = renderPlanMarkdown(persistedPlan);
  await draftWs.writeFile(`${draftDir}/plan.md`, planMd);

  // 6. 确认门 2
  if (!opts.yes) {
    await runtimeLog(io, 'accent', `\n${M.compile.planPreviewHeader}`);
    await runtimeLog(io, 'raw', planMd.split('\n').slice(0, 60).join('\n'));
    if (planMd.split('\n').length > 60) await runtimeLog(io, 'dim', M.compile.planPreviewTruncated);
    await runtimeLog(io, 'accent', M.compile.planPreviewFooter);
    const interaction = requireRuntimeInteraction(io, 'plan confirmation gate');
    const ok = await interaction.confirm({
      message: M.compile.gate2Confirm,
      default: false,
    });
    await audit.userDecision(M.compile.gate2AuditLabel, ok ? 'confirm' : 'reject');
    if (!ok) {
      await draftWs.remove(draftDir);
      await runtimeLog(io, 'warning', M.compile.gate2Rejected);
      await audit.end({ status: 'rejected', gate: 2 });
      await runtimeResult(io, 'build', 'rejected', { gate: 2 });
      return {};
    }
  }

  // 7. Persist
  const planPath = defaultPhasePlanStepPath(path.dirname(phasePlanPath), persistedPlan.phaseId ?? 'P1');
  await savePlan(planPath, persistedPlan);
  const phasePlan = buildPhasePlanFromCurrentPlan({
    plan: persistedPlan,
    phasePlanPath,
    currentPlanPath: planPath,
    existing: isIncrementalIntent(intent) && phasePlanBaseline
      ? { ...phasePlanBaseline, sourceDigest: existingPhasePlan?.sourceDigest }
      : existingPhasePlan,
  });
  await savePhasePlan(phasePlanPath, phasePlan);
  // 归档上一版本（如有），再写入新版本。topic.md 已在第 3.5 步落盘，这里只处理 plan.
  await archiveIfExists(ws, DOC_NAMES.plan, audit, container.state);
  await ws.writeFile(DOC_NAMES.plan, planMd);
  await refreshProjectMemory(ws, container.state, {
    planPath,
    language: persistedPlan.language,
    intent: persistedPlan.intent,
  });
  await draftWs.remove(draftDir);
  await audit.event('plan.persist', M.compile.auditPlanPersisted(planPath), {
    messageId: 'compile.plan_persisted',
    planPath,
    phasePlanPath,
    steps: persistedPlan.steps.length,
  });
  let graph: CompiledProjectGraph | CompiledProjectExtension;
  if (previousProject && isIncrementalIntent(intent)) {
    const projectPlanObject = await repository.read(previousProject.projectPlanId);
    if (projectPlanObject.objectType !== 'plan' || projectPlanObject.planKind !== 'project') {
      throw new Error(`Project ${previousProject.name} does not reference a canonical ProjectPlan`);
    }
    const predecessorPhaseId = previousProject.phaseIds.at(-1)!;
    const predecessorPhaseObject = await repository.read(predecessorPhaseId);
    if (predecessorPhaseObject.objectType !== 'phase') {
      throw new Error(`Project ${previousProject.name} terminal object is not a Phase`);
    }
    const predecessorEpicObject = await repository.read(predecessorPhaseObject.epicTicketId);
    if (predecessorEpicObject.objectType !== 'ticket' || predecessorEpicObject.type !== 'epic') {
      throw new Error(`Phase ${predecessorPhaseObject.name} does not reference an Epic Ticket`);
    }
    const managementPlanObject = await repository.read(previousProject.managementPlanId);
    if (managementPlanObject.objectType !== 'project-management-plan') {
      throw new Error(`Project ${previousProject.name} does not reference a Project Management Plan`);
    }
    const actorObjects = await repository.list({
      objectType: 'actor-registration',
      projectId: previousProject.id,
    });
    const actors = actorObjects.filter(
      (object) => object.objectType === 'actor-registration',
    );
    const extension = compileProjectExtension({
      draft: persistedPlan,
      topic: finalTopicMd,
      topicSourceRef: DOC_NAMES.topic,
      projectName: previousProject.name,
      project: previousProject,
      projectPlan: projectPlanObject,
      predecessorPhase: predecessorPhaseObject,
      predecessorEpic: predecessorEpicObject,
      actors,
      managementPlan: managementPlanObject,
    });
    await graphPersistence.persistExtension(extension);
    graph = extension;
  } else {
    const compiled = compileProjectGraph({
      draft: persistedPlan,
      topic: finalTopicMd,
      topicSourceRef: DOC_NAMES.topic,
      // The container directory is the fallback, never the working copy underneath it: that is
      // always the canonical branch, so naming a Project after it would call every project "master".
      projectName: opts.name ?? path.basename(container.root) ?? 'project',
      roleTemplates: await loadRoleTemplates(defaultRoleTemplatePath(ws.root)),
    });
    await graphPersistence.persistGraph(compiled);
    if (previousProject) await repository.retireProject(previousProject.id);
    graph = compiled;
  }
  await new ProjectPlanningGovernanceService(
    repository,
    // Container state, not the working copy: see the note at the run-time writer.
    new FileProjectProjectionWriter(new Workspace(container.state.root)),
  ).baseline({
    project: graph.project,
    plan: persistedPlan,
    clarifications: clarifications.map((item) => ({
      question: item.question,
      answer: item.answer,
      why: item.why,
      options: item.options?.map((option) => `${option.label}. ${option.answer}`),
    })),
  });
  await new DomainAuditTrail(repository).recordEvent({
    projectId: graph.project.id,
    subject: { id: graph.projectPlan.activePhaseId, objectType: 'phase' },
    kind: 'workflow.project_planned',
    actor: 'xcompiler-runtime',
    correlationId: graph.projectPlan.id,
    payload: {
      projectPlanId: graph.projectPlan.id,
      phaseIds: graph.phases.map((phase) => phase.id),
      activePhaseId: graph.projectPlan.activePhaseId,
    },
  });
  await audit.event('plan.persist', `canonical domain graph persisted for ${graph.project.name}`, {
    messageId: 'compile.domain_graph_persisted',
    projectId: graph.project.id,
    projectPlanId: graph.projectPlan.id,
    phaseIds: graph.phases.map((phase) => phase.id),
    activePhaseId: graph.projectPlan.activePhaseId,
  });
  await emitRuntimeEvent(io, {
    type: 'workflow',
    event: 'project_planned',
    projectId: graph.project.id,
    phaseId: graph.projectPlan.activePhaseId,
    correlationId: graph.projectPlan.id,
    message: `${graph.phases.length} Phase(s) planned; ${graph.phases[0]?.name ?? 'P1'} materialized.`,
  });
  const projectFile = await updateProjectFile({
    workspace: ws.root,
    container: container.root,
    planPath: phasePlanPath,
    configPath: cfgPath,
    projectFilePath: opts.projectFilePath,
    projectId: graph.project.id,
    command: opts.projectCommand ?? 'build',
    intent,
    requirementFile: opts.inputFile,
    topicFile: opts.topicFile,
    recordHistory: true,
  });

  await runtimeLog(io, 'success', M.compile.planWritten(planPath));
  await runtimeLog(io, 'success', M.compile.phasePlanWritten(phasePlanPath));
  await runtimeLog(io, 'success', M.compile.projectFileWritten(projectFile));
  await runtimeLog(io, 'info', M.compile.nextCommand(`xcompiler run ${path.relative(process.cwd(), phasePlanPath)}`));
  await pluginHost.emit('compile.finish', { plan: persistedPlan, planPath: phasePlanPath, phasePlanPath, currentPlanPath: planPath });
  await audit.end({ status: 'ok', planPath, phasePlanPath, steps: persistedPlan.steps.length });
  await runtimeResult(io, 'build', 'ok', { planPath: phasePlanPath, currentPlanPath: planPath, steps: persistedPlan.steps.length });
  return { planPath: phasePlanPath };
  } finally {
    try { await scoreStore?.flush(); } catch { /* never block release */ }
    await lock.release();
  }
}

function assertControlFilePath(container: ProjectContainer, target: string, label: string): string {
  if (path.dirname(target) !== container.control.root) {
    throw new Error(`${label} must be stored in the project root ${container.control.root}: ${target}`);
  }
  return target;
}

function buildPhasePlanSourceDigest(input: {
  topic: string;
  language: Language;
  intent: PlanIntent;
  baselineSummary: string;
  userAddenda: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
}

function isPlannerTransportFailure(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('fetch failed') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('connection') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('socket') ||
    text.includes('terminated') ||
    text.includes('server closed')
  );
}

async function tryLoadPhasePlan(phasePlanPath: string) {
  try {
    return await loadPhasePlan(phasePlanPath);
  } catch {
    return undefined;
  }
}

async function intake(inputFile: string | undefined, io: RuntimeIO): Promise<string> {
  if (inputFile) {
    return fs.readFile(path.resolve(inputFile), 'utf8');
  }
  return requireRuntimeInteraction(io, 'requirement intake').readMultiline({
    message: t().compile.requirementInputHint,
  });
}

function renderTopicDraft(
  raw: string,
  qa: Array<{
    question: string;
    answer: string;
    category?: ClarificationCategory;
    why?: string;
    options?: ClarifyOption[];
  }>,
  addenda: string = '',
): string {
  const M = t().compile;
  const lines: string[] = [];
  lines.push(M.topicTitle);
  lines.push('');
  lines.push(M.topicPreamble);
  lines.push('');
  lines.push(M.topicSecRequirement);
  lines.push('');
  lines.push(raw.trim());
  lines.push('');
  if (qa.length > 0) {
    lines.push(M.topicSecClarify);
    lines.push('');
    for (const [i, c] of qa.entries()) {
      lines.push(`- **Q${i + 1}${c.category ? ` · ${c.category}` : ''}** ${c.question}`);
      if (c.why) lines.push(`  - **Why** ${c.why}`);
      if (c.options && c.options.length > 0) {
        lines.push('  - **Options**');
        for (const option of c.options) {
          lines.push(`    - ${option.label}. ${option.answer}`);
        }
      }
      lines.push(`  - **A** ${c.answer}`);
    }
    lines.push('');
  }
  const trimmed = addenda.trim();
  if (trimmed) {
    lines.push(M.topicSecAddenda);
    lines.push('');
    lines.push(trimmed);
    lines.push('');
  }
  return lines.join('\n');
}
