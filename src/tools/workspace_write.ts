import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileTreeChangeKind } from '../domain/workspace/file_tree.js';

/**
 * What a tool needs from the file tree, and nothing else.
 *
 * Narrow on purpose: the tools live below the application layer and must not reach a repository.
 * Runtime supplies the real `FileTreeService`; a tool run without one still writes, it just writes
 * unindexed — the tree is a record of the project, not a permission to change it.
 */
export interface FileTreeSink {
  record(rel: string, kind: FileTreeChangeKind): Promise<void>;
  markDirty?(): Promise<void>;
}

/**
 * The single place a tool puts bytes on disk.
 *
 * Every tool used to call `fs.mkdir` + `fs.writeFile` itself — seven sites across five files — so
 * "a file changed" was decided in seven places and recorded in none. That is the shape this
 * codebase keeps paying for: an index maintained at seven call sites drifts at the first one that
 * forgets, and the one that forgets is always the one added later.
 *
 * The change kind is derived here rather than taken from the caller, because a caller that has not
 * checked cannot know whether it is creating or modifying, and the difference is exactly what the
 * tree is being asked to remember.
 */
export async function writeWorkspaceFile(
  abs: string,
  content: string | Uint8Array,
  options: { tree?: FileTreeSink; root?: string } = {},
): Promise<void> {
  const existed = await fs.access(abs).then(() => true).catch(() => false);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  await recordWorkspaceWrite(abs, existed ? 'modified' : 'created', options);
}

/** The single place a tool removes a file. Absent files are still reported, so the tree converges. */
export async function removeWorkspaceFile(
  abs: string,
  options: { tree?: FileTreeSink; root?: string } = {},
): Promise<void> {
  await fs.rm(abs, { force: true });
  await recordWorkspaceWrite(abs, 'deleted', options);
}

/**
 * Indexes a write a tool performed itself.
 *
 * `append_file` cannot go through `writeWorkspaceFile` — it appends rather than replaces — so it
 * needs the recording half on its own. Any tool that must own its write syscall uses this; a tool
 * that merely writes bytes should not.
 */
export async function recordWorkspaceWrite(
  abs: string,
  kind: FileTreeChangeKind,
  options: { tree?: FileTreeSink; root?: string },
): Promise<void> {
  if (!options.tree || !options.root) return;
  // Both sides are resolved through their real paths first. On macOS the workspace root arrives as
  // `/var/...` while the guard resolves the file to `/private/var/...` — the same symlink that made
  // every write look like it landed outside the workspace, so nothing was ever indexed. The
  // directory is resolved rather than the file itself, because a delete has to be recorded too and
  // its file is already gone.
  const root = options.root;
  const dir = path.dirname(abs);
  const [realRoot, realDir] = await Promise.all([
    fs.realpath(root).catch(() => root),
    fs.realpath(dir).catch(() => dir),
  ]);
  const rel = path.relative(realRoot, path.join(realDir, path.basename(abs)));
  // A path outside the workspace is not part of this project's tree, and `..` in an index would be
  // a defect that only shows up in the delivered manifest.
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  // Indexing must never fail the write that succeeded: the bytes are already on disk, and a tool
  // reporting failure would send a Step to repair something that is not broken.
  try {
    await options.tree.record(rel.replaceAll('\\', '/'), kind);
  } catch {
    await options.tree.markDirty?.().catch(() => undefined);
  }
}
