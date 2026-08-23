import { z } from 'zod';
import { ObjectEnvelopeSchema } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';

/**
 * The project's file tree, held as one shared object so every actor reads the same index.
 *
 * Entries are keyed by workspace-relative POSIX path and carry the timestamps `stat(2)` reports.
 * The names follow POSIX rather than intuition, and the difference matters when reading them back:
 *
 * - `mtimeMs` — last time the *contents* changed.
 * - `ctimeMs` — last time the *inode* changed. Contents, mode, owner, or link count all move it,
 *   and it cannot be set by hand. This is **change** time, not creation time; treating it as
 *   creation is the classic misreading, and here it is the field that says "something happened to
 *   this file even though its bytes look the same".
 * - `birthtimeMs` — creation, where the platform records it (`statx` STATX_BTIME). Optional
 *   because not every filesystem carries it, and a fabricated value would be worse than its
 *   absence.
 */

export const FILE_TREE_ENTRY_TYPES = ['file', 'directory', 'symlink'] as const;
export type FileTreeEntryType = (typeof FILE_TREE_ENTRY_TYPES)[number];

export const FileTreeEntrySchema = z.object({
  path: z.string().min(1),
  type: z.enum(FILE_TREE_ENTRY_TYPES),
  size: z.number().int().nonnegative(),
  /** Last content modification, epoch milliseconds. */
  mtimeMs: z.number().nonnegative(),
  /** Last inode change, epoch milliseconds. Never earlier than the write that caused it. */
  ctimeMs: z.number().nonnegative(),
  /** Creation, where the filesystem records one. */
  birthtimeMs: z.number().nonnegative().optional(),
  /** Permission bits as `stat` reports them, so a mode change is visible as a change. */
  mode: z.number().int().nonnegative().optional(),
  /** Target of a symlink, unresolved — the tree records the link, not what it points at. */
  linkTarget: z.string().min(1).optional(),
}).strict();

export type FileTreeEntry = z.infer<typeof FileTreeEntrySchema>;

export const FileTreeSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('file-tree'),
  /** Only the canonical mainline is persistent. Candidate worktrees are represented by ChangeSets. */
  branch: z.literal('master'),
  entries: z.array(FileTreeEntrySchema).default([]),
  /** Paths excluded from tracking, as configured on the owning management plan. */
  ignoredPrefixes: z.array(z.string().min(1)).default([]),
  /** When the tree was last reconciled against the real filesystem rather than updated in place. */
  scannedAt: z.string().datetime({ offset: true }).optional(),
  dirty: z.boolean().default(false),
  reconciledRevision: z.string().min(1).optional(),
}).strict();

export type FileTree = z.infer<typeof FileTreeSchema>;

export const FILE_TREE_CHANGE_KINDS = ['created', 'modified', 'deleted'] as const;
export type FileTreeChangeKind = (typeof FILE_TREE_CHANGE_KINDS)[number];

export interface FileTreeChange {
  kind: FileTreeChangeKind;
  entry: FileTreeEntry;
}

/** Normalizes a path the way every comparison in this module expects to receive it. */
export function normalizeTreePath(path: string): string {
  if (path.includes('\0')) throw new Error('File-tree paths cannot contain NUL');
  const slashed = path.replaceAll('\\', '/');
  if (/^(?:\/|[A-Za-z]:\/|\/\/)/u.test(slashed)) {
    throw new Error(`File-tree paths must be workspace-relative: ${path}`);
  }
  const segments = slashed.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`File-tree paths cannot escape the canonical workspace: ${path}`);
  }
  return segments.filter((segment) => segment !== '.').join('/');
}

/** Whether a path is excluded from the tree by configuration. */
export function isIgnoredTreePath(path: string, ignoredPrefixes: readonly string[]): boolean {
  const normalized = normalizeTreePath(path);
  return ignoredPrefixes.some((prefix) => {
    const bare = normalizeTreePath(prefix);
    return normalized === bare || normalized.startsWith(`${bare}/`);
  });
}

/**
 * Applies one filesystem change to a tree, returning the new entry list.
 *
 * Pure and total: a delete of something absent, or a modify of something never seen, both settle on
 * the state the filesystem is actually in rather than throwing. The tree follows the filesystem; it
 * does not get to disagree with it.
 */
export function applyFileTreeChange(
  entries: readonly FileTreeEntry[],
  change: FileTreeChange,
): FileTreeEntry[] {
  const path = normalizeTreePath(change.entry.path);
  const without = entries.filter((entry) => normalizeTreePath(entry.path) !== path);
  if (change.kind === 'deleted') {
    // A delete takes the subtree with it, the way `rm -r` and an unlinked directory both do.
    // Removing only the exact path left every descendant behind as an entry for a file that no
    // longer exists — in a manifest that gets delivered as the record of what the project is.
    const prefix = `${path}/`;
    return without.filter((entry) => !normalizeTreePath(entry.path).startsWith(prefix));
  }
  return [...without, { ...change.entry, path }].sort((a, b) => a.path.localeCompare(b.path));
}

/** `stat`: the entry at a path, or undefined when the tree has never seen it. */
export function statTreePath(
  entries: readonly FileTreeEntry[],
  path: string,
): FileTreeEntry | undefined {
  const normalized = normalizeTreePath(path);
  return entries.find((entry) => normalizeTreePath(entry.path) === normalized);
}

/**
 * `readdir`: the entries directly under a directory, not its whole subtree.
 *
 * An empty prefix lists the workspace root. Descendants deeper than one level are excluded, so a
 * caller walking the tree gets the same shape `readdir` gives and can recurse deliberately.
 */
export function readTreeDir(
  entries: readonly FileTreeEntry[],
  dir = '',
): FileTreeEntry[] {
  const prefix = normalizeTreePath(dir);
  const base = prefix === '' ? '' : `${prefix}/`;
  return entries.filter((entry) => {
    const path = normalizeTreePath(entry.path);
    if (!path.startsWith(base) || path === prefix) return false;
    return !path.slice(base.length).includes('/');
  });
}

/** Configuration the management plan holds for the tree it owns. */
export const FileTreePolicySchema = z.object({
  fileTreeId: ObjectIdSchema,
  branch: z.literal('master').default('master'),
  /** Paths never indexed. Defaults cover build output and the tool's own state. */
  ignoredPrefixes: z.array(z.string().min(1)).default([]),
  /** Whether delivery renders the manifest into the delivery document. */
  publishManifestOnDelivery: z.boolean().default(true),
}).strict();

export type FileTreePolicy = z.infer<typeof FileTreePolicySchema>;

/**
 * Paths excluded unless a project says otherwise: dependency and build output nobody delivers, and
 * XCompiler's own state, which would otherwise index its own index on every write.
 */
export const DEFAULT_IGNORED_TREE_PREFIXES = [
  '.git',
  '.xcompiler',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
] as const;
