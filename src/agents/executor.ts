import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { ChatOptions, LLMClient } from '../llm/types.js';
import {
  V_MODEL_DEVELOPMENT_PHASES,
  V_MODEL_TEST_PHASES,
  type Step,
} from '../core/plan.js';
import {
  normalizeQualityAssessment,
  reconcileDevelopmentQualityAssessment,
  resolveQualityGate,
  type StageQualityAssessment,
} from '../core/quality_gate.js';
import type {
  ChangeRequestTicket,
  EnhancementTicket,
  Ticket,
} from '../domain/tickets/ticket.js';
import { getLanguageProfile, type LanguageProfile } from '../core/language.js';
import type {
  Tool,
  ToolContext,
  ToolPermissionRequest,
  ToolResult,
} from '../tools/types.js';
import { makeStreamReporter } from '../llm/stream.js';
import { t } from '../i18n/index.js';
import { updateOperationWindow } from '../llm/window.js';
import { renderExecutionPromptPolicy } from './prompt_policy.js';
import {
  extractBugResolutionPlan,
  extractValidationDefect,
  isCompleteTurnJson,
  parseTurn,
  type LLMAction,
  type LLMTurn,
} from './execution/turn_parser.js';
import {
  compactExecutionMessages,
  renderExecutionUserPrompt,
} from './execution/prompt_renderer.js';
import {
  missingQualityAssessmentFields,
  renderExecutionFeedback,
} from './execution/feedback_renderer.js';
import {
  describeToolForStep,
  normalizeActions,
  safeRunTool,
} from './execution/tool_action_normalizer.js';

export { isCompleteTurnJson } from './execution/turn_parser.js';

const MISSING_OUTPUT_STALL_ROUND_LIMIT = 3;
const RECOVERY_PROBE_ACTIONS_PER_ROUND = 4;
const MAX_DIRECT_REPAIR_PROBE_ROUNDS = 4;

/**
 * Executor 把一个 Step 交给对应角色的 LLM，要求其用一组 tool calls 完成产出。
 *
 * 协议：LLM 必须严格返回 JSON：
 *   { "thoughts": "短说明", "validationDefect": "可选验证缺陷", "qualityAssessment": {...}, "actions": [...], "done": true|false }
 * DEBUG Bug Ticket 场景还必须额外返回 bugResolutionPlan，供 Ticket/debug-wiki 持久化。
 *
 * 主循环：
 *   while not done and rounds < maxRounds:
 *     ask LLM (with previous tool results)
 *     for each action: lookup tool in step.tools whitelist, run, collect summary
 *
 * 最终通过 verifyOutputs() 校验 step.outputs 是否全部生成。
 */

export interface ExecutorOptions {
  llm: LLMClient;
  signal?: AbortSignal;
  /** Enables direct human terminal stream rendering for the CLI adapter only. */
  streamOutput?: boolean;
  /** 同一 Step 内最多对话轮数，避免无限循环。 */
  maxRounds?: number;
  /** run_tests 连续/累计失败达到该预算后提前停止，让外层 V 模型回退处理。 */
  maxFailedTestRuns?: number;
  /** Tools whose failed calls are diagnostic only for this attempt and should not block completion. */
  advisoryFailureTools?: string[];
  /** Fine-grained failed calls that should be treated as diagnostics instead of blocking completion. */
  advisoryFailureRules?: AdvisoryFailureRule[];
}

export interface ExecutorRunInput {
  step: Step;
  /** Human-readable domain Step name used only for prompts and UI, for example P1-S004. */
  stepName?: string;
  /** Runtime execution role. Debug retries keep the same source step but execute as Debugger. */
  executionRole?: Step['role'];
  /** 仅暴露给 LLM 的工具子集（已按 step.tools 过滤）。 */
  tools: Tool[];
  ctx: ToolContext;
  /** 注入到 user prompt 的额外上下文（如已有 inputs 内容）。 */
  contextSnippets?: Array<{ path: string; content: string }>;
  /** Canonical task handoff for this execution boundary. */
  ticket?: Ticket;
  /** Active engineering CR. The Step must apply only this delta to the existing baseline. */
  changeRequest?: ChangeRequestTicket;
  /** Active quality-gap remediation. The Step appends only the missing or under-target work. */
  enhancement?: EnhancementTicket;
  /** 来自 Skill 的提示词，拼接到 system prompt 后。 */
  skillHints?: string[];
  /** debug 模式下传入上一轮失败记录（错误文本 / 失败测试 / 上下文）。 */
  debugContext?: {
    bugTicketId?: string;
    reason: string;
    failureLog: string;
    debugBrief?: string;
    suggestions?: string;
    repairRequired?: boolean;
    verificationScope?: {
      stepId: string;
      phase: Step['phase'];
      testArgs: string[];
    };
  };
  /** Plan 级别的全局 system prompt（xcompiler build 沉淀）。 */
  globalPrompt?: string;
  /** 目标语言 profile（决定 executor system prompt 的语言专属覆盖块）。默认 python。 */
  languageProfile?: LanguageProfile;
}

export interface ExecutorRunResult {
  success: boolean;
  rounds: number;
  toolCalls: ToolCallRecord[];
  finalThought?: string;
  /** Debugger 处理 Bug Ticket 时输出的可复用方案，成功后写回 Ticket/debug-wiki。 */
  bugResolutionPlan?: string;
  /** Right-side validation found a semantic test/contract defect that must route to the paired source phase. */
  validationDefect?: string;
  /** Structured completion/alignment/coverage evidence evaluated by the Runtime quality gate. */
  qualityAssessment?: StageQualityAssessment;
  error?: string;
  /** 健康度统计：用于调用方做"滑动窗口"自适应重试决策。 */
  metrics: ExecutorRunMetrics;
}

export interface ToolCallRecord {
  callId?: string;
  tool: string;
  args?: Record<string, unknown>;
  ok: boolean;
  summary?: string;
  error?: string;
  data?: unknown;
}

export interface ExecutorRunMetrics {
  /** 实际跑过的轮数（与 rounds 相同，便于消费方独立解读）。 */
  rounds: number;
  /** JSON 解析失败的轮数（LLM 返回空 / 不可解析）。 */
  parseFailures: number;
  /** 与上一轮 actions 完全相同的轮数（疑似 loop / 卡死）。 */
  repeatedTurns: number;
  /** 工具调用失败比例（0..1）。无调用时为 0。 */
  toolFailRatio: number;
  /** 进度比例：1 - 当前缺失输出 / 起始缺失输出（0..1）。无初始缺失时为 1。 */
  progressRatio: number;
  /** [0..1] 健康度得分；越高越值得继续重试。 */
  healthScore: number;
  /** Providers that produced accepted response turns during this attempt. */
  providers: string[];
}

export interface AdvisoryFailureRule {
  tool?: string;
  pathPrefix?: string;
  errorIncludes?: string;
}

export class StepExecutor {
  constructor(private readonly opts: ExecutorOptions) {}

