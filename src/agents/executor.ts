import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { jsonrepair } from 'jsonrepair';
import type { ChatOptions, LLMClient } from '../llm/types.js';
import type { Step } from '../core/plan.js';
import type { EngineeringChangeRequest } from '../core/change_request.js';
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

const MISSING_OUTPUT_STALL_ROUND_LIMIT = 3;

/**
 * Executor 把一个 Step 交给对应角色的 LLM，要求其用一组 tool calls 完成产出。
 *
 * 协议：LLM 必须严格返回 JSON：
 *   { "thoughts": "短说明", "actions": [ { "tool": "name", "args": {...} }, ... ], "done": true|false }
 * DEBUG issue 场景还必须额外返回 issueResolutionPlan，供 issue/debug-wiki 持久化。
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
  /** Explicit bytes remain a hard override; auto follows the active provider context window. */
  maxWriteChunkBytes?: number | 'auto';
}

export interface ExecutorRunInput {
  step: Step;
  /** Runtime execution role. Debug retries keep the same source step but execute as Debugger. */
  executionRole?: Step['role'];
  /** 仅暴露给 LLM 的工具子集（已按 step.tools 过滤）。 */
  tools: Tool[];
  ctx: ToolContext;
  /** 注入到 user prompt 的额外上下文（如已有 inputs 内容）。 */
  contextSnippets?: Array<{ path: string; content: string }>;
  /** Active engineering CR. The Step must apply only this delta to the existing baseline. */
  changeRequest?: EngineeringChangeRequest;
  /** 来自 Skill 的提示词，拼接到 system prompt 后。 */
  skillHints?: string[];
  /** debug 模式下传入上一轮失败记录（错误文本 / 失败测试 / 上下文）。 */
  debugContext?: {
    issueId?: string;
    reason: string;
    failureLog: string;
    debugBrief?: string;
    suggestions?: string;
    repairRequired?: boolean;
  };
  /** Plan 级别的全局 system prompt（xcompiler build 沉淀）。 */
  globalPrompt?: string;
  /** 目标语言 profile（决定 executor system prompt 的语言专属覆盖块）。默认 python。 */
  languageProfile?: LanguageProfile;
}

export interface ExecutorRunResult {
  success: boolean;
  rounds: number;
  toolCalls: Array<{ tool: string; ok: boolean; summary?: string; error?: string }>;
  finalThought?: string;
  /** Debugger 处理 issue 时输出的可复用处理方案，成功后写回 issue/debug-wiki。 */
  issueResolutionPlan?: string;
  error?: string;
  /** 健康度统计：用于调用方做"滑动窗口"自适应重试决策。 */
  metrics: ExecutorRunMetrics;
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
}

interface LLMAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface AdvisoryFailureRule {
  tool?: string;
  pathPrefix?: string;
  errorIncludes?: string;
}

interface LLMTurn {
  thoughts?: string;
  issueResolutionPlan?: string;
  issue_resolution_plan?: string;
  resolutionPlan?: string;
  handlingPlan?: string;
  fixPlan?: string;
  actions?: unknown;
  done?: boolean;
}

interface TurnFeedbackContext {
  declaredDone: boolean;
  actionCount: number;
  unresolvedFailures?: string[];
  readOnlyLoopWarning?: { rounds: number; targets: string };
  missingOutputStallWarning?: { rounds: number; missing: string };
  readOnlyRecoveryWarning?: boolean;
  noProgressWarning?: { rounds: number };
  repairEvidenceMissing?: boolean;
  issueResolutionPlanMissing?: boolean;
}

export class StepExecutor {
  constructor(private readonly opts: ExecutorOptions) {}

