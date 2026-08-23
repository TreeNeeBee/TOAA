import path from 'node:path';

/**
 * Which sandbox environment a piece of work runs in.
 *
 * Environments are addressed by owner, not by a hash of the dependency manifest. An environment
 * belongs to whoever works in it, so a dependency change simply evolves it in place — the same way
 * a developer's own virtualenv evolves — instead of invalidating a content fingerprint and forcing
 * a rebuild on every edit to `requirements.txt`.
 *
 * Only CODE has concurrent workers, so only CODE needs per-role isolation: while a developer
 * installs a package, a tester must not have the environment change underneath a running test.
 * Every other V-model stage shares the canonical environment.
 *
 *   canonical    every stage except parallel CODE work and gate validation
 *   development  one per role, for concurrent CODE work on a Phase
 *   gate         one per Phase, shared by that Phase's gate runs
 *
 * Gate validation gets its own environment rather than borrowing the tester's: a gate judges an
 * independent merge candidate, so it must not observe a role's in-progress state.
 */
export type SandboxScope = 'canonical' | 'development' | 'gate';

export type SandboxEnvironmentKey =
  | { scope: 'canonical'; projectId: string }
  | { scope: 'development'; projectId: string; phaseId: string; roleId: string }
  | { scope: 'gate'; projectId: string; phaseId: string };

export const SANDBOX_ENVIRONMENTS_DIR = 'sandboxes';

/** Guest mount point for the environment; deliberately outside the working copy mount. */
export const SANDBOX_GUEST_ENVIRONMENT_DIR = '/xcsandbox';

/**
 * Path of an environment relative to the container state root.
 *
 * Environments live in container state rather than inside a worktree so that creating or deleting a
 * Ticket or gate worktree never destroys a prepared environment. Rebuilding one per worktree — and
 * per gate run — is the dominant cost of the worktree model.
 */
export function sandboxEnvironmentRelPath(key: SandboxEnvironmentKey): string {
  const segments = [SANDBOX_ENVIRONMENTS_DIR, sanitizeSegment(key.projectId)];
  switch (key.scope) {
    case 'canonical':
      segments.push('canonical');
      break;
    case 'development':
      segments.push(sanitizeSegment(key.phaseId), 'dev', sanitizeSegment(key.roleId));
      break;
    case 'gate':
      segments.push(sanitizeSegment(key.phaseId), 'gate');
      break;
  }
  return segments.join('/');
}

/**
 * Where downloaded packages are cached, shared by every environment of one project.
 *
 * Environments are isolated so that one role's install cannot change what another role is running.
 * That is about *installed* state — `node_modules`, a virtualenv. A download cache holds
 * content-addressed immutable archives, so sharing it changes nothing any environment observes,
 * while giving each its own means fetching identical bytes once per environment. With canonical,
 * per-role CODE, and gate environments that is three cold downloads of the same packages, on the
 * one operation that has actually failed in practice — npm timing out on a weak link.
 */
export function sandboxDownloadCachePath(stateRoot: string, projectId: string): string {
  return path.join(stateRoot, SANDBOX_ENVIRONMENTS_DIR, sanitizeSegment(projectId), 'download-cache');
}

export function describeSandboxEnvironment(key: SandboxEnvironmentKey): string {
  switch (key.scope) {
    case 'canonical': return 'canonical';
    case 'development': return `${key.phaseId}/dev/${key.roleId}`;
    case 'gate': return `${key.phaseId}/gate`;
  }
}

/**
 * Keeps an identifier usable as exactly one path segment.
 *
 * Separators become `-` and dot runs collapse, so no input can produce `.`, `..`, or a nested path
 * and thereby address an environment outside its own root.
 */
function sanitizeSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/gu, '-')
    .replace(/\.{2,}/gu, '-')
    .replace(/^[.]+/u, '');
  if (!cleaned) throw new Error(`Sandbox environment identifier is empty after sanitization: ${value}`);
  return cleaned;
}

/** Absolute host path of an environment, given the container state root. */
export function sandboxEnvironmentPath(stateRoot: string, key: SandboxEnvironmentKey): string {
  return path.join(stateRoot, ...sandboxEnvironmentRelPath(key).split('/'));
}
