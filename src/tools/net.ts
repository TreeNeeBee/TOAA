import type { Tool, ToolResult } from './types.js';
import { writeWorkspaceFile } from './workspace_write.js';
import { t } from '../i18n/index.js';
import { resolveWorkspacePath } from './path_guard.js';

/**
 * Network access tools.
 *
 * `http_fetch` is performed from the **XCompiler host** (Node side), so it works
 * regardless of the sandbox's network policy — useful when:
 *   - the LLM needs to look up a web page / JSON API while planning or coding;
 *   - python tests inside a `network=off` sandbox still need a small piece of
 *     external data (the LLM fetches it once and writes it as a fixture).
 *
 * For generated code that itself needs to talk to the network, configure
 * `agent.sandboxes.<language>.<local|docker>.limits.network` in `config.yaml`:
 *   - `download-only` (default) — outbound HTTP/HTTPS allowed, no inbound.
 *   - `full` + `expose_ports: [8000]` — also publish container ports to
 *     127.0.0.1 on the host so host-side tests can reach the running app.
 */

interface HttpFetchArgs {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Total wall-clock timeout in ms. Default 15s. */
  timeoutMs?: number;
  /** Maximum body bytes to read. Default 256 KiB. */
  maxBytes?: number;
  /** Save the response body to this workspace-relative path instead of returning it. */
  saveAs?: string;
}

interface HttpFetchData {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  contentType: string;
  bodyText?: string;
  truncated?: boolean;
  totalBytes?: number;
  savedTo?: string;
  /** Persisted only inside record/replay entries so replay can restore saveAs. */
  _recordedBodyBase64?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

export const httpFetchTool: Tool<HttpFetchArgs, HttpFetchData> = {
  name: 'http_fetch',
  description:
    'Fetch a URL from the XCompiler host (HTTP/HTTPS only). Returns status, headers and body text. ' +
    'Use this to look up web pages, REST/JSON APIs, or to download a small fixture. ' +
    'For binary or larger downloads, pass `saveAs: "<rel-path>"` to stream the body to a workspace file ' +
    '(must be inside the current step\'s allowedWrites).',
  argsSchema: {
    url: 'string (http:// or https://)',
    method: 'string? (GET|POST|PUT|DELETE|HEAD, default GET)',
    headers: 'Record<string,string>?',
    body: 'string?',
    timeoutMs: 'number?',
    maxBytes: 'number?',
    saveAs: 'string? (workspace-relative path)',
  },
  async run(args, ctx) {
    if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) {
      return { ok: false, error: 'http_fetch: url must start with http:// or https://' };
    }
    const method = (args.method ?? 'GET').toUpperCase();
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;

    // Enforce allowedWrites for saveAs (same guard as fs tools).
    let saveAsAbs: string | undefined;
    if (args.saveAs) {
      const resolved = await resolveWorkspacePath(ctx.ws, args.saveAs, 'http_fetch.saveAs', {
        forWrite: true,
        relativePathHints: ctx.allowedWrites,
      });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      saveAsAbs = resolved.abs;
      const { isAllowedWrite } = await import('./types.js');
      if (!isAllowedWrite(resolved.rel, ctx.allowedWrites)) {
        return {
          ok: false,
          error: `http_fetch: saveAs "${resolved.rel}" is not in allowedWrites=[${ctx.allowedWrites.join(', ')}]`,
        };
      }
    }

    const executeLive = async (): Promise<ToolResult<HttpFetchData>> => {
      const controller = new AbortController();
      const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const res = await fetch(args.url, {
          method,
          headers: args.headers,
          body: args.body,
          signal: controller.signal,
          redirect: 'follow',
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const contentType = headers['content-type'] ?? '';

        if (args.saveAs) {
          const buf = Buffer.from(await res.arrayBuffer());
          const trimmed = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
          await ctx.audit?.event('tool.call', t().audit.httpFetchSaved(method, args.url, args.saveAs, trimmed.length), {
            messageId: 'audit.http_fetch_saved',
            stepId: ctx.stepId,
            status: res.status,
          });
          return {
            ok: res.ok,
            data: {
              status: res.status,
              ok: res.ok,
              url: res.url,
              headers,
              contentType,
              savedTo: args.saveAs,
              truncated: buf.length > maxBytes,
              totalBytes: buf.length,
              _recordedBodyBase64: trimmed.toString('base64'),
            },
            summary: `http_fetch ${method} ${args.url} → ${res.status} (saved ${trimmed.length}B to ${args.saveAs})`,
          };
        }

        const arr = new Uint8Array(await res.arrayBuffer());
        const truncated = arr.length > maxBytes;
        const slice = truncated ? arr.subarray(0, maxBytes) : arr;
        let bodyText: string;
        try {
          bodyText = new TextDecoder('utf-8', { fatal: false }).decode(slice);
        } catch {
          bodyText = `[binary response, ${arr.length} bytes; use saveAs to download]`;
        }
        await ctx.audit?.event('tool.call', t().audit.httpFetchResponse(method, args.url, res.status, arr.length), {
          messageId: 'audit.http_fetch_response',
          stepId: ctx.stepId,
          status: res.status,
          truncated,
        });
        return {
          ok: res.ok,
          data: {
            status: res.status,
            ok: res.ok,
            url: res.url,
            headers,
            contentType,
            bodyText,
            truncated,
            totalBytes: arr.length,
          },
          summary: `http_fetch ${method} ${args.url} → ${res.status} (${arr.length}B${truncated ? `, truncated to ${maxBytes}B` : ''})`,
        };
      } catch (err) {
        const msg = (err as Error).message || String(err);
        return { ok: false, error: `http_fetch: request failed: ${msg}` };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const result = ctx.recordReplay?.enabled('http')
      ? await ctx.recordReplay.execute({
          channel: 'http',
          operation: 'fetch',
          request: {
            url: args.url,
            method,
            headers: args.headers,
            body: args.body,
            timeoutMs,
            maxBytes,
            saveAs: args.saveAs,
          },
        }, executeLive)
      : await executeLive();

    if (args.saveAs && saveAsAbs && result.data?._recordedBodyBase64) {
      const body = Buffer.from(result.data._recordedBodyBase64, 'base64');
      await writeWorkspaceFile(saveAsAbs, body, { tree: ctx.fileTree, root: ctx.ws.root });
      delete result.data._recordedBodyBase64;
    }
    return result;
  },
};
