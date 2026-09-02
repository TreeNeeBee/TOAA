import type { ToolCallRecord } from '../../agents/executor.js';
import type { StepType } from '../../domain/steps/step.js';
import { isTestRunnerInvocation } from '../../tools/sandbox.js';

export type TestOutcomeStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'incomplete'
  | 'denied'
  | 'timed_out';

export interface TestOutcome {
  status: TestOutcomeStatus;
  stepType: StepType;
  tool: 'run_tests' | 'run_program';
  callId?: string;
  args: string[];
  exitCode?: number;
  timedOut: boolean;
  passedTests?: number;
  totalTests?: number;
  summary?: string;
  failure?: string;
  failedTests: string[];
  recordedAt: string;
}

export function collectTestOutcomes(
  calls: readonly ToolCallRecord[],
  stepType: StepType,
): TestOutcome[] {
  // What was executed decides, not which tool executed it. A Step holding `run_tests` may still run
  // its suite through `run_program` to get a specific invocation, and keying this on the tool name
  // meant those runs produced no outcomes at all: a live HIGH_LEVEL_DESIGN attempt ran every test
  // through `npx vitest` and recorded nothing, which leaves a Bug whose verification contract names
  // that Step unable to ever be proven. The sibling check in `run_program` already reads the command
  // rather than the tool; this is the same rule, applied where the evidence is collected.
  return calls.filter((call) =>
    call.tool === 'run_tests' ||
    (call.tool === 'run_program' && isTestRunnerInvocation(toolArgList(call)))).map((call) => {
    const data = isRecord(call.data) ? call.data : {};
    const timedOut = data.timedOut === true;
    const exitCode = typeof data.exitCode === 'number' ? data.exitCode : undefined;
    const failure = call.error;
    const failedTests = Array.isArray(data.failedTests)
      ? data.failedTests.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      status: timedOut ? 'timed_out' : call.ok ? 'passed' : 'failed',
      stepType,
      tool: call.tool === 'run_program' ? 'run_program' : 'run_tests',
      callId: call.callId,
      args: Array.isArray(data.effectiveArgs)
        ? data.effectiveArgs.filter((value): value is string => typeof value === 'string')
        : toolArgList(call),
      exitCode,
      timedOut,
      passedTests: numericMatch(call.summary, /Tests\s+(\d+)\s+passed/iu),
      totalTests: numericMatch(call.summary, /Tests\s+\d+\s+passed\s+\((\d+)\)/iu),
      summary: call.summary,
      failure,
      failedTests,
      recordedAt: new Date().toISOString(),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numericMatch(value: string | undefined, expression: RegExp): number | undefined {
  const match = value ? expression.exec(value) : undefined;
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

/** The argument list a tool call was invoked with, whichever tool it was. */
function toolArgList(call: ToolCallRecord): string[] {
  return Array.isArray(call.args?.args)
    ? call.args.args.filter((value): value is string => typeof value === 'string')
    : [];
}