  async run(inp: ExecutorRunInput): Promise<ExecutorRunResult> {
    const maxRounds = this.opts.maxRounds ?? 6;
    let roundLimit = maxRounds;
    const role = inp.executionRole ?? inp.step.role;
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
    const userPrompt = renderUserPrompt(inp, toolDocs, initialMissingOutputs);
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
    let issueResolutionPlan: string | undefined;

    // 健康度信号采集
    const initialMissing = initialVerify.missing.length;
    const hardRoundLimit = Math.max(maxRounds, maxRounds + Math.min(12, Math.max(4, initialMissing * 2)));
    let lastMissingCount = initialMissing;
    let missingOutputStallRounds = 0;
    let parseFailures = 0;
    let repeatedTurns = 0;
    let lastActionsKey: string | null = null;
    /** 每个 (tool+args) 指纹被尝试过的累计次数；用于检测"换汤不换药"。 */
    const actionFingerprints = new Map<string, number>();
    const unresolvedToolFailures = new Map<string, string>();
    let actualRounds = 0;
    let consecutiveReadOnlyRounds = 0;
    let consecutiveNoProgressRounds = 0;
    let failedTestRunRounds = 0;
    let repairEvidence = false;
    const repairRequired = inp.debugContext?.repairRequired === true;
    const readOnlyRecoveryMode = isReadOnlyLoopFailure(inp.debugContext?.reason ?? '');
    const directRepairMode =
      role === 'Debugger' &&
      repairRequired &&
      (initialMissing > 0 || hasActionableDebuggerFailure(inp.debugContext));
    let readOnlyRecoveryRounds = 0;
    const advisoryFailureTools = new Set(this.opts.advisoryFailureTools ?? []);
    const advisoryFailureRules = this.opts.advisoryFailureRules ?? [];

    for (let round = 1; round <= roundLimit; round++) {
      const rep = makeStreamReporter(
        `${inp.step.id} ${role} round ${round}`,
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
        const chatMessages = compactMessagesForChat(messages, !!inp.debugContext);
        const chatOptions: ChatOptions = {
          responseFormat: 'json',
          temperature: 0.1,
          maxTokens: inp.ctx.responseTokenBudget,
          scoreSuccess: false,
          validate:
            role === 'Debugger' && (
              (readOnlyRecoveryMode && readOnlyRecoveryRounds >= 1) ||
              (directRepairMode && consecutiveReadOnlyRounds >= 1)
            )
              ? (text) => validateDebuggerRecoveryTurn(text, toolMap)
              : undefined,
          onProvider: (name) => { provider = name; },
          onProviderStart: (name, model, providerWindow) => {
            provider = name;
            rawAggregate = '';
            updateOperationWindow(inp.ctx, {
              contextWindowTokens: providerWindow?.contextWindowTokens ?? inp.ctx.contextWindowTokens,
              promptChars: chatMessages.reduce((sum, message) => sum + message.content.length, 0),
              configuredWriteChunkBytes: this.opts.maxWriteChunkBytes ?? 'auto',
            });
            const refreshedToolDocs = inp.tools
              .map((tool) =>
                `- ${tool.name}: ${describeToolForStep(tool, inp.ctx, inp.step)} args=${JSON.stringify(tool.argsSchema)}`,
              )
              .join('\n');
            if (messages[1]) {
              messages[1].content = renderUserPrompt(inp, refreshedToolDocs, initialMissingOutputs);
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
        text = await this.opts.llm.chat(chatMessages, chatOptions);
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
          const verify = await verifyOutputs(inp);
          const metrics = computeMetrics({
            rounds: actualRounds,
            parseFailures,
            repeatedTurns,
            calls,
            initialMissing,
            currentMissing: verify.missing.length,
          });
          return {
            success: false,
            rounds: round,
            toolCalls: calls,
            finalThought,
            issueResolutionPlan,
            error: errMsg,
            metrics,
          };
        }
        throw err;
      }
      rep.done();
      const turn = parseTurn(text);
      finalThought = turn.thoughts;
      issueResolutionPlan = extractIssueResolutionPlan(turn) ?? issueResolutionPlan;
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
      const noProgressRound = actions.length === 0 && turn.done !== true;
      if (noProgressRound) {
        consecutiveNoProgressRounds++;
      } else {
        consecutiveNoProgressRounds = 0;
      }
      if (readOnlyRound) {
        consecutiveReadOnlyRounds++;
        if (readOnlyRecoveryMode) {
          readOnlyRecoveryRounds++;
        }
      } else if (actions.length > 0) {
        consecutiveReadOnlyRounds = 0;
        readOnlyRecoveryRounds = 0;
      }
      // 把 LLM 本轮的"思考过程 + 计划行动"写入审计，作为交付时的可追溯材料
      await inp.ctx.audit?.executorTurn(inp.step.id, role, round, {
        thoughts: turn.thoughts,
        issueResolutionPlan,
        actions,
        done: turn.done === true,
        raw: text,
        provider,
      });
      const turnResults: Array<ToolResult & { tool: string }> = normalizedActions.invalid.map((item) => ({
        ...item.result,
        tool: item.result.tool,
      }));
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
        const permission = buildPermissionRequest(a.tool, a.args, inp.step.id, inp.ctx.language);
        if (permission) permission.id = callId;
        await inp.ctx.onToolEvent?.({
          callId,
          status: 'started',
          stepId: inp.step.id,
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
          t().stream.toolExecution(inp.step.id, a.tool),
          t().stream.toolRunner,
          { enabled: this.opts.streamOutput === true },
        );
        const r = await safeRunTool(selectedTool, a.args, inp.ctx);
        toolReporter.done(r.ok ? 'done' : 'failed');
        updateUnresolvedToolFailures(unresolvedToolFailures, a, r, advisoryFailureTools, advisoryFailureRules);
        if (r.ok && isRepairEvidenceTool(a.tool)) {
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
          tool: a.tool,
          target: actionTargetPaths(a.tool, a.args).join(', ') || undefined,
          ok: r.ok,
          summary: r.summary,
          error: r.error,
          changedFiles: r.ok ? changedFilesForAction(a.tool, a.args, r) : undefined,
        });
        calls.push({ tool: a.tool, ok: r.ok, summary: r.summary, error: r.error });
        turnResults.push({ ...r, tool: a.tool });
      }
      const verify = await verifyOutputs(inp);
      const mutationSucceededThisRound = turnResults.some((r) => r.ok && isRepairEvidenceTool(r.tool));
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
      const repairGateOk = !repairRequired ||
        repairEvidence ||
        canAcceptOutputCompletionRecovery(inp, initialMissing);
      const issueResolutionPlanRequired = role === 'Debugger' && !!inp.debugContext?.issueId;
      const issueResolutionPlanOk = !issueResolutionPlanRequired || !!issueResolutionPlan?.trim();
      const verifiedCompletion = !turn.done && hasSuccessfulCompletionVerification(calls);
      const outputCompletionRecovery = verify.ok && canAcceptOutputCompletionRecovery(inp, initialMissing);
      const declarativeOutputCompletion =
        !turn.done &&
        verify.ok &&
        isDeclarativeOutputPhase(inp.step.phase) &&
        turnResults.some((result) => result.ok && isOutputMutationTool(result.tool));
      const supersededContractFailures =
        repairEvidence &&
        hasSuccessfulCompletionVerification(calls) &&
        hasOnlySupersededToolContractFailures(unresolvedToolFailures);
      const unresolvedFailuresOk =
        unresolvedToolFailures.size === 0 ||
        (outputCompletionRecovery && hasOnlyUntargetedToolContractFailures(unresolvedToolFailures)) ||
        supersededContractFailures;
      const completionSignal =
        turn.done ||
        verifiedCompletion ||
        outputCompletionRecovery ||
        declarativeOutputCompletion;
      if (
        completionSignal &&
        verify.ok &&
        unresolvedFailuresOk &&
        repairGateOk &&
        issueResolutionPlanOk
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
        });
        return { success: true, rounds: round, toolCalls: calls, finalThought, issueResolutionPlan, metrics };
      }
      if (this.opts.maxFailedTestRuns && failedTestRunRounds >= this.opts.maxFailedTestRuns) {
        const metrics = computeMetrics({
          rounds: actualRounds,
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: verify.missing.length,
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
        return { success: false, rounds: round, toolCalls: calls, finalThought, issueResolutionPlan, error, metrics };
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
        return { success: false, rounds: round, toolCalls: calls, finalThought, issueResolutionPlan, error, metrics };
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
        return { success: false, rounds: round, toolCalls: calls, finalThought, issueResolutionPlan, error, metrics };
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
        return { success: false, rounds: round, toolCalls: calls, finalThought, issueResolutionPlan, error, metrics };
      }
      if (
        round >= roundLimit &&
        roundLimit < hardRoundLimit &&
        shouldExtendProductiveRun({
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: verify.missing.length,
          consecutiveReadOnlyRounds,
          unresolvedFailures: unresolvedToolFailures.size,
        })
      ) {
        const nextLimit = Math.min(hardRoundLimit, roundLimit + 2);
        await inp.ctx.audit?.event('note', `productive step progress detected; extending round budget ${roundLimit}→${nextLimit}`, {
          messageId: 'audit.executor_productive_round_extension',
          stepId: inp.step.id,
          round,
          previousLimit: roundLimit,
          nextLimit,
          initialMissing,
          currentMissing: verify.missing.length,
        });
        roundLimit = nextLimit;
      }
      messages.push({ role: 'assistant', content: compactTurnForHistory(turn, toolMap) });
      messages.push({
        role: 'user',
        content: renderFeedback(turnResults, verify, {
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
          readOnlyRecoveryWarning: (readOnlyRecoveryMode || directRepairMode) && readOnlyRound,
          noProgressWarning: noProgressRound
            ? { rounds: consecutiveNoProgressRounds }
            : undefined,
          repairEvidenceMissing:
            repairRequired &&
            turn.done === true &&
            verify.ok &&
            unresolvedToolFailures.size === 0 &&
            !repairEvidence,
          issueResolutionPlanMissing:
            issueResolutionPlanRequired &&
            turn.done === true &&
            verify.ok &&
            unresolvedToolFailures.size === 0 &&
            !issueResolutionPlanOk,
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
    });
    return {
      success: false,
      rounds: actualRounds || roundLimit,
      toolCalls: calls,
      finalThought,
      issueResolutionPlan,
      error:
        role === 'Debugger' &&
          !!inp.debugContext?.issueId &&
          !issueResolutionPlan?.trim()
          ? 'DEBUG issue completion missing issueResolutionPlan; provide a concrete handling plan before marking the issue resolved.'
          :
        repairRequired &&
          finalVerify.ok &&
          unresolvedToolFailures.size === 0 &&
          !repairEvidence &&
          !canAcceptOutputCompletionRecovery(inp, initialMissing)
          ? 'DEBUG retry ended without repair evidence; run a successful patch/write/dependency change or verification command before done=true.'
          :
        finalVerify.ok && unresolvedToolFailures.size > 0
          ? `unresolved tool failures remain: ${[...unresolvedToolFailures.values()].join('; ')}`
          : 'max rounds exceeded without satisfying outputs',
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
  maxReadOnlyActions = 4,
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

function isReadOnlyLoopFailure(reason: string): boolean {
  return /repeated read-only\/probe actions without progress/i.test(reason) ||
    /read-only recovery mode repeated probe actions/i.test(reason);
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
    /outputs?\s+(?:still\s+missing|missing)/i.test(text) ||
    /missing\s+(?:required\s+)?outputs?/i.test(text) ||
    /outputs?\s*(?:仍缺失|缺失)/u.test(text) ||
    /仍缺失[:：]/u.test(text);
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

function isOutputCompletionFailure(reason = '', failureLog = ''): boolean {
  const text = `${reason}\n${failureLog}`;
  return /max rounds exceeded without satisfying outputs/i.test(text) ||
    /outputs?\s+(?:still\s+)?missing/i.test(text) ||
    /missing\s+(?:required\s+)?outputs?/i.test(text) ||
    /outputs?\s*仍缺失/u.test(text) ||
    /仍缺失[:：]/u.test(text);
}

function validateDebuggerRecoveryTurn(text: string, toolMap: Map<string, Tool>): void {
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
    throw new Error(
      'low-quality Debugger response: read-only/probe actions in read-only recovery mode; ' +
      'produce a repair action, verification action, or concrete blocker instead',
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
}): boolean {
  if (p.parseFailures > 0 || p.repeatedTurns > 0 || p.consecutiveReadOnlyRounds >= 2) return false;
  const totalCalls = p.calls.length;
  const failedCalls = p.calls.filter((call) => !call.ok).length;
  const toolFailRatio = totalCalls > 0 ? failedCalls / totalCalls : 0;
  const pendingMutation = hasUnverifiedSuccessfulMutation(p.calls);
  // A successful repair after a failed verification needs one more round to
  // prove the fix. The next successful verification clears the unresolved test failure.
  if (pendingMutation && toolFailRatio <= 0.5) return true;
  if (p.consecutiveReadOnlyRounds > 0) return false;
  if (toolFailRatio > 0.25 || p.unresolvedFailures > 0) return false;
  if (p.initialMissing > 0 && p.currentMissing < p.initialMissing) return true;
  return pendingMutation;
}

function hasUnverifiedSuccessfulMutation(calls: ExecutorRunResult['toolCalls']): boolean {
  let mutationPendingVerification = false;
  for (const call of calls) {
    if (!call.ok) continue;
    if (COMPLETION_VERIFICATION_TOOLS.has(call.tool)) {
      mutationPendingVerification = false;
      continue;
    }
    if (isRepairEvidenceTool(call.tool)) mutationPendingVerification = true;
  }
  return mutationPendingVerification;
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
    issueResolutionPlan: truncate(extractIssueResolutionPlan(turn) ?? '', 900),
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
    unresolved.delete(`tool:${action.tool}`);
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
  if (!result.error?.includes('tool not allowed for this step')) return false;
  return action.tool === 'read_file' || action.tool === 'list_dir' || action.tool === 'code_search';
}

function actionResolutionKeys(action: LLMAction): string[] {
  const targets = actionTargetPaths(action.tool, action.args);
  if (targets.length > 0) return targets.map((target) => `path:${target}`);
  return [`tool:${action.tool}`];
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
): ToolPermissionRequest | undefined {
  const argRecord = isPlainRecord(args) ? args : {};
  const target = actionTargetPaths(tool, args).join(', ');
  const runtime = language === 'typescript' ? 'npm' : 'python';
  if (tool === 'write_file' || tool === 'append_file' || tool === 'replace_in_file' || tool === 'apply_patch') {
    return {
      operationType: 'file_write',
      target: target || '(workspace file)',
      reason: `Step ${stepId} requested ${tool} to update project files.`,
      risk: 'This operation modifies files in the current workspace.',
      scope: 'current workspace',
      skippable: true,
      denyBehavior: 'The tool call is skipped and the agent must continue with an alternative or fail the step.',
      stepId,
      tool,
      metadata: { args: redactLargeArgs(args) },
    };
  }
  if (tool === 'add_dependency') {
    return {
      operationType: 'config_change',
      target: language === 'typescript' ? 'package.json' : 'requirements.txt',
      reason: `Step ${stepId} requested dependency manifest changes.`,
      risk: 'This can alter project dependencies and may trigger sandbox rebuilds.',
      scope: 'current workspace dependency manifest',
      skippable: true,
      denyBehavior: 'The dependency change is skipped; later build or test steps may fail and report the missing dependency.',
      stepId,
      tool,
      metadata: { args },
    };
  }
  if (tool === 'install_deps') {
    return {
      operationType: 'install_dependency',
      target: Array.isArray(argRecord.packages) ? argRecord.packages.join(', ') : '(packages)',
      reason: `Step ${stepId} requested dependency installation.`,
      risk: 'This may execute package manager scripts and download code from registries.',
      scope: 'current workspace sandbox',
      skippable: true,
      denyBehavior: 'Dependency installation is skipped and the task continues with the missing dependency reported.',
      stepId,
      tool,
      metadata: { args },
    };
  }
  if (tool === 'run_tests') {
    return {
      operationType: 'test_command',
      target: runtime === 'npm' ? 'npm test' : 'pytest',
      reason: `Step ${stepId} requested test execution to validate changes.`,
      risk: 'Project test scripts may execute arbitrary local project code.',
      scope: 'current workspace sandbox',
      skippable: true,
      denyBehavior: 'Tests are skipped and the final result must mark verification as incomplete.',
      stepId,
      tool,
      metadata: { args },
    };
  }
  if (tool === 'run_program') {
    return {
      operationType: 'shell_command',
      target: `${runtime} ${Array.isArray(argRecord.args) ? argRecord.args.join(' ') : ''}`.trim(),
      reason: `Step ${stepId} requested program execution.`,
      risk: 'This executes project code in the configured sandbox.',
      scope: 'current workspace sandbox',
      skippable: true,
      denyBehavior: 'The command is skipped and the agent must use another validation strategy or fail the step.',
      stepId,
      tool,
      metadata: { args },
    };
  }
  if (tool === 'http_fetch') {
    return {
      operationType: 'network_access',
      target: typeof argRecord.url === 'string' ? argRecord.url : '(url)',
      reason: `Step ${stepId} requested network access.`,
      risk: 'This contacts an external HTTP endpoint from the host process.',
      scope: 'network',
      skippable: true,
      denyBehavior: 'The network call is skipped; the agent must use local context or report the missing data.',
      stepId,
      tool,
      metadata: { args: redactLargeArgs(args) },
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

function normalizeActions(raw: unknown, toolMap?: Map<string, Tool>): {
  actions: LLMAction[];
  invalid: Array<{ index: number; raw: unknown; result: ToolResult & { tool: string } }>;
} {
  if (raw === undefined || raw === null) return { actions: [], invalid: [] };
  if (!Array.isArray(raw)) {
    return {
      actions: [],
      invalid: [{
        index: -1,
        raw,
        result: {
          tool: 'invalid_action',
          ok: false,
          error: 'invalid actions field: expected an array of tool calls',
        },
      }],
    };
  }
  const actions: LLMAction[] = [];
  const invalid: Array<{ index: number; raw: unknown; result: ToolResult & { tool: string } }> = [];
  raw.forEach((item, index) => {
    if (!isPlainRecord(item)) {
      invalid.push({
        index,
        raw: item,
        result: { tool: 'invalid_action', ok: false, error: `invalid action at index ${index}: expected object` },
      });
      return;
    }
    if (typeof item.tool !== 'string' || item.tool.trim().length === 0) {
      invalid.push({
        index,
        raw: item,
        result: { tool: 'invalid_action', ok: false, error: `invalid action at index ${index}: missing string tool` },
      });
      return;
    }
    const normalizedArgs = normalizeActionArgs(item.tool, item.args);
    if (!normalizedArgs.ok) {
      invalid.push({
        index,
        raw: item,
        result: { tool: item.tool, ok: false, error: `invalid action at index ${index}: ${normalizedArgs.error}` },
      });
      return;
    }
    const selectedTool = toolMap?.get(item.tool);
    const schemaError = selectedTool
      ? validateToolArgsAgainstSchema(selectedTool, normalizedArgs.args)
      : undefined;
    if (schemaError) {
      invalid.push({
        index,
        raw: item,
        result: { tool: item.tool, ok: false, error: schemaError },
      });
      return;
    }
    actions.push({ tool: item.tool, args: normalizedArgs.args });
  });
  return { actions, invalid };
}

function validateToolArgsAgainstSchema(tool: Tool, args: Record<string, unknown>): string | undefined {
  for (const [key, rawDescriptor] of Object.entries(tool.argsSchema)) {
    if (typeof rawDescriptor !== 'string') continue;
    const token = rawDescriptor.trim().split(/\s+/, 1)[0] ?? '';
    const optional = token.endsWith('?');
    const expectedType = optional ? token.slice(0, -1) : token;
    const value = args[key];

    if (value === undefined || value === null) {
      if (optional) continue;
      return formatToolArgError(tool, key, expectedType);
    }
    if (expectedType === 'string' && typeof value !== 'string') {
      return formatToolArgError(tool, key, expectedType);
    }
    if (expectedType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      return formatToolArgError(tool, key, expectedType);
    }
    if (expectedType === 'boolean' && typeof value !== 'boolean') {
      return formatToolArgError(tool, key, expectedType);
    }
    if (
      expectedType === 'string[]' &&
      (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    ) {
      return formatToolArgError(tool, key, expectedType);
    }
    if (
      expectedType.startsWith('Record<') &&
      (!isPlainRecord(value))
    ) {
      return formatToolArgError(tool, key, expectedType);
    }
    if (key === 'path' && typeof value === 'string' && value.trim().length === 0) {
      return formatToolArgError(tool, key, expectedType);
    }
  }
  return undefined;
}

function formatToolArgError(tool: Tool, key: string, expectedType: string): string {
  const expected = JSON.stringify(tool.argsSchema);
  if (key === 'path' && expectedType === 'string') {
    return `invalid ${tool.name} args: path must be a non-empty string; expected args=${expected}`;
  }
  const label =
    expectedType === 'string[]'
      ? 'a string array'
      : expectedType.startsWith('Record<')
        ? 'an object'
        : `a ${expectedType || 'valid'} value`;
  return `invalid ${tool.name} args: ${key} must be ${label}; expected args=${expected}`;
}

function normalizeActionArgs(
  tool: string,
  rawArgs: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (isPlainRecord(rawArgs)) return { ok: true, args: rawArgs };
  if (rawArgs === undefined || rawArgs === null) return { ok: true, args: {} };

  if (typeof rawArgs === 'string') {
    const key = STRING_ARG_TOOL_KEYS[tool];
    if (key) return { ok: true, args: { [key]: rawArgs } };
  }

  if (Array.isArray(rawArgs)) {
    if (tool === 'run_tests' || tool === 'run_program') {
      const args = rawArgs.filter((item): item is string => typeof item === 'string');
      if (args.length === rawArgs.length) return { ok: true, args: { args } };
    }
    const key = STRING_ARG_TOOL_KEYS[tool];
    if (key && typeof rawArgs[0] === 'string') {
      const out: Record<string, unknown> = { [key]: rawArgs[0] };
      if (tool === 'read_file' && typeof rawArgs[1] === 'number') out.maxBytes = rawArgs[1];
      return { ok: true, args: out };
    }
  }

  return { ok: false, error: 'args must be an object' };
}

const STRING_ARG_TOOL_KEYS: Record<string, string> = {
  apply_patch: 'patch',
  code_search: 'query',
  http_fetch: 'url',
  list_dir: 'path',
  read_file: 'path',
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function describeToolForStep(tool: Tool, ctx: ToolContext, step: Step): string {
  const details = [tool.description];
  const inputs = compactPathCandidates(step.inputs);
  const outputs = compactPathCandidates(step.outputs);
  const writable = compactPathCandidates(ctx.allowedWrites);

  if (tool.name === 'read_file') {
    details.push(
      `args.path is required: use one concrete workspace-relative file path; never omit it. ` +
      `Step path hints: inputs=[${inputs}], outputs=[${outputs}]. ` +
      `Current read window: ${ctx.readChunkBytes ?? '(runtime default)'}B; when truncated, continue with args.offset=nextOffset.`,
    );
  } else if (tool.name === 'write_file' || tool.name === 'append_file' || tool.name === 'replace_in_file') {
    details.push(
      `args.path is required and must be a concrete workspace-relative path allowed by this Step. ` +
      `Path candidates: outputs=[${outputs}], writable=[${writable}].`,
    );
    if (tool.name === 'replace_in_file') {
      details.push('The target must already exist; use read_file on that exact path before replacing when current bytes are uncertain.');
    }
  } else if (tool.name === 'apply_patch') {
    details.push(
      `Every target in the unified diff +++ header must be workspace-relative and allowed by this Step. ` +
      `Path candidates: outputs=[${outputs}], writable=[${writable}].`,
    );
  } else if (tool.name === 'list_dir') {
    details.push('args.path is optional; when present, use a concrete workspace-relative directory path.');
  } else if (tool.name === 'code_search') {
    details.push('args.root is optional; when present, use a concrete workspace-relative directory path.');
  } else if (tool.name === 'http_fetch') {
    details.push(
      `args.saveAs is optional; when present, it must be a concrete workspace-relative path in writable=[${writable}].`,
    );
  } else if (tool.name === 'run_program' || tool.name === 'run_tests') {
    details.push('args.cwd is optional; when present, it must be a concrete workspace-relative directory path.');
  }

  if ((tool.name === 'write_file' || tool.name === 'append_file') && ctx.writeChunkBytes) {
    details.push(`Current Step content chunk limit: ${ctx.writeChunkBytes}B.`);
  }
  return details.join(' ');
}

function compactPathCandidates(paths: string[], limit = 10): string {
  if (paths.length === 0) return '(none declared)';
  const visible = paths.slice(0, limit);
  const omitted = paths.length - visible.length;
  return `${visible.join(', ')}${omitted > 0 ? `, ... (+${omitted})` : ''}`;
}

async function safeRunTool(t: Tool, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    return await t.run(args as never, ctx);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function computeMetrics(p: {
  rounds: number;
  parseFailures: number;
  repeatedTurns: number;
  calls: ExecutorRunResult['toolCalls'];
  initialMissing: number;
  currentMissing: number;
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

function renderUserPrompt(
  inp: ExecutorRunInput,
  toolDocs: string,
  initialMissingOutputs: string[] = [],
): string {
  const role = inp.executionRole ?? inp.step.role;
  const compactContext = !!inp.debugContext;
  const snippetLimit = compactContext ? 900 : 2200;
  const architectureLimit = compactContext ? 3000 : 8000;
  const failureLogLimit = compactContext ? 2200 : 4000;
  const ctxBlock = (inp.contextSnippets ?? [])
    .map((s) =>
      `### ${s.path}\n\`\`\`\n${truncate(
        s.content,
        s.path === '.xcompiler/architecture-contract.json' ||
          s.path.startsWith('.xcompiler/change-requests/')
          ? architectureLimit
          : snippetLimit,
      )}\n\`\`\``,
    )
    .join('\n\n');
  const dbg = inp.debugContext
    ? [
        inp.debugContext.issueId ? `## issue\nid: ${inp.debugContext.issueId}\n` : '',
        inp.debugContext.debugBrief ? `${inp.debugContext.debugBrief}\n` : '',
        `## compact failure evidence\n\`\`\`\n${truncate(inp.debugContext.failureLog, failureLogLimit)}\n\`\`\`\n`,
        inp.debugContext.suggestions ? `\n${inp.debugContext.suggestions}\n` : '',
      ].join('\n')
    : '';
  const missingOutputPriority = initialMissingOutputs.length > 0
    ? [
        '## highest-priority required-output gate',
        'The following exact required outputs are missing at this attempt start:',
        initialMissingOutputs.map((output) => `- ${output}`).join('\n'),
        'Create these exact paths before rewriting outputs that already exist. ' +
          'A write/progress round that does not reduce this list is not progress.',
        '',
      ].join('\n')
    : '';
  const changeRequestBlock = inp.changeRequest
    ? [
        '## active engineering change request',
        `id: ${inp.changeRequest.id}`,
        `revision: ${inp.changeRequest.revision}`,
        `status: ${inp.changeRequest.status}`,
        `objective: ${inp.changeRequest.objective}`,
        `contract delta: ${inp.changeRequest.contractChange.summary}`,
        'This is incremental CR execution against the existing project baseline.',
        'Apply only the affected contract and artifacts for this Step. Preserve unrelated files and accepted behavior.',
        'Do not regenerate the whole phase, project, design, or test suite.',
        '',
      ].join('\n')
    : '';
  return [
    `# Step ${inp.step.id} — ${inp.step.title}`,
    `phase: ${inp.step.phase}`,
    `role: ${role}`,
    `acceptance: ${inp.step.acceptance}`,
    '',
    missingOutputPriority,
    changeRequestBlock,
    '## description',
    inp.step.description,
    '',
    '## required outputs',
    inp.step.outputs.map((o) => `- ${o}`).join('\n'),
    '',
    '## writable paths (tool allowlist)',
    inp.ctx.allowedWrites.map((o) => `- ${o}`).join('\n'),
    '',
    '## active model operation window',
    `context_window_tokens: ${inp.ctx.contextWindowTokens ?? '(runtime default)'}`,
    `response_token_budget: ${inp.ctx.responseTokenBudget ?? '(runtime default)'}`,
    `read_file_chunk_bytes: ${inp.ctx.readChunkBytes ?? '(runtime default)'}`,
    `write_content_chunk_bytes: ${inp.ctx.writeChunkBytes ?? '(runtime default)'}`,
    `tool_feedback_chars: ${inp.ctx.feedbackCharBudget ?? '(runtime default)'}`,
    '',
    inp.step.subTasks && inp.step.subTasks.length > 0
      ? `## step subtasks (execute inside this macro Step)\n${renderStepSubTasks(inp.step.subTasks, 0)}\n`
      : '',
    '## available tools',
    toolDocs || '(none)',
    '',
    inp.step.inputs.length > 0
      ? `## inputs (already produced):\n${inp.step.inputs.map((i) => `- ${i}`).join('\n')}\n`
      : '',
    ctxBlock ? `## context\nTreat these existing files as the current project truth. Extend or refactor them in place; do not replace the project with a tiny parallel implementation.\n\n${ctxBlock}\n` : '',
    dbg,
    t().prompts.executorUserPromptOutro,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderStepSubTasks(tasks: NonNullable<Step['subTasks']>, depth: number): string {
  const indent = '  '.repeat(depth);
  return tasks
    .flatMap((task) => {
      const outputs = task.outputs && task.outputs.length > 0 ? ` outputs=[${task.outputs.join(', ')}]` : '';
      const lines = [
        `${indent}- ${task.id}: ${task.title}${outputs}`,
        `${indent}  ${task.description}`,
      ];
      if (task.acceptance) lines.push(`${indent}  acceptance: ${task.acceptance}`);
      if (task.subTasks && task.subTasks.length > 0) lines.push(renderStepSubTasks(task.subTasks, depth + 1));
      return lines;
    })
    .join('\n');
}

function compactMessagesForChat<T extends { role: 'system' | 'user' | 'assistant'; content: string }>(
  messages: T[],
  compact: boolean,
): T[] {
  if (!compact || messages.length <= 6) return messages;
  const system = messages[0];
  const initialUser = messages[1];
  if (!system || !initialUser) return messages;
  const recent = messages.slice(-4);
  return [system, initialUser, ...recent];
}

function renderFeedback(
  results: Array<ToolResult & { tool: string }>,
  verify: { ok: boolean; missing: string[] },
  turn: TurnFeedbackContext,
  operationWindow: {
    feedbackCharBudget?: number;
    readChunkBytes?: number;
  } = {},
): string {
  const M = t().prompts;
  const lines: string[] = [M.executorFeedbackHeader];
  const failureDetails = [
    ...results.filter((result) => !result.ok).map((result) => result.error ?? result.summary ?? ''),
    ...(turn.unresolvedFailures ?? []),
  ];
  let detailBudget = operationWindow.feedbackCharBudget ?? 12_000;
  for (const r of results) {
    lines.push(`- ${r.tool}: ${r.ok ? 'OK' : 'FAIL'} — ${truncate(r.summary ?? r.error ?? '', 1800)}`);
    const detail = renderToolResultDetail(r, detailBudget, operationWindow.readChunkBytes);
    if (detail) {
      lines.push(detail.text);
      detailBudget -= detail.used;
    }
  }
  if (verify.ok) {
    lines.push(M.executorFeedbackVerifyOk);
    if (turn.repairEvidenceMissing) {
      lines.push(M.executorFeedbackRepairEvidenceMissing);
    }
  } else {
    lines.push(M.executorFeedbackVerifyMissing(verify.missing.join(', ')));
    if (turn.declaredDone && turn.actionCount === 0) {
      lines.push(
        `Invalid completion: required outputs are still missing. ` +
        `Next response must include concrete write actions that create: ${verify.missing.join(', ')}. ` +
        `Do not return done=true with actions=[] until those files exist.`,
      );
    }
  }
  if (turn.readOnlyLoopWarning) {
    lines.push(
      M.executorFeedbackReadOnlyLoopWarning(
        turn.readOnlyLoopWarning.rounds,
        turn.readOnlyLoopWarning.targets,
      ),
    );
  }
  if (turn.missingOutputStallWarning) {
    lines.push(
      `Output progress warning: required outputs have not decreased for ${turn.missingOutputStallWarning.rounds} write/progress rounds. ` +
      `Create these exact missing outputs next: ${turn.missingOutputStallWarning.missing}. ` +
      'Do not keep rewriting files that already satisfy declared outputs.',
    );
  }
  if (turn.readOnlyRecoveryWarning) {
    lines.push(M.executorFeedbackReadOnlyRecoveryRequired);
    if (!verify.ok && verify.missing.length > 0) {
      lines.push(
        `Direct repair target: required outputs are still missing: ${verify.missing.join(', ')}. ` +
        `Next response must create or update those exact paths with write_file/apply_patch/replace_in_file, ` +
        `or run a concrete verification command if they already exist. Do not spend another round only reading files.`,
      );
    }
  }
  if (turn.noProgressWarning) {
    lines.push(
      'No-progress warning: actions=[] with done=false does not advance the step. ' +
      'The next response must run a concrete tool action or return done=true only when completion is already verified.',
    );
  }
  if (turn.issueResolutionPlanMissing) {
    lines.push(M.executorFeedbackIssueResolutionPlanMissing);
  }
  if (failureDetails.some((failure) => /path must be a non-empty string/i.test(failure))) {
    lines.push(
      'Tool contract violation: file write/read tools require args.path to be a non-empty relative workspace path. ' +
      'Retry with an explicit path from the current Step inputs, outputs, or writable allowlist.',
    );
  }
  if (turn.unresolvedFailures && turn.unresolvedFailures.length > 0) {
    lines.push(
      `Unresolved tool failures remain: ${turn.unresolvedFailures.map((failure) => truncate(failure, 1200)).join('; ')}`,
    );
    if (turn.unresolvedFailures.some((failure) => /replace_in_file FAIL .*expected 1 occurrences of find, found 0/i.test(failure))) {
      lines.push(
        'Replace miss recovery: the find string does not match the current file. ' +
        'Do not retry the same find text. Next response must use the exact current file bytes shown by read_file/tool hints, ' +
        'or switch to apply_patch/write_file on the same target with a minimal repair, then run verification.',
      );
    }
    if (turn.unresolvedFailures.some((failure) => /content must be a string/i.test(failure))) {
      lines.push(
        'Tool contract violation: write_file/append_file require args.content to be a literal string. ' +
        'Do not send contentBytes, arrays, objects, or omitted content; retry the same target with a valid content string.',
      );
    }
    if (turn.unresolvedFailures.some((failure) => /invalid add_dependency args/i.test(failure))) {
      lines.push(
        'Tool contract violation: add_dependency requires args.packages as a non-empty string array, ' +
        'for example {"packages":["cheerio"]}.',
      );
    }
    if (turn.declaredDone) {
      lines.push(
        `Invalid completion: do not return done=true until each failed tool call is corrected ` +
        `or superseded by a successful tool call on the same target.`,
      );
    }
  }
  return lines.join('\n');
}

function renderToolResultDetail(
  result: ToolResult & { tool: string },
  remainingBudget: number,
  readChunkBytes?: number,
): { text: string; used: number } | undefined {
  if (!result.ok || remainingBudget <= 200) return undefined;
  const budget = Math.min(
    remainingBudget,
    result.tool === 'read_file' ? (readChunkBytes ?? 6000) : 3000,
  );
  const data = isPlainRecord(result.data) ? result.data : undefined;
  if (result.tool === 'read_file' && typeof data?.content === 'string') {
    const content = truncate(data.content, budget);
    return {
      text: ['  content:', '<<<BEGIN read_file content', content, 'END read_file content>>>'].join('\n'),
      used: content.length,
    };
  }
  if (result.tool === 'list_dir' && Array.isArray(data?.entries)) {
    const entries = data.entries.filter((entry): entry is string => typeof entry === 'string');
    if (entries.length === 0) return { text: '  entries: (empty)', used: 18 };
    const text = `  entries:\n${truncate(entries.map((entry) => `  - ${entry}`).join('\n'), budget)}`;
    return { text, used: text.length };
  }
  if (result.tool === 'code_search' && Array.isArray(data?.matches)) {
    const matches = data.matches
      .filter((match): match is { path: string; line: number; text: string } =>
        isPlainRecord(match) &&
        typeof match.path === 'string' &&
        typeof match.line === 'number' &&
        typeof match.text === 'string',
      )
      .map((match) => `${match.path}:${match.line}: ${match.text}`);
    if (matches.length === 0) return undefined;
    const text = `  matches:\n${truncate(matches.map((match) => `  - ${match}`).join('\n'), budget)}`;
    return { text, used: text.length };
  }
  return undefined;
}

function parseTurn(text: string): LLMTurn {
  const cleaned = stripFence(text).trim();
  // 1) 直接解析最常见的"单一 JSON 对象"输出
  const direct = tryParseTurnCandidate(cleaned);
  if (direct) return direct;
  // 2) 扫描首个完整的平衡花括号对象（兼容 LLM 返回多段 ```json``` 拼接、
  //    或 JSON 前后带散文 / 多个对象）。逐字符按 {/} 计数，跳过字符串与转义。
  const first = extractFirstJsonObject(cleaned);
  if (first) {
    const parsed = tryParseTurnCandidate(first);
    if (parsed) {
      const firstEnd = cleaned.indexOf(first) + first.length;
      const hasTrailingDone = /"done"\s*:/u.test(cleaned.slice(firstEnd));
      if (typeof parsed.done === 'boolean' || !hasTrailingDone) return parsed;
    }
  }
  // 3) 终极兜底：原来的 first-{ to last-} 切片
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a >= 0 && b > a) {
    const parsed = tryParseTurnCandidate(cleaned.slice(a, b + 1));
    if (parsed) return parsed;
  }
  const salvaged = salvageMalformedTurn(cleaned);
  if (salvaged) return salvaged;
  return {};
}

function salvageMalformedTurn(text: string): LLMTurn | null {
  const actions: unknown[] = [];
  const re = /\{\s*"tool"\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const candidate = extractJsonObjectAt(text, match.index);
    if (!candidate) continue;
    const parsed = tryParseJson(repairJsonCandidate(candidate));
    if (isPlainRecord(parsed) && typeof parsed.tool === 'string') {
      actions.push(parsed);
    }
    re.lastIndex = match.index + Math.max(1, candidate.length);
  }
  if (actions.length === 0) return null;
  const thoughtMatch = text.match(/"thoughts"\s*:\s*"((?:\\.|[^"\\])*)"/u);
  const doneMatch = [...text.matchAll(/"done"\s*:\s*(true|false)/gu)].at(-1);
  return {
    thoughts: thoughtMatch ? parseJsonStringLiteral(thoughtMatch[1] ?? '') : undefined,
    actions,
    done: doneMatch ? doneMatch[1] === 'true' : false,
  };
}

function parseJsonStringLiteral(value: string): string | undefined {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return undefined;
  }
}

export function isCompleteTurnJson(text: string): boolean {
  const cleaned = stripFence(text).trim();
  if (!/"done"\s*:/.test(cleaned)) return false;
  const last = cleaned.at(-1);
  if (last !== '}' && last !== ']') return false;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  const candidate = cleaned.slice(start, end + 1);
  // Streaming must stop only on strict JSON. Applying jsonrepair here can turn a
  // prefix such as `content":"import` into a seemingly complete action and
  // truncate the provider stream before the file payload arrives.
  const turn = isTurnObject(tryParseJson(candidate));
  return !!turn && typeof turn.done === 'boolean' && Array.isArray(turn.actions);
}

/** 返回 s 中第一个语法上完整的 `{...}` 子串（按字符串/转义正确计数花括号）。 */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 返回 s 中从 start 开始的语法上完整 `{...}` 子串。 */
function extractJsonObjectAt(s: string, start: number): string | null {
  if (s[start] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function stripFence(s: string): string {
  return s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n... [truncated ${s.length - n} chars]` : s;
}

function tryParseTurnCandidate(candidate: string): LLMTurn | null {
  const exact = isTurnObject(tryParseJson(candidate));
  if (exact) return exact;
  const repaired = repairJsonCandidate(candidate);
  if (repaired !== candidate) {
    const parsed = isTurnObject(tryParseJson(repaired));
    if (parsed) return parsed;
  }
  return null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function repairJsonCandidate(text: string): string {
  const normalized = normalizeJsonLikeStrings(text).trim();
  try {
    return jsonrepair(normalized).trim();
  } catch {
    return normalized;
  }
}

function isTurnObject(value: unknown): LLMTurn | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as LLMTurn;
}

function extractIssueResolutionPlan(turn: LLMTurn): string | undefined {
  const candidates = [
    turn.issueResolutionPlan,
    turn.issue_resolution_plan,
    turn.resolutionPlan,
    turn.handlingPlan,
    turn.fixPlan,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return truncate(value.trim(), 2400);
    }
  }
  return undefined;
}

function normalizeJsonLikeStrings(text: string): string {
  let out = '';
  let inStr = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      out += '\\n';
      continue;
    }
    if (ch === '"') {
      const next = nextNonWhitespaceChar(text, i + 1);
      if (next === ':' || next === ',' || next === '}' || next === ']' || next === '') {
        out += ch;
        inStr = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function nextNonWhitespaceChar(text: string, start: number): string {
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (!/\s/.test(ch)) return ch;
  }
  return '';
}
