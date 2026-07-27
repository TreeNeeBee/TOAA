import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfigWithPath } from '../config/config.js';
import { LLMRouter } from '../llm/router.js';
import { reportRoleModelAdvice } from '../llm/role_advice.js';
import { ScoreStore, scoreStoreOptionsFromConfig } from '../llm/scores.js';
import { preflightProviders } from '../llm/preflight.js';
import { Workspace } from '../workspace/workspace.js';
import { archiveIfExists } from '../workspace/doc_archive.js';
import { Planner, buildPlan, type ClarificationCategory, type ClarifyOption, type ClarifyQuestion, type PlannerInput } from '../agents/planner.js';
import { PlanSchema } from '../core/plan.js';
import { DOC_NAMES } from '../core/docs.js';
import { loadIncrementalBaseline, isIncrementalIntent } from '../core/incremental.js';
import { lintPlan } from '../core/lint.js';
import { refreshProjectMemory } from '../core/project_memory.js';
import { renderPlanMarkdown } from '../core/render.js';
import { loadPhasePlan, savePhasePlan, savePlan } from '../core/storage.js';
import {
  buildPhasePlanFromCurrentPlan,
  defaultPhasePlanPath,
  defaultPhasePlanStepPath,
} from '../core/phase_plan.js';
import { updateProjectFile } from '../core/project_file.js';
import { AuditLogger } from '../audit/audit.js';
import { acquireLock, LockError } from '../core/lock.js';
import { setLocale, t } from '../i18n/index.js';
import type { Language, PlanIntent } from '../core/plan.js';
import { PluginHost } from '../plugins/host.js';
import type { XCompilerPlugin } from '../plugins/types.js';
import { hasXcEnv, xcEnv } from '../config/env.js';
import {
  requireRuntimeInteraction,
  runtimeLog,
  runtimeResult,
  silentRuntimeIO,
  type RuntimeIO,
} from './io.js';

export interface CompileOptions {
  workspace: string;
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
}

/** CLI 可映射为退出码、程序化调用方可捕获并安全收尾的编译终止。 */
export class CompileExitError extends Error {
  constructor(public readonly exitCode: number, message: string) {
    super(message);
    this.name = 'CompileExitError';
  }
}

export function formatClarificationQuestion(q: ClarifyQuestion): string {
  const choiceRange = formatClarificationChoiceRange(q.options);
  const lines = [
    `${q.id} [${q.category}] ${q.question}`,
    `  ↳ ${q.why}`,
  ];
  for (const option of q.options) {
    lines.push(`  ${option.label}. ${option.answer}`);
  }
  lines.push(`  ${t().compile.clarifyChoiceHint(choiceRange)}`);
  return lines.join('\n');
}

function formatClarificationChoiceRange(options: ClarifyOption[]): string {
  if (options.length === 0) return 'A-E';
  const first = options[0]?.label ?? 'A';
  const last = options[options.length - 1]?.label ?? first;
  return first === last ? first : `${first}-${last}`;
}

export function resolveClarificationAnswer(q: ClarifyQuestion, rawAnswer: string): string {
  const answer = rawAnswer.trim();
  const label = answer.toUpperCase();
  if (/^[A-E]$/u.test(label)) {
    const option = q.options.find((candidate) => candidate.label === label);
    if (option) return `${option.label}. ${option.answer}`;
  }
  return answer;
}

export interface CompileLanguageResolutionInput {
  rawRequirement: string;
  clarifications?: PlannerInput['clarifications'];
  userAddenda?: string;
  intent?: PlanIntent;
  baseline?: { language?: Language; languageSource?: string; summary?: string };
}

export interface CompileLanguageResolution {
  language: Language;
  source: 'baseline' | 'topic' | 'clarification' | 'default';
  ambiguous: boolean;
}

