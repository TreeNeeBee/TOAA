import { promises as fs } from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { MergeConflictError } from '../../application/workspace/git_port.js';

/**
 * Whether XCompiler created this repository, which decides how much branch policy it may impose.
 *
 * A repository XCompiler initialized is its own: it may protect the mainline and merge into it.
 * A repository that already existed belongs to someone else — the self-bootstrap case is exactly
 * this — so XCompiler confines itself to `xcompiler/*` branches, never rewrites the default branch
 * or its protection, and merges only when explicitly authorized.
 */
export type RepositoryOwnership = 'xcompiler-created' | 'pre-existing';

/** Durable home for the ownership fact, so it survives the call that discovered it. */
export interface OwnershipRecord {
  read(): Promise<RepositoryOwnership | undefined>;
  write(ownership: RepositoryOwnership): Promise<void>;
}

export interface GitRepositoryInfo {
  /** Absolute path of the main working tree. */
  root: string;
  /** Resolved `--git-common-dir`: shared across every linked worktree. */
  commonDir: string;
  ownership: RepositoryOwnership;
}

export interface CreateWorktreeRequest {
  path: string;
  branch: string;
  /** Commit the new branch starts from. */
  startPoint: string;
}

export interface WorktreeEntry {
  path: string;
  branch?: string;
  head?: string;
}

/**
 * Repository-scoped Git operations: discovery, branches, and worktrees.
 *
 * Separate from working-copy operations because these act on state shared by every worktree, and
 * because they must never assume `.git` is a directory — in a linked worktree it is a file pointing
 * into the common directory. Every internal path is resolved through `rev-parse` for that reason.
 */
export class GitRepositoryService {
  private readonly git: SimpleGit;

  constructor(private readonly cwd: string) {
    this.git = simpleGit({ baseDir: cwd });
  }

  async isRepository(): Promise<boolean> {
    return this.git.checkIsRepo().catch(() => false);
  }

