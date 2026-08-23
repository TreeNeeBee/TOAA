import {
  V_MODEL_DEVELOPMENT_PHASES,
  type Step,
} from '../../core/plan.js';
import {
  normalizeQualityAssessment,
  qualityAssessmentConsistencyIssues,
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
  changeRequestContradictionRecovery?: boolean;
  missingOutputStallWarning?: { rounds: number; missing: string };
  readOnlyRecoveryWarning?: boolean;
  diagnosticProbeAllowance?: {
    remainingRounds: number;
    maxActionsPerRound: number;
  };
  noProgressWarning?: { rounds: number };
  repairEvidenceMissing?: boolean;
  validationContractRepairRequired?: boolean;
  bugDeferredDispositionProblem?: {
    reason: 'missing' | 'owned-artifact' | 'uninspected-artifact';
    artifacts: string[];
  };
  ownedChangeRequestArtifacts?: string[];
  bugResolutionPlanMissing?: boolean;
  changeRequestDispositionMissing?: boolean;
  invalidChangeRequestDisposition?: {
    reasonCategory: string;
    reason: 'all-artifacts-owned' | 'owned-artifact-in-scope' | 'verification-required';
    artifacts: string[];
  };
  postMutationVerificationRequired?: boolean;
  qualityAssessmentMissing?: string[];
  deferredVerification?: {
    stepId: string;
    phase: Step['phase'];
  };
  unsupportedValidationDefect?: string;
  permissionAdaptation?: { deniedCapabilities: string[] };
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
    if (turn.repairEvidenceMissing && turn.ownedChangeRequestArtifacts?.length) {
      lines.push(
        'Invalid CR completion: this Step owns affected artifacts ' +
        `${turn.ownedChangeRequestArtifacts.join(', ')}. ` +
        'Their existence, exported symbol names, and read-only inspection do not prove that the reported behavior was repaired. ' +
        'Compare the CR before/after contract and failing invocation with the current implementation. Then either use an authorized mutation tool ' +
        'for a minimal semantic delta, or return changeRequestDisposition.outcome="not-applicable" with every owned affected artifact in inspectedArtifacts, concrete evidence, and the true downstream owner in qualityAssessment.blockedBy. ' +
        'Comments, whitespace, formatting, or unrelated edits are invalid mutation evidence.',
      );
    }
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
    if (turn.changeRequestContradictionRecovery) {
      lines.push(
        'Change Request convergence: if the inspected evidence disproves the original failure diagnosis, ' +
        'stop probing and do not mutate unrelated files. Return actions=[], done=true and ' +
        'changeRequestDisposition={outcome:"not-applicable",reasonCategory:"diagnosis-contradicted",' +
        'rationale,inspectedArtifacts,evidence}. Runtime will turn that evidence into a Bug owned by the ' +
        'discovering role and PM will route it. Otherwise apply the actual contract delta or report a ' +
        'different evidence-backed not-applicable category.',
      );
    }
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
      (!verify.ok && verify.missing.length > 0
        ? `Create exactly the first missing output now: return one write_file action with path="${verify.missing[0]}" and its complete content. ` +
          'Do not merely describe the action or try to generate several remaining files in one response.'
        // The condition this sentence used to defer to is exactly the branch it is in: the outputs
        // verified. Restating it as something for the model to judge left it with nothing to do and
        // no way to say so, and it answered with the same empty round until the guard stopped the
        // attempt and the run with it.
        // Naming done=true alone is still not an action the model can complete: the turn contract
        // rejects actions=[] with done=true unless a complete qualityAssessment comes with it, so
        // the first wording traded an unanswerable condition for an instruction that validation
        // then refused.
        : 'Every required output is present and verified, so the step is complete: return done=true ' +
          'in the next response, with actions=[] and a complete qualityAssessment covering the ' +
          'verified outputs. Run a concrete tool action instead only if you have specific work left ' +
          'that the verified outputs do not yet cover.'),
    );
  }
  if (turn.bugResolutionPlanMissing) lines.push(messages.executorFeedbackBugResolutionPlanMissing);
  if (turn.validationContractRepairRequired) {
    lines.push(
      'Validation-contract Bug completion is invalid without a real correction. The discovering role proved that the failed validation contract, paired test, or its source-stage specification is defective. ' +
      'This paired source Step must patch or rewrite the affected output it owns and record the incremental change; actions=[] cannot delegate the unchanged defect downstream. ' +
      'Preserve product behavior and assertions that remain valid, then let PM propagate the corrected contract through Change Requests.',
    );
  }
  if (turn.bugDeferredDispositionProblem) {
    const problem = turn.bugDeferredDispositionProblem;
    const detail = problem.reason === 'missing'
      ? 'No valid structured deferred disposition was supplied.'
      : problem.reason === 'owned-artifact'
        ? `The proposed downstream artifacts are owned by this Step: ${problem.artifacts.join(', ')}.`
        : `The proposed downstream artifacts were not inspected from the current workspace: ${problem.artifacts.join(', ')}.`;
    lines.push(
      `Invalid Bug no-op handoff: ${detail} ` +
      'If the root cause truly belongs downstream, return bugResolutionDisposition={outcome:"deferred",reasonCategory:"downstream-owned"|"external-dependency",rationale,affectedArtifacts:["path"],evidence:["fact"]}; ' +
      'every affected artifact must be outside this Step ownership and backed by a successful context/read inspection. Otherwise patch the current Step output that owns the defect.',
    );
  }
  if (turn.invalidChangeRequestDisposition) {
    const invalid = turn.invalidChangeRequestDisposition;
    if (invalid.reason === 'all-artifacts-owned') {
      lines.push(
        `Invalid Change Request classification: reasonCategory="${invalid.reasonCategory}" cannot be used because ` +
        `this Step owns every declared affected artifact (${invalid.artifacts.join(', ')}). ` +
        'Apply and verify the contract delta in this Step, or use reasonCategory="diagnosis-contradicted" when the evidence disproves the immutable origin-failure diagnosis.',
      );
    } else if (invalid.reason === 'owned-artifact-in-scope') {
      lines.push(
        `Invalid Change Request classification: reasonCategory="${invalid.reasonCategory}" cannot be used because ` +
        `this Step owns affected artifact(s) ${invalid.artifacts.join(', ')}. ` +
        'Handle the owned delta here; only the remaining artifacts may be delegated. Use reasonCategory="diagnosis-contradicted" if the origin diagnosis itself is false.',
      );
    } else {
      lines.push(
        `Invalid Change Request classification: reasonCategory="${invalid.reasonCategory}" cannot close an immutable origin failure ` +
        `for owned artifact(s) ${invalid.artifacts.join(', ')} without successful executable verification. ` +
        'Run the relevant verification, apply the contract delta, or use reasonCategory="diagnosis-contradicted" if current evidence disproves the original diagnosis.',
      );
    }
  }
  if (turn.changeRequestDispositionMissing) {
    lines.push(
      'Change Request completion is incomplete. Return a top-level changeRequestDisposition with outcome, reasonCategory, rationale, inspectedArtifacts, and evidence. ' +
      'Use outcome="applied" only with real mutation or successful executable verification evidence. ' +
      'Use outcome="not-applicable" only after inspecting the declared affected artifact(s), with ' +
      'actions=[], done=true, concrete evidence, and the true downstream owner in qualityAssessment.blockedBy. ' +
      'Do not rewrite unrelated phase outputs to manufacture an application.',
    );
  }
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
  if (turn.unsupportedValidationDefect) {
    lines.push(
      'Validation defect rejected: a Bug requires failed executable test evidence from run_tests. ' +
      'The current executable gate did not fail. Complete the Step from the successful test evidence, ' +
      'or report measurable completeness/coverage shortcomings in qualityAssessment.gaps so Runtime can create an Enhancement.',
    );
  }
  if (turn.permissionAdaptation) {
    lines.push(
      'Permission control outcome: the following capabilities are unavailable for this Runtime task: ' +
      `${turn.permissionAdaptation.deniedCapabilities.join(', ')}. ` +
      'You have exactly one adaptation round. Do not request any denied capability again. ' +
      'Use a materially different permitted action, or return actions=[] and done=false so Runtime ' +
      'can report permission_blocked to PM without opening a defect Ticket.',
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
    if (turn.unresolvedFailures.some((failure) =>
      /replace_in_file FAIL .*expected \d+ occurrences of find, found \d+/i.test(failure)
    )) {
      lines.push(
        'Replace count recovery: expectedCount or find does not match the current file. ' +
        'Do not guess a new count or retry the same find text. Next response must use the exact current file bytes shown by snippets/read_file/tool hints, ' +
        'or switch to apply_patch on the same existing target with a minimal repair, then run verification. ' +
        'Use write_file only when the target file is genuinely missing.',
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
    if (turn.unresolvedFailures.some((failure) =>
      /tool not allowed for this step: (?:execute_command|run_command|run_shell)/i.test(failure)
    )) {
      lines.push(
        'Tool name correction: execute_command/run_command/run_shell are not Runtime tools. ' +
        'Use read_file/list_dir/code_search for inspection, run_tests for the declared test gate, ' +
        'or run_program for an authorized build/program check. A successful canonical tool call ' +
        'with the same capability supersedes the denied alias.',
      );
    }
    if (turn.declaredDone) {
      lines.push(turn.deferredVerification
        ? 'Deferred verification completion requires a fresh, complete qualityAssessment whose blockedBy evidence ' +
          `attributes the remaining failure to downstream ${turn.deferredVerification.phase} Step ${turn.deferredVerification.stepId}. ` +
          'Do not rerun the unchanged gate or create a duplicate Bug.'
        : 'Invalid completion: do not return done=true until each failed tool call is corrected ' +
          'or superseded by a successful tool call on the same target.');
    }
  }
  return lines.join('\n');
}

export function missingQualityAssessmentFields(
  step: Step,
  assessment: StageQualityAssessment | undefined,
  freshAfterTools = true,
  context: { baselineExecutionDeferred?: boolean } = {},
): string[] {
  if (!step.qualityGate) return [];
  // Naming only the absent object leaves the model nothing to build. Both providers answered a
  // rejection that said `missing: qualityAssessment` with the same turn again, and the exhausted
  // retries surfaced as an infrastructure failure that stopped the run. Enumerating what an empty
  // assessment would still be missing turns the rejection into the field list to fill in.
  if (!assessment) {
    // Fresh, always: an assessment that was never made cannot be out of date, and asking for a
    // re-assessment beside "there is no assessment" spends a line of the instruction contradicting
    // the one above it. Producing one is the whole action here, and it is necessarily post-tool.
    return [
      'qualityAssessment',
      ...missingQualityAssessmentFields(step, normalizeQualityAssessment({}), true, context),
    ];
  }
  const missing: string[] = [];
  // Staleness is not an absent field, and naming it like one names a field that does not exist.
  //
  // `freshAfterTools` is false when the assessment was produced in an earlier round than the last
  // tool call — a fact about ordering, not about the payload. Reporting it as
  // `qualityAssessment.postToolEvidence` told the model to add a key that `StageQualityAssessment`
  // has no room for, and adding it changes no round number, so the same rejection came back and the
  // Step burned its rounds on it. The comment above records the same lesson for the absent-object
  // case; this line reintroduced it with an invented field name, which is harder to spot because it
  // reads like a real one.
  if (!freshAfterTools) {
    missing.push('a qualityAssessment measured after the last tool call (the one supplied predates it — re-assess now and answer again)');
  }
  if ((V_MODEL_DEVELOPMENT_PHASES as readonly string[]).includes(step.phase)) {
    if (typeof assessment.completion !== 'number') missing.push('qualityAssessment.completion');
    if (typeof assessment.upstreamAlignment !== 'number') {
      missing.push('qualityAssessment.upstreamAlignment');
    }
  }
  for (const metric of Object.keys(resolveQualityGate(step).metrics)) {
    if (
      typeof assessment.metrics[metric] !== 'number' &&
      !assessment.unavailableMetrics.includes(metric)
    ) {
      missing.push(`qualityAssessment.metrics.${metric}`);
    }
  }
  if (assessment.evidence.length === 0) missing.push('qualityAssessment.evidence');
  missing.push(...qualityAssessmentConsistencyIssues(assessment, context));
  return missing;
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
