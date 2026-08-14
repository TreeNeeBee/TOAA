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

  // Recurrence means "not converging" only while the toolchain holds still. A live Ticket stopped
  // for non-convergence on a defect that was then repaired in XCompiler itself, and the evidence
  // blocking its retry predated the repair — so the fix could never be exercised and the workspace,
  // with three delivered Steps and sixteen landed merges, had no way forward.
  it('does not hold failures from a replaced build against a Ticket', () => {
    const stale = [
      { signature: 'prefix-off-by-one', category: 'contract', toolchainBuildId: '0.3.0+old' },
      { signature: 'prefix-off-by-one', category: 'contract', toolchainBuildId: '0.3.0+old' },
      { signature: 'prefix-off-by-one', category: 'contract', toolchainBuildId: '0.3.0+old' },
    ];
    expect(evaluateAttemptExtension(stale, '0.3.0+new')).toMatchObject({ extend: true });
    // Under the build that recorded them, they are exactly the non-convergence they look like.
    expect(evaluateAttemptExtension(stale, '0.3.0+old')).toMatchObject({ extend: false });
  });

  // Unattributed evidence cannot support "this keeps failing under the current toolchain". Every
  // failure logged before builds were identified is unlabelled, and that is exactly the case where
  // the toolchain has changed.
  it('treats a failure that does not say which build produced it as not the running one', () => {
    const unlabelled = [
      { signature: 'same', category: 'contract' },
      { signature: 'same', category: 'contract' },
      { signature: 'same', category: 'contract' },
    ];
    expect(evaluateAttemptExtension(unlabelled, '0.3.0+new')).toMatchObject({ extend: true });
    // With no running build to compare against, the guard behaves exactly as it always did.
    expect(evaluateAttemptExtension(unlabelled)).toMatchObject({ extend: false });
  });

  it('still refuses when the recurrence continues under the running build', () => {
    const decision = evaluateAttemptExtension([
      { signature: 'old', category: 'contract', toolchainBuildId: '0.3.0+old' },
      { signature: 'same', category: 'contract', toolchainBuildId: '0.3.0+new' },
      { signature: 'same', category: 'contract', toolchainBuildId: '0.3.0+new' },
      { signature: 'same', category: 'contract', toolchainBuildId: '0.3.0+new' },
    ], '0.3.0+new');
    expect(decision.extend).toBe(false);
    expect(decision.reason).toContain('recurred');
  });
});