export function resolveCompileLanguage(
  configuredLanguage: Language,
  intent: PlanIntent,
  baseline: { language?: Language },
): Language;
export function resolveCompileLanguage(input: CompileLanguageResolutionInput): CompileLanguageResolution;
export function resolveCompileLanguage(
  inputOrConfigured: CompileLanguageResolutionInput | Language,
  intent?: PlanIntent,
  baseline?: { language?: Language },
): CompileLanguageResolution | Language {
  if (typeof inputOrConfigured === 'string') {
    return isIncrementalIntent(intent ?? 'greenfield')
      ? baseline?.language ?? inputOrConfigured
      : inputOrConfigured;
  }
  const input = inputOrConfigured;
  if (isIncrementalIntent(input.intent ?? 'greenfield') && input.baseline?.language) {
    return { language: input.baseline.language, source: 'baseline', ambiguous: false };
  }
  const topicInferred = inferCompileLanguageFromText(input.rawRequirement);
  if (topicInferred) {
    return {
      language: topicInferred,
      source: 'topic',
      ambiguous: false,
    };
  }
  const clarificationText = formatLanguageClarificationText(input.clarifications ?? []);
  const clarifiedInferred = inferCompileLanguageFromText([
    clarificationText,
    input.userAddenda ?? '',
  ].join('\n'));
  if (clarifiedInferred) {
    return { language: clarifiedInferred, source: 'clarification', ambiguous: false };
  }
  return { language: 'python', source: 'default', ambiguous: true };
}

export function inferCompileLanguageFromText(text: string): Language | undefined {
  const normalized = text
    .toLowerCase()
    .replace(/[，。；：、（）【】]/gu, ' ')
    .replace(/\s+/gu, ' ');
  const pythonStrong =
    /\bpython\b/u.test(normalized) ||
    /python\s*脚本/u.test(normalized) ||
    /\.py\b/u.test(normalized) ||
    /\bpytest\b/u.test(normalized) ||
    /\bpip\b/u.test(normalized);
  const typescriptStrong =
    /\btypescript\b/u.test(normalized) ||
    /\btype\s*script\b/u.test(normalized) ||
    /(^|[^a-z0-9])ts\s*(程序|工程|项目|脚本|语言|实现)/u.test(normalized) ||
    /\.tsx?\b/u.test(normalized) ||
    /\btsx\b/u.test(normalized);
  if (pythonStrong && !typescriptStrong) return 'python';
  if (typescriptStrong && !pythonStrong) return 'typescript';
  const pythonWeak =
    /\bopenpyxl\b/u.test(normalized) ||
    /\bpandas\b/u.test(normalized) ||
    /\bfastapi\b/u.test(normalized) ||
    /\bflask\b/u.test(normalized);
  const typescriptWeak =
    /\bnode(?:\.js)?\b/u.test(normalized) ||
    /\bnpm\b/u.test(normalized) ||
    /\bvitest\b/u.test(normalized) ||
    /\bpackage\.json\b/u.test(normalized) ||
    /\bjavascript\b/u.test(normalized) ||
    /\bjs\s*(程序|工程|项目|脚本|语言|实现)\b/u.test(normalized);
  if ((pythonStrong || pythonWeak) && !(typescriptStrong || typescriptWeak)) return 'python';
  if ((typescriptStrong || typescriptWeak) && !(pythonStrong || pythonWeak)) return 'typescript';
  return undefined;
}

function formatLanguageClarificationText(input: PlannerInput['clarifications']): string {
  return input
    .map((item) => [
      item.question,
      item.answer,
      item.why ?? '',
      ...(item.options ?? []).map((option) => option.answer),
    ].join('\n'))
    .join('\n\n');
}

