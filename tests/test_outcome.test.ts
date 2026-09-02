import { describe, expect, it } from 'vitest';
import { collectTestOutcomes } from '../src/application/execution/test_outcome.js';

describe('collectTestOutcomes', () => {
  it('uses the runner structured selectors and effective arguments', () => {
    const [outcome] = collectTestOutcomes([{
      callId: 'call-1',
      tool: 'run_tests',
      args: { args: ['--reporter=verbose'] },
      ok: false,
      summary: 'FAIL tests/unrelated.test.ts > prose that must not control routing',
      data: {
        exitCode: 1,
        timedOut: false,
        effectiveArgs: ['tests/integration/adapter.test.ts'],
        failedTests: ['tests/integration/adapter.test.ts::returns source'],
      },
    }], 'INTEGRATION_TEST');

    expect(outcome).toMatchObject({
      status: 'failed',
      args: ['tests/integration/adapter.test.ts'],
      failedTests: ['tests/integration/adapter.test.ts::returns source'],
    });
  });

  it('does not reconstruct missing structural selectors from rendered prose', () => {
    const [outcome] = collectTestOutcomes([{
      tool: 'run_tests',
      args: { args: ['tests/unit'] },
      ok: false,
      summary: 'FAIL tests/unit/parser.test.ts > rejects empty input',
      data: { exitCode: 1, timedOut: false },
    }], 'UNIT_TEST');

    expect(outcome?.args).toEqual(['tests/unit']);
    expect(outcome?.failedTests).toEqual([]);
  });
});

describe('collectTestOutcomes by what was executed', () => {
  it('records a suite the Step ran through run_program', () => {
    // A Step holding run_tests may still shell out for a specific invocation. Keying collection on
    // the tool name recorded nothing for those runs, which leaves a Bug whose verification contract
    // names that Step impossible to prove.
    const outcomes = collectTestOutcomes([{
      tool: 'run_program',
      args: { args: ['npx', 'vitest', 'run', 'tests/modules/upstream-listing.test.ts'] },
      ok: true,
      summary: 'npx vitest run exit=0',
      data: { exitCode: 0, timedOut: false },
    }], 'HIGH_LEVEL_DESIGN');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('passed');
    expect(outcomes[0]!.tool).toBe('run_program');
    expect(outcomes[0]!.args).toContain('tests/modules/upstream-listing.test.ts');
  });

  it('ignores a run_program call that ran something other than a test suite', () => {
    const outcomes = collectTestOutcomes([{
      tool: 'run_program',
      args: { args: ['npx', 'tsc', '--noEmit'] },
      ok: false,
      summary: 'npx tsc --noEmit exit=2',
      data: { exitCode: 2, timedOut: false },
    }], 'HIGH_LEVEL_DESIGN');
    expect(outcomes).toEqual([]);
  });
});