  async run(inp: ExecutorRunInput): Promise<ExecutorRunResult> {
    const maxRounds = this.opts.maxRounds ?? 6;
    let roundLimit = maxRounds;
    const role = inp.executionRole ?? inp.step.role;
    const bugResolutionPlanRequired = role === 'Debugger' && !!inp.debugContext?.bugTicketId;
    const toolMap = new Map(inp.tools.map((t) => [t.name, t]));
    const toolDocs = inp.tools
      .map((t) => `- ${t.name}: ${describeToolForStep(t, inp.ctx, inp.step)} args=${JSON.stringify(t.argsSchema)}`)
      .join('\n');
    const initialVerify = await verifyOutputs(inp);
    const initialMissingOutputs = initialVerify.missing;
    const skillBlock =
      inp.skillHints && inp.skillHints.length > 0
        ? t().prompts.executorSkillBlock(inp.skillHints)
        : '';
    const debugBlock = inp.debugContext
      ? t().prompts.executorDebugBlock(inp.debugContext.reason, inp.debugContext.suggestions)
      : '';
    const globalBlock =
      inp.globalPrompt && inp.globalPrompt.trim()
        ? t().prompts.executorGlobalBlock(inp.globalPrompt.trim())
        : '';
    const stepBlock = t().prompts.executorStepBlock(inp.step.systemPrompt.trim());
    const policyBlock = renderExecutionPromptPolicy({
      debug: !!inp.debugContext,
      changeRequest: !!inp.changeRequest,
    });
    const userPrompt = renderExecutionUserPrompt(inp, toolDocs, initialMissingOutputs);
    const profile = inp.languageProfile ?? getLanguageProfile('python');

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content:
          t().prompts.executorSystem(profile) +
          policyBlock +
          globalBlock +
          stepBlock +
          skillBlock +
          debugBlock,
      },
      { role: 'user', content: userPrompt },
    ];
    const calls: ExecutorRunResult['toolCalls'] = [];
    let finalThought: string | undefined;
    let bugResolutionPlan: string | undefined;
    let qualityAssessment: StageQualityAssessment | undefined;
    let qualityAssessmentRound = 0;
    let lastToolActionRound = 0;
    let completionSignaled = false;

    // 健康度信号采集
    const initialMissing = initialVerify.missing.length;
    const hardRoundLimit = Math.max(maxRounds, maxRounds + Math.min(12, Math.max(4, initialMissing * 2)));
    let lastMissingCount = initialMissing;
    let missingOutputStallRounds = 0;
    let parseFailures = 0;
    let repeatedTurns = 0;
    let consecutiveLowQualityRejections = 0;
    let lastActionsKey: string | null = null;
    /** 每个 (tool+args) 指纹被尝试过的累计次数；用于检测"换汤不换药"。 */
    const actionFingerprints = new Map<string, number>();
    const unresolvedToolFailures = new Map<string, string>();
    const failedVerificationAttempts = new Map<string, number>();
    const failedMutationAttempts = new Map<string, number>();
    let mutationGeneration = 0;
    let verifiedMutationGeneration = 0;
    let actualRounds = 0;
    let consecutiveReadOnlyRounds = 0;
    let consecutiveNoProgressRounds = 0;
    let failedTestRunRounds = 0;
    let repairEvidence = false;
    const repairRequired = inp.debugContext?.repairRequired === true;
    const readOnlyRecoveryMode = isReadOnlyLoopFailure(inp.debugContext?.reason ?? '');
    const strictReadOnlyRecoveryMode = isRejectedReadOnlyRecovery(inp.debugContext?.reason ?? '');
    const directRepairMode =
      role === 'Debugger' &&
      repairRequired &&
      (initialMissing > 0 || hasActionableDebuggerFailure(inp.debugContext));
    const directRepairProbeRoundBudget = directRepairMode
      ? resolveDirectRepairProbeRoundBudget(inp.debugContext)
      : 0;
    let readOnlyRecoveryRounds = 0;
    const directRepairProbeRoundsByGeneration = new Map<number, number>();
    const recoveryProbeFingerprints = new Set<string>();
    const advisoryFailureTools = new Set(this.opts.advisoryFailureTools ?? []);
    const advisoryFailureRules = this.opts.advisoryFailureRules ?? [];
    const providers = new Set<string>();

    const stepLabel = inp.stepName?.trim() || inp.step.id;
    for (let round = 1; round <= roundLimit; round++) {
      const rep = makeStreamReporter(
        `${stepLabel} ${role} round ${round}`,
        this.opts.llm.name,
        { enabled: this.opts.streamOutput === true },
      );
      // 另起一份本轮完整原始输出的拼接，以便 llm.chat 报错/超时/loop 被 abort 时仔细存证。
      // 上限 256KB，略大于 ollama 默认 maxOutputChars，只作为内存保护。
      const RAW_CAP = 256 * 1024;
      let rawAggregate = '';
      let provider: string | undefined;
      let text: string;
      try {
        const chatMessages = compactExecutionMessages(messages, !!inp.debugContext);
        const directRepairProbeRounds =
          directRepairProbeRoundsByGeneration.get(mutationGeneration) ?? 0;
        const allowNovelDirectRepairProbe =
          directRepairMode &&
          directRepairProbeRounds < directRepairProbeRoundBudget &&
          (!strictReadOnlyRecoveryMode || mutationGeneration > 0);
        const enforceRecoveryContract =
          role === 'Debugger' && (
            strictReadOnlyRecoveryMode ||
            (readOnlyRecoveryMode && recoveryProbeFingerprints.size > 0) ||
            (
              directRepairMode &&
              (
                consecutiveReadOnlyRounds >= 1 ||
                unresolvedToolFailures.size > 0 ||
                directRepairProbeRounds > 0
              )
            )
          );
        const chatOptions: ChatOptions = {
          responseFormat: 'json',
          temperature: 0.1,
          maxTokens: inp.ctx.responseTokenBudget,
          scoreSuccess: false,
          validate:
            role === 'Debugger' && (
              enforceRecoveryContract ||
              (bugResolutionPlanRequired && !bugResolutionPlan?.trim())
            )
              ? (text) => validateDebuggerRecoveryTurn(text, toolMap, {
                  enforceRecoveryContract,
                  requireBugResolutionPlanBeforeAction:
                    bugResolutionPlanRequired && !bugResolutionPlan?.trim(),
                  allowNovelReadOnlyProbes:
                    (readOnlyRecoveryMode && !directRepairMode) ||
                    allowNovelDirectRepairProbe,
                  seenProbeFingerprints: recoveryProbeFingerprints,
                })
              : undefined,
          onProvider: (name) => { provider = name; },
          onProviderStart: (name, model, providerWindow) => {
            provider = name;
            rawAggregate = '';
            updateOperationWindow(inp.ctx, {
              contextWindowTokens: providerWindow?.contextWindowTokens ?? inp.ctx.contextWindowTokens,
              promptChars: chatMessages.reduce((sum, message) => sum + message.content.length, 0),
            });
            const refreshedToolDocs = inp.tools
              .map((tool) =>
                `- ${tool.name}: ${describeToolForStep(tool, inp.ctx, inp.step)} args=${JSON.stringify(tool.argsSchema)}`,
              )
              .join('\n');
            if (messages[1]) {
              messages[1].content = renderExecutionUserPrompt(inp, refreshedToolDocs, initialMissingOutputs);
            }
            chatOptions.maxTokens = inp.ctx.responseTokenBudget;
            rep.reset();
            rep.setModel(`${name}/${model}`);
          },
          streamStopWhen: isCompleteTurnJson,
          onToken: (chunk) => {
            if (rawAggregate.length < RAW_CAP) {
              rawAggregate = (rawAggregate + chunk).slice(0, RAW_CAP);
            }
            rep.onToken(chunk);
          },
        };
        text = await this.opts.llm.chat(chatMessages, { ...chatOptions, signal: this.opts.signal });
        providers.add(provider ?? this.opts.llm.name);
      } catch (err) {
        rep.done('failed');
        const errMsg = (err as Error).message;
        actualRounds = round;
        // 把部分流落盘到 .xcompiler/llm-stream/<step>-<role>-r<n>.txt
        const dumpRel = `.xcompiler/llm-stream/${inp.step.id}-${role}-r${round}.txt`;
        try {
          const dumpAbs = inp.ctx.ws.abs(dumpRel);
          await fs.mkdir(path.dirname(dumpAbs), { recursive: true });
          await fs.writeFile(
            dumpAbs,
            `${t().audit.partialFailureHeader(errMsg)}\n${t().audit.streamLength(rawAggregate.length)}\n\n${rawAggregate}`,
            'utf8',
          );
        } catch {
          /* best-effort */
        }
        await inp.ctx.audit?.executorTurn(inp.step.id, role, round, {
          thoughts: t().audit.llmChatFailedThought(errMsg),
          actions: [],
          done: false,
          raw: rawAggregate,
          provider,
        });
        await inp.ctx.audit?.event(
          'llm.error',
          t().audit.llmChatAborted(inp.step.id, round, rawAggregate.length, errMsg),
          {
            messageId: 'audit.llm_chat_aborted',
            stepId: inp.step.id,
            role,
            round,
            partialDump: dumpRel,
            partialBytes: rawAggregate.length,
          },
        );
        if (isLowQualityLLMResponseError(errMsg)) {
          repeatedTurns++;
          consecutiveLowQualityRejections++;
          const verify = await verifyOutputs(inp);
          if (
            consecutiveLowQualityRejections < 2 &&
            round < hardRoundLimit
          ) {
            if (round >= roundLimit) {
              roundLimit = Math.min(hardRoundLimit, roundLimit + 1);
            }
            messages.push({
              role: 'assistant',
              content: JSON.stringify({
                thoughts: 'provider output rejected by the Debugger recovery contract',
                actions: [],
                done: false,
              }),
            });
            messages.push({
              role: 'user',
              content:
                `The previous provider output was rejected: ${truncate(errMsg, 1600)}\n` +
                'Keep the concrete file/tool evidence already present in this conversation. ' +
                'Do not reread those files. The next response must apply a focused patch/write, ' +
                'run the required post-repair verification, or state a concrete blocker.',
            });
            await inp.ctx.audit?.event(
              'note',
              `${inp.step.id} retained Debugger context after a low-quality provider response`,
              {
                messageId: 'audit.executor_low_quality_context_retained',
                stepId: inp.step.id,
                role,
                round,
                consecutiveLowQualityRejections,
                nextRoundLimit: roundLimit,
              },
            );
            continue;
          }
          const metrics = computeMetrics({
            rounds: actualRounds,
            parseFailures,
            repeatedTurns,
            calls,
            initialMissing,
            currentMissing: verify.missing.length,
            providers: [...providers],
          });
          return {
            success: false,
            rounds: round,
            toolCalls: calls,
            finalThought,
            bugResolutionPlan,
            error: errMsg,
            metrics,
          };
        }
        throw err;
      }
      rep.done();
      consecutiveLowQualityRejections = 0;
      const turn = parseTurn(text);
      finalThought = turn.thoughts;
      bugResolutionPlan = extractBugResolutionPlan(turn) ?? bugResolutionPlan;
      const turnQualityAssessment = normalizeQualityAssessment(
        turn.qualityAssessment ?? turn.quality_assessment,
      );
      if (turnQualityAssessment) {
        qualityAssessment = turnQualityAssessment;
        qualityAssessmentRound = round;
      }
      const normalizedActions = normalizeActions(turn.actions, toolMap);
      let actions = normalizedActions.actions;
      if (role === 'Debugger' && (readOnlyRecoveryMode || directRepairMode)) {
        const bounded = boundRecoveryProbeActions(actions);
        actions = bounded.actions;
        if (bounded.omitted > 0) {
          await inp.ctx.audit?.event(
            'note',
            `bounded Debugger recovery probes to ${bounded.kept} read-only action(s); omitted ${bounded.omitted}`,
            {
              messageId: 'audit.executor_recovery_probe_bound',
              stepId: inp.step.id,
              round,
              keptReadOnlyActions: bounded.kept,
              omittedReadOnlyActions: bounded.omitted,
            },
          );
        }
      }
      if (normalizedActions.invalid.length > 0) {
        parseFailures++;
        await inp.ctx.audit?.event(
          'note',
          `ignored ${normalizedActions.invalid.length} invalid action item(s) from LLM turn`,
          {
            messageId: 'audit.executor_invalid_actions_ignored',
            stepId: inp.step.id,
            role,
            round,
            invalidActions: normalizedActions.invalid.map((item) => ({
              index: item.index,
              error: item.result.error,
              raw: item.raw,
            })),
          },
        );
      }
      const repairOrVerificationRequested = actions.some((action) =>
        isRepairEvidenceTool(action.tool),
      );
      if (
        bugResolutionPlanRequired &&
        !bugResolutionPlan?.trim() &&
        (repairOrVerificationRequested || turn.done === true)
      ) {
        actualRounds = round;
        await inp.ctx.audit?.executorTurn(inp.step.id, role, round, {
          thoughts: turn.thoughts,
          actions: [],
          done: false,
          raw: text,
          provider,
        });
        await inp.ctx.audit?.event(
          'note',
          `${inp.step.id} rejected Debugger repair actions submitted before bugResolutionPlan`,
          {
            messageId: 'audit.executor_bug_resolution_plan_required_before_action',
            stepId: inp.step.id,
            role,
            round,
            rejectedActions: actions.map((action) => action.tool),
          },
        );
        if (round >= roundLimit && roundLimit < hardRoundLimit) {
          roundLimit = Math.min(hardRoundLimit, roundLimit + 1);
        }
        if (round < roundLimit) {
          messages.push({ role: 'assistant', content: compactTurnForHistory(turn, toolMap) });
          messages.push({ role: 'user', content: t().prompts.executorFeedbackBugResolutionPlanMissing });
          continue;
        }
        const metrics = computeMetrics({
          rounds: actualRounds,
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: (await verifyOutputs(inp)).missing.length,
          providers: [...providers],
        });
        return {
          success: false,
          rounds: round,
          toolCalls: calls,
          finalThought,
          bugResolutionPlan,
          error: 'DEBUG bug-ticket repair rejected: bugResolutionPlan is required before repair or verification actions.',
          metrics,
        };
      }
      const automaticCodeVerifications = await automaticCodeDebugVerificationActions({
        actions,
        role,
        phase: inp.step.phase,
        language: profile.id,
        toolMap,
        ctx: inp.ctx,
      });
      if (automaticCodeVerifications.length > 0) {
        actions = [...actions, ...automaticCodeVerifications];
        await inp.ctx.audit?.event(
          'note',
          `${inp.step.id} appended CODE verification gate(s) after Debugger mutation`,
          {
            messageId: 'audit.executor_automatic_code_verification',
            stepId: inp.step.id,
            role,
            round,
            language: profile.id,
            actions: automaticCodeVerifications,
          },
        );
      }
      actualRounds = round;
      // 解析失败 / 空响应：关键的"不健康"信号。
      if (!turn || (turn.thoughts === undefined && actions.length === 0 && turn.done === undefined)) {
        parseFailures++;
      }
      // 重复检测：与上一轮 actions 完全相同（且非空）→ 卡死信号。
      const actionsKey = JSON.stringify(actions);
      if (actions.length > 0 && lastActionsKey === actionsKey) {
        repeatedTurns++;
      }
      lastActionsKey = actionsKey;
      // 单 action 级重复：即使整体不一样，只要本轮包含已经尝试过的指纹，
      // 也视作"卡在同一坑"。LLM 常见模式：把同一无效 replace 拼到不同 action 列里。
      let perActionRepeats = 0;
      for (const a of actions) {
        const fp = JSON.stringify({ t: a.tool, a: a.args });
        const prev = actionFingerprints.get(fp) ?? 0;
        if (prev > 0) perActionRepeats++;
        actionFingerprints.set(fp, prev + 1);
      }
      // 一轮里有 ≥ 2 个 action 是旧指纹的重复 → 强信号；只 1 个不计入避免误伤。
      if (perActionRepeats >= 2) repeatedTurns++;
      const readOnlyRound = actions.length > 0 && actions.every(isReadOnlyOrProbeAction);
      const probeFingerprints = readOnlyRound
        ? actions.flatMap(recoveryProbeActionFingerprints)
        : [];
      const novelProbeFingerprints = probeFingerprints.filter(
        (fingerprint) => !recoveryProbeFingerprints.has(fingerprint),
      );
      const novelDiagnosticProbeRound =
        role === 'Debugger' &&
        readOnlyRound &&
        novelProbeFingerprints.length > 0;
      if (directRepairMode && novelDiagnosticProbeRound) {
        directRepairProbeRoundsByGeneration.set(
          mutationGeneration,
          (directRepairProbeRoundsByGeneration.get(mutationGeneration) ?? 0) + 1,
        );
      }
      for (const fingerprint of probeFingerprints) {
        recoveryProbeFingerprints.add(fingerprint);
      }
      const noProgressRound = actions.length === 0 && turn.done !== true;
      if (noProgressRound) {
        consecutiveNoProgressRounds++;
      } else {
        consecutiveNoProgressRounds = 0;
      }
      if (readOnlyRound) {
        if (novelDiagnosticProbeRound) {
          consecutiveReadOnlyRounds = 0;
          readOnlyRecoveryRounds = readOnlyRecoveryMode ? 1 : 0;
        } else {
          consecutiveReadOnlyRounds++;
          if (readOnlyRecoveryMode) {
            readOnlyRecoveryRounds++;
          }
        }
      } else if (actions.length > 0) {
        consecutiveReadOnlyRounds = 0;
        readOnlyRecoveryRounds = 0;
      }
      // 把 LLM 本轮的"思考过程 + 计划行动"写入审计，作为交付时的可追溯材料
      await inp.ctx.audit?.executorTurn(inp.step.id, role, round, {
        thoughts: turn.thoughts,
        bugResolutionPlan,
        actions,
        done: turn.done === true,
        raw: text,
        provider,
      });
      const turnResults: Array<ToolResult & { tool: string }> = normalizedActions.invalid.map((item) => ({
        ...item.result,
        tool: item.result.tool,
      }));
      let repeatedVerificationFailure: string | undefined;
      let repeatedMutationFailure: string | undefined;
      for (const item of normalizedActions.invalid) {
        calls.push({ tool: item.result.tool, ok: false, error: item.result.error });
      }
      for (const a of actions) {
        const selectedTool = toolMap.get(a.tool);
        if (!selectedTool) {
          const r = { ok: false, error: `tool not allowed for this step: ${a.tool}` };
          updateUnresolvedToolFailures(unresolvedToolFailures, a, r, advisoryFailureTools, advisoryFailureRules);
          calls.push({ tool: a.tool, ok: false, error: r.error });
          turnResults.push({ ...r, tool: a.tool });
          await inp.ctx.audit?.event('tool.call', t().audit.toolDenied(a.tool), {
            messageId: 'audit.tool_denied', stepId: inp.step.id, tool: a.tool,
          });
          continue;
        }
        const callId = randomUUID();
        const permission = buildPermissionRequest(a.tool, a.args, inp.step.id, inp.ctx.language, stepLabel);
        if (permission) permission.id = callId;
        await inp.ctx.onToolEvent?.({
          callId,
          status: 'started',
          stepId: inp.step.id,
          stepName: stepLabel,
          tool: a.tool,
          target: actionTargetPaths(a.tool, a.args).join(', ') || undefined,
          args: a.args,
          patch: a.tool === 'apply_patch' && typeof a.args.patch === 'string' ? a.args.patch : undefined,
        });
        if (permission && inp.ctx.requestPermission) {
          const decision = await inp.ctx.requestPermission(permission);
          if (!decision.approved) {
            const r = {
              ok: false,
              error: `permission denied for ${permission.operationType}: ${permission.target}` +
                (decision.reason ? ` (${decision.reason})` : ''),
            };
            updateUnresolvedToolFailures(unresolvedToolFailures, a, r, advisoryFailureTools, advisoryFailureRules);
            await inp.ctx.audit?.event('tool.result', t().audit.toolResult(a.tool, false, r.error), {
              messageId: 'audit.tool_result',
              stepId: inp.step.id,
              tool: a.tool,
              ok: false,
              permissionDenied: true,
            });
            calls.push({ tool: a.tool, ok: false, error: r.error });
            turnResults.push({ ...r, tool: a.tool });
            await inp.ctx.onToolEvent?.({
              callId,
              status: 'completed',
              stepId: inp.step.id,
              stepName: stepLabel,
              tool: a.tool,
              target: permission.target,
              ok: false,
              error: r.error,
            });
            continue;
          }
        }
        await inp.ctx.audit?.event('tool.call', t().audit.toolCalled(a.tool), {
          messageId: 'audit.tool_called', stepId: inp.step.id, tool: a.tool, args: a.args,
        });
        const toolReporter = makeStreamReporter(
          t().stream.toolExecution(stepLabel, a.tool),
          t().stream.toolRunner,
          { enabled: this.opts.streamOutput === true },
        );
        const r = await safeRunTool(selectedTool, a.args, inp.ctx);
        toolReporter.done(r.ok ? 'done' : 'failed');
        updateUnresolvedToolFailures(unresolvedToolFailures, a, r, advisoryFailureTools, advisoryFailureRules);
        const successfulMutation = didPerformSuccessfulMutation(a, r);
        if (successfulMutation) {
          mutationGeneration++;
        }
        if (isOutputMutationTool(a.tool)) {
          const mutationKey = `${mutationGeneration}:${JSON.stringify({ tool: a.tool, args: a.args })}`;
          if (successfulMutation) {
            failedMutationAttempts.delete(mutationKey);
          } else if (!r.ok && shouldTrackRepeatedMutationFailure(r)) {
            const count = (failedMutationAttempts.get(mutationKey) ?? 0) + 1;
            failedMutationAttempts.set(mutationKey, count);
            if (count >= 2 && !advisoryFailureTools.has(a.tool)) {
              repeatedMutationFailure =
                `mutation action repeated without a successful mutation: ${a.tool} ${truncate(stableActionValue(a.args), 600)}; ` +
                `latest failure: ${truncate(r.error ?? r.summary ?? 'unknown error', 1000)}; ` +
                'next attempt must use corrected arguments or a different repair strategy.';
            }
          }
        }
        if (COMPLETION_VERIFICATION_TOOLS.has(a.tool)) {
          const verificationKey = `${mutationGeneration}:${verificationActionKey(a)}`;
          if (r.ok) {
            failedVerificationAttempts.delete(verificationKey);
            verifiedMutationGeneration = mutationGeneration;
          } else {
            const count = (failedVerificationAttempts.get(verificationKey) ?? 0) + 1;
            failedVerificationAttempts.set(verificationKey, count);
            if (count >= 2 && !advisoryFailureTools.has(a.tool)) {
              repeatedVerificationFailure =
                `verification command repeated without a successful mutation: ${verificationActionLabel(a)}; ` +
                `latest failure: ${truncate(r.error ?? r.summary ?? 'unknown error', 1000)}; ` +
                'next attempt must patch/write before rerunning this command.';
            }
          }
        }
        if (r.ok && isRepairEvidenceTool(a.tool) && (
          !isOutputMutationTool(a.tool) || successfulMutation
        )) {
          repairEvidence = true;
        }
        await inp.ctx.audit?.event('tool.result', t().audit.toolResult(a.tool, r.ok, r.summary ?? r.error ?? ''), {
          messageId: 'audit.tool_result',
          stepId: inp.step.id,
          tool: a.tool,
          ok: r.ok,
        });
        await inp.ctx.onToolEvent?.({
          callId,
          status: 'completed',
          stepId: inp.step.id,
          stepName: stepLabel,
          tool: a.tool,
          target: actionTargetPaths(a.tool, a.args).join(', ') || undefined,
          ok: r.ok,
          summary: r.summary,
          error: r.error,
          changedFiles: r.ok ? changedFilesForAction(a.tool, a.args, r) : undefined,
        });
        calls.push({
          callId,
          tool: a.tool,
          args: a.args,
          ok: r.ok,
          summary: r.summary,
          error: r.error,
          data: r.data,
        });
        turnResults.push({ ...r, tool: a.tool });
      }
      if (actions.length > 0 || normalizedActions.invalid.length > 0) {
        lastToolActionRound = round;
      }
      const verify = await verifyOutputs(inp);
      qualityAssessment = reconcileDevelopmentQualityAssessment(
        inp.step,
        qualityAssessment,
        verify.missing,
      );
      const mutationSucceededThisRound = actions.some((action, index) =>
        didPerformSuccessfulMutation(action, turnResults[normalizedActions.invalid.length + index]!)
      );
      if (verify.missing.length < lastMissingCount) {
        lastMissingCount = verify.missing.length;
        missingOutputStallRounds = 0;
      } else if (
        !verify.ok &&
        initialMissing > 0 &&
        mutationSucceededThisRound &&
        !readOnlyRound &&
        unresolvedToolFailures.size === 0
      ) {
        missingOutputStallRounds++;
      }
      if (turnResults.some((r) => r.tool === 'run_tests' && !r.ok) && !advisoryFailureTools.has('run_tests')) {
        failedTestRunRounds++;
      }
      if (repeatedMutationFailure) {
        const metrics = computeMetrics({
          rounds: actualRounds,
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: verify.missing.length,
          providers: [...providers],
        });
        await inp.ctx.audit?.event('note', repeatedMutationFailure, {
          messageId: 'audit.executor_repeated_mutation_without_progress',
          stepId: inp.step.id,
          phase: inp.step.phase,
          round,
          mutationGeneration,
        });
        return {
          success: false,
          rounds: round,
          toolCalls: calls,
          finalThought,
          bugResolutionPlan,
          qualityAssessment,
          error: repeatedMutationFailure,
          metrics,
        };
      }
      const validationDefect = extractValidationDefect(turn);
      if (
        validationDefect &&
        (V_MODEL_TEST_PHASES as readonly string[]).includes(inp.step.phase)
      ) {
        const metrics = computeMetrics({
          rounds: actualRounds,
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: verify.missing.length,
          providers: [...providers],
        });
        await inp.ctx.audit?.event(
          'note',
          `${inp.step.id} reported a validation defect that requires paired-source repair`,
          {
            messageId: 'audit.executor_validation_defect',
            stepId: inp.step.id,
            phase: inp.step.phase,
            round,
            validationDefect,
          },
        );
        return {
          success: false,
          rounds: round,
          toolCalls: calls,
          finalThought,
          bugResolutionPlan,
          validationDefect,
          error: `validation defect reported: ${validationDefect}`,
          metrics,
        };
      }
      const repairGateOk = !repairRequired ||
        repairEvidence ||
        canAcceptOutputCompletionRecovery(inp, initialMissing);
      const bugResolutionPlanOk = !bugResolutionPlanRequired || !!bugResolutionPlan?.trim();
      const verifiedCompletion = !turn.done && hasSuccessfulCompletionVerification(calls);
      const outputCompletionRecovery = verify.ok && canAcceptOutputCompletionRecovery(inp, initialMissing);
      const declarativeOutputCompletion =
        !turn.done &&
        verify.ok &&
        isDeclarativeOutputPhase(inp.step.phase) &&
        turnResults.some((result) => result.ok && isOutputMutationTool(result.tool));
      const qualityAssessmentMissing = missingQualityAssessmentFields(
        inp.step,
        qualityAssessment,
        qualityAssessmentRound > lastToolActionRound,
        unresolvedToolFailures.size > 0,
      );
      const supersededContractFailures =
        repairEvidence &&
        hasSuccessfulCompletionVerification(calls) &&
        hasOnlySupersededToolContractFailures(unresolvedToolFailures);
      const nonBlockingPhaseVerificationFailures =
        verify.ok &&
        (V_MODEL_DEVELOPMENT_PHASES as readonly string[]).includes(inp.step.phase) &&
        qualityAssessmentMissing.length === 0 &&
        hasOnlyUnauthorizedVerificationFailures(unresolvedToolFailures);
      const reportedQualityGateFailure =
        turn.done === true &&
        actions.length === 0 &&
        verify.ok &&
        (V_MODEL_TEST_PHASES as readonly string[]).includes(inp.step.phase) &&
        qualityAssessment !== undefined &&
        qualityAssessment.gaps.length > 0 &&
        unresolvedToolFailures.size > 0 &&
        qualityAssessmentMissing.length === 0;
      const unresolvedFailuresOk =
        unresolvedToolFailures.size === 0 ||
        (outputCompletionRecovery && hasOnlyUntargetedToolContractFailures(unresolvedToolFailures)) ||
        supersededContractFailures ||
        nonBlockingPhaseVerificationFailures ||
        reportedQualityGateFailure;
      const completionSignal =
        turn.done ||
        verifiedCompletion ||
        outputCompletionRecovery ||
        declarativeOutputCompletion;
      completionSignaled = completionSignaled || completionSignal;
      if (
        completionSignal &&
        verify.ok &&
        unresolvedFailuresOk &&
        repairGateOk &&
        bugResolutionPlanOk &&
        qualityAssessmentMissing.length === 0
      ) {
        if (declarativeOutputCompletion) {
          await inp.ctx.audit?.event(
            'note',
            `accepted ${inp.step.phase} completion after successful output mutation and output verification`,
            {
              messageId: 'audit.executor_declarative_output_completion',
              stepId: inp.step.id,
              round,
              phase: inp.step.phase,
              outputs: inp.step.outputs,
            },
          );
        }
        const metrics = computeMetrics({
          rounds: actualRounds,
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: verify.missing.length,
          providers: [...providers],
        });
        return {
          success: true,
          rounds: round,
          toolCalls: calls,
          finalThought,
          bugResolutionPlan,
          qualityAssessment,
          metrics,
        };
      }
      if (this.opts.maxFailedTestRuns && failedTestRunRounds >= this.opts.maxFailedTestRuns) {
        const metrics = computeMetrics({
          rounds: actualRounds,
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: verify.missing.length,
          providers: [...providers],
        });
        const error =
          `run_tests failed ${failedTestRunRounds} time(s) in this step; ` +
          'stopping the test step so the V-model rollback can repair the paired source phase.';
        await inp.ctx.audit?.event('note', error, {
          messageId: 'audit.executor_test_gate_limit',
          stepId: inp.step.id,
          round,
          failedTestRunRounds,
          maxFailedTestRuns: this.opts.maxFailedTestRuns,
        });
        return { success: false, rounds: round, toolCalls: calls, finalThought, bugResolutionPlan, error, metrics };
      }
      if (repeatedVerificationFailure) {
        const metrics = computeMetrics({
          rounds: actualRounds,
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: verify.missing.length,
          providers: [...providers],
        });
        await inp.ctx.audit?.event('note', repeatedVerificationFailure, {
          messageId: 'audit.executor_repeated_verification_without_mutation',
          stepId: inp.step.id,
          phase: inp.step.phase,
          round,
          mutationGeneration,
        });
        return {
          success: false,
          rounds: round,
          toolCalls: calls,
          finalThought,
          bugResolutionPlan,
          qualityAssessment,
          error: repeatedVerificationFailure,
          metrics,
        };
      }
      if (missingOutputStallRounds >= MISSING_OUTPUT_STALL_ROUND_LIMIT) {
        repeatedTurns++;
        const metrics = computeMetrics({
          rounds: actualRounds,
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: verify.missing.length,
          providers: [...providers],
        });
        const error =
          `write/progress actions did not reduce missing outputs for ${missingOutputStallRounds} rounds; ` +
          `missing outputs: ${verify.missing.join(', ')}. ` +
          'Next attempt must create those exact outputs before rewriting already-existing files.';
        await inp.ctx.audit?.event('note', error, {
          messageId: 'audit.executor_missing_output_stall',
          stepId: inp.step.id,
          round,
          missingOutputStallRounds,
          missingOutputs: verify.missing,
        });
        return { success: false, rounds: round, toolCalls: calls, finalThought, bugResolutionPlan, error, metrics };
      }
      const readOnlyRecoveryViolation = readOnlyRecoveryMode && readOnlyRecoveryRounds >= 2;
      const readOnlyRoundLimit = directRepairMode ? 2 : 3;
      if (consecutiveReadOnlyRounds >= readOnlyRoundLimit || readOnlyRecoveryViolation) {
        repeatedTurns++;
        const metrics = computeMetrics({
          rounds: actualRounds,
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: verify.missing.length,
          providers: [...providers],
        });
        const targets = actions.flatMap((action) => actionTargetPaths(action.tool, action.args)).join(', ');
        const error =
          (readOnlyRecoveryViolation
            ? `read-only recovery mode repeated probe actions for ${readOnlyRecoveryRounds} rounds`
            : `repeated read-only/probe actions without progress for ${consecutiveReadOnlyRounds} rounds`) +
          (targets ? ` (last target: ${targets})` : '') +
          '; next attempt must patch/write an allowed file, run verification, or stop with a concrete blocker.';
        await inp.ctx.audit?.event('note', error, {
          messageId: 'audit.executor_loop_guard',
          stepId: inp.step.id,
          round,
          consecutiveReadOnlyRounds,
          actions,
        });
        return { success: false, rounds: round, toolCalls: calls, finalThought, bugResolutionPlan, error, metrics };
      }
      if (consecutiveNoProgressRounds >= 2) {
        repeatedTurns++;
        const metrics = computeMetrics({
          rounds: actualRounds,
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: verify.missing.length,
          providers: [...providers],
        });
        const blockers = [
          verify.missing.length > 0
            ? `missing outputs: ${verify.missing.join(', ')}`
            : '',
          unresolvedToolFailures.size > 0
            ? `unresolved tool failures: ${[...unresolvedToolFailures.values()].join('; ')}`
            : '',
        ].filter(Boolean);
        const error =
          `model returned actions=[] and done=false for ${consecutiveNoProgressRounds} consecutive rounds; ` +
          'this is invalid no-progress output, so the attempt is stopping before it becomes a token-consuming loop.' +
          (blockers.length > 0 ? ` Current blockers: ${blockers.join('. ')}.` : '');
        await inp.ctx.audit?.event('note', error, {
          messageId: 'audit.executor_no_progress_guard',
          stepId: inp.step.id,
          round,
          consecutiveNoProgressRounds,
          missingOutputs: verify.missing,
          unresolvedToolFailures: [...unresolvedToolFailures.values()],
        });
        return { success: false, rounds: round, toolCalls: calls, finalThought, bugResolutionPlan, error, metrics };
      }
      const needsQualityHandshake =
        completionSignal &&
        verify.ok &&
        qualityAssessmentMissing.length > 0;
      const postMutationVerificationRequired = mutationGeneration > verifiedMutationGeneration;
      const successfulVerificationThisRound = turnResults.some(
        (result) => result.ok && COMPLETION_VERIFICATION_TOOLS.has(result.tool),
      );
      const productiveExtensionAtLimit =
        mutationSucceededThisRound ||
        (
          repeatedTurns === 0 &&
          needsQualityHandshake &&
          successfulVerificationThisRound
        );
      const productiveHandshakeAtLimit =
        needsQualityHandshake &&
        productiveExtensionAtLimit &&
        !mutationSucceededThisRound;
      if (
        round >= roundLimit &&
        (
          productiveExtensionAtLimit ||
          (
            roundLimit < hardRoundLimit &&
            (
              novelDiagnosticProbeRound ||
              shouldExtendProductiveRun({
                parseFailures,
                repeatedTurns,
                calls,
                initialMissing,
                currentMissing: verify.missing.length,
                consecutiveReadOnlyRounds,
                unresolvedFailures: unresolvedToolFailures.size,
                pendingMutation: postMutationVerificationRequired,
              })
            )
          )
        )
      ) {
        const nextLimit = productiveExtensionAtLimit
          ? roundLimit + 2
          : Math.min(hardRoundLimit, roundLimit + 2);
        await inp.ctx.audit?.event('note', mutationSucceededThisRound
          ? `successful mutation needs verification; extending round budget ${roundLimit}→${nextLimit}`
          : productiveHandshakeAtLimit
            ? `verified outputs need quality evidence; extending round budget ${roundLimit}→${nextLimit}`
            : `productive step progress detected; extending round budget ${roundLimit}→${nextLimit}`, {
          messageId: mutationSucceededThisRound
            ? 'audit.executor_post_mutation_verification_extension'
            : productiveHandshakeAtLimit
              ? 'audit.executor_quality_handshake_extension'
              : 'audit.executor_productive_round_extension',
          stepId: inp.step.id,
          round,
          previousLimit: roundLimit,
          nextLimit,
          initialMissing,
          currentMissing: verify.missing.length,
          qualityAssessmentMissing: needsQualityHandshake
            ? qualityAssessmentMissing
            : undefined,
        });
        roundLimit = nextLimit;
      }
      messages.push({ role: 'assistant', content: compactTurnForHistory(turn, toolMap) });
      messages.push({
        role: 'user',
        content: renderExecutionFeedback(turnResults, verify, {
          declaredDone: turn.done === true,
          actionCount: actions.length,
          unresolvedFailures: [...unresolvedToolFailures.values()],
          readOnlyLoopWarning: consecutiveReadOnlyRounds >= 2
            ? {
                rounds: consecutiveReadOnlyRounds,
                targets: actions.flatMap((action) => actionTargetPaths(action.tool, action.args)).join(', '),
              }
            : undefined,
          missingOutputStallWarning: missingOutputStallRounds >= 1 && !verify.ok
            ? {
                rounds: missingOutputStallRounds,
                missing: verify.missing.join(', '),
              }
            : undefined,
          readOnlyRecoveryWarning:
            (readOnlyRecoveryMode || directRepairMode) &&
            readOnlyRound,
          diagnosticProbeAllowance:
            directRepairMode &&
            readOnlyRound &&
            (!strictReadOnlyRecoveryMode || mutationGeneration > 0) &&
            (directRepairProbeRoundsByGeneration.get(mutationGeneration) ?? 0) <
              directRepairProbeRoundBudget
              ? {
                  remainingRounds:
                    directRepairProbeRoundBudget -
                    (directRepairProbeRoundsByGeneration.get(mutationGeneration) ?? 0),
                  maxActionsPerRound: RECOVERY_PROBE_ACTIONS_PER_ROUND,
                }
              : undefined,
          noProgressWarning: noProgressRound
            ? { rounds: consecutiveNoProgressRounds }
            : undefined,
          repairEvidenceMissing:
            repairRequired &&
            turn.done === true &&
            verify.ok &&
            unresolvedToolFailures.size === 0 &&
            !repairEvidence,
          bugResolutionPlanMissing:
            bugResolutionPlanRequired &&
            turn.done === true &&
            verify.ok &&
            unresolvedToolFailures.size === 0 &&
            !bugResolutionPlanOk,
          postMutationVerificationRequired,
          qualityAssessmentMissing:
            completionSignal && verify.ok && qualityAssessmentMissing.length > 0
              ? qualityAssessmentMissing
              : undefined,
        }, {
          feedbackCharBudget: inp.ctx.feedbackCharBudget,
          readChunkBytes: inp.ctx.readChunkBytes,
        }),
      });
    }

    const finalVerify = await verifyOutputs(inp);
    const metrics = computeMetrics({
      rounds: actualRounds || roundLimit,
      parseFailures,
      repeatedTurns,
      calls,
      initialMissing,
      currentMissing: finalVerify.missing.length,
      providers: [...providers],
    });
    const finalQualityAssessmentMissing = missingQualityAssessmentFields(
      inp.step,
      qualityAssessment,
      qualityAssessmentRound > lastToolActionRound,
    );
    const unresolvedFailureDetails = [...unresolvedToolFailures.values()];
    return {
      success: false,
      rounds: actualRounds || roundLimit,
      toolCalls: calls,
      finalThought,
      bugResolutionPlan,
      qualityAssessment,
      error:
        finalVerify.missing.length > 0
          ? `max rounds exceeded without satisfying outputs; missing outputs: ${finalVerify.missing.join(', ')}`
          :
        unresolvedFailureDetails.length > 0
          ? `max rounds exceeded; unresolved tool failures remain: ${unresolvedFailureDetails.join('; ')}`
          :
        role === 'Debugger' &&
          !!inp.debugContext?.bugTicketId &&
          !bugResolutionPlan?.trim()
          ? 'DEBUG bug-ticket completion missing bugResolutionPlan; provide a concrete handling plan before closing the ticket.'
          :
        repairRequired &&
          finalVerify.ok &&
          unresolvedToolFailures.size === 0 &&
          !repairEvidence &&
          !canAcceptOutputCompletionRecovery(inp, initialMissing)
          ? 'DEBUG retry ended without repair evidence; run a successful patch/write/dependency change or verification command before done=true.'
          :
        completionSignaled && finalQualityAssessmentMissing.length > 0
          ? `qualityAssessment is incomplete; missing: ${finalQualityAssessmentMissing.join(', ')}`
          :
        mutationGeneration > verifiedMutationGeneration
          ? 'max rounds exceeded before completion; the latest successful repair has not been followed by a successful verification.'
          : 'max rounds exceeded before completion',
      metrics,
    };
  }
}

