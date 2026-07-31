import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isAllowedWrite, type Tool } from './types.js';
import { resolveWorkspacePath } from './path_guard.js';
import { suspiciousTextTruncationError } from './content_guard.js';

/**
 * 字符串替换工具：在已有文件内查找 `find` 并替换为 `replace`。
 * - 默认要求精确出现 1 次；可通过 `expectedCount` 改为指定次数。
 * - 与 apply_patch 互补：对小修改更稳，不依赖上下文行号。
 */
export const replaceInFileTool: Tool<
  { path: string; find: string; replace: string; expectedCount?: number },
  { occurrences: number }
> = {
  name: 'replace_in_file',
  description:
    '把当前 Step writable allowlist 内目标文件的 find 字符串精确替换为 replace（默认要求出现 1 次）。' +
    '必须提供 args.path（具体的 workspace 相对文件路径，取自 writable allowlist）、args.find、args.replace 三个字符串参数；缺少 path 会被拒绝。',
  argsSchema: { path: 'string', find: 'string', replace: 'string', expectedCount: 'number?' },
  async run(args, ctx) {
    if (!args || typeof args.path !== 'string' || args.path.trim() === '') {
      return { ok: false, error: 'invalid replace_in_file args: path must be a non-empty string' };
    }
    if (typeof args.find !== 'string' || typeof args.replace !== 'string') {
      return { ok: false, error: 'invalid replace_in_file args: find and replace must be strings' };
    }
    const resolved = await resolveWorkspacePath(ctx.ws, args.path, 'replace_in_file', {
      forWrite: true,
      relativePathHints: ctx.allowedWrites,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (!isAllowedWrite(resolved.rel, ctx.allowedWrites)) {
      return { ok: false, error: `write denied: ${resolved.rel}` };
    }
    if (!args.find) return { ok: false, error: 'find must be non-empty' };
    if (args.find === args.replace) {
      return {
        ok: false,
        error:
          'no-op edit refused: find === replace（替换前后字符串完全相同）。请确认你真正要修改的差异；如只想读取文件请改用 read_file，如要整文件重写请用 write_file。',
      };
    }
    if (args.replace.length === 0 && !args.find.includes('\n')) {
      return {
        ok: false,
        error:
          'replace_in_file refused an empty replacement for a single-line fragment. ' +
          'This commonly indicates a truncated model response and can corrupt a declaration. ' +
          'Use one atomic replacement containing the complete intended code, or apply_patch with surrounding context.',
      };
    }
    const abs = resolved.abs;
    let original: string;
    try {
      original = await fs.readFile(abs, 'utf8');
    } catch {
      return { ok: false, error: `file not found: ${resolved.rel}` };
    }
    const expected = args.expectedCount ?? 1;
    const parts = original.split(args.find);
    const occurrences = parts.length - 1;
    if (occurrences !== expected) {
      // 帮 LLM 下一轮修正：返回一个提示块。含（1）文件总长度，
      // （2）按 find 的首行在原文中模糊定位的周边上下文（3 行）。
      // 这样模型下一轮能看到「文件中实际是什么样」，避免反复提交同样的错误 find。
      const firstFindLine = (args.find.split('\n')[0] ?? '').trim();
      const hint: string[] = [];
      hint.push(`expected ${expected} occurrences of find, found ${occurrences} in ${resolved.rel} (file size=${Buffer.byteLength(original)}B)`);
      if (firstFindLine.length >= 4) {
        // 掏出含 firstFindLine 前 8个词符的行作为「似是该区域」
        const probe = firstFindLine.slice(0, Math.min(20, firstFindLine.length));
        const lines = original.split('\n');
        const matches = lines
          .map((l, i) => ({ i, l }))
          .filter((x) => x.l.includes(probe))
          .slice(0, 3);
        if (matches.length > 0) {
          hint.push('提示：以下是原文中似是你要改的区域（请以下面的字节为准重新起 find）：');
          for (const m of matches) {
            const start = Math.max(0, m.i - 1);
            const end = Math.min(lines.length, m.i + 2);
            for (let k = start; k < end; k++) {
              hint.push(`  ${k + 1}: ${JSON.stringify(lines[k])}`);
            }
            hint.push('  ---');
          }
        } else {
          hint.push('提示：未在原文中找到 find 的首行片段。考虑改用 read_file 读出原文，再用 apply_patch 精确修改；若要整文件重写，必须低于当前运行时 chunk limit。');
        }
      }
      return { ok: false, error: hint.join('\n') };
    }
    const next = parts.join(args.replace);
    const truncationError = suspiciousTextTruncationError({
      tool: 'replace_in_file',
      path: resolved.rel,
      originalBytes: Buffer.byteLength(original),
      replacementBytes: Buffer.byteLength(next),
    });
    if (truncationError) return { ok: false, error: truncationError };
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, next, 'utf8');
    return {
      ok: true,
      data: { occurrences },
      summary: `replaced ${occurrences}× in ${resolved.rel}`,
    };
  },
};

/**
 * 简易代码搜索：在指定子目录内做大小写敏感的子串匹配（行级）。
 * 返回最多 N 条匹配，每条含 path / line / text。
 */
export const codeSearchTool: Tool<
  { query: string; root?: string; maxResults?: number; ext?: string[] },
  { matches: Array<{ path: string; line: number; text: string }> }
> = {
  name: 'code_search',
  description:
    '在 workspace 内按子串搜索代码（行级匹配）。args.root 可选；提供时必须是具体的 workspace 相对目录路径。',
  argsSchema: { query: 'string', root: 'string?', maxResults: 'number?', ext: 'string[]?' },
  async run(args, ctx) {
    if (!args.query) return { ok: false, error: 'query empty' };
    const resolved = await resolveWorkspacePath(ctx.ws, args.root ?? '.', 'code_search', { mustExist: true });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const root = resolved.abs;
    const workspaceRoot = await fs.realpath(ctx.ws.root).catch(() => ctx.ws.root);
    const max = args.maxResults ?? 50;
    const exts = args.ext && args.ext.length > 0 ? new Set(args.ext.map((e) => (e.startsWith('.') ? e : '.' + e))) : null;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    await walk(root, async (abs) => {
      if (exts && !exts.has(path.extname(abs))) return;
      // 跳过常见非源码目录
      if (/(?:^|\/)(node_modules|\.git|\.sandbox|\.xcompiler|dist|__pycache__)\//.test(abs)) return;
      let content: string;
      try {
        const stat = await fs.stat(abs);
        if (stat.size > 512_000) return;
        content = await fs.readFile(abs, 'utf8');
      } catch {
        return;
      }
      const rel = path.relative(workspaceRoot, abs);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if ((lines[i] ?? '').includes(args.query)) {
          matches.push({ path: rel, line: i + 1, text: (lines[i] ?? '').slice(0, 240) });
          if (matches.length >= max) return;
        }
      }
    });
    return {
      ok: true,
      data: { matches },
      summary: `code_search "${args.query}" → ${matches.length} hits`,
    };
  },
};

async function walk(dir: string, onFile: (abs: string) => Promise<void>): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, onFile);
    else if (e.isFile()) await onFile(abs);
  }
}

