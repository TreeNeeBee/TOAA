import { describe, expect, it } from 'vitest';
import { evaluateAttemptExtension } from '../src/domain/tickets/retry_policy.js';

describe('adaptive Ticket attempt policy', () => {
  it('extends while corrective failures are converging', () => {
    expect(evaluateAttemptExtension([
      { signature: 'a', category: 'test_failure' },
      { signature: 'b', category: 'test_failure' },
      { signature: 'c', category: 'test_failure' },
    ]).extend).toBe(true);
  });

  it('stops a repeated root cause and explicit tool loops', () => {
    expect(evaluateAttemptExtension([
      { signature: 'same', category: 'test_failure' },
      { signature: 'same', category: 'test_failure' },
      { signature: 'same', category: 'test_failure' },
    ])).toMatchObject({ extend: false });
    expect(evaluateAttemptExtension([
      { signature: 'loop', category: 'tool_loop' },
    ])).toMatchObject({ extend: false });
  });

  it('rejects attempt extensions without structured failure fingerprints', () => {
    expect(evaluateAttemptExtension([{}, {}, {}])).toMatchObject({ extend: false });
  });

  // From a live run that could not converge: the functional-test failure `80ace82b` recurred four
  // times, and between each recurrence a "Change Request diagnosis was contradicted" exception
  // arrived from a different Step, carrying a fresh signature every time. Requiring the repeats to
  // be consecutive meant the breaker never fired, and every extension was granted because "failure
  // evidence is still changing".
  it('stops on a failure that keeps coming back, even when other failures interleave', () => {
    const decision = evaluateAttemptExtension([
      { signature: 'test-failure', category: 'test_failure' },
      { signature: 'contradiction-1', category: 'exception' },
      { signature: 'test-failure', category: 'test_failure' },
      { signature: 'contradiction-2', category: 'exception' },
      { signature: 'test-failure', category: 'test_failure' },
    ]);
    expect(decision.extend).toBe(false);
    expect(decision.reason).toContain('recurred');
  });

  it('still extends while the failures are genuinely different', () => {
    const decision = evaluateAttemptExtension([
      { signature: 'a', category: 'test_failure' },
      { signature: 'b', category: 'test_failure' },
      { signature: 'c', category: 'exception' },
      { signature: 'd', category: 'test_failure' },
    ]);
    expect(decision.extend).toBe(true);
  });
});
