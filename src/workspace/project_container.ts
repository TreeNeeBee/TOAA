import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Workspace } from './workspace.js';

/**
 * Layout of a 0.3 project container.
 *
 * Project state and the working copy are separate roots. Keeping state outside every worktree is
 * what lets a sandbox mount the working copy without also handing the generated project XCompiler's
 * own registry, audit trail, and fixtures — an exclusion that would otherwise have to be remembered
 * at each mount site.
 *
 *   <container>/
 *   ├── .xcompiler/            shared project state; never in Git, never inside a worktree
 *   └── worktrees/
 *       ├── <canonical>/       the canonical working copy
 *       │   └── .xcw/          execution state local to this worktree
 *       ├── tickets/<id>/        first CODE delivery generation
 *       │   └── r<N>/             later downstream correction generations
 *       └── gates/<mr>/<run>/
 */
export const CONTAINER_STATE_DIR = '.xcompiler';
export const CONTAINER_WORKTREES_DIR = 'worktrees';
export const WORKTREE_LOCAL_STATE_DIR = '.xcw';
export const DEFAULT_CANONICAL_BRANCH = 'master';

export type WorkspaceKind = 'canonical' | 'ticket' | 'gate';

/**
 * One working copy plus the execution state that belongs to it alone.
 *
 * Nothing under `localState` is canonical: it holds the current attempt's scratch, run logs, and the
 * resolved sandbox session, all of which may be discarded with the worktree. Anything that must
 * outlive the worktree is committed to the container state first.
 */
export interface WorkspaceHandle {
  kind: WorkspaceKind;
  /** Working-copy root; project code lives here. */
  workspace: Workspace;
  /** Worktree-local execution state, rooted at `<workspace>/.xcw`. */
  localState: Workspace;
  branch: string;
}

export class ProjectContainer {
  readonly root: string;
  /** Shared project state, rooted at `<container>/.xcompiler`. */
  readonly state: Workspace;
  readonly worktreesRoot: string;

  constructor(containerRoot: string, readonly canonicalBranch: string = DEFAULT_CANONICAL_BRANCH) {
    this.root = path.resolve(containerRoot);
    this.state = new Workspace(path.join(this.root, CONTAINER_STATE_DIR));
    this.worktreesRoot = path.join(this.root, CONTAINER_WORKTREES_DIR);
  }

  /** The canonical working copy: `<container>/worktrees/<canonicalBranch>`. */
  canonical(): WorkspaceHandle {
    return this.handle('canonical', path.join(this.worktreesRoot, this.canonicalBranch), this.canonicalBranch);
  }

  ticket(ticketId: string, branch: string, generation = 1): WorkspaceHandle {
    const root = generation === 1
      ? path.join(this.worktreesRoot, 'tickets', ticketId)
      : path.join(this.worktreesRoot, 'tickets', ticketId, `r${generation}`);
    return this.handle('ticket', root, branch);
  }

  gate(mergeRequestId: string, gateRunId: string, branch: string): WorkspaceHandle {
    return this.handle('gate', path.join(this.worktreesRoot, 'gates', mergeRequestId, gateRunId), branch);
  }

  private handle(kind: WorkspaceKind, root: string, branch: string): WorkspaceHandle {
    return {
      kind,
      workspace: new Workspace(root),
      localState: new Workspace(path.join(root, WORKTREE_LOCAL_STATE_DIR)),
      branch,
    };
  }
}

/**
 * Finds the container that owns `start`, which may be the container itself, a worktree inside it, or
 * any path within one.
 *
 * A validated walk rather than a fixed number of parent hops: the canonical worktree, a Ticket
 * worktree, and a gate worktree sit at three different depths under the same container, so counting
 * levels is only ever right for one of them. Each candidate is accepted only if it actually has both
 * roots, which is what makes this a lookup rather than a guess.
 */
export async function findProjectContainer(
  start: string,
  canonicalBranch: string = DEFAULT_CANONICAL_BRANCH,
): Promise<ProjectContainer | undefined> {
  let current = path.resolve(start);
  for (;;) {
    const candidate = new ProjectContainer(current, canonicalBranch);
    const [hasState, hasWorktrees] = await Promise.all([
      candidate.state.exists('.'),
      pathExists(candidate.worktreesRoot),
    ]);
    if (hasState && hasWorktrees) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export class ContainerLayoutError extends Error {
  constructor(containerRoot: string, reason: string) {
    super(
      `${containerRoot} is not an XCompiler 0.3 project container: ${reason}.\n` +
      '0.3 separates project state from the working copy and does not migrate an earlier layout:\n' +
      `  ${CONTAINER_STATE_DIR}/            shared project state\n` +
      `  ${CONTAINER_WORKTREES_DIR}/<branch>/   the working copy\n` +
      'Rebuild the project from its topic/requirements with 0.3.',
    );
    this.name = 'ContainerLayoutError';
  }
}

/**
 * Distinguishes a 0.3 container from an earlier workspace, whose `.xcompiler` sits beside the project
 * code rather than beside a `worktrees/` directory. Such a layout must fail with the rebuild message
 * rather than be silently reinterpreted, because its state paths and `.xc` references no longer
 * resolve.
 */
export async function assertProjectContainer(container: ProjectContainer): Promise<void> {
  if (!await container.state.exists('.')) {
    throw new ContainerLayoutError(container.root, `${CONTAINER_STATE_DIR}/ is missing`);
  }
  const canonical = container.canonical();
  if (!await canonical.workspace.exists('.')) {
    throw new ContainerLayoutError(
      container.root,
      `${CONTAINER_WORKTREES_DIR}/${container.canonicalBranch}/ is missing`,
    );
  }
}
