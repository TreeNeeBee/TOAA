import {
  V_MODEL_DEVELOPMENT_PHASES,
  type Step,
} from '../../core/plan.js';
import {
  resolveQualityGate,
  type StageQualityAssessment,
} from '../../core/quality_gate.js';
import { t } from '../../i18n/index.js';
import type { ToolResult } from '../../tools/types.js';

export interface TurnFeedbackContext {
  declaredDone: boolean;
  actionCount: number;
  unresolvedFailures?: string[];
  readOnlyLoopWarning?: { rounds: number; targets: string };
  missingOutputStallWarning?: { rounds: number; missing: string };
  readOnlyRecoveryWarning?: boolean;
  diagnosticProbeAllowance?: {
    remainingRounds: number;
    maxActionsPerRound: number;
  };
  noProgressWarning?: { rounds: number };
  repairEvidenceMissing?: boolean;
  bugResolutionPlanMissing?: boolean;
  postMutationVerificationRequired?: boolean;
  qualityAssessmentMissing?: string[];
}

export function renderExecutionFeedback(
  results: Array<ToolResult & { tool: string }>,
  verify: { ok: boolean; missing: string[] },
  turn: TurnFeedbackContext,
  operationWindow: {
    feedbackCharBudget?: number;
    readChunkBytes?: number;
  } = {},
): string {
  const messages = t().prompts;
  const lines: string[] = [messages.executorFeedbackHeader];
  const failureDetails = [
    ...results.filter((result) => !result.ok).map((result) => result.error ?? result.summary ?? ''),
    ...(turn.unresolvedFailures ?? []),
  ];
  let detailBudget = operationWindow.feedbackCharBudget ?? 12_000;
  for (const result of results) {
    lines.push(`- ${result.tool}: ${result.ok ? 'OK' : 'FAIL'} — ${truncate(result.summary ?? result.error ?? '', 1800)}`);
    const detail = renderToolResultDetail(result, detailBudget, operationWindow.readChunkBytes);
    if (detail) {
      lines.push(detail.text);
      detailBudget -= detail.used;
    }
  }
  if (verify.ok) {
    lines.push(messages.executorFeedbackVerifyOk);
    if (turn.repairEvidenceMissing) lines.push(messages.executorFeedbackRepairEvidenceMissing);
  } else {
    lines.push(messages.executorFeedbackVerifyMissing(verify.missing.join(', ')));
    if (turn.declaredDone && turn.actionCount === 0) {
      lines.push(
        'Invalid completion: required outputs are still missing. ' +
        `Next response must include concrete write actions that create: ${verify.missing.join(', ')}. ` +
        'Do not return done=true with actions=[] until those files exist.',
      );
    }
  }
  if (turn.readOnlyLoopWarning) {
    lines.push(messages.executorFeedbackReadOnlyLoopWarning(
      turn.readOnlyLoopWarning.rounds,
      turn.readOnlyLoopWarning.targets,
    ));
  }
  if (turn.missingOutputStallWarning) {
    lines.push(
      `Output progress warning: required outputs have not decreased for ${turn.missingOutputStallWarning.rounds} write/progress rounds. ` +
      `Create these exact missing outputs next: ${turn.missingOutputStallWarning.missing}. ` +
      'Do not keep rewriting files that already satisfy declared outputs.',
    );
  }
  if (turn.readOnlyRecoveryWarning) {
    if (turn.diagnosticProbeAllowance) {
      lines.push(messages.executorFeedbackDiagnosticProbeAllowance(
        turn.diagnosticProbeAllowance.remainingRounds,
        turn.diagnosticProbeAllowance.maxActionsPerRound,
      ));
    } else {
      lines.push(messages.executorFeedbackReadOnlyRecoveryRequired);
    }
    if (!verify.ok && verify.missing.length > 0) {
      lines.push(
        `Direct repair target: required outputs are still missing: ${verify.missing.join(', ')}. ` +
        'Next response must create or update those exact paths with write_file/apply_patch/replace_in_file, ' +
        'or run a concrete verification command if they already exist. Do not spend another round only reading files.',
      );
    }
  }
  if (turn.noProgressWarning) {
    lines.push(
      'No-progress warning: actions=[] with done=false does not advance the step. ' +
      'The next response must run a concrete tool action or return done=true only when completion is already verified.',
    );
  }
  if (turn.bugResolutionPlanMissing) lines.push(messages.executorFeedbackBugResolutionPlanMissing);
  if (turn.postMutationVerificationRequired) {
    lines.push(messages.executorFeedbackPostMutationVerificationRequired);
  }
  if (turn.qualityAssessmentMissing && turn.qualityAssessmentMissing.length > 0) {
    lines.push(
      'Quality gate protocol is incomplete. Required fields/evidence are missing: ' +
      `${turn.qualityAssessmentMissing.join(', ')}. ` +
      'Do not rewrite verified outputs. Return actions=[] and done=true with a complete qualityAssessment ' +
      'backed by the existing artifact, test-report, or command evidence.',
    );
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
        'for example {"packages":["cheerio@1.0.0"]}; set dev=true for test/build tooling.',
      );
    }
    if (turn.declaredDone) {
      lines.push(
        'Invalid completion: do not return done=true until each failed tool call is corrected ' +
        'or superseded by a successful tool call on the same target.',
      );
    }
  }
  return lines.join('\n');
}

export function missingQualityAssessmentFields(
  step: Step,
  assessment: StageQualityAssessment | undefined,
  freshAfterTools = true,
  allowMetricGaps = false,
): string[] {
  if (!step.qualityGate) return [];
  if (!assessment) return ['qualityAssessment'];
  const missing: string[] = [];
  if (!freshAfterTools) missing.push('qualityAssessment.postToolEvidence');
  if ((V_MODEL_DEVELOPMENT_PHASES as readonly string[]).includes(step.phase)) {
    if (typeof assessment.completion !== 'number') missing.push('qualityAssessment.completion');
    if (typeof assessment.upstreamAlignment !== 'number') {
      missing.push('qualityAssessment.upstreamAlignment');
    }
  }
  for (const metric of Object.keys(resolveQualityGate(step).metrics)) {
    if (
      typeof assessment.metrics[metric] !== 'number' &&
      !(allowMetricGaps && assessment.gaps.some((gap) => qualityGapNamesMetric(gap, metric)))
    ) {
      missing.push(`qualityAssessment.metrics.${metric}`);
    }
  }
  if (assessment.evidence.length === 0) missing.push('qualityAssessment.evidence');
  return missing;
}

function qualityGapNamesMetric(gap: string, metric: string): boolean {
  const normalizedGap = gap.toLowerCase().replaceAll(/[^a-z0-9]+/g, '');
  const normalizedMetric = metric.toLowerCase().replaceAll(/[^a-z0-9]+/g, '');
  return normalizedMetric.length > 0 && normalizedGap.includes(normalizedMetric);
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
        typeof match.text === 'string')
      .map((match) => `${match.path}:${match.line}: ${match.text}`);
    if (matches.length === 0) return undefined;
    const text = `  matches:\n${truncate(matches.map((match) => `  - ${match}`).join('\n'), budget)}`;
    return { text, used: text.length };
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, limit: number): string {
  return value.length > limit
    ? value.slice(0, limit) + `\n... [truncated ${value.length - limit} chars]`
    : value;
}
