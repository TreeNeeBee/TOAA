import type { FileTreeEntry } from '../../domain/workspace/file_tree.js';

/**
 * The delivered file manifest: what the project consists of, as the filesystem had it at delivery.
 *
 * The section is generated, never authored. A Step asked to write this by hand would restate what
 * it believed it had produced, which is the one thing the manifest exists to check — and it would
 * be stale the moment the next Step wrote a file.
 *
 * Because it shares a document with authored prose, the generated region is fenced by markers and
 * only that region is ever replaced. Without them, regenerating means either appending duplicates
 * or overwriting a delivery document somebody wrote.
 */
export const FILE_MANIFEST_BEGIN = '<!-- xcompiler:file-manifest:begin -->';
export const FILE_MANIFEST_END = '<!-- xcompiler:file-manifest:end -->';

/** Formats an epoch-millisecond stamp as UTC seconds, so two runs of the same tree render alike. */
function stamp(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z') : '—';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Renders the manifest section.
 *
 * `mtime` and `ctime` are both shown because they answer different questions, and a manifest with
 * only one of them cannot distinguish a file whose contents changed from a file whose mode or link
 * count changed. The column headers say which is which, since `ctime` is routinely misread as
 * creation time.
 */
export function renderFileManifest(
  entries: readonly FileTreeEntry[],
  options: { scannedAt?: string } = {},
): string {
  const files = entries.filter((entry) => entry.type !== 'directory');
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  const rows = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => [
      `\`${entry.path}\``,
      entry.type,
      entry.type === 'directory' ? '—' : formatSize(entry.size),
      stamp(entry.mtimeMs),
      stamp(entry.ctimeMs),
    ].join(' | '));

  return [
    FILE_MANIFEST_BEGIN,
    '',
    '## 文件清单 / File manifest',
    '',
    `Generated from the project file tree${options.scannedAt ? ` (reconciled ${options.scannedAt})` : ''}. ` +
      'Do not edit by hand — this region is replaced on every delivery.',
    '',
    `${files.length} files, ${formatSize(totalBytes)}.`,
    '',
    '| Path | Type | Size | Modified (mtime) | Inode changed (ctime) |',
    '| --- | --- | --- | --- | --- |',
    ...(rows.length > 0 ? rows.map((row) => `| ${row} |`) : ['| _(empty)_ | — | — | — | — |']),
    '',
    FILE_MANIFEST_END,
  ].join('\n');
}

/**
 * Puts the section into a delivery document, replacing an earlier one if present.
 *
 * Appending when a section already exists would grow a duplicate per delivery, and each duplicate
 * would disagree with the others — a delivered document that contradicts itself is worse than one
 * that omits the manifest entirely.
 */
export function upsertFileManifest(document: string, section: string): string {
  const begin = document.indexOf(FILE_MANIFEST_BEGIN);
  const end = document.indexOf(FILE_MANIFEST_END);
  if (begin >= 0 && end > begin) {
    const before = document.slice(0, begin);
    const after = document.slice(end + FILE_MANIFEST_END.length);
    return `${before}${section}${after}`;
  }
  const body = document.replace(/\s*$/u, '');
  return body.length > 0 ? `${body}\n\n${section}\n` : `${section}\n`;
}