function isReadOnlyOrProbeAction(action: LLMAction): boolean {
  if (action.tool === 'read_file' || action.tool === 'list_dir' || action.tool === 'code_search') return true;
  if (action.tool === 'analyze_error') return true;
  return action.tool === 'http_fetch' && typeof action.args.saveAs !== 'string';
}

function boundRecoveryProbeActions(
  actions: LLMAction[],
  maxReadOnlyActions = RECOVERY_PROBE_ACTIONS_PER_ROUND,
): { actions: LLMAction[]; kept: number; omitted: number } {
  let kept = 0;
  let omitted = 0;
  const bounded = actions.filter((action) => {
    if (!isReadOnlyOrProbeAction(action)) return true;
    if (kept < maxReadOnlyActions) {
      kept++;
      return true;
    }
    omitted++;
    return false;
  });
  return { actions: bounded, kept, omitted };
}

function recoveryProbeActionFingerprints(action: LLMAction): string[] {
  if (!isReadOnlyOrProbeAction(action)) return [];
  const targets = actionTargetPaths(action.tool, action.args)
    .map(normalizeRelPath)
    .filter((target) => target && target !== '.');
  if (targets.length === 0) return [];
  const qualifier =
    action.tool === 'read_file'
      ? `offset=${typeof action.args.offset === 'number' ? action.args.offset : 0}`
      : action.tool === 'code_search'
        ? `query=${typeof action.args.query === 'string' ? action.args.query : ''}`
        : '';
  return targets.map((target) => `${action.tool}:${target}:${qualifier}`);
}

