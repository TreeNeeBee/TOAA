import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isAllowedWrite, type Tool } from './types.js';
import { resolveWorkspacePath } from './path_guard.js';

/**
 * 极简的 unified-diff patcher。仅支持：
 *   - 单文件 patch 中的多个 hunk
 *   - 文件头形如 `--- a/path` `+++ b/path`，或 `--- path` `+++ path`
 *   - 行级 +/-/" "（空格上下文）
 *   - 不支持二进制 / 重命名 / 模式变更
 *
 * 设计目标：覆盖 LLM 在 CODE 阶段和 DEBUG 模式最常产生的差异格式；不追求完整 git apply 语法。
 */
export const applyPatchTool: Tool<{ patch: string }, { changedFiles: string[] }> = {
  name: 'apply_patch',
  description:
    '应用 unified diff 补丁；每个 +++ 文件头必须包含具体的 workspace 相对目标路径，且目标必须在当前 Step writable allowlist 内。',
  argsSchema: { patch: 'string' },
  async run(args, ctx) {
    const fileDiffs = parseUnifiedDiff(args.patch);
    if (fileDiffs.length === 0) return { ok: false, error: 'no file diff parsed' };
    const changed: string[] = [];
    for (const fd of fileDiffs) {
      const resolved = await resolveWorkspacePath(ctx.ws, fd.target, 'apply_patch', {
        forWrite: true,
        relativePathHints: ctx.allowedWrites,
      });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      if (!isAllowedWrite(resolved.rel, ctx.allowedWrites)) {
        return { ok: false, error: `write denied: ${resolved.rel} not in step writable allowlist` };
      }
      const abs = resolved.abs;
      let original = '';
      try {
        original = await fs.readFile(abs, 'utf8');
      } catch {
        if (!fd.isNewFile) return { ok: false, error: `target file missing: ${resolved.rel}` };
      }
      const next = applyHunks(original, fd.hunks);
      if (next.error) return { ok: false, error: `${resolved.rel}: ${next.error}` };
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, next.content, 'utf8');
      changed.push(resolved.rel);
    }
    return { ok: true, data: { changedFiles: changed }, summary: `patched ${changed.join(', ')}` };
  },
};

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // 包含行首的 ' ' / '+' / '-' 字符
}
interface FileDiff {
  source: string;
  target: string;
  isNewFile: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  if (p === '/dev/null') return '/dev/null';
  return p.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(patch: string): FileDiff[] {
  const lines = patch.split(/\r?\n/);
  const out: FileDiff[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('--- ')) {
      const src = stripPrefix(line.slice(4).trim().split('\t')[0] ?? '');
      const nextRaw = lines[i + 1] ?? '';
      if (!nextRaw.startsWith('+++ ')) {
        i++;
        continue;
      }
      const tgt = stripPrefix(nextRaw.slice(4).trim().split('\t')[0] ?? '');
      const isNew = src === '/dev/null';
      const target = tgt === '/dev/null' ? src : tgt;
      i += 2;
      const hunks: Hunk[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('@@')) {
        const header = lines[i] ?? '';
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
        if (!m) return out; // 解析失败，放弃
        const oldStart = Number(m[1] ?? '0');
        const oldLines = m[2] ? Number(m[2]) : 1;
        const newStart = Number(m[3] ?? '0');
        const newLines = m[4] ? Number(m[4]) : 1;
        i++;
        const body: string[] = [];
        while (i < lines.length) {
          const l = lines[i] ?? '';
          if (l.startsWith('@@') || l.startsWith('--- ')) break;
          if (l.startsWith('+') || l.startsWith('-') || l.startsWith(' ')) {
            body.push(l);
            i++;
          } else if (l === '') {
            // 允许 patch 末尾空行：仅在没有更多内容时退出
            if (i === lines.length - 1) {
              i++;
              break;
            }
            // 否则把它当作上下文中的空行
            body.push(' ');
            i++;
          } else if (l.startsWith('\\ No newline at end of file')) {
            i++;
          } else {
            break;
          }
        }
        hunks.push({ oldStart, oldLines, newStart, newLines, lines: body });
      }
      out.push({ source: src, target, isNewFile: isNew, hunks });
    } else {
      i++;
    }
  }
  return out;
}

function applyHunks(original: string, hunks: Hunk[]): { content: string; error?: string } {
  const src = original.length === 0 ? [] : original.split('\n');
  // 处理末尾换行：按 split 行末若文件以 \n 结尾，会有一个空字符串
  const trailingNL = original.endsWith('\n');
  const body = trailingNL ? src.slice(0, -1) : src;

  const out: string[] = [];
  let cursor = 0; // 0-based index into body
  for (const h of hunks) {
    const hunkStart = h.oldStart === 0 ? 0 : h.oldStart - 1;
    if (hunkStart < cursor) {
      return { content: '', error: `hunk overlap at line ${h.oldStart}` };
    }
    // 复制中间未变化的行
    out.push(...body.slice(cursor, hunkStart));
    cursor = hunkStart;
    for (const ln of h.lines) {
      const tag = ln[0];
      const text = ln.slice(1);
      if (tag === ' ') {
        if (body[cursor] !== text) {
          return {
            content: '',
            error: `context mismatch at old line ${cursor + 1}: expected ${JSON.stringify(text)}, got ${JSON.stringify(body[cursor])}`,
          };
        }
        out.push(text);
        cursor++;
      } else if (tag === '-') {
        if (body[cursor] !== text) {
          return {
            content: '',
            error: `delete mismatch at old line ${cursor + 1}: expected ${JSON.stringify(text)}, got ${JSON.stringify(body[cursor])}`,
          };
        }
        cursor++;
      } else if (tag === '+') {
        out.push(text);
      }
    }
  }
  out.push(...body.slice(cursor));
  return { content: out.join('\n') + (trailingNL || out.length > 0 ? '\n' : '') };
}