/**
 * analyze_error：把一段 stderr/stdout 文本解析成结构化要点，便于 LLM 修复。
 * 仅做正则启发式：抓 Python traceback 最末一帧、pytest FAILED 行、ImportError/ModuleNotFoundError。
 */
export const analyzeErrorTool: Tool<
  { text: string },
  {
    kind: string;
    summary: string;
    file?: string;
    line?: number;
    missingModule?: string;
    failedTests: string[];
  }
> = {
  name: 'analyze_error',
  description: '解析 Python 错误/测试输出，给出结构化摘要。',
  argsSchema: { text: 'string' },
  async run(args) {
    const t = args.text ?? '';
    const out: {
      kind: string;
      summary: string;
      file?: string;
      line?: number;
      missingModule?: string;
      failedTests: string[];
    } = { kind: 'unknown', summary: '', failedTests: [] };

    const mn = /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/.exec(t);
    if (mn) {
      out.kind = 'ModuleNotFoundError';
      out.missingModule = mn[1];
      out.summary = `缺失模块 ${mn[1]}，需要 pip 安装并写回 requirements.txt`;
    }

    const ie = /ImportError: ([^\n]+)/.exec(t);
    if (!mn && ie) {
      out.kind = 'ImportError';
      out.summary = ie[1] ?? '';
    }

    // 抓最末一帧 File "...", line N
    const frames = [...t.matchAll(/File "([^"]+)", line (\d+)/g)];
    const last = frames[frames.length - 1];
    if (last) {
      out.file = last[1];
      out.line = Number(last[2]);
    }

    // pytest FAILED 行
    const failed = [...t.matchAll(/^FAILED\s+([^\s]+)/gm)].map((m) => m[1] ?? '');
    out.failedTests = failed.filter((s): s is string => !!s);
    if (out.failedTests.length > 0 && out.kind === 'unknown') {
      out.kind = 'TestFailure';
      out.summary = `${out.failedTests.length} 个测试失败`;
    }

    // 普通异常摘要（最后一行非空）
    if (out.kind === 'unknown') {
      const lastLine = t
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .at(-1);
      if (lastLine) {
        out.kind = lastLine.split(':')[0] ?? 'Error';
        out.summary = lastLine;
      } else {
        out.summary = '(no output)';
      }
    }
    return { ok: true, data: out, summary: `${out.kind}: ${out.summary}` };
  },
};
