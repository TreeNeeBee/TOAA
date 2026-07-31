import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildDebugBrief,
  compactFailureEvidence,
  type DebugBrief,
} from './debug_brief.js';

/**
 * 单步 debug 尝试历史条目。所有字段都做了截断，避免缓存文件无限膨胀。
 */
export interface DebugAttemptEntry {
  /** 第几次 retry（1-based）。0 表示初始尝试。 */
  attempt: number;
  /** ISO8601 时间戳。 */
  ts: string;
  /** 失败原因（一行摘要）。 */
  reason: string;
  /** 失败日志尾部（已按 maxFailureLogLines 截断）。 */
  failureLogTail: string;
  /** 结构化核心错误摘要；用于跨会话恢复时避免重新注入长日志。 */
  debugBrief?: DebugBrief;
  /** Debug 场景来源；用于跨会话恢复时保留测试回退/审计修复语义。 */
  contextMode?: 'audit-repair' | 'iteration-gate' | 'test-rollback';
  /** 关联的 Bug Ticket；中断恢复后继续同一 Ticket，而不是创建或选择错误 Ticket。 */
  bugTicketId?: string;
  /** 进入 Debugger 前源阶段是否已完成；测试回退恢复时必须保留增量修复语义。 */
  completedBeforeDebug?: boolean;
  /** 中断恢复所需的精简上下文路径。 */
  contextPaths?: string[];
  /** 测试回退时允许修复的受影响 V-model 产物。 */
  extraAllowedWrites?: string[];
  /** 测试回退 Debugger 的默认验证范围，避免 resume 后无参 run_tests 退化成全量测试。 */
  testScopeArgs?: string[];
  /** Calibrator 给出的修复建议（一行一条）。 */
  suggestions?: string[];
  /** 该次尝试前 git snapshot SHA，便于人工 checkout 复盘。 */
  snapshotSha?: string;
  /** ExecutorRunMetrics 关键字段；保留 healthScore / parseFailures / repeatedTurns / progressRatio。 */
  metrics?: {
    healthScore: number;
    parseFailures: number;
    repeatedTurns: number;
    progressRatio: number;
    rounds: number;
  };
}

interface StepEntry {
  lastUpdated: string;
  lastStatus: 'RUNNING' | 'FAILED' | 'DONE';
  lastReason?: string;
  attempts: DebugAttemptEntry[];
}

interface CacheShape {
  version: 1;
  steps: Record<string, StepEntry>;
}

const EMPTY: CacheShape = { version: 1, steps: {} };

