import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { XCOMPILER_VERSION } from '../version.js';

/**
 * Identifies the XCompiler build that is running, not the release it claims to be.
 *
 * The version string is fixed for a whole release, so it cannot answer the question the retry
 * policy actually needs: *has the toolchain changed since this failure was recorded?* Without an
 * answer, a Ticket that stopped for non-convergence stops forever. Repairing the defect that caused
 * the recurrences changes nothing, because the evidence blocking the retry was gathered under a
 * build that no longer exists — a live run reached exactly that state, and the only way forward was
 * to abandon a workspace with three delivered Steps and sixteen landed merges.
 *
 * The fingerprint is the running module's size and mtime. It is not a content hash: this is asked
 * once per process and has to stay cheap, and size-and-mtime already distinguishes every rebuild,
 * which is the only distinction being made. Two builds that differ but collide here would be a
 * missed retry, never a wrong one.
 */
let cached: string | undefined;

export function xcompilerBuildId(): string {
  if (cached) return cached;
  let fingerprint = 'unknown';
  try {
    const self = fileURLToPath(import.meta.url);
    const stats = statSync(self);
    fingerprint = `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
  } catch {
    /* an unidentifiable build is treated as its own, which only ever grants a retry */
  }
  cached = `${XCOMPILER_VERSION}+${createHash('sha256').update(fingerprint).digest('hex').slice(0, 12)}`;
  return cached;
}

/** Test seam: a case that fakes a rebuild must not inherit the previous fingerprint. */
export function resetBuildIdentity(): void {
  cached = undefined;
}

/**
 * A fingerprint of what a Step was told to do, so a repair on the project side is visible.
 *
 * The build id answers "did XCompiler change"; nothing answered "did this Step's instructions
 * change". An operator who diagnoses a stalled Ticket and fixes its cause — a declared output that
 * no longer exists, a prompt that named the wrong artifact — has made exactly the repair the retry
 * policy exists to recognise, and it was invisible: releasing the guard meant rebuilding XCompiler
 * for no reason, which is both the wrong signal and trivially forged.
 */
export function stepContextFingerprint(step: {
  inputs?: readonly string[];
  outputs?: readonly string[];
  systemPrompt?: string;
}): string {
  const material = JSON.stringify({
    inputs: [...(step.inputs ?? [])].sort(),
    outputs: [...(step.outputs ?? [])].sort(),
    systemPrompt: step.systemPrompt ?? '',
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}
