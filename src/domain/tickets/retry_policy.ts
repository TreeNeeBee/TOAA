export interface AttemptFailureEvidence {
  signature?: string;
  category?: string;
  /** The XCompiler build that produced this failure, when the run recorded one. */
  toolchainBuildId?: string;
  /**
   * What the Step was told to do when this failure was recorded.
   *
   * The build id answers "did XCompiler change". This answers "did this Step's instructions change",
   * which is the other way a recurrence stops being evidence: a declared output that no longer
   * exists, or a prompt naming an artifact that was removed, produces the same failure every time
   * until someone repairs the declaration — and that repair was invisible here.
   */
  stepContextFingerprint?: string;
}

export interface AttemptExtensionDecision {
  extend: boolean;
  reason: string;
}

const REPEATED_FAILURE_LIMIT = 3;

export function evaluateAttemptExtension(
  evidence: readonly AttemptFailureEvidence[],
  currentBuildId?: string,
  currentStepContext?: string,
): AttemptExtensionDecision {
  // Recurrence means "the corrective work is not converging" only while the toolchain holds still.
  // Failures recorded by a build that no longer exists say nothing about whether the repair that
  // replaced it works, and holding them against the Ticket makes a stopped Ticket permanent: fixing
  // the defect that caused the recurrences changes nothing, because the evidence blocking the retry
  // predates the fix. A live run reached exactly that, and the only way on was to abandon a
  // workspace with three delivered Steps and sixteen landed merges.
  // Unattributed evidence cannot support the claim being made. The guard asserts that a failure
  // keeps coming back *under this toolchain*; a record that does not say which build produced it
  // is not evidence of that. Counting it as current was the conservative-looking choice and the
  // wrong one: every failure logged before builds were identified is unlabelled, which is exactly
  // the case where the toolchain has demonstrably changed — a live Ticket stayed stopped through
  // the repair that fixed it for precisely this reason.
  const relevant = evidence.filter((item) =>
    (currentBuildId === undefined || item.toolchainBuildId === currentBuildId) &&
    // A failure recorded against instructions this Step no longer has says nothing about whether it
    // still recurs. Unlabelled records keep their old meaning: only a fingerprint that is present
    // and different proves the instructions moved.
    (currentStepContext === undefined ||
      item.stepContextFingerprint === undefined ||
      item.stepContextFingerprint === currentStepContext));
  if (evidence.length > 0 && relevant.length === 0) {
    return {
      extend: true,
      reason: 'every recorded failure predates the running build or this Step\'s current instructions',
    };
  }
  const latest = relevant.at(-1);
  if (latest?.category === 'tool_loop') {
    return { extend: false, reason: 'latest failure is an unproductive tool loop' };
  }
  const signatures = relevant
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