export function sanitizeDebugFailureLogForPrompt(log: string): string {
  const lines = log.split(/\r?\n/u);
  const out: string[] = [];
  const seenReasonLines = new Set<string>();
  let mode: 'keep' | 'skip-history' | 'skip-suggestions' | 'skip-brief' = 'keep';
  for (const line of lines) {
    if (/^##\s+历史\s+DEBUG\s+尝试/u.test(line)) {
      mode = 'skip-history';
      continue;
    }
    if (/^##\s+(?:debug brief|root bug ticket brief|current retry brief)\b/u.test(line)) {
      mode = 'skip-brief';
      continue;
    }
    if (/^##\s+修复建议/u.test(line)) {
      mode = 'skip-suggestions';
      continue;
    }
    if (mode === 'skip-history') {
      if (/^(原因：|Reason:|##\s+(?:debug failure log|compact failure evidence)\b)/u.test(line)) {
        mode = 'keep';
      } else {
        continue;
      }
    }
    if (mode === 'skip-suggestions') {
      if (/^(原因：|Reason:|轮次：|工具调用：|---\s+|##\s+历史\s+DEBUG\s+尝试|##\s+(?:debug failure log|compact failure evidence)\b)/u.test(line)) {
        mode = 'keep';
        if (/^##\s+历史\s+DEBUG\s+尝试/u.test(line)) {
          mode = 'skip-history';
          continue;
        }
      } else {
        continue;
      }
    }
    if (mode === 'skip-brief') {
      if (/^(原因：|Reason:|轮次：|工具调用：|---\s+|##\s+修复建议|##\s+历史\s+DEBUG\s+尝试|##\s+(?:debug failure log|compact failure evidence)\b)/u.test(line)) {
        mode = 'keep';
      } else {
        continue;
      }
    }
    if (/^\s*suggestions:\s/u.test(line)) continue;
    if (/^(原因：|Reason:)/u.test(line)) {
      const normalized = line.trim();
      if (seenReasonLines.has(normalized)) continue;
      seenReasonLines.add(normalized);
    }
    out.push(line);
  }
  const cleaned = out.join('\n').trim();
  return cleaned.length > 0 ? cleaned : log;
}

export function stripNestedLatestDebuggerFailures(log: string): string {
  const marker = /^##\s+(?:latest Debugger attempt failure|paired source phase latest failure\b)/m;
  const match = marker.exec(log);
  if (!match) return log;
  const cleaned = log.slice(0, match.index).trim();
  return cleaned.length > 0 ? cleaned : log;
}

/**
 * 跨 `xcompiler run` 的 debug 历史持久化。
 *
 * 落盘位置：`<workspace>/.xcompiler/debug_cache.json`。
 *
 * 设计原则：
 * 1. 只在 workspace 内，**不污染阶段计划**——phasePlan / plan.Px 是用户与 Planner 的契约，不应混入运行期日志。
 * 2. 一次 `xcompiler run` 内的多次 retry → append；单步 DONE → clear；单步 FAILED → 保留，下一次 `xcompiler run`
 *    可读到这些尝试，作为 Debugger 的 prior context，让模型不要再走死路。
 * 3. 单步保留 attempts 数量上限 `maxAttemptsPerStep`（默认 12），超出按 FIFO 丢弃；每条 failureLog 按
 *    `maxFailureLogLines`（默认 80）截断尾部。
 */
export class DebugCache {
  private data: CacheShape = { version: 1, steps: {} };
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly opts: { maxAttemptsPerStep?: number; maxFailureLogLines?: number } = {},
  ) {}

  private get maxAttempts(): number {
    return this.opts.maxAttemptsPerStep ?? 12;
  }
  private get maxLogLines(): number {
    return this.opts.maxFailureLogLines ?? 80;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CacheShape>;
      if (parsed && parsed.version === 1 && parsed.steps && typeof parsed.steps === 'object') {
        this.data = { version: 1, steps: parsed.steps };
        return;
      }
    } catch {
      /* 文件不存在 / 损坏 → 空缓存 */
    }
    this.data = { ...EMPTY, steps: {} };
  }

  /** 取某 step 的历史尝试（可能为空数组）。 */
  attempts(stepId: string): DebugAttemptEntry[] {
    return this.data.steps[stepId]?.attempts ?? [];
  }

  /** 该 step 在上一次会话中是否以 FAILED 结束。 */
  hasUnresolvedFailure(stepId: string): boolean {
    const e = this.data.steps[stepId];
    return !!e && e.lastStatus === 'FAILED' && e.attempts.length > 0;
  }

  /** A prior process recorded debug evidence but exited before writing a terminal cache status. */
  hasRunningAttempt(stepId: string): boolean {
    const e = this.data.steps[stepId];
    return !!e && e.lastStatus === 'RUNNING' && e.attempts.length > 0;
  }

  /** 仅由运行入口在计划确有 stale RUNNING 时调用，保留 attempts 并转成可恢复失败。 */
  async markInterrupted(stepId: string, reason: string): Promise<boolean> {
    await this.load();
    const cur = this.data.steps[stepId];
    if (!cur || cur.lastStatus === 'DONE' || cur.attempts.length === 0) return false;
    cur.lastStatus = 'FAILED';
    cur.lastReason = reason.slice(0, 500);
    cur.lastUpdated = new Date().toISOString();
    await this.save();
    return true;
  }

  /** 追加一次尝试记录（在每次 retry 末尾调用）。failureLog 会自动截断到尾部 N 行。 */
  async recordAttempt(stepId: string, entry: Omit<DebugAttemptEntry, 'ts'> & { ts?: string }): Promise<void> {
    const tail = (s: string): string => {
      const lines = (s ?? '').split('\n');
      return lines.length <= this.maxLogLines ? s : lines.slice(-this.maxLogLines).join('\n');
    };
    const cleanedFailureLog = stripNestedLatestDebuggerFailures(
      sanitizeDebugFailureLogForPrompt(entry.failureLogTail ?? ''),
    );
    const debugBrief = buildDebugBrief({
      reason: entry.reason,
      failureLog: cleanedFailureLog,
    });
    const compactFailureLog = compactFailureEvidence({
      reason: entry.reason,
      failureLog: cleanedFailureLog,
      maxChars: 3600,
      maxLines: this.maxLogLines,
    });
    const e: DebugAttemptEntry = {
      attempt: entry.attempt,
      ts: entry.ts ?? new Date().toISOString(),
      reason: (entry.reason ?? '').slice(0, 500),
      failureLogTail: tail(compactFailureLog),
      debugBrief,
      contextMode: entry.contextMode,
      bugTicketId: entry.bugTicketId,
      completedBeforeDebug: entry.completedBeforeDebug,
      contextPaths: dedupPaths(entry.contextPaths),
      extraAllowedWrites: dedupPaths(entry.extraAllowedWrites),
      testScopeArgs: entry.testScopeArgs,
      suggestions: entry.suggestions,
      snapshotSha: entry.snapshotSha,
      metrics: entry.metrics,
    };
    const cur: StepEntry = this.data.steps[stepId] ?? {
      lastUpdated: e.ts,
      lastStatus: 'RUNNING',
      attempts: [],
    };
    cur.attempts.push(e);
    if (cur.attempts.length > this.maxAttempts) {
      cur.attempts.splice(0, cur.attempts.length - this.maxAttempts);
    }
    cur.lastUpdated = e.ts;
    cur.lastStatus = 'RUNNING';
    cur.lastReason = e.reason;
    this.data.steps[stepId] = cur;
    await this.save();
  }

  /** 该 step 修复成功 → 清理它的历史，避免下次 run 误以为还有未解决的失败。 */
  async markDone(stepId: string): Promise<void> {
    if (this.data.steps[stepId]) {
      delete this.data.steps[stepId];
      await this.save();
    }
  }

  /** `xcompiler run --reset` 会重置所有 Step 状态；对应的跨会话失败记忆也必须清空。 */
  async clearAll(): Promise<void> {
    await this.load();
    if (Object.keys(this.data.steps).length === 0) return;
    this.data = { version: 1, steps: {} };
    await this.save();
  }

  /** 该 step 终态失败 → 保留 attempts，更新 lastStatus，便于下一次 run 直接用 Debugger 模式复用上下文。 */
  async markFailed(stepId: string, reason: string): Promise<void> {
    const cur = this.data.steps[stepId];
    if (!cur) {
      this.data.steps[stepId] = {
        lastUpdated: new Date().toISOString(),
        lastStatus: 'FAILED',
        lastReason: reason.slice(0, 500),
        attempts: [],
      };
    } else {
      cur.lastStatus = 'FAILED';
      cur.lastReason = reason.slice(0, 500);
      cur.lastUpdated = new Date().toISOString();
    }
    await this.save();
  }

  /**
   * 把历史 attempts 渲染成一段供 Debugger system prompt 使用的中文摘要，
   * 强调"上一次会话已经试过的修复方向，请勿重复"。
   */
  renderPriorAttemptsForPrompt(stepId: string, maxItems = 3): string {
    const list = this.attempts(stepId);
    if (list.length === 0) return '';
    const actionable = list.filter((entry) => !isNoisyDebugReason(entry.reason));
    const noisyCount = list.length - actionable.length;
    const tail = actionable.slice(-maxItems);
    const lines = tail.map((e) => {
      const m = e.metrics
        ? ` [health=${e.metrics.healthScore.toFixed(2)} parseFail=${e.metrics.parseFailures} repeat=${e.metrics.repeatedTurns}]`
        : '';
      const sugg = e.suggestions && e.suggestions.length > 0
        ? `\n    prior suggestions: omitted (${e.suggestions.length}) to avoid stale guidance; use the current failure log first.`
        : '';
      const brief = e.debugBrief
        ? `\n    brief: ${e.debugBrief.category} — ${e.debugBrief.summary}`
        : '';
      return `- attempt #${e.attempt} @ ${e.ts}${m}\n    reason: ${e.reason}${brief}${sugg}`;
    });
    const omitted = [
      noisyCount > 0 ? `- omitted ${noisyCount} noisy provider/read-only/recovery attempt(s); keep focus on the current actionable failure.` : '',
      actionable.length > tail.length ? `- omitted ${actionable.length - tail.length} older actionable attempt(s).` : '',
    ].filter(Boolean);
    const noActionable = actionable.length === 0
      ? ['- no actionable prior Debugger attempt remains; use the current test/tool failure log as the source of truth.']
      : [];
    return [
      '## 历史 DEBUG 尝试（来自上一次/本次 xcompiler run，请勿重复同样的修复思路）',
      ...omitted,
      ...noActionable,
      ...lines,
      '请基于以上历史，提出**新的诊断假设**与**新的修改方向**。优先使用当前 prompt 中已注入的完整 debug repair packet；只有关键文件未注入或明确标记为 truncated 时才补充 read_file，然后立即做最小修改。',
    ].join('\n');
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

function dedupPaths(paths: string[] | undefined, max = 200): string[] | undefined {
  if (!paths || paths.length === 0) return undefined;
  return [...new Set(paths.map((value) => value.trim()).filter(Boolean))].slice(0, max);
}

function isNoisyDebugReason(reason: string): boolean {
  const text = reason.toLowerCase();
  return (
    /repeated read-only\/probe actions without progress/u.test(text) ||
    /read-only recovery mode repeated probe actions/u.test(text) ||
    /low-quality debugger response/u.test(text) ||
    /script exhausted/u.test(text) ||
    /without repair evidence/u.test(text) ||
    /without a successful repair mutation or verification tool call/u.test(text) ||
    /had an unresolved failure from a previous run.*rolling back/u.test(text) ||
    /tool verification failed.*rolling back/u.test(text) ||
    /openai http (?:400|401|403|408|409|429|5\d\d)/u.test(text) ||
    /rate limit exceeded|free-models-per-day|retry_after_seconds|retry-after/u.test(text) ||
    /response_format|json_object|json_schema|invalid_request_body/u.test(text) ||
    /stream (?:wall-clock|idle)|request timed out|fetch failed/u.test(text)
  );
}
