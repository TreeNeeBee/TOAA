import { isUnownedStepFailure } from '../../tools/types.js';
import type { ExecutorRunResult } from '../../agents/executor.js';
import {
  buildDebugBrief,
  compactFailureEvidence,
  renderDebugBriefForPrompt,
  type DebugBriefInput,
} from '../../core/debug_brief.js';
import type { Plan, Step } from '../../core/plan.js';
import type { StageQualityAssessment } from '../../core/quality_gate.js';
import { defaultQualityGateForPhase } from '../../core/quality_gate.js';
import { pairedTestAssetPaths } from '../../core/test_assets.js';
import type { DomainLog } from '../../domain/observability/records.js';
import { workStepId, type Ticket } from '../../domain/tickets/ticket.js';

export type AttemptMode = 'normal' | 'debug' | 'enhancement' | 'change-request';

export function shouldPreserveExistingFiles(mode: AttemptMode): boolean {
  return mode !== 'normal';
}

export interface AttemptVerificationScope {
  testArgs: string[];
  inheritedFromTicket: boolean;
  /** The original failed gate is rerun after the upstream correction travels through its CR chain. */
  deferredToChangeRequest?: boolean;
  verificationStepId?: string;
  verificationPhase?: Step['phase'];
}

export function resolveAttemptTestArgs(
  scope: AttemptVerificationScope,
  language: Plan['language'],
): string[] {
  const args = [...scope.testArgs];
  if (
    language === 'typescript' &&
    scope.verificationPhase === 'UNIT_TEST' &&
    !args.some((arg) => arg === '--coverage' || arg.startsWith('--coverage.'))
  ) {
    args.push('--coverage');
  }
  return args;
}

export function resolveAttemptRoundLimit(
  mode: AttemptMode,
  configuredRounds: number,
  configuredCorrectiveRounds?: number,
): number {
  if (mode === 'normal') return configuredRounds;
  return configuredCorrectiveRounds ?? Math.ceil(configuredRounds * 1.5);
}

export function reconcileMeasuredQualityAssessment(
  value: StageQualityAssessment | undefined,
  toolCalls: ExecutorRunResult['toolCalls'],
): StageQualityAssessment | undefined {
  if (!value) return value;
  // A Step that could not run its tests because the manifest belongs to another phase reports that
  // honestly, and the gate fails it for every gap it reports — punishing accuracy. The declared
  // outputs still gate the Step; this only stops a condition it does not own from counting as work
  // it failed to deliver. The fourth guard to need the same fact.
  if (toolCalls.some((call) => isUnownedStepFailure(call.code))) {
    value = { ...value, gaps: [] };
  }
  const summaries = toolCalls
    .filter((call) => call.ok && call.tool === 'run_tests' && call.summary)
    .map((call) => call.summary!);
  const measured = [...summaries].reverse().map((summary) => ({
    summary,
    coverage: summary.match(
      /coverage statements=(\d+(?:\.\d+)?)% branches=(\d+(?:\.\d+)?)% functions=(\d+(?:\.\d+)?)% lines=(\d+(?:\.\d+)?)%/u,
    ),
    tests: summary.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/u),
  })).find((item) => item.coverage || item.tests);
  if (!measured) return value;
  const metrics = { ...value.metrics };
  if (measured.coverage) {
    metrics.statementCoverage = Number(measured.coverage[1]) / 100;
    metrics.branchCoverage = Number(measured.coverage[2]) / 100;
    metrics.functionCoverage = Number(measured.coverage[3]) / 100;
    metrics.lineCoverage = Number(measured.coverage[4]) / 100;
  }
  if (measured.tests) {
    const passed = Number(measured.tests[1]);
    const total = Number(measured.tests[2]);
    metrics.testCasePassRate = total > 0 ? passed / total : 0;
  }
  return {
    ...value,
    metrics,
    evidence: [...new Set([...value.evidence, measured.summary])],
  };
}

export function reconcileDeferredSourceQualityAssessment(
  value: StageQualityAssessment | undefined,
  input: {
    currentPhase: Step['phase'];
    deferredToChangeRequest?: boolean;
    verificationPhase?: Step['phase'];
    changedFiles: readonly string[];
  },
): StageQualityAssessment | undefined {
  if (
    !value ||
    !input.deferredToChangeRequest ||
    isVerificationPhase(input.currentPhase) ||
    !input.verificationPhase ||
    !isVerificationPhase(input.verificationPhase) ||
    input.changedFiles.length === 0 ||
    value.gaps.length === 0 ||
    value.blockedBy.length === 0 ||
    value.unavailableMetrics.length === 0 ||
    value.tolerance.failedTests > 0 ||
    value.tolerance.skippedTests > 0 ||
    value.tolerance.warnings > 0
  ) {
    return value;
  }
  const downstreamMetrics = new Set(
    Object.keys(defaultQualityGateForPhase(input.verificationPhase).metrics),
  );
  if (!value.unavailableMetrics.every((metric) => downstreamMetrics.has(metric))) return value;
  return {
    ...value,
    gaps: [],
    blockedBy: [...new Set([
      ...value.blockedBy,
      ...value.gaps.map((gap) =>
        `deferred to ${input.verificationPhase}: ${gap}`
      ),
    ])],
  };
}

