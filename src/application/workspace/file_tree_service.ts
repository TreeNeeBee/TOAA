import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ReadWriteLock } from '../../core/rwlock.js';
import { createObjectEnvelope, reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  DEFAULT_IGNORED_TREE_PREFIXES,
  FileTreeSchema,
  applyFileTreeChange,
  isIgnoredTreePath,
  normalizeTreePath,
  readTreeDir,
  statTreePath,
  type FileTree,
  type FileTreeChangeKind,
  type FileTreeEntry,
} from '../../domain/workspace/file_tree.js';

/**
 * The one writer of the shared file tree.
 *
 * Before this existed, seven call sites across the tools wrote files straight through `node:fs`,
 * so no part of the system could answer what the project contained without walking the disk. That
 * is the shape this codebase keeps getting caught by — one concept decided in several places — and
 * an index maintained at seven of them would drift at the first one that forgot.
 *
 * Every mutation goes through `record`, which stats the real file and folds the result into the
 * tree. Readers go through `stat`/`list`, which hold the read side of the lock. The tree is
 * therefore always a statement about what the filesystem actually contained at a point in time,
 * never a prediction of what a caller intended to write.
 */
export class FileTreeService {
  private readonly lock = new ReadWriteLock();

  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    private readonly workspaceRoot: string,
    private readonly treeId: ObjectId,
  ) {}

  /**
   * Creates the tree object for a workspace. Returns the object to commit with the plan that owns
   * it, so a project gains its tree in the same write that gains the policy pointing at it.
   */
  static create(input: {
    projectId: ObjectId;
    ignoredPrefixes?: readonly string[];
  }): FileTree {
    return FileTreeSchema.parse({
      ...createObjectEnvelope({
        name: 'file-tree-master',
        objectType: 'file-tree',
        projectId: input.projectId,
      }),
      branch: 'master',
      entries: [],
      ignoredPrefixes: [...(input.ignoredPrefixes ?? DEFAULT_IGNORED_TREE_PREFIXES)],
      dirty: false,
    });
  }

  /** `stat(2)`: what the tree knows about one path. */
  async stat(rel: string): Promise<FileTreeEntry | undefined> {
    return this.lock.read(async () => statTreePath((await this.load()).entries, rel));
  }

  /** `readdir(3)`: the entries directly under a directory, one level only. */
  async list(dir = ''): Promise<FileTreeEntry[]> {
    return this.lock.read(async () => readTreeDir((await this.load()).entries, dir));
  }

  /** Every tracked entry, ordered by path. For delivery rendering and audit. */
  async entries(): Promise<FileTreeEntry[]> {
    return this.lock.read(async () => [...(await this.load()).entries]);
  }

  /**
   * Folds one create/modify/delete into the tree.
   *
   * The caller says which path changed; the timestamps come from `lstat`, never from the caller.
   * A tool that reports a write it did not perform, or performs one it does not report, is a defect
   * either way — but a tree built from what actually landed on disk cannot invent a file, and that
   * is the property worth having when the tree becomes part of the delivered record.
   */
  async record(rel: string, kind: FileTreeChangeKind): Promise<void> {
    const normalized = normalizeTreePath(rel);
    if (normalized === '') throw new Error('File-tree mutation path cannot be empty');
    await this.lock.write(async () => {
      const tree = await this.load();
      if (isIgnoredTreePath(normalized, ignoredFor(tree))) return;
      const entry = kind === 'deleted'
        ? { path: normalized, type: 'file' as const, size: 0, mtimeMs: 0, ctimeMs: 0 }
        : await this.statOnDisk(normalized);
      // A create or modify whose file is already gone is a delete: the filesystem is the authority,
      // and racing another actor's removal must not leave a phantom entry behind.
      const resolved = entry ?? { path: normalized, type: 'file' as const, size: 0, mtimeMs: 0, ctimeMs: 0 };
      const effective = entry === undefined && kind !== 'deleted' ? 'deleted' : kind;
      const next = applyFileTreeChange(tree.entries, { kind: effective, entry: resolved });
      await this.commit(tree, next);
    });
  }

  /**
   * Reconciles the whole tree against the filesystem.
   *
   * Incremental updates only cover what this process performed. A resumed run, a Git checkout, or a
   * merge landing on the mainline all change files without passing through `record`, so the tree
   * needs a way to be told the truth wholesale rather than drifting silently.
   */
  async rescan(reconciledRevision?: string): Promise<number> {
    return this.lock.write(async () => {
      const tree = await this.load();
      const ignored = ignoredFor(tree);
      const found: FileTreeEntry[] = [];
      await this.walk('', ignored, found);
      found.sort((a, b) => a.path.localeCompare(b.path));
      await this.commit(tree, found, {
        scannedAt: new Date().toISOString(),
        dirty: false,
        reconciledRevision,
      });
      return found.length;
    });
  }

  /** Records that bytes landed but the incremental index could not be reconciled. */
  async markDirty(): Promise<void> {
    await this.lock.write(async () => {
      const tree = await this.load();
      if (tree.dirty) return;
      await this.commit(tree, tree.entries, { dirty: true });
    });
  }

  private async walk(rel: string, ignored: readonly string[], out: FileTreeEntry[]): Promise<void> {
    const abs = rel === '' ? this.workspaceRoot : path.join(this.workspaceRoot, rel);
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && rel !== '') return;
      throw error;
    }
    for (const dirent of dirents) {
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      if (isIgnoredTreePath(childRel, ignored)) continue;
      const entry = await this.statOnDisk(childRel);
      if (entry) out.push(entry);
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) await this.walk(childRel, ignored, out);
    }
  }

  /** `lstat`, not `stat`: a symlink is recorded as the link it is, not as what it resolves to. */
  private async statOnDisk(rel: string): Promise<FileTreeEntry | undefined> {
    const abs = path.join(this.workspaceRoot, rel);
    let stats;
    try {
      stats = await fs.lstat(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!stats) return undefined;
    const type = stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file';
    return {
      path: rel,
      type,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      ...(stats.birthtimeMs > 0 ? { birthtimeMs: stats.birthtimeMs } : {}),
      mode: stats.mode,
      ...(type === 'symlink'
        ? { linkTarget: await fs.readlink(abs) }
        : {}),
    } as FileTreeEntry;
  }

  private async load(): Promise<FileTree> {
    const object = await this.repository.read(this.treeId);
    if (object.objectType !== 'file-tree') {
      throw new Error(`Object ${this.treeId} is not a file tree`);
    }
    return object;
  }

  private async commit(
    tree: FileTree,
    entries: FileTreeEntry[],
    state: { scannedAt?: string; dirty?: boolean; reconciledRevision?: string } = {},
  ): Promise<void> {
    await this.repository.commit([FileTreeSchema.parse({
      ...tree,
      ...reviseObjectEnvelope(tree),
      entries,
      ...(state.scannedAt ? { scannedAt: state.scannedAt } : {}),
      ...(state.dirty !== undefined ? { dirty: state.dirty } : {}),
      ...(state.reconciledRevision ? { reconciledRevision: state.reconciledRevision } : {}),
    })]);
  }
}

/** An unset exclusion list means the defaults, not "index everything". */
function ignoredFor(tree: FileTree): readonly string[] {
  return tree.ignoredPrefixes.length > 0 ? tree.ignoredPrefixes : DEFAULT_IGNORED_TREE_PREFIXES;
}