function isReadOnlyLoopFailure(reason: string): boolean {
  return /repeated read-only\/probe actions without progress/i.test(reason) ||
    /read-only recovery mode repeated probe actions/i.test(reason);
}

function isRejectedReadOnlyRecovery(reason: string): boolean {
  return /low-quality Debugger response: read-only\/probe actions in read-only recovery mode/i.test(reason);
}

function isLowQualityLLMResponseError(message: string): boolean {
  return /low-quality (?:debugger )?response/i.test(message) ||
    /read-only\/probe actions in read-only recovery mode/i.test(message);
}

function hasActionableDebuggerFailure(debugContext: ExecutorRunInput['debugContext']): boolean {
  if (!debugContext) return false;
  const text = [
    debugContext.reason,
    debugContext.failureLog,
    debugContext.suggestions ?? '',
  ].join('\n');
  return /content must be a string/i.test(text) ||
    /invalid (?:write_file|append_file|replace_in_file|apply_patch) args/i.test(text) ||
    /\berror\s+TS\d{4}\b/i.test(text) ||
    /\b(?:SyntaxError|TypeError|ReferenceError|AssertionError)\b/u.test(text) ||
    /\b(?:pytest|vitest|npm test|tsc|typecheck|build)\b[^\n]*(?:exit[=\s]\d+|failed)/i.test(text) ||
    /\b(?:tests?|test suites?)\s+failed\b/i.test(text) ||
    /outputs?\s+(?:still\s+missing|missing)/i.test(text) ||
    /missing\s+(?:required\s+)?outputs?/i.test(text) ||
    /outputs?\s*(?:仍缺失|缺失)/u.test(text) ||
    /仍缺失[:：]/u.test(text);
}

