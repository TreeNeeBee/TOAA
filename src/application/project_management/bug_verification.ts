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
  const testSelectors = canonicalStrings(
    exactFailedTests.length > 0
      ? exactFailedTests
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
  if (contract.testSelectors.length === 0) return true;
  const executed = canonicalStrings(
    passed.flatMap((outcome) => outcome.args.filter((arg) => !arg.startsWith('-'))),
    normalizeSelector,
  );
  return contract.testSelectors.every((selector) =>
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
  return normalizePath(value.split('::', 1)[0] ?? value);
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
