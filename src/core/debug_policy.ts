import type { ExecutorRunMetrics } from '../agents/executor.js';
import {
  sanitizeDebugFailureLogForPrompt,
  stripNestedLatestDebuggerFailures,
} from './debug_cache.js';
import { t } from '../i18n/index.js';

export type DebugFailureRoute =
  | 'stop-infrastructure'
  | 'rollback-paired-source'
  | 'retry-current-step';

export function classifyDebugFailure(
  phaseKind: 'test' | 'development',
  reason?: string,
  failureLog?: string,
): DebugFailureRoute {
  if (isNonDebuggableInfrastructureFailure(reason, failureLog)) {
    return 'stop-infrastructure';
  }
  if (phaseKind === 'test' && shouldRollbackTestPhaseFailure(reason, failureLog)) {
    return 'rollback-paired-source';
  }
  return 'retry-current-step';
}

export function isNonDebuggableInfrastructureFailure(
  reason?: string,
  failureLog?: string,
): boolean {
  const text = `${reason ?? ''}\n${failureLog ?? ''}`.toLowerCase();
  if (/low-quality debugger response/u.test(text)) return false;
  return (
    /sandbox dependency install failed|npm dependency install failed|pip install failed/u.test(text) ||
    /permission denied for code validation/u.test(text) ||
    /permission denied for (?:test|functional probe) revalidation/u.test(text) ||
    /typeerror:\s*fetch failed/u.test(text) ||
    /(?:openai|ollama) http (?:401|403|408|409|429|5\d\d)\b/u.test(text) ||
    /rate limit exceeded|free-models-per-day|retry_after_seconds|retry-after/u.test(text) ||
    /(?:openai|ollama|llm|provider)[^\n]{0,180}(?:rate[- ]?limit|rate limited|rate-limited|retry-after|retry_after_seconds)/u.test(text) ||
    /(?:response_format|json_object|json_schema)[^\n]{0,220}(?:not support|unsupported|invalid_request_body|supported formats)/u.test(text) ||
    /(?:openai|ollama) stream (?:wall-clock|idle)/u.test(text) ||
    /request timed out after \d+ms/u.test(text) ||
    /prefill_memory_exceeded|prefill memory guard|dynamic ceiling/u.test(text) ||
    /context (?:length|window)|token limit|too many tokens|prompt too long|max(?:imum)? context/u.test(text) ||
    /input[^\n]{0,80}tokens[^\n]{0,120}(?:exceed|limit|ceiling)/u.test(text) ||
    /llm provider|provider_call_failed|all llm providers failed/u.test(text)
  );
}

export function isReadOnlyProbeLoopFailure(reason?: string): boolean {
  return /repeated read-only\/probe actions without progress/u.test(reason ?? '') ||
    /read-only recovery mode repeated probe actions/u.test(reason ?? '');
}

export function isMissingOutputStallFailure(reason?: string): boolean {
  return /write\/progress actions did not reduce missing outputs/u.test(reason ?? '');
}

export function isLowQualityDebuggerResponseFailure(reason?: string): boolean {
  return /low-quality debugger response/iu.test(reason ?? '');
}

export function isRepairEvidenceMissingFailure(reason?: string): boolean {
  return /without repair evidence/u.test(reason ?? '') ||
    /without a successful repair mutation/u.test(reason ?? '') ||
    /without a successful repair mutation or verification tool call/u.test(reason ?? '');
}

export function shouldRollbackTestPhaseFailure(reason?: string, failureLog?: string): boolean {
  const text = `${reason ?? ''}\n${failureLog ?? ''}`.toLowerCase();
  if (isReadOnlyProbeLoopFailure(reason) || isRepairEvidenceMissingFailure(reason)) return false;
  if (/tool verification failed.*rolling back to paired/u.test(text)) return true;
  if (isCachedTestArtifactDiscoveryFailure(text)) return false;
  if (/missing outputs|outputs? 校验|verify outputs|declared outputs|产物/u.test(text)) return false;
  if (/invalid action|args must be an object|invalid json|parse failure/u.test(text)) return false;
  if (/test gate|functional gate|functional entry probe|entry probe|delivery gate|测试门禁|功能门禁|功能入口探测|入口探测|交付门禁/u.test(text)) return true;
  if (/pytest exit=\s*[1-9]\d*|exit code\s*[1-9]\d*|failed tests?|test failures?/u.test(text)) return true;
  return /assertionerror|failed:\s+did not|traceback \(most recent call last\)/u.test(text);
}