function resolveDirectRepairProbeRoundBudget(
  debugContext: ExecutorRunInput['debugContext'],
): number {
  if (!debugContext) return 1;
  const text = [
    debugContext.reason,
    debugContext.failureLog,
    debugContext.suggestions ?? '',
  ].join('\n');
  const paths = new Set<string>();
  const pathPattern =
    /(?:^|[\s"'`(])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?=[(:\s"'`\]])/gmu;
  for (const match of text.matchAll(pathPattern)) {
    const candidate = normalizeRelPath(match[1] ?? '');
    if (
      candidate &&
      candidate !== '.' &&
      !candidate.startsWith('node_modules/') &&
      !candidate.startsWith('.xcompiler/')
    ) {
      paths.add(candidate);
    }
  }
  return Math.max(
    1,
    Math.min(
      MAX_DIRECT_REPAIR_PROBE_ROUNDS,
      Math.ceil(Math.max(1, paths.size) / RECOVERY_PROBE_ACTIONS_PER_ROUND),
    ),
  );
}

function canAcceptOutputCompletionRecovery(inp: ExecutorRunInput, initialMissing: number): boolean {
  if (inp.executionRole !== 'Debugger') return false;
  if (inp.debugContext?.repairRequired !== true) return false;
  if (initialMissing !== 0) return false;
  return isOutputCompletionFailure(inp.debugContext.reason, inp.debugContext.failureLog);
}

function hasOnlyUntargetedToolContractFailures(unresolved: Map<string, string>): boolean {
  if (unresolved.size === 0) return true;
  return [...unresolved.entries()].every(([key, detail]) =>
    key.startsWith('tool:') &&
    /invalid (?:write_file|append_file|replace_in_file|read_file) args: path must be a non-empty string/i.test(detail),
  );
}

function hasOnlySupersededToolContractFailures(unresolved: Map<string, string>): boolean {
  if (unresolved.size === 0) return true;
  return [...unresolved.values()].every((detail) =>
    /invalid (?:write_file|append_file|replace_in_file|apply_patch|read_file) args/i.test(detail) ||
    /(?:read_file|write_file|append_file|replace_in_file|apply_patch) denied: path "\." is outside the project directory/i.test(detail) ||
    /(?:read_file|write_file|append_file|replace_in_file) failed:.*path must be a non-empty string/i.test(detail) ||
    /path must be a non-empty string/i.test(detail) ||
    /tool not allowed for this step: add_dependency/i.test(detail),
  );
}

function hasOnlyUnauthorizedVerificationFailures(unresolved: Map<string, string>): boolean {
  if (unresolved.size === 0) return false;
  return [...unresolved.entries()].every(([key, detail]) =>
    (key.startsWith('verification:run_tests:') || key.startsWith('verification:run_program:')) &&
    /tool not allowed for this step: (?:run_tests|run_program)/i.test(detail),
  );
}

function isOutputCompletionFailure(reason = '', failureLog = ''): boolean {
  const text = `${reason}\n${failureLog}`;
  return /max rounds exceeded without satisfying outputs/i.test(text) ||
    /outputs?\s+(?:still\s+)?missing/i.test(text) ||
    /missing\s+(?:required\s+)?outputs?/i.test(text) ||
    /outputs?\s*仍缺失/u.test(text) ||
    /仍缺失[:：]/u.test(text);
}

function validateDebuggerRecoveryTurn(
  text: string,
  toolMap: Map<string, Tool>,
  options: {
    enforceRecoveryContract?: boolean;
    requireBugResolutionPlanBeforeAction?: boolean;
    allowNovelReadOnlyProbes?: boolean;
    seenProbeFingerprints?: ReadonlySet<string>;
  } = {},
): void {
  const turn = parseTurn(text);
  const normalized = normalizeActions(turn.actions, toolMap);
  const actions = normalized.actions;
  const allowedActions = actions.filter((action) => toolMap.has(action.tool));
  const emptyOrUnparsed =
    turn.thoughts === undefined &&
    actions.length === 0 &&
    normalized.invalid.length === 0 &&
    turn.done === undefined;
  if (emptyOrUnparsed) {
    throw new Error(
      'low-quality Debugger response: empty or unparseable JSON turn in read-only recovery mode; ' +
      'produce valid JSON with a repair action, verification action, or concrete blocker',
    );
  }
  if (normalized.invalid.length > 0 && actions.length === 0) {
    throw new Error(
      'low-quality Debugger response: invalid tool actions in read-only recovery mode; ' +
      'produce valid tool arguments for a repair action, verification action, or concrete blocker',
    );
  }
  if (
    options.requireBugResolutionPlanBeforeAction &&
    !extractBugResolutionPlan(turn)?.trim() &&
    (allowedActions.some((action) => isRepairEvidenceTool(action.tool)) || turn.done === true)
  ) {
    throw new Error(
      'low-quality Debugger response: bugResolutionPlan is required before repair or verification actions; ' +
      'include the root-cause hypothesis, repair target, and validation command in the same JSON response',
    );
  }
  if (!options.enforceRecoveryContract) return;
  if (actions.length === 0 && turn.done === true) return;
  if (actions.length === 0) {
    throw new Error(
      'low-quality Debugger response: no valid tool actions in read-only recovery mode; ' +
      'produce a repair action, verification action, or concrete blocker instead',
    );
  }
  if (allowedActions.length === 0) {
    const unknownTools = [...new Set(actions.map((action) => action.tool))].join(', ');
    throw new Error(
      'low-quality Debugger response: no allowed tool actions in read-only recovery mode; ' +
      `unknown or unavailable tools: ${unknownTools || 'none'}; ` +
      'produce an allowed repair action, verification action, or concrete blocker instead',
    );
  }
  if (allowedActions.every(isReadOnlyOrProbeAction)) {
    const fingerprints = allowedActions.flatMap(recoveryProbeActionFingerprints);
    if (
      options.allowNovelReadOnlyProbes &&
      fingerprints.some((fingerprint) => !options.seenProbeFingerprints?.has(fingerprint))
    ) {
      return;
    }
    throw new Error(
      'low-quality Debugger response: read-only/probe actions in read-only recovery mode; ' +
      'read a new concrete error-related path/window, produce a repair action, run verification, or provide a concrete blocker instead',
    );
  }
}

const REPAIR_EVIDENCE_TOOLS = new Set([
  'add_dependency',
  'append_file',
  'apply_patch',
  'replace_in_file',
  'run_program',
  'run_tests',
  'write_file',
]);

const OUTPUT_MUTATION_TOOLS = new Set([
  'add_dependency',
  'append_file',
  'apply_patch',
  'replace_in_file',
  'write_file',
]);

function isRepairEvidenceTool(tool: string): boolean {
  return REPAIR_EVIDENCE_TOOLS.has(tool);
}

function isOutputMutationTool(tool: string): boolean {
  return OUTPUT_MUTATION_TOOLS.has(tool);
}

async function automaticCodeDebugVerificationActions(input: {
  actions: LLMAction[];
  role: string;
  phase: Step['phase'];
  language: LanguageProfile['id'];
  toolMap: Map<string, Tool>;
  ctx: ToolContext;
}): Promise<LLMAction[]> {
  if (input.role !== 'Debugger' || input.phase !== 'CODE') return [];
  if (!input.actions.some((action) => isOutputMutationTool(action.tool))) return [];
  const automatic: LLMAction[] = [];
  const requestedTools = new Set(input.actions.map((action) => action.tool));
  const hasInheritedTestGate = (input.ctx.defaultTestArgs?.length ?? 0) > 0;
  const hasStaticPrerequisites =
    input.language === 'typescript' || await input.ctx.ws.exists('src');
  if (
    !hasInheritedTestGate &&
    hasStaticPrerequisites &&
    input.toolMap.has('run_program') &&
    !requestedTools.has('run_program')
  ) {
    automatic.push({
      tool: 'run_program',
      args: input.language === 'typescript'
        ? { args: ['npx', 'tsc', '--noEmit'] }
        : { args: ['-m', 'compileall', '-q', 'src'] },
    });
  }
  if (
    (input.ctx.defaultTestArgs?.length ?? 0) > 0 &&
    input.toolMap.has('run_tests') &&
    !requestedTools.has('run_tests')
  ) {
    automatic.push({ tool: 'run_tests', args: {} });
  }
  return automatic;
}

function didPerformSuccessfulMutation(action: LLMAction, result: ToolResult): boolean {
  if (!result.ok || !isOutputMutationTool(action.tool)) return false;
  if (action.tool === 'write_file') {
    if (!isPlainRecord(result.data)) return true;
    return result.data.changed !== false;
  }
  if (action.tool === 'append_file') {
    return typeof action.args.content === 'string' && action.args.content.length > 0;
  }
  if (action.tool !== 'add_dependency') return true;
  if (!isPlainRecord(result.data)) return false;
  return (Array.isArray(result.data.added) && result.data.added.length > 0) ||
    (Array.isArray(result.data.updated) && result.data.updated.length > 0);
}

function shouldTrackRepeatedMutationFailure(result: ToolResult): boolean {
  return !/not in step writable allowlist/i.test(result.error ?? '');
}

function isDeclarativeOutputPhase(phase: Step['phase']): boolean {
  return phase === 'REQUIREMENT_ANALYSIS' ||
    phase === 'HIGH_LEVEL_DESIGN' ||
    phase === 'DETAILED_DESIGN';
}

const COMPLETION_VERIFICATION_TOOLS = new Set([
  'run_program',
  'run_tests',
]);

function hasSuccessfulCompletionVerification(calls: ExecutorRunResult['toolCalls']): boolean {
  return calls.some((call) => call.ok && COMPLETION_VERIFICATION_TOOLS.has(call.tool));
}

function shouldExtendProductiveRun(p: {
  parseFailures: number;
  repeatedTurns: number;
  calls: ExecutorRunResult['toolCalls'];
  initialMissing: number;
  currentMissing: number;
  consecutiveReadOnlyRounds: number;
  unresolvedFailures: number;
  pendingMutation: boolean;
}): boolean {
  if (p.parseFailures > 0 || p.repeatedTurns > 0 || p.consecutiveReadOnlyRounds >= 2) return false;
  const totalCalls = p.calls.length;
  const failedCalls = p.calls.filter((call) => !call.ok).length;
  const toolFailRatio = totalCalls > 0 ? failedCalls / totalCalls : 0;
  // A successful repair after a failed verification needs one more round to
  // prove the fix. The next successful verification clears the unresolved test failure.
  if (p.pendingMutation && toolFailRatio <= 0.5) return true;
  if (p.consecutiveReadOnlyRounds > 0) return false;
  if (toolFailRatio > 0.25 || p.unresolvedFailures > 0) return false;
  if (p.initialMissing > 0 && p.currentMissing < p.initialMissing) return true;
  return p.pendingMutation;
}

function compactTurnForHistory(turn: LLMTurn, toolMap?: Map<string, Tool>): string {
  const normalized = normalizeActions(turn.actions, toolMap);
  const omittedPayloadActions = normalized.actions.filter(hasReplayUnsafePayload);
  const safeActions = normalized.actions.filter((action) => !hasReplayUnsafePayload(action));
  const omittedSummary = omittedPayloadActions.length > 0
    ? ` Previous payload actions already executed; do not replay these summaries as tool args: ${omittedPayloadActions
        .map((action) => {
          const targets = actionTargetPaths(action.tool, action.args).join(', ') || 'no target';
          return `${action.tool}(${targets}; payload omitted)`;
        })
        .join('; ')}.`
    : '';
  return JSON.stringify({
    thoughts: truncate(`${turn.thoughts ?? ''}${omittedSummary}`, 900),
    bugResolutionPlan: truncate(extractBugResolutionPlan(turn) ?? '', 900),
    actions: safeActions.map((action) => ({
      tool: action.tool,
      args: compactActionArgs(action.tool, action.args),
    })),
    invalidActions: normalized.invalid.map((item) => ({
      index: item.index,
      error: item.result.error,
    })),
    done: turn.done === true,
  });
}

function hasReplayUnsafePayload(action: LLMAction): boolean {
  if (!isPlainRecord(action.args)) return false;
  return ['content', 'patch', 'body'].some((key) => typeof action.args[key] === 'string');
}

function compactActionArgs(tool: string, args: unknown): Record<string, unknown> {
  if (!isPlainRecord(args)) {
    return { invalidArgs: args ?? null };
  }
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      compact[key] = truncate(value, 500);
    } else if (Array.isArray(value)) {
      compact[key] = value.map((item) => typeof item === 'string' ? truncate(item, 200) : item);
    } else if (value && typeof value === 'object') {
      const encoded = JSON.stringify(value);
      compact[key] = encoded.length > 800 ? `${encoded.slice(0, 800)}... [truncated ${encoded.length - 800} chars]` : value;
    } else {
      compact[key] = value;
    }
  }
  if (!('path' in compact)) {
    const targets = actionTargetPaths(tool, args);
    if (targets.length > 0) compact.targets = targets;
  }
  return compact;
}

