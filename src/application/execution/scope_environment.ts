import type { Sandbox } from '../../sandbox/types.js';
import type { AuditLogger } from '../../audit/audit.js';

/**
 * Prepares the package environment of a working copy before any attempt runs in it.
 *
 * The canonical copy is prepared once, at run start. An isolated working copy is not: it is a fresh
 * Git checkout, and Git restores the manifest but not `node_modules` or a virtualenv, which are
 * untracked. So the one Step that develops in isolation — CODE — was the one guaranteed to find no
 * toolchain, and it could not run a single test.
 *
 * A failure here is recorded, not raised. Nothing about the change has been shown to be wrong, and
 * the attempt's own tooling reports a missing toolchain in terms the Step can act on; aborting the
 * run instead would replace an actionable diagnosis with a stack trace.
 */
export async function prepareScopeEnvironment(input: {
  sandbox: Sandbox;
  manifestFile: string;
  /** False for the canonical copy, which the run prepared before the V-model started. */
  isolated: boolean;
  root: string;
  audit?: AuditLogger;
}): Promise<{ prepared: boolean; error?: string }> {
  if (!input.isolated) return { prepared: false };
  try {
    await input.sandbox.build(input.manifestFile);
    return { prepared: true };
  } catch (error) {
    const message = (error as Error).message;
    await input.audit?.event('note', `sandbox sync failed for ${input.root}: ${message}`, {
      messageId: 'execute.scope_sandbox_sync_failed',
    });
    return { prepared: false, error: message };
  }
}
