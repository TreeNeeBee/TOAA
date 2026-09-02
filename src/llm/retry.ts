/**
 * How a provider waits before retrying a request it was rate limited on.
 *
 * A 429 says "not now", not "not ever". Switching providers does not answer it: a chain is usually
 * limited per account rather than per route, so the next candidate returns the same status and the
 * run ends over a wait of a few seconds. Three live runs died that way with the work half done.
 */
export interface ProviderRetryPolicy {
  /** Retries after the first attempt. 0 disables retrying a rate-limited request. */
  readonly max_retries: number;
  /** Ceiling for one wait, in milliseconds. Exponential growth and a provider's own retry-after both stop here. */
  readonly max_delay: number;
  /** Whether callers limited together spread their return out. */
  readonly jitter: 'random' | 'none';
}

export const DEFAULT_PROVIDER_RETRY: ProviderRetryPolicy = {
  max_retries: 3,
  max_delay: 32_000,
  jitter: 'random',
};

/** First wait of the sequence. Doubling from one second reaches the 32s ceiling on the sixth try. */
const BASE_DELAY_MS = 1_000;

/**
 * The wait before retry number `attempt` (1 for the first retry).
 *
 * `retryAfterMs` is the provider's own instruction and outranks the curve — it knows when its
 * window reopens — but is still capped, so a provider asking for an hour cannot stall the run.
 *
 * Jitter is applied as half fixed, half random. Full randomisation would let a retry return almost
 * immediately, which is the one thing a rate limit is asking it not to do.
 */
export function computeRetryDelayMs(
  attempt: number,
  policy: ProviderRetryPolicy,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.max(0, policy.max_delay);
  if (ceiling === 0) return 0;
  const planned = retryAfterMs !== undefined && retryAfterMs > 0
    ? retryAfterMs
    : BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(planned, ceiling);
  if (policy.jitter === 'none') return Math.round(capped);
  return Math.round(capped / 2 + random() * (capped / 2));
}
