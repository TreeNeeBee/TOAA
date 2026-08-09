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
  const recent = signatures.slice(-REPEATED_FAILURE_LIMIT);
  if (
    recent.length === REPEATED_FAILURE_LIMIT &&
    recent.every((signature) => signature === recent[0])
  ) {
    return {
      extend: false,
      reason: `same failure repeated ${REPEATED_FAILURE_LIMIT} times without convergence`,
    };
  }
  return {
    extend: signatures.length > 0,
    reason: signatures.length === 0
      ? 'attempt extension requires structured failure fingerprints'
      : 'failure evidence is still changing and the corrective work is converging',
  };
}
