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
