/**
 * The Git capabilities the workspace use cases need, declared by the layer that uses them.
 *
 * Application states the contract and Infrastructure satisfies it, so a change-set use case can be
 * exercised against an in-memory Git without dragging the real repository adapter into the
 * application layer.
 */
export interface WorktreeRequest {
  path: string;
  branch: string;
  /** Commit the branch starts from when it does not already exist. */
  startPoint: string;
}

export interface WorktreeRecord {
  path: string;
  branch?: string;
  head?: string;
}

export interface GitCommitRecord {
  revision: string;
  parents: string[];
  message: string;
}

/** A merge candidate could not be assembled because source and target edit the same paths. */
export class MergeConflictError extends Error {
  constructor(
    readonly source: string,
    readonly files: readonly string[],
    options?: ErrorOptions,
  ) {
    super(`Merge conflict for ${source}: ${files.join(', ')}`, options);
    this.name = 'MergeConflictError';
  }
}

export interface GitWorktreePort {
  head(): Promise<string>;
  addWorktree(request: WorktreeRequest): Promise<void>;
  listWorktrees(): Promise<WorktreeRecord[]>;
  pruneWorktrees(): Promise<void>;
  removeWorktree(path: string, options?: { force?: boolean }): Promise<void>;
}

/** Merge-side Git capabilities the gate and merge use cases need. */
export interface GitMergePort extends GitWorktreePort {
  /** Resolves a branch or ref to a commit sha. */
  revision(ref: string): Promise<string>;
  /** Reads immutable commit evidence used to reconcile an interrupted merge transaction. */
  readCommit(ref: string): Promise<GitCommitRecord>;
  /** Merges `source` into the working copy at `root`, returning the resulting commit. */
  mergeInto(root: string, source: string): Promise<string>;
  deleteBranch(branch: string, options?: { force?: boolean }): Promise<void>;
  /**
   * Squashes `sourceBranch` onto `targetBranch` and returns the new target head.
   *
   * Squash keeps one mainline commit per ChangeSet, so a Ticket can be reverted as a unit and the
   * mainline is not filled with per-attempt commits; the attempt history stays on the branch.
   */
  squashMerge(input: {
    targetBranch: string;
    sourceBranch: string;
    expectedTargetRevision: string;
    message: string;
  }): Promise<string>;
}