function updateUnresolvedToolFailures(
  unresolved: Map<string, string>,
  action: LLMAction,
  result: ToolResult,
  advisoryFailureTools: Set<string>,
  advisoryFailureRules: AdvisoryFailureRule[] = [],
): void {
  const keys = actionResolutionKeys(action);
  if (result.ok) {
    for (const key of keys) unresolved.delete(key);
    if (!COMPLETION_VERIFICATION_TOOLS.has(action.tool)) {
      unresolved.delete(`tool:${action.tool}`);
    }
    return;
  }
  if (advisoryFailureTools.has(action.tool)) return;
  if (matchesAdvisoryFailureRule(action, result, advisoryFailureRules)) return;
  if (isIgnorableReadOnlyToolFailure(action, result)) return;
  const detail = truncate(
    `${action.tool} FAIL ${result.error ?? result.summary ?? 'unknown error'}`,
    1500,
  );
  for (const key of keys) unresolved.set(key, detail);
}

function matchesAdvisoryFailureRule(
  action: LLMAction,
  result: ToolResult,
  rules: AdvisoryFailureRule[],
): boolean {
  if (rules.length === 0) return false;
  const detail = `${result.error ?? ''}\n${result.summary ?? ''}`.toLowerCase();
  const targets = actionTargetPaths(action.tool, action.args);
  return rules.some((rule) => {
    if (rule.tool && rule.tool !== action.tool) return false;
    if (rule.errorIncludes && !detail.includes(rule.errorIncludes.toLowerCase())) return false;
    if (rule.pathPrefix) {
      const prefix = normalizeRelPath(rule.pathPrefix);
      if (!targets.some((target) => normalizeRelPath(target).startsWith(prefix))) return false;
    }
    return true;
  });
}

