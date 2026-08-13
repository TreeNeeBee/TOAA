export interface AttemptFailureEvidence {
  signature?: string;
  category?: string;
}

export interface AttemptExtensionDecision {
  extend: boolean;
  reason: string;
}

const REPEATED_FAILURE_LIMIT = 3;

export function evaluateAttemptExtension(
  evidence: readonly AttemptFailureEvidence[],
): AttemptExtensionDecision {
  const latest = evidence.at(-1);
  if (latest?.category === 'tool_loop') {
    return { extend: false, reason: 'latest failure is an unproductive tool loop' };
  }
  const signatures = evidence
    .map((item) => item.signature)
    .filter((value): value is string => Boolean(value));
  // Counted, not required to be consecutive. A live run alternated between one functional-test
  // failure and a fresh "diagnosis contradicted" exception at a different Step each cycle: the real
  // failure recurred four times, never twice in a row, so a consecutive test never fired and every
  // extension was granted on the grounds that "failure evidence is still changing". Variety is not
  // progress — the same failure coming back is what says the corrective work is not converging.
  const recurrences = new Map<string, number>();
  for (const signature of signatures) {
    const count = (recurrences.get(signature) ?? 0) + 1;
    recurrences.set(signature, count);
    if (count >= REPEATED_FAILURE_LIMIT) {
      return {
        extend: false,
        reason: `same failure recurred ${count} times without convergence`,
      };
    }
  }
  return {
    extend: signatures.length > 0,
    reason: signatures.length === 0
      ? 'attempt extension requires structured failure fingerprints'
      : 'failure evidence is still changing and the corrective work is converging',
  };
}
