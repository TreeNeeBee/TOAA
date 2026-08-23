import type { ToolCallRecord } from '../../agents/executor.js';
import type { StepType } from '../../domain/steps/step.js';

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
  tool: 'run_tests';
  callId?: string;
  args: string[];
  exitCode?: number;
  timedOut: boolean;
  passedTests?: number;
  totalTests?: number;
  summary?: string;
  failure?: string;
  recordedAt: string;
}

export function collectTestOutcomes(
  calls: readonly ToolCallRecord[],
  stepType: StepType,
): TestOutcome[] {
  return calls.filter((call) => call.tool === 'run_tests').map((call) => {
    const data = isRecord(call.data) ? call.data : {};
    const timedOut = data.timedOut === true;
    const exitCode = typeof data.exitCode === 'number' ? data.exitCode : undefined;
    return {
      status: timedOut ? 'timed_out' : call.ok ? 'passed' : 'failed',
      stepType,
      tool: 'run_tests',
      callId: call.callId,
      args: Array.isArray(call.args?.args)
        ? call.args.args.filter((value): value is string => typeof value === 'string')
        : [],
      exitCode,
      timedOut,
      passedTests: numericMatch(call.summary, /Tests\s+(\d+)\s+passed/iu),
      totalTests: numericMatch(call.summary, /Tests\s+\d+\s+passed\s+\((\d+)\)/iu),
      summary: call.summary,
      failure: call.error,
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
