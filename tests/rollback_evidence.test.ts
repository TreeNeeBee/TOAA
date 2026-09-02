import { describe, expect, it } from 'vitest';
import { validationDefectFromTestFailure } from '../src/agents/executor.js';

describe('what a failing verification level hands back', () => {
  // Both halves are needed and only the error detail used to travel. A level that supplements the
  // suite is usually failing on the case it just added, and the Step receiving the rollback has no
  // other way to see which case was being demanded.
  it('carries the cases under test alongside the error detail', () => {
    const defect = validationDefectFromTestFailure(
      'MODULE_TEST',
      {
        tool: 'run_tests',
        ok: false,
        summary: 'npm test exit=1',
        error: 'FAIL tests/modules/upstream.test.ts > parses the captured page\nexpected 0 to be > 0',
      },
      ['tests/modules/upstream.test.ts', 'tests/modules/renderer.test.ts'],
    );

    expect(defect).toContain('Cases under test: tests/modules/upstream.test.ts, tests/modules/renderer.test.ts');
    expect(defect).toContain('expected 0 to be > 0');
    expect(defect).toContain('MODULE_TEST executable test gate failed');
  });

  it('still reports the failure when the runner named no cases', () => {
    const defect = validationDefectFromTestFailure(
      'UNIT_TEST',
      { tool: 'run_tests', ok: false, summary: 'npm test exit=1' },
    );
    expect(defect).toContain('UNIT_TEST executable test gate failed');
    expect(defect).not.toContain('Cases under test');
  });
});
