import { describe, expect, it } from 'vitest';
import {
  adjustDebugRetryWindow,
  classifyDebugFailure,
  shouldRollbackTestPhaseFailure,
} from '../src/core/debug_policy.js';

describe('debug policy', () => {
  it('separates infrastructure stops, V-model rollback, and same-step repair', () => {
    expect(classifyDebugFailure(
      'test',
      'OpenAI HTTP 429',
      'rate limit exceeded',
    )).toBe('stop-infrastructure');
    expect(classifyDebugFailure(
      'test',
      'UNIT_TEST gate failed',
      'AssertionError: expected true',
    )).toBe('rollback-paired-source');
    expect(classifyDebugFailure(
      'test',
      'outputs verification failed',
      'missing outputs: docs/tests/unit-test.md',
    )).toBe('retry-current-step');
  });

  it('honors an explicit paired-source rollback before no-tests artifact detection', () => {
    expect(shouldRollbackTestPhaseFailure(
      'INTEGRATION_TEST tool verification failed; rolling back to paired V-model source phase.',
      'No test files found',
    )).toBe(true);
  });

  it('routes missing test discovery back to the paired source phase', () => {
    expect(shouldRollbackTestPhaseFailure(
      'UNIT_TEST run_tests failed',
      'filter: tests/test_hello.py\nNo test files found, exiting with code 1',
    )).toBe(true);
    expect(shouldRollbackTestPhaseFailure(
      'INTEGRATION_TEST run_tests failed',
      'Error: No test suite found in file tests/integration.test.ts',
    )).toBe(true);
    expect(shouldRollbackTestPhaseFailure(
      'MODULE_TEST found an incomplete or inconsistent paired test contract',
      'Validation defect: missing cross-module error propagation case',
    )).toBe(true);
  });

  it('expands only productive retry windows and aborts repeated low-quality attempts', () => {
    const productive = adjustDebugRetryWindow({
      attempt: 1,
      budget: 3,
      cap: 10,
      consecutiveBad: 0,
      metrics: {
        healthScore: 0.8,
        parseFailures: 0,
        repeatedTurns: 0,
        progressRatio: 0.6,
        rounds: 4,
      },
    });
    expect(productive).toMatchObject({
      quality: 'healthy',
      budget: 5,
      earlyAbort: false,
    });

    const bad = adjustDebugRetryWindow({
      attempt: 2,
      budget: 6,
      cap: 10,
      consecutiveBad: 1,
      reason: 'low-quality Debugger response',
    });
    expect(bad).toMatchObject({
      quality: 'bad',
      budget: 3,
      consecutiveBad: 2,
      earlyAbort: true,
    });
  });
});
