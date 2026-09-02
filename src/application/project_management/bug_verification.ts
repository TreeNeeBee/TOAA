import type { TestOutcome } from '../execution/test_outcome.js';
import type { AttemptFailure } from '../execution/failure_classification.js';
import type { Step } from '../../domain/steps/step.js';
import {
  BugVerificationContractSchema,
  FailureIdentitySchema,
  failureIdentityKey,
  type BugTicket,
  type BugVerificationContract,
  type FailureIdentity,
} from '../../domain/tickets/ticket.js';

export function buildBugFailureContracts(input: {
  failedStep: Step;
  targetStep: Step;
  verificationStep: Step;
  failure: AttemptFailure;
  tool?: string;
  exitCode?: number;
  statusCode?: number;
  testOutcomes?: readonly TestOutcome[];
  artifactTargets?: readonly string[];
}): { identity: FailureIdentity; verificationContract: BugVerificationContract } {
  const failedOutcomes = (input.testOutcomes ?? []).filter((outcome) =>
    outcome.status === 'failed' || outcome.status === 'timed_out');
  const exactFailedTests = failedOutcomes.flatMap((outcome) => outcome.failedTests);
  // Runner output can mix executable selectors with presentation-only suite labels. Vitest, for
  // example, emits both `file > suite > case` and `suite > case 3ms`. The latter cannot be replayed
  // by a test command, so persisting it makes the Bug impossible to verify even when the exact file
  // passes. Keep selectors that identify a test file; otherwise retain the invocation scope that
  // can actually be executed again.
  const replayableFailedTests = exactFailedTests.filter(hasExecutableTestPath);
  const testSelectors = canonicalStrings(
    replayableFailedTests.length > 0
      ? replayableFailedTests
      : failedOutcomes.flatMap((outcome) => outcome.args.filter((arg) => !arg.startsWith('-'))),
    normalizeSelector,
  );
  const artifactTargets = canonicalStrings(input.artifactTargets ?? [], normalizePath);
  const operation = input.tool ?? (failedOutcomes.length > 0 ? 'run_tests' : undefined);
  const identity = FailureIdentitySchema.parse({
    version: 1,
    category: input.failure.category,
    code: input.failure.code,
    failedStepId: input.failedStep.id,
    targetStepId: input.targetStep.id,
    verificationStepId: input.verificationStep.id,
    operation,
    testSelectors,
    artifactTargets,
    exitCode: input.exitCode,
    statusCode: input.statusCode ?? input.failure.statusCode,
  });
  const verificationContract = BugVerificationContractSchema.parse({
    kind: input.failure.category === 'quality' ? 'quality-gate' : 'test-gate',
    verificationStepId: input.verificationStep.id,
    verificationStepType: input.verificationStep.type,
    operation,
    testSelectors,
    artifactTargets,
  });
  return { identity, verificationContract };
}

/** Verifies the original failed scope, not merely that some later CR gate happened to pass. */
export function bugVerificationSatisfied(
  bug: BugTicket,
  step: Step,
  outcomes: readonly TestOutcome[],
): boolean {
  const contract = bug.verificationContract;
  if (contract.verificationStepId !== step.id || contract.verificationStepType !== step.type) return false;
  if (contract.kind === 'quality-gate' && contract.testSelectors.length === 0) return true;
  const passed = outcomes.filter((outcome) => outcome.status === 'passed' && outcome.stepType === step.type);
  if (passed.length === 0) return false;
  const requiredSelectors = replayableTestSelectors(contract.testSelectors);
  if (requiredSelectors.length === 0) return true;
  const executed = canonicalStrings(
    passed.flatMap((outcome) => outcome.args.filter((arg) => !arg.startsWith('-'))),
    normalizeSelector,
  );
  return requiredSelectors.every((selector) =>
    executed.some((candidate) => selectorCoveredBy(candidate, selector)));
}

/** Accepts either this execution's exact replay or an earlier append-only proof from the same CR chain. */
export function bugVerificationProven(
  bug: BugTicket,
  step?: Step,
  outcomes: readonly TestOutcome[] = [],
): boolean {
  if (step && bugVerificationSatisfied(bug, step, outcomes)) return true;
  const identityKey = failureIdentityKey(bug.failure.identity);
  return bug.verificationRecords.some((record) => record.failureIdentityKey === identityKey);
}

export function passedTestSelectors(step: Step, outcomes: readonly TestOutcome[]): string[] {
  return canonicalStrings(
    outcomes
      .filter((outcome) => outcome.status === 'passed' && outcome.stepType === step.type)
      .flatMap((outcome) => outcome.args.filter((arg) => !arg.startsWith('-'))),
    normalizeSelector,
  );
}

function selectorCoveredBy(executed: string, required: string): boolean {
  const executionPath = selectorPath(executed);
  const requiredPath = selectorPath(required);
  return executionPath === requiredPath ||
    requiredPath.startsWith(`${executionPath.replace(/\/$/u, '')}/`);
}

function selectorPath(value: string): string {
  const normalized = normalizePath(value);
  // Pytest renders `file::suite::case`; Vitest/Jest render `file > suite > case`.
  // A successful file-level invocation proves every selected case in that file, so comparison is
  // performed on the runner-independent file portion rather than on presentation syntax.
  return normalized.split('::', 1)[0]!.split(/\s+>\s+/u, 1)[0]!;
}

function hasExecutableTestPath(selector: string): boolean {
  return /\.(?:py|[cm]?[jt]sx?)$/iu.test(selectorPath(selector));
}

function replayableTestSelectors(selectors: readonly string[]): string[] {
  const replayable = selectors.filter(hasExecutableTestPath);
  // Preserve contracts that contain only a runner-specific non-file selector. We cannot infer a
  // broader executable scope safely. Mixed contracts are different: their file-qualified entries
  // carry the same cases in a replayable form, while suite-only labels are duplicate presentation.
  return replayable.length > 0 ? replayable : [...selectors];
}

function canonicalStrings(
  values: readonly string[],
  normalize: (value: string) => string,
): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))].sort();
}

function normalizeSelector(value: string): string {
  return normalizePath(value).replace(/\bpytest-\d+\b/gu, 'pytest-<run>');
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '');
}