function isIgnorableReadOnlyToolFailure(action: LLMAction, result: ToolResult): boolean {
  const readOnly = action.tool === 'read_file' || action.tool === 'list_dir' || action.tool === 'code_search';
  if (!readOnly) return false;
  return result.error?.includes('tool not allowed for this step') === true ||
    /\bENOENT\b|no such file or directory/iu.test(result.error ?? '');
}

function actionResolutionKeys(action: LLMAction): string[] {
  if (COMPLETION_VERIFICATION_TOOLS.has(action.tool)) {
    return [`verification:${verificationActionKey(action)}`];
  }
  const targets = actionTargetPaths(action.tool, action.args);
  if (targets.length > 0) return targets.map((target) => `path:${target}`);
  return [`tool:${action.tool}`];
}

function verificationActionKey(action: LLMAction): string {
  return `${action.tool}:${stableActionValue(action.args)}`;
}

function verificationActionLabel(action: LLMAction): string {
  if (!isPlainRecord(action.args)) return verificationActionKey(action);
  const command = typeof action.args.command === 'string'
    ? action.args.command
    : Array.isArray(action.args.args)
      ? action.args.args.map(String).join(' ')
      : undefined;
  const cwd = typeof action.args.cwd === 'string' ? action.args.cwd : '.';
  return command ? `${action.tool} ${command} (cwd=${cwd})` : verificationActionKey(action);
}

function stableActionValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableActionValue).join(',')}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableActionValue(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function actionTargetPaths(tool: string, args: unknown): string[] {
  if (!isPlainRecord(args)) return [];
  if (tool === 'read_file') {
    return typeof args.path === 'string' ? [normalizeRelPath(args.path)] : [];
  }
  if (tool === 'list_dir') {
    return typeof args.path === 'string' ? [normalizeRelPath(args.path)] : ['.'];
  }
  if (tool === 'code_search') {
    return typeof args.root === 'string' ? [normalizeRelPath(args.root)] : ['.'];
  }
  if (tool === 'write_file' || tool === 'append_file' || tool === 'replace_in_file') {
    return typeof args.path === 'string' ? [normalizeRelPath(args.path)] : [];
  }
  if (tool === 'apply_patch' && typeof args.patch === 'string') {
    return extractPatchTargets(args.patch).map(normalizeRelPath);
  }
  if (tool === 'add_dependency') return ['requirements.txt'];
  if (tool === 'http_fetch' && typeof args.saveAs === 'string') {
    return [normalizeRelPath(args.saveAs)];
  }
  return [];
}

function extractPatchTargets(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split('\n')) {
    const m =
      line.match(/^\*\*\* (?:Update File|Add File|Delete File):\s+(.+)$/) ??
      line.match(/^\+\+\+\s+b\/(.+)$/) ??
      line.match(/^---\s+a\/(.+)$/);
    if (m?.[1] && m[1] !== '/dev/null') out.add(m[1].trim());
  }
  return [...out];
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function buildPermissionRequest(
  tool: string,
  args: unknown,
  stepId: string,
  language: ToolContext['language'],
  stepName?: string,
): ToolPermissionRequest | undefined {
  const argRecord = isPlainRecord(args) ? args : {};
  const target = actionTargetPaths(tool, args).join(', ');
  const runtime = language === 'typescript' ? 'npm' : 'python';
  const stepLabel = stepName?.trim() || stepId;
  if (tool === 'write_file' || tool === 'append_file' || tool === 'replace_in_file' || tool === 'apply_patch') {
    return {
      operationType: 'file_write',
      target: target || '(workspace file)',
      reason: `Step ${stepLabel} requested ${tool} to update project files.`,
      risk: 'This operation modifies files in the current workspace.',
      scope: 'current workspace',
      skippable: true,
      denyBehavior: 'The tool call is skipped and the agent must continue with an alternative or fail the step.',
      stepId,
      tool,
      metadata: { stepName: stepLabel, args: redactLargeArgs(args) },
    };
  }
  if (tool === 'add_dependency') {
    return {
      operationType: 'config_change',
      target: language === 'typescript' ? 'package.json' : 'requirements.txt',
      reason: `Step ${stepLabel} requested dependency manifest changes.`,
      risk: 'This can alter project dependencies and may trigger sandbox rebuilds.',
      scope: 'current workspace dependency manifest',
      skippable: true,
      denyBehavior: 'The dependency change is skipped; later build or test steps may fail and report the missing dependency.',
      stepId,
      tool,
      metadata: { stepName: stepLabel, args },
    };
  }
  if (tool === 'install_deps') {
    return {
      operationType: 'install_dependency',
      target: Array.isArray(argRecord.packages) ? argRecord.packages.join(', ') : '(packages)',
      reason: `Step ${stepLabel} requested dependency installation.`,
      risk: 'This may execute package manager scripts and download code from registries.',
      scope: 'current workspace sandbox',
      skippable: true,
      denyBehavior: 'Dependency installation is skipped and the task continues with the missing dependency reported.',
      stepId,
      tool,
      metadata: { stepName: stepLabel, args },
    };
  }
  if (tool === 'run_tests') {
    return {
      operationType: 'test_command',
      target: runtime === 'npm' ? 'npm test' : 'pytest',
      reason: `Step ${stepLabel} requested test execution to validate changes.`,
      risk: 'Project test scripts may execute arbitrary local project code.',
      scope: 'current workspace sandbox',
      skippable: true,
      denyBehavior: 'Tests are skipped and the final result must mark verification as incomplete.',
      stepId,
      tool,
      metadata: { stepName: stepLabel, args },
    };
  }
  if (tool === 'run_program') {
    return {
      operationType: 'shell_command',
      target: `${runtime} ${Array.isArray(argRecord.args) ? argRecord.args.join(' ') : ''}`.trim(),
      reason: `Step ${stepLabel} requested program execution.`,
      risk: 'This executes project code in the configured sandbox.',
      scope: 'current workspace sandbox',
      skippable: true,
      denyBehavior: 'The command is skipped and the agent must use another validation strategy or fail the step.',
      stepId,
      tool,
      metadata: { stepName: stepLabel, args },
    };
  }
  if (tool === 'http_fetch') {
    return {
      operationType: 'network_access',
      target: typeof argRecord.url === 'string' ? argRecord.url : '(url)',
      reason: `Step ${stepLabel} requested network access.`,
      risk: 'This contacts an external HTTP endpoint from the host process.',
      scope: 'network',
      skippable: true,
      denyBehavior: 'The network call is skipped; the agent must use local context or report the missing data.',
      stepId,
      tool,
      metadata: { stepName: stepLabel, args: redactLargeArgs(args) },
    };
  }
  return undefined;
}

function redactLargeArgs(args: unknown): Record<string, unknown> {
  if (!isPlainRecord(args)) return { value: args ?? null };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 500) {
      out[key] = `${value.slice(0, 500)}... [truncated ${value.length - 500} chars]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function changedFilesForAction(tool: string, args: unknown, result: ToolResult): string[] {
  if (tool === 'apply_patch' && result.data && typeof result.data === 'object') {
    const changed = (result.data as { changedFiles?: unknown }).changedFiles;
    if (Array.isArray(changed)) return changed.filter((x): x is string => typeof x === 'string');
  }
  if (
    tool !== 'write_file' &&
    tool !== 'append_file' &&
    tool !== 'replace_in_file' &&
    tool !== 'http_fetch' &&
    tool !== 'add_dependency'
  ) {
    return [];
  }
  return actionTargetPaths(tool, args);
}

function computeMetrics(p: {
  rounds: number;
  parseFailures: number;
  repeatedTurns: number;
  calls: ExecutorRunResult['toolCalls'];
  initialMissing: number;
  currentMissing: number;
  providers: string[];
}): ExecutorRunMetrics {
  const rounds = Math.max(1, p.rounds);
  const totalCalls = p.calls.length;
  const failedCalls = p.calls.filter((c) => !c.ok).length;
  const toolFailRatio = totalCalls > 0 ? failedCalls / totalCalls : 0;
  const progressRatio =
    p.initialMissing > 0
      ? Math.max(0, Math.min(1, 1 - p.currentMissing / p.initialMissing))
      : 1;
  // 健康度：解析失败 / 重复 / 工具失败率 / 反向进度都是扣分项。
  const badRoundsRatio = Math.min(1, (p.parseFailures + p.repeatedTurns) / rounds);
  let score = 1 - badRoundsRatio * 0.6 - toolFailRatio * 0.2 - (1 - progressRatio) * 0.2;
  score = Math.max(0, Math.min(1, score));
  return {
    rounds,
    parseFailures: p.parseFailures,
    repeatedTurns: p.repeatedTurns,
    toolFailRatio,
    progressRatio,
    healthScore: score,
    providers: [...new Set(p.providers)],
  };
}

export async function verifyOutputs(inp: ExecutorRunInput): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const out of inp.step.outputs) {
    if (out.endsWith('/')) continue; // 目录约束跳过显式文件检查
    const exists = await inp.ctx.ws.exists(out);
    if (!exists || !(await hasSubstantiveOutputContent(inp, out))) missing.push(out);
  }
  return { ok: missing.length === 0, missing };
}

async function hasSubstantiveOutputContent(inp: ExecutorRunInput, output: string): Promise<boolean> {
  if (output.endsWith('/__init__.py') || output.endsWith('/.gitkeep')) return true;
  const stat = await fs.stat(inp.ctx.ws.abs(output)).catch(() => undefined);
  if (!stat?.isFile() || stat.size === 0) return false;
  if (!isTextOutput(output)) return true;
  const content = await fs.readFile(inp.ctx.ws.abs(output), 'utf8').catch(() => '');
  return content.trim().length > 0;
}

function isTextOutput(output: string): boolean {
  return /(?:^|\/)(?:README|LICENSE)(?:\.[A-Za-z0-9]+)?$/iu.test(output) ||
    /\.(?:cjs|css|csv|hbs|html?|ini|json|jsx?|md|mjs|py|toml|tsx?|txt|xml|ya?ml)$/iu.test(output);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n... [truncated ${s.length - n} chars]` : s;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