  /** Whether HEAD resolves. False in a repository that has been initialized but never committed. */
  async hasCommits(): Promise<boolean> {
    // `--quiet` makes rev-parse exit 0 with empty output for an unborn HEAD rather than failing.
    const sha = await this.git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '');
    return sha.trim().length > 0;
  }

  /**
   * Initializes a repository when none exists, and reports who owns it. Ownership is derived here,
   * at the one moment the distinction is observable, rather than guessed later.
   *
   * A repository XCompiler creates is initialized on the caller's canonical branch: the worktree
   * layout, the merge target, and every gate verdict are keyed by that name, so letting
   * `init.defaultBranch` decide it would leave the model pointing at a branch that does not exist.
   * An initial commit is made because an unborn HEAD has nothing to snapshot from, and every Step
   * attempt begins by snapshotting the working copy.
   */
  async ensureRepository(
    identity?: { name: string; email: string },
    options: { initialBranch?: string; ownershipRecord?: OwnershipRecord } = {},
  ): Promise<GitRepositoryInfo> {
    const existed = await this.isRepository();
    if (!existed) {
      await this.git.raw(options.initialBranch
        ? ['init', `--initial-branch=${options.initialBranch}`]
        : ['init']);
    }
    const local = await this.git.listConfig('local').catch(() => null);
    const has = (key: string) => !!local?.all?.[key];
    if (!has('user.email')) await this.git.addConfig('user.email', identity?.email ?? 'xcompiler@local');
    if (!has('user.name')) await this.git.addConfig('user.name', identity?.name ?? 'XCompiler');
    if (!await this.hasCommits()) {
      // Project state lives in the container, so there is nothing to stage here; an empty commit is
      // the honest representation of an empty working copy and gives HEAD something to resolve to.
      await this.git.raw(['commit', '--allow-empty', '-m', '[xcompiler] init workspace']);
    }
    // Ownership is a fact about the repository, not about this call. Deriving it from `existed` on
    // every invocation made the *second* run of a workspace report `pre-existing`, so an interrupted
    // run, once resumed, could never merge into a mainline XCompiler had created itself. Recorded at
    // the only moment the distinction is observable, and read back from then on.
    const recorded = await options.ownershipRecord?.read();
    const ownership: RepositoryOwnership = recorded ?? (existed ? 'pre-existing' : 'xcompiler-created');
    if (!recorded) await options.ownershipRecord?.write(ownership);
    return {
      root: await this.root(),
      commonDir: await this.commonDir(),
      ownership,
    };
  }

  async root(): Promise<string> {
    return canonicalPath(path.resolve((await this.git.revparse(['--show-toplevel'])).trim()));
  }

  /**
   * The directory shared by every linked worktree; `--git-dir` is per-worktree and is not it.
   *
   * Git answers relatively from the main worktree and absolutely from a linked one, and on macOS the
   * absolute form has symlinks resolved (`/private/var` rather than `/var`). Both are canonicalized
   * so paths from different worktrees compare equal — worktree reconciliation depends on that.
   */
  async commonDir(): Promise<string> {
    const dir = (await this.git.revparse(['--git-common-dir'])).trim();
    return canonicalPath(path.resolve(this.cwd, dir));
  }

  /**
   * Resolves a path inside the Git directory. `git rev-parse --git-path` is the only correct way to
   * do this: it returns the per-worktree or the shared location as appropriate, so callers never
   * have to know which they are in.
   */
  async gitPath(relative: string): Promise<string> {
    const resolved = path.resolve(this.cwd, (await this.git.revparse(['--git-path', relative])).trim());
    // The target need not exist yet, so canonicalize its directory and re-attach the name.
    return path.join(await canonicalPath(path.dirname(resolved)), path.basename(resolved));
  }

  async head(): Promise<string> {
    return (await this.git.revparse(['HEAD'])).trim();
  }

  async isClean(): Promise<boolean> {
    return (await this.git.status()).isClean();
  }

  async branchExists(name: string): Promise<boolean> {
    // `--quiet` makes rev-parse exit 0 with empty output for a missing ref, so resolving without
    // throwing proves nothing; only a non-empty sha does.
    const sha = await this.git
      .raw(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
      .catch(() => '');
    return sha.trim().length > 0;
  }

  async addWorktree(request: CreateWorktreeRequest): Promise<void> {
    const args = await this.branchExists(request.branch)
      ? ['worktree', 'add', request.path, request.branch]
      : ['worktree', 'add', '-b', request.branch, request.path, request.startPoint];
    await this.git.raw(args);
  }

  async listWorktrees(): Promise<WorktreeEntry[]> {
    const output = await this.git.raw(['worktree', 'list', '--porcelain']);
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | undefined;
    for (const line of output.split(/\r?\n/u)) {
      if (line.startsWith('worktree ')) {
        current = { path: await canonicalPath(path.resolve(line.slice('worktree '.length))) };
        entries.push(current);
      } else if (current && line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length);
      } else if (current && line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '');
      }
    }
    return entries;
  }

  async removeWorktree(worktreePath: string, options: { force?: boolean } = {}): Promise<void> {
    const args = ['worktree', 'remove', worktreePath];
    if (options.force) args.push('--force');
    await this.git.raw(args).catch(async (error: unknown) => {
      // A worktree directory deleted out from under Git cannot be removed, only pruned.
      if (!await this.pathIsMissing(worktreePath)) throw error;
      await this.pruneWorktrees();
    });
  }

  async deleteBranch(branch: string, options: { force?: boolean } = {}): Promise<void> {
    await this.git.raw(['branch', options.force ? '-D' : '-d', branch]);
  }

  /**
   * Drops registrations whose directories no longer exist. A run killed mid-gate leaves exactly this
   * behind, so recovery calls it before trusting `listWorktrees()`.
   */
  async pruneWorktrees(): Promise<void> {
    await this.git.raw(['worktree', 'prune']);
  }

  async revision(ref: string): Promise<string> {
    return (await this.git.revparse([ref])).trim();
  }

  /** Merges `source` into the working copy at `root`, producing the candidate a gate judges. */
  async mergeInto(root: string, source: string): Promise<string> {
    const worktree = simpleGit({ baseDir: root });
    try {
      await worktree.raw(['merge', '--no-ff', '--no-edit', source]);
    } catch (error) {
      const status = await worktree.status().catch(() => undefined);
      if (status && status.conflicted.length > 0) {
        throw new MergeConflictError(source, status.conflicted, { cause: error });
      }
      throw error;
    }
    return (await worktree.revparse(['HEAD'])).trim();
  }

  /**
   * Squashes a branch onto the target, refusing if the target moved since the caller last looked.
   *
   * The check is the merge-time half of gate revision locking: a gate can pass and the mainline can
   * still advance before the merge runs, and squashing onto a different target would land something
   * no gate ever judged.
   */
  async squashMerge(input: {
    targetBranch: string;
    sourceBranch: string;
    expectedTargetRevision: string;
    message: string;
  }): Promise<string> {
    const current = await this.revision(input.targetBranch);
    if (current !== input.expectedTargetRevision) {
      throw new Error(
        `Target ${input.targetBranch} moved from ${input.expectedTargetRevision} to ${current}; ` +
        'the gate verdict no longer describes what would land',
      );
    }
    const head = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (head !== input.targetBranch) {
      throw new Error(`Merge must run on ${input.targetBranch}; the working copy is on ${head}`);
    }
    // Names the files, because "uncommitted changes" is not something an operator can act on. The
    // one that actually stopped a run was XCompiler's own PM projection, and the message gave no
    // hint of that.
    const status = await this.git.status();
    if (!status.isClean()) {
      const dirty = [...status.not_added, ...status.modified, ...status.created, ...status.deleted]
        .slice(0, 20);
      throw new Error(
        `Cannot merge into ${input.targetBranch}: the working copy has uncommitted changes: ` +
        `${dirty.join(', ')}${status.files.length > dirty.length ? ', …' : ''}`,
      );
    }
    try {
      await this.git.raw(['merge', '--squash', input.sourceBranch]);
      await this.git.raw(['commit', '-m', input.message]);
    } catch (error) {
      try {
        await this.git.raw(['reset', '--hard', input.expectedTargetRevision]);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Squash merge failed and ${input.targetBranch} could not be restored`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return this.revision(input.targetBranch);
  }

  raw(): SimpleGit {
    return this.git;
  }

  private async pathIsMissing(candidate: string): Promise<boolean> {
    return fs.stat(candidate).then(() => false).catch(() => true);
  }
}

/** The ownership fact, kept in container state beside everything else that outlives a run. */
export function containerOwnershipRecord(state: {
  exists(rel: string): Promise<boolean>;
  readFile(rel: string): Promise<string>;
  writeFile(rel: string, content: string): Promise<void>;
}): OwnershipRecord {
  const file = 'repository-ownership.json';
  return {
    async read() {
      if (!await state.exists(file)) return undefined;
      try {
        const value = JSON.parse(await state.readFile(file)) as { ownership?: unknown };
        return value.ownership === 'xcompiler-created' || value.ownership === 'pre-existing'
          ? value.ownership
          : undefined;
      } catch {
        // An unreadable record must not decide who owns a mainline; rediscovering is safe because
        // the repository exists by then and the answer is `pre-existing`, the cautious one.
        return undefined;
      }
    },
    async write(ownership) {
      await state.writeFile(file, `${JSON.stringify({ ownership }, null, 2)}\n`);
    },
  };
}

/** Resolves symlinks when the path exists, so paths seen from different worktrees compare equal. */
async function canonicalPath(candidate: string): Promise<string> {
  return fs.realpath(candidate).catch(() => candidate);
}