export async function runCompile(opts: CompileOptions): Promise<{ planPath?: string }> {
  const io = opts.io ?? silentRuntimeIO;
  const ws = new Workspace(path.resolve(opts.workspace));
  const { config: cfg, path: cfgPath, missingEnv } = await loadConfigWithPath(opts.configPath);
  // Locale 必须在第一条输出之前生效，确保终端与审计文件从头到尾使用同一语言。
  if (!hasXcEnv('LANG')) setLocale(cfg.locale);
  if (missingEnv.length > 0) {
    await runtimeLog(io, 'warning', t().system.configEnvMissing(missingEnv.join(', ')));
  }
  await runtimeLog(io, 'success', t().compile.workspaceReady(ws.root));

  let lock;
  try {
    lock = await acquireLock(ws.root, 'xcompiler_build', { force: !!opts.force });
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
  const audit = new AuditLogger({ root: ws.root, command: 'xcompiler_build' });
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
  await pluginHost.initialize();
  if (opts.topicFile && opts.inputFile) {
    await runtimeLog(io, 'warning', M.compile.topicInputConflict);
  }
  const topicMode = !!opts.topicFile;
  const intent = opts.intent ?? 'greenfield';
  await pluginHost.emit('compile.start', { workspace: ws.root, intent, topicMode });
  scoreStore = new ScoreStore(cfgPath, audit, scoreStoreOptionsFromConfig(cfg.llm));
  await scoreStore.load();
  let unavailableProviders = new Set<string>();
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
    throw new CompileExitError(7, (err as Error).message);
  }
  const router = new LLMRouter(cfg, audit, scoreStore, unavailableProviders, pluginHost);
  await reportRoleModelAdvice(router, audit, (message) => runtimeLog(io, 'warning', message));
  const baseline =
    isIncrementalIntent(intent)
      ? await loadIncrementalBaseline(ws, { planPath: opts.baselinePlanFile })
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
    const clarifyPlanner = new Planner(plannerClient, audit, initialLanguage.language, io.terminalOutput === true);
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
  const draftDir = 'docs/.draft';
  const draftTopic = `${draftDir}/topic.md`;
  trace('ws.ensure.draftDir');
  await ws.ensure(draftDir);
  let topicMd: string;
  if (topicMode) {
    topicMd = rawRequirement;
    await ws.writeFile(draftTopic, topicMd);
  } else {
    trace('renderTopicDraft');
    topicMd = renderTopicDraft(rawRequirement, clarifications, userAddenda);
    trace('ws.writeFile.draftTopic');
    await ws.writeFile(draftTopic, topicMd);
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
        await ws.remove(draftDir);
        await runtimeLog(io, 'warning', M.compile.gate1Cancelled);
        await audit.end({ status: 'cancelled', gate: 1 });
        await runtimeResult(io, 'build', 'cancelled', { gate: 1 });
        return {};
      }
      if (decision === 'edit') {
        const edited = await interaction.editor({ message: M.compile.editTopicMsg, default: topicMd, postfix: '.md' });
        await ws.writeFile(draftTopic, edited);
        await audit.userInput(M.compile.auditEditedTopic, edited);
      }
    }
  }

  // 3.5 立即把 topic.md 写到最终位置（docs/topic.md），不再等到第 7 步。
  //   这样即使后续 decompose / lint 失败，已澄清的 topic 仍然落盘，
  //   下次可用 `xcompiler build --topic docs/topic.md` 直接重跑而不必再澄清一次。
  trace('ws.readFile.finalTopic');
  const finalTopicMd = await ws.readFile(draftTopic);
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
  await archiveIfExists(ws, DOC_NAMES.topic, audit);
  await ws.writeFile(DOC_NAMES.topic, finalTopicMd);
  await audit.event('topic.persist', M.compile.auditTopicPersisted(ws.abs(DOC_NAMES.topic)), {
    messageId: 'compile.topic_persisted',
    topicPath: ws.abs(DOC_NAMES.topic),
    mode: topicMode ? 'topic-input' : 'clarified',
  });
  await runtimeLog(io, 'success', M.compile.topicWritten(ws.abs(DOC_NAMES.topic)));

  // 4. Decompose — with topic.md as the V-model input
  trace('ora.spin2.start');
  const spin2 = io.progress(M.compile.spinDecompose, { animate: false });
  trace('ora.spin2.started');
  let draft;
  try {
    const planner = new Planner(plannerClient, audit, language, io.terminalOutput === true);
    const plannerInput: PlannerInput = {
      rawRequirement: finalTopicMd,
      clarifications,
      userAddenda,
      baselineContext: baseline.summary,
      intent,
    };
    const decomposeContext = { input: plannerInput };
    await pluginHost.emit('compile.beforeDecompose', decomposeContext);
    draft = await planner.decompose(decomposeContext.input);
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
  const planContext = { plan };
  await pluginHost.emit('compile.afterPlan', planContext);
  plan = planContext.plan;
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) {
    await runtimeLog(io, 'error', M.compile.schemaFail);
    await runtimeLog(io, 'raw', JSON.stringify(parsed.error.format(), null, 2));
    await ws.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    await runtimeLog(io, 'dim', M.compile.schemaInvalidSavedAt(ws.abs(`${draftDir}/plan.invalid.json`)));
    throw new CompileExitError(2, M.compile.schemaFail);
  }
  const issues = lintPlan(parsed.data).filter((i) => i.level === 'error');
  if (issues.length > 0) {
    await runtimeLog(io, 'error', M.compile.lintFail(issues.length));
    for (const i of issues) await runtimeLog(io, 'raw', M.compile.lintIssue(i.stepId ?? '*', i.message));
    // 落到 draft 便于排查
    await ws.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    throw new CompileExitError(3, M.compile.lintFail(issues.length));
  }

  const planMd = renderPlanMarkdown(parsed.data);
  await ws.writeFile(`${draftDir}/plan.md`, planMd);

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
      await ws.remove(draftDir);
      await runtimeLog(io, 'warning', M.compile.gate2Rejected);
      await audit.end({ status: 'rejected', gate: 2 });
      await runtimeResult(io, 'build', 'rejected', { gate: 2 });
      return {};
    }
  }

  // 7. Persist
  const phasePlanPath = opts.outputFile
    ? path.resolve(opts.outputFile)
    : defaultPhasePlanPath(ws.root);
  const planPath = defaultPhasePlanStepPath(path.dirname(phasePlanPath), parsed.data.phaseId ?? 'P1');
  await savePlan(planPath, parsed.data);
  const existingPhasePlan = await tryLoadPhasePlan(phasePlanPath);
  const phasePlan = buildPhasePlanFromCurrentPlan({
    plan: parsed.data,
    phasePlanPath,
    currentPlanPath: planPath,
    existing: existingPhasePlan,
  });
  await savePhasePlan(phasePlanPath, phasePlan);
  // 归档上一版本（如有），再写入新版本。topic.md 已在第 3.5 步落盘，这里只处理 plan.
  await archiveIfExists(ws, DOC_NAMES.plan, audit);
  await ws.writeFile(DOC_NAMES.plan, planMd);
  await refreshProjectMemory(ws, {
    planPath,
    language: parsed.data.language,
    intent: parsed.data.intent,
  });
  await ws.remove(draftDir);
  await audit.event('plan.persist', M.compile.auditPlanPersisted(planPath), {
    messageId: 'compile.plan_persisted',
    planPath,
    phasePlanPath,
    steps: parsed.data.steps.length,
  });
  const projectFile = await updateProjectFile({
    workspace: ws.root,
    planPath: phasePlanPath,
    configPath: cfgPath,
    projectFilePath: opts.projectFilePath,
    command: opts.projectCommand ?? 'build',
    intent,
    plan: parsed.data,
    requirementFile: opts.inputFile,
    topicFile: opts.topicFile,
    recordHistory: true,
  });

  await runtimeLog(io, 'success', M.compile.planWritten(planPath));
  await runtimeLog(io, 'success', M.compile.phasePlanWritten(phasePlanPath));
  await runtimeLog(io, 'success', M.compile.projectFileWritten(projectFile));
  await runtimeLog(io, 'info', M.compile.nextCommand(`xcompiler run ${path.relative(process.cwd(), phasePlanPath)}`));
  await pluginHost.emit('compile.finish', { plan: parsed.data, planPath: phasePlanPath, phasePlanPath, currentPlanPath: planPath });
  await audit.end({ status: 'ok', planPath, phasePlanPath, steps: parsed.data.steps.length });
  await runtimeResult(io, 'build', 'ok', { planPath: phasePlanPath, currentPlanPath: planPath, steps: parsed.data.steps.length });
  return { planPath: phasePlanPath };
  } finally {
    try { await scoreStore?.flush(); } catch { /* never block release */ }
    await lock.release();
  }
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
