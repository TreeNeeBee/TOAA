import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isAllowedWrite, type Tool } from './types.js';
import { resolveWorkspacePath } from './path_guard.js';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  resolveSkillOperationWindow,
} from '../llm/window.js';
import { suspiciousTextTruncationError } from './content_guard.js';

interface ReadFileData {
  content: string;
  offset: number;
  bytes: number;
  totalBytes: number;
  truncated: boolean;
  nextOffset?: number;
}

export const readFileTool: Tool<
  { path: string; offset?: number; maxBytes?: number },
  ReadFileData
> = {
  name: 'read_file',
  description:
    '分块读取 workspace 内的文本文件。必须提供非空 args.path；args.offset 是可选字节偏移，使用上次结果的 nextOffset 可继续读取后续内容。',
  argsSchema: { path: 'string', offset: 'number?', maxBytes: 'number?' },
  async run(args, ctx) {
    if (!args || typeof args.path !== 'string' || args.path.trim() === '') {
      return { ok: false, error: 'invalid read_file args: path must be a non-empty string' };
    }
    if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)) {
      return { ok: false, error: 'invalid read_file args: offset must be a non-negative integer' };
    }
    if (args.maxBytes !== undefined && (!Number.isInteger(args.maxBytes) || args.maxBytes <= 0)) {
      return { ok: false, error: 'invalid read_file args: maxBytes must be a positive integer' };
    }
    try {
      const resolved = await resolveWorkspacePath(ctx.ws, args.path, 'read_file', { mustExist: true });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const abs = resolved.abs;
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return { ok: false, error: 'not a file' };
      const offset = args.offset ?? 0;
      const operationLimit = ctx.readChunkBytes ??
        resolveSkillOperationWindow({ contextWindowTokens: ctx.contextWindowTokens }).readChunkBytes;
      const limit = Math.min(args.maxBytes ?? operationLimit, operationLimit);
      const requestedBytes = Math.max(0, Math.min(limit, stat.size - offset));
      const buffer = Buffer.alloc(requestedBytes);
      let bytesRead = 0;
      if (requestedBytes > 0) {
        const handle = await fs.open(abs, 'r');
        try {
          const result = await handle.read(buffer, 0, requestedBytes, offset);
          bytesRead = utf8SafeEnd(buffer.subarray(0, result.bytesRead));
        } finally {
          await handle.close();
        }
      }
      const nextOffset = offset + bytesRead;
      const truncated = nextOffset < stat.size;
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const content = truncated
        ? `${text}\n... [read window ended at byte ${nextOffset}/${stat.size}; continue with offset=${nextOffset}]`
        : text;
      return {
        ok: true,
        data: {
          content,
          offset,
          bytes: bytesRead,
          totalBytes: stat.size,
          truncated,
          nextOffset: truncated ? nextOffset : undefined,
        },
        summary:
          `read ${resolved.rel} bytes ${offset}-${nextOffset}/${stat.size}` +
          (truncated ? ` (continue offset=${nextOffset})` : ''),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};

export type WriteChunkBytes = number | 'auto';

export interface WriteChunkBudgetContext {
  phase?: string;
  role?: string;
  debug?: boolean;
  tools?: string[];
  outputs?: string[];
  allowedWrites?: string[];
  contextChars?: number;
  contextWindowTokens?: number;
}

/** Legacy public baseline; auto budgets are now derived from the active model context window. */
export const DEFAULT_WRITE_CHUNK_BYTES = 6000;

export function resolveWriteChunkBytes(
  configured: WriteChunkBytes | undefined,
  ctx: WriteChunkBudgetContext = {},
): number {
  return resolveSkillOperationWindow({
    contextWindowTokens: ctx.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    promptChars: ctx.contextChars,
    configuredWriteChunkBytes: configured,
  }).writeChunkBytes;
}

function utf8SafeEnd(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
  if (lead < 0) return 0;
  const first = buffer[lead]!;
  const expectedLength =
    (first & 0x80) === 0
      ? 1
      : (first & 0xe0) === 0xc0
        ? 2
        : (first & 0xf0) === 0xe0
          ? 3
          : (first & 0xf8) === 0xf0
            ? 4
            : 1;
  return buffer.length - lead < expectedLength ? lead : buffer.length;
}

interface WriteFileData {
  bytes: number;
  previousBytes: number;
  changed: boolean;
}

export const writeFileTool: Tool<{ path: string; content: string }, WriteFileData> = {
  name: 'write_file',
  description:
    '在当前 Step writable allowlist 内创建或覆盖文件。必须提供非空 args.path 和字符串 args.content；path 使用具体的 workspace 相对路径。' +
    '单次 content 受运行时 chunk limit 限制；大文件按模块/函数/类边界用 write_file 首段 + append_file 续写。' +
    '覆盖已有文件时必须提供完整内容；异常缩短会被拒绝，此时应优先用 replace_in_file/apply_patch 精确修改。' +
    '注意：runtime 管理的依赖清单请用 add_dependency 维护。',
  argsSchema: { path: 'string', content: 'string' },
  async run(args, ctx) {
    const argError = validateTextFileArgs('write_file', args);
    if (argError) return { ok: false, error: argError };
    const resolved = await resolveWorkspacePath(ctx.ws, args.path, 'write_file', {
      forWrite: true,
      relativePathHints: ctx.allowedWrites,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (resolved.rel === 'requirements.txt' || resolved.rel.endsWith('/requirements.txt')) {
      return {
        ok: false,
        error:
          'write denied: requirements.txt 由 plan.dependencies 在 xcompiler run 启动时种入并由 add_dependency 工具维护；请改用 add_dependency 工具新增依赖（一行一包，不要再 write_file 直接覆盖）。',
      };
    }
    if (!isAllowedWrite(resolved.rel, ctx.allowedWrites)) {
      return { ok: false, error: `write denied: ${resolved.rel} not in step writable allowlist` };
    }
    const size = Buffer.byteLength(args.content);
    const limit = resolveWriteChunkBytes(ctx.writeChunkBytes);
    if (size > limit) {
      return {
        ok: false,
        error:
          `write_file 单次内容 ${size}B 超过本 Step chunk limit ${limit}B。请将大文件拆分写入：` +
          `第 1 个 action 用 write_file 写头部（≤${limit}B，覆盖现有文件），` +
          `后续 action 用 append_file 按模块/函数/类边界逐段追加（每段 ≤${limit}B）。同一轮可放多个 actions。`,
      };
    }
    try {
      const abs = resolved.abs;
      let previous: Buffer | undefined;
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile()) {
          return { ok: false, error: `write denied: ${resolved.rel} is not a regular file` };
        }
        previous = await fs.readFile(abs);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw err;
      }

      const next = Buffer.from(args.content, 'utf8');
      const previousBytes = previous?.byteLength ?? 0;
      const truncationError = previous
        ? suspiciousTextTruncationError({
            tool: 'write_file',
            path: resolved.rel,
            originalBytes: previousBytes,
            replacementBytes: size,
          })
        : undefined;
      if (truncationError) {
        return {
          ok: false,
          error: truncationError,
        };
      }

      if (previous?.equals(next)) {
        return {
          ok: true,
          data: { bytes: size, previousBytes, changed: false },
          summary: `unchanged ${resolved.rel} (${size}B; content identical)`,
        };
      }

      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, next);
      return {
        ok: true,
        data: { bytes: size, previousBytes, changed: true },
        summary: `wrote ${resolved.rel} (${size}B, was ${previousBytes}B)`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};

/**
 * append_file：把一段内容追加到当前 Step writable allowlist 内的文件末尾。
 * - 单次同样受运行时 chunk limit 限制，鼓励按逻辑段（一个函数 / 一个类）切分。
 * - 文件不存在时自动创建（等价于 write_file 写第一段，便于鲁棒续写）。
 * - 注意：append_file 不会自动添加换行；若调用者忘了在 content 末尾收尾换行，下一段会拼接在同一行。
 */
export const appendFileTool: Tool<{ path: string; content: string }, { bytes: number; total: number }> = {
  name: 'append_file',
  description:
    '把一段内容追加到当前 Step writable allowlist 内文件末尾。必须提供非空 args.path 和字符串 args.content；path 使用具体的 workspace 相对路径。' +
    '单次 content 受运行时 chunk limit 限制，用于配合 write_file 分块写出大文件。',
  argsSchema: { path: 'string', content: 'string' },
  async run(args, ctx) {
    const argError = validateTextFileArgs('append_file', args);
    if (argError) return { ok: false, error: argError };
    const resolved = await resolveWorkspacePath(ctx.ws, args.path, 'append_file', {
      forWrite: true,
      relativePathHints: ctx.allowedWrites,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (resolved.rel === 'requirements.txt' || resolved.rel.endsWith('/requirements.txt')) {
      return { ok: false, error: 'append denied: requirements.txt 由 add_dependency 维护。' };
    }
    if (!isAllowedWrite(resolved.rel, ctx.allowedWrites)) {
      return { ok: false, error: `append denied: ${resolved.rel} not in step writable allowlist` };
    }
    const size = Buffer.byteLength(args.content);
    const limit = resolveWriteChunkBytes(ctx.writeChunkBytes);
    if (size > limit) {
      return {
        ok: false,
        error: `append_file 单次内容 ${size}B 超过本 Step chunk limit ${limit}B；请按模块/函数/类边界进一步拆分。`,
      };
    }
    try {
      const abs = resolved.abs;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.appendFile(abs, args.content, 'utf8');
      let total = size;
      try {
        total = (await fs.stat(abs)).size;
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        data: { bytes: size, total },
        summary: `appended ${size}B to ${resolved.rel} (now ${total}B)`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};

function validateTextFileArgs(tool: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return `invalid ${tool} args: expected object`;
  const candidate = args as { path?: unknown; content?: unknown };
  if (typeof candidate.path !== 'string' || candidate.path.trim() === '') {
    return `invalid ${tool} args: path must be a non-empty string`;
  }
  if (typeof candidate.content !== 'string') {
    return `invalid ${tool} args: content must be a string`;
  }
  return undefined;
}

export const listDirTool: Tool<{ path?: string }, { entries: string[] }> = {
  name: 'list_dir',
  description: '列出指定目录下的条目（仅文件名）。args.path 可选；提供时必须是具体的 workspace 相对目录路径。',
  argsSchema: { path: 'string?' },
  async run(args, ctx) {
    try {
      const resolved = await resolveWorkspacePath(ctx.ws, args.path ?? '.', 'list_dir', { mustExist: true });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const abs = resolved.abs;
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return {
        ok: true,
        data: { entries: entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)) },
        summary: `list ${resolved.rel}: ${entries.length} entries`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
