import { describe, expect, it } from 'vitest';
import { computeRetryDelayMs, DEFAULT_PROVIDER_RETRY } from '../src/llm/retry.js';

const fixed = { ...DEFAULT_PROVIDER_RETRY, jitter: 'none' as const };

describe('computeRetryDelayMs', () => {
  it('doubles the wait on each retry', () => {
    expect([1, 2, 3, 4].map((n) => computeRetryDelayMs(n, fixed))).toEqual([1000, 2000, 4000, 8000]);
  });

  it('stops growing at max_delay', () => {
    // Without a ceiling the sixth retry would already ask for 32s and the tenth for over eight minutes.
    expect(computeRetryDelayMs(10, fixed)).toBe(fixed.max_delay);
    expect(computeRetryDelayMs(10, { ...fixed, max_delay: 4_000 })).toBe(4_000);
  });

  it("prefers the provider's own retry-after over the curve", () => {
    expect(computeRetryDelayMs(1, fixed, 7_000)).toBe(7_000);
  });

  it('caps a retry-after that would stall the run', () => {
    expect(computeRetryDelayMs(1, fixed, 3_600_000)).toBe(fixed.max_delay);
  });

  it('keeps random jitter inside the upper half of the planned wait', () => {
    // Half fixed, half random: never near zero, never above the plan. A retry that returned at once
    // would ask the same question the limit just refused.
    for (const roll of [0, 0.5, 0.999]) {
      const delay = computeRetryDelayMs(3, DEFAULT_PROVIDER_RETRY, undefined, () => roll);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(4000);
    }
  });

  it('returns nothing to wait when the ceiling is zero', () => {
    expect(computeRetryDelayMs(1, { ...fixed, max_delay: 0 })).toBe(0);
  });
});