export function renderAttemptRetryFeedback(log: DomainLog, phase: Step['phase']): string {
  const failureLog = typeof log.data.failureLog === 'string' ? log.data.failureLog : log.message;
  const typedFailure = structuredFailureEvidence(log.data.structuredFailure);
  const brief = buildDebugBrief({
    reason: log.message,
    failureLog,
    phase,
    targetPhase: phase,
    typedFailure,
  });
  const evidence = compactFailureEvidence({
    reason: log.message,
    failureLog,
    phase,
    targetPhase: phase,
    typedFailure,
    maxChars: 2600,
    maxLines: 36,
  });
  return [
    '## latest failed attempt',
    'The previous attempt for this same Ticket failed and its file changes were rolled back.',
    'Continue from the accepted baseline, diagnose this evidence, and do not repeat the failed approach unchanged.',
    renderDebugBriefForPrompt(brief),
    ...(evidence ? ['## compact failure evidence', '```text', evidence, '```'] : []),
  ].join('\n');
}

export function prioritizeAttemptFailureEvidence(
  originalFailure: string,
  retryFeedback?: string,
): string {
  if (!retryFeedback?.trim()) return originalFailure;
  return [
    retryFeedback.trim(),
    '## original bug context',
    originalFailure.trim(),
  ].filter(Boolean).join('\n\n');
}

export function selectActionableAttemptFailure(logs: readonly DomainLog[]): DomainLog | undefined {
  const latestFirst = [...logs].reverse();
  return latestFirst.find((log) => !isInfrastructureFailureLog(log)) ?? latestFirst[0];
}

function isInfrastructureFailureLog(log: DomainLog): boolean {
  const failure = log.data.structuredFailure;
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return false;
  const record = failure as Record<string, unknown>;
  return record.kind === 'infrastructure' || record.category === 'llm-provider';
}

function structuredFailureEvidence(value: unknown): DebugBriefInput['typedFailure'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const categories: NonNullable<DebugBriefInput['typedFailure']>['category'][] = [
    'llm-provider',
    'tool',
    'test',
    'quality',
    'contract',
    'internal',
  ];
  if (!categories.includes(record.category as never) || typeof record.code !== 'string') {
    return undefined;
  }
  return {
    category: record.category as NonNullable<DebugBriefInput['typedFailure']>['category'],
    code: record.code,
    ...(typeof record.statusCode === 'number' ? { statusCode: record.statusCode } : {}),
  };
}

export function resolveAttemptVerificationScope(
  plan: Plan,
  executionStep: Step,
  ticket: Ticket,
): AttemptVerificationScope {
  const currentTestArgs = pairedTestAssetPaths(plan.steps, executionStep, plan.language);
  const verificationStepId = ticket.type === 'bug'
    ? ticket.failure.verificationStepId
    : ticket.type === 'enhancement'
      ? ticket.verificationStepId
      : undefined;
  // Same rule PM routes and WorkScheduler dispatches by; keeping a local copy is how routing and
  // scheduling drifted apart before.
  const targetStepId = workStepId(ticket);
  const routedToUpstreamSource =
    verificationStepId !== undefined &&
    targetStepId === executionStep.id &&
    !isVerificationPhase(executionStep.phase) &&
    verificationStepId !== executionStep.id &&
    (ticket.type !== 'bug' || ticket.failure.failedStepId !== ticket.failure.targetStepId);
  if (routedToUpstreamSource) {
    const verificationStep = plan.steps.find((step) => step.id === verificationStepId);
    return {
      // S1-S4 author their paired tests, but a corrective attempt in an upstream source phase cannot
      // prove the failed gate until downstream CRs have applied the accepted contract. The exact
      // selectors are still retained as a safety boundary: if the Debugger voluntarily verifies a
      // local test-asset repair, run_tests must not widen into the full project suite.
      testArgs: verificationStep
        ? pairedTestAssetPaths(plan.steps, verificationStep, plan.language)
        : currentTestArgs,
      inheritedFromTicket: false,
      deferredToChangeRequest: true,
      verificationStepId: verificationStep?.id,
      verificationPhase: verificationStep?.phase,
    };
  }
  const inheritedFromTicket =
    verificationStepId !== undefined &&
    targetStepId === executionStep.id &&
    (ticket.type !== 'bug' || ticket.failure.failedStepId !== ticket.failure.targetStepId) &&
    verificationStepId !== executionStep.id;
  if (!inheritedFromTicket) {
    return {
      testArgs: currentTestArgs,
      inheritedFromTicket: false,
      verificationStepId: isVerificationPhase(executionStep.phase) ? executionStep.id : undefined,
      verificationPhase: isVerificationPhase(executionStep.phase) ? executionStep.phase : undefined,
    };
  }
  const verificationStep = plan.steps.find((step) => step.id === verificationStepId);
  if (!verificationStep) return { testArgs: currentTestArgs, inheritedFromTicket: false };
  return {
    testArgs: pairedTestAssetPaths(plan.steps, verificationStep, plan.language),
    inheritedFromTicket: true,
    verificationStepId: verificationStep.id,
    verificationPhase: verificationStep.phase,
  };
}

function isVerificationPhase(phase: Step['phase']): boolean {
  return ['UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST'].includes(phase);
}
