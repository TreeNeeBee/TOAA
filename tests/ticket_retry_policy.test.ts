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

  it('grants legacy Tickets one adaptive retry when fingerprints are absent', () => {
    expect(evaluateAttemptExtension([{}, {}, {}])).toMatchObject({ extend: true });
  });
});