export interface DebugRetryWindowInput {
  attempt: number;
  budget: number;
  cap: number;
  consecutiveBad: number;
  reason?: string;
  metrics?: ExecutorRunMetrics;
}

export interface DebugRetryWindowDecision {
  quality: 'healthy' | 'bad' | 'neutral';
  budget: number;
  consecutiveBad: number;
  earlyAbort: boolean;
  metricsTag: string;
}

export function adjustDebugRetryWindow(
  input: DebugRetryWindowInput,
): DebugRetryWindowDecision {
  const readOnlyProbeLoop = isReadOnlyProbeLoopFailure(input.reason);
  const missingOutputStall = isMissingOutputStallFailure(input.reason);
  const lowQualityResponse = isLowQualityDebuggerResponseFailure(input.reason);
  const repairEvidenceMissing = isRepairEvidenceMissingFailure(input.reason);
  const metrics = input.metrics;
  const healthy =
    !readOnlyProbeLoop &&
    !missingOutputStall &&
    !lowQualityResponse &&
    !repairEvidenceMissing &&
    !!metrics &&
    metrics.parseFailures === 0 &&
    metrics.repeatedTurns <= 1 &&
    metrics.healthScore >= 0.6;
  const bad =
    readOnlyProbeLoop ||
    missingOutputStall ||
    lowQualityResponse ||
    repairEvidenceMissing ||
    (!!metrics &&
      (
        metrics.healthScore < 0.3 ||
        metrics.parseFailures + metrics.repeatedTurns >= Math.max(2, Math.ceil(metrics.rounds / 2))
      ));
  const metricsTag = metrics
    ? `health=${metrics.healthScore.toFixed(2)} parseFail=${metrics.parseFailures} repeat=${metrics.repeatedTurns} progress=${metrics.progressRatio.toFixed(2)}`
    : '';

  if (healthy) {
    return {
      quality: 'healthy',
      budget: Math.min(input.cap, input.budget + 2),
      consecutiveBad: 0,
      earlyAbort: false,
      metricsTag,
    };
  }
  if (bad) {
    const consecutiveBad = input.consecutiveBad + 1;
    return {
      quality: 'bad',
      budget: Math.max(input.attempt + 1, Math.ceil(input.budget / 2)),
      consecutiveBad,
      earlyAbort: consecutiveBad >= 2,
      metricsTag,
    };
  }
  return {
    quality: 'neutral',
    budget: input.budget,
    consecutiveBad: 0,
    earlyAbort: false,
    metricsTag,
  };
}

export function latestActionableDebugAttempt<T extends { reason?: string }>(
  attempts: T[],
): T | undefined {
  const newest = [...attempts].reverse();
  return newest.find((attempt) =>
    !isReadOnlyProbeLoopFailure(attempt.reason) &&
    !isNonDebuggableInfrastructureFailure(attempt.reason),
  ) ??
    newest.find((attempt) => !isNonDebuggableInfrastructureFailure(attempt.reason)) ??
    attempts.at(-1);
}

export function latestActionableSourceFailureLog<
  T extends { reason?: string; failureLogTail?: string },
>(attempts: T[]): string | undefined {
  const actionable = [...attempts].reverse().find((attempt) => {
    const log = cleanFailureLogForDebugContext(attempt.failureLogTail ?? '');
    return log.length > 0 &&
      !isReadOnlyProbeLoopFailure(attempt.reason) &&
      !isRepairEvidenceMissingFailure(attempt.reason) &&
      !isNonDebuggableInfrastructureFailure(attempt.reason, log);
  });
  return actionable?.failureLogTail;
}

export function composeDebugRetryFailureLog(
  rootFailureLog: string,
  latestFailureLog: string,
  latestReason: string,
): string {
  const root = cleanFailureLogForDebugContext(rootFailureLog).trim();
  const latest = cleanFailureLogForDebugContext(latestFailureLog).trim();
  if (!latest || latest === root || root.includes(latest)) return root;
  return [
    root,
    '',
    '## latest Debugger attempt failure',
    t().engine.reasonLine(latestReason),
    latest,
  ].filter(Boolean).join('\n');
}

export function cleanFailureLogForDebugContext(log: string): string {
  return stripNestedLatestDebuggerFailures(
    sanitizeDebugFailureLogForPrompt(log),
  );
}

function isCachedTestArtifactDiscoveryFailure(text: string): boolean {
  return /no test files? found|no tests? found/u.test(text) ||
    /filter:\s+tests?\//u.test(text) ||
    /(?:enoent|no such file or directory|not a file)[^\n]{0,240}tests?\//u.test(text);
}
