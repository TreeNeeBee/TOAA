import type { ExecutorRunResult } from '../../agents/executor.js';
import {
  buildDebugBrief,
  compactFailureEvidence,
  renderDebugBriefForPrompt,
} from '../../core/debug_brief.js';
import type { Plan, Step } from '../../core/plan.js';
import type { StageQualityAssessment } from '../../core/quality_gate.js';
import { pairedTestAssetPaths } from '../../core/test_assets.js';
import type { DomainLog } from '../../domain/observability/records.js';
import type { Ticket } from '../../domain/tickets/ticket.js';

export type AttemptMode = 'normal' | 'debug' | 'enhancement' | 'change-request';

export interface AttemptVerificationScope {
  testArgs: string[];
  inheritedFromTicket: boolean;
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

export function renderAttemptRetryFeedback(log: DomainLog, phase: Step['phase']): string {
  const failureLog = typeof log.data.failureLog === 'string' ? log.data.failureLog : log.message;
  const brief = buildDebugBrief({
    reason: log.message,
    failureLog,
    phase,
    targetPhase: phase,
  });
  const evidence = compactFailureEvidence({
    reason: log.message,
    failureLog,
    phase,
    targetPhase: phase,
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
  const targetStepId = ticket.type === 'bug'
    ? ticket.failure.targetStepId
    : ticket.type === 'enhancement'
      ? ticket.targetStepId
      : undefined;
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
