import type { Step } from '../../src/domain/steps/step.js';
import type {
  BugVerificationContract,
  FailureIdentity,
} from '../../src/domain/tickets/ticket.js';
import type { TestOutcome } from '../../src/application/execution/test_outcome.js';

type StepRef = Pick<Step, 'id' | 'type'>;

export function bugContracts(
  failed: StepRef,
  target: StepRef,
  verification: StepRef,
  input: {
    category: FailureIdentity['category'];
    code: string;
    operation?: string;
    testSelectors?: string[];
    artifactTargets?: string[];
    exitCode?: number;
    statusCode?: number;
  },
): { identity: FailureIdentity; verificationContract: BugVerificationContract } {
  const testSelectors = [...(input.testSelectors ?? [])];
  const artifactTargets = [...(input.artifactTargets ?? [])];
  return {
    identity: {
      version: 1,
      category: input.category,
      code: input.code,
      failedStepId: failed.id,
      targetStepId: target.id,
      verificationStepId: verification.id,
      operation: input.operation,
      testSelectors,
      artifactTargets,
      exitCode: input.exitCode,
      statusCode: input.statusCode,
    },
    verificationContract: {
      kind: input.category === 'quality' ? 'quality-gate' : 'test-gate',
      verificationStepId: verification.id,
      verificationStepType: verification.type,
      operation: input.operation,
      testSelectors,
      artifactTargets,
    },
  };
}

export function passedTestOutcome(step: StepRef, args: string[]): TestOutcome {
  return {
    status: 'passed',
    stepType: step.type,
    tool: 'run_tests',
    args,
    timedOut: false,
    failedTests: [],
    recordedAt: new Date().toISOString(),
  };
}

export function failedTestOutcome(step: StepRef, failedTests: string[]): TestOutcome {
  return {
    status: 'failed',
    stepType: step.type,
    tool: 'run_tests',
    args: [...new Set(failedTests.map((selector) => selector.split('::', 1)[0]!))],
    exitCode: 1,
    timedOut: false,
    failedTests: [...failedTests],
    recordedAt: new Date().toISOString(),
  };
}
