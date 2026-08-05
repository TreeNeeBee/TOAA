import type { ChatMessage, ChatOptions, LLMClient } from './types.js';
import { Agent } from 'undici';
import { detectCyclicTokenLoop, detectRepeatedTextLoop, RepeatTokenDetector } from './stream_watchdog.js';
import {
  LLMRequestError,
  isLLMRequestError,
  llmFailureCodeForStatus,
} from './errors.js';

export const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_OPENAI_CONNECT_TIMEOUT_MS = 60 * 1000;
export const DEFAULT_OPENAI_STREAM_FIRST_TOKEN_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_OPENAI_STREAM_IDLE_TIMEOUT_MS = 60 * 1000;

export interface OpenAIConfig {
  providerName?: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Structured JSON response format for OpenAI-compatible providers. */
  jsonResponseFormat?: 'json_object' | 'json_schema' | 'none';
  /** 非流式请求总超时；流式请求仅在首个内容 token 前生效。0 表示无超时。 */
  requestTimeoutMs?: number;
  /** DNS/TCP/TLS 建连超时；默认 60 秒，0 关闭。 */
  connectTimeoutMs?: number;
  /** 已收到内容后，连续多久没有新 token 即视为卡死并中断；默认 60 秒，0 关闭。 */
  streamIdleTimeoutMs?: number;
  /** 流式模式等待首个内容 token 的超时；默认 5 分钟，0 关闭。 */
  streamFirstTokenTimeoutMs?: number;
  /** 流式异常保护阈值；真实有效输出不会因长度本身被截断，loop/无效输出由 watchdog 中断。 */
  maxOutputChars?: number;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
  done?: boolean;
}

export class OpenAIClient implements LLMClient {
  readonly name: string;
  private readonly dispatcher: Agent;

  constructor(private readonly cfg: OpenAIConfig) {
    this.name = `openai:${cfg.model}`;
    this.dispatcher = new Agent({
      connect: { timeout: cfg.connectTimeoutMs ?? DEFAULT_OPENAI_CONNECT_TIMEOUT_MS },
    });
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.maxTokens,
      stream: !!options?.onToken,
    };
    if (options?.responseFormat === 'json') {
      const responseFormat = buildJsonResponseFormat(this.cfg.jsonResponseFormat ?? 'json_object');
      if (responseFormat) body.response_format = responseFormat;
    }
    if (options?.onToken) return this.streamChat(url, body, options);
    const ctrl = new AbortController();
    const unbindAbort = bindAbortSignal(options?.signal, (reason) => ctrl.abort(reason));
    const timeoutMs = this.cfg.requestTimeoutMs ?? DEFAULT_OPENAI_REQUEST_TIMEOUT_MS;
    const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs) : null;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
        dispatcher: this.dispatcher,
      } as RequestInit & { dispatcher: Agent });
      if (!res.ok) {
        const text = await res.text();
        throw buildHttpError(this.cfg, res.status, res.statusText, text);
      }
      const json = (await res.json()) as OpenAIChatResponse;
      if (json.error) throw new Error(`OpenAI error: ${json.error.message}`);
      return json.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      throw wrapOpenAIError(this.cfg, err, 'non-stream');
    } finally {
      if (timer) clearTimeout(timer);
      unbindAbort();
    }
  }

  private async streamChat(url: string, body: Record<string, unknown>, options: ChatOptions): Promise<string> {
    const ctrl = new AbortController();
    const timeoutMs = this.cfg.requestTimeoutMs ?? DEFAULT_OPENAI_REQUEST_TIMEOUT_MS;
    const idleTimeoutMs = this.cfg.streamIdleTimeoutMs ?? DEFAULT_OPENAI_STREAM_IDLE_TIMEOUT_MS;
    const firstTokenTimeoutMs =
      this.cfg.streamFirstTokenTimeoutMs ?? DEFAULT_OPENAI_STREAM_FIRST_TOKEN_TIMEOUT_MS;
    const maxOutputChars = this.cfg.maxOutputChars ?? 200_000;

    // 把 watchdog 触发的中断原因记下来，因为底层 reader 在 abort 时
    // 抛出的是泛型 AbortError，会丢失我们的人类可读信息。
    let abortReason: Error | null = null;
    const abort = (err: Error) => {
      if (!abortReason) abortReason = err;
      ctrl.abort(err);
    };
    const unbindAbort = bindAbortSignal(options.signal, (reason) => abort(abortError(reason)));

    let wallTimer =
      timeoutMs > 0
        ? setTimeout(
            () => abort(new Error(`OpenAI stream wall-clock ${timeoutMs}ms exceeded; aborting`)),
            timeoutMs,
          )
        : null;
    let idleTimer: NodeJS.Timeout | null = null;
    let streamedContentChars = 0;
    const armIdle = () => {
      const activeTimeoutMs = streamedContentChars === 0 ? firstTokenTimeoutMs : idleTimeoutMs;
      if (idleTimer) clearTimeout(idleTimer);
      if (activeTimeoutMs <= 0) {
        idleTimer = null;
        return;
      }
      idleTimer = setTimeout(
        () => abort(new Error(
          streamedContentChars === 0
            ? `OpenAI stream idle before first token for ${activeTimeoutMs}ms; aborting`
            : `OpenAI stream idle for ${activeTimeoutMs}ms; aborting`,
        )),
        activeTimeoutMs,
      );
    };
    const cleanup = () => {
      if (wallTimer) clearTimeout(wallTimer);
      wallTimer = null;
      if (idleTimer) clearTimeout(idleTimer);
      unbindAbort();
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    try {
      armIdle();
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
        dispatcher: this.dispatcher,
      } as RequestInit & { dispatcher: Agent });
      if (!res.ok) {
        const text = await res.text();
        throw buildHttpError(this.cfg, res.status, res.statusText, text);
      }
      if (!res.body) throw new Error('OpenAI stream response has no body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let aggregate = '';
      let done = false;
      let cancelled = false;
      const repeatDetector = new RepeatTokenDetector();
      const expectsJsonObject = options.responseFormat === 'json';
      const cancelReader = () => {
        if (cancelled) return;
        cancelled = true;
        ctrl.abort();
        void reader.cancel().catch(() => {});
      };
      const shouldStopByContent = () => {
        try {
          if (options.streamStopWhen?.(aggregate)) return true;
        } catch {
          /* ignore stop predicate errors during partial streams */
        }
        if (!options.validate) return false;
        try {
          options.validate(aggregate);
          return true;
        } catch {
          return false;
        }
      };
      const onData = (data: string) => {
        if (data === '[DONE]') {
          done = true;
          return;
        }
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(data) as OpenAIStreamChunk;
        } catch {
          return;
        }
        if (chunk.error) throw new Error(`OpenAI error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
        if (chunk.done === true) {
          done = true;
        }
        let terminalChoice = false;
        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason && choice.finish_reason !== 'tool_calls') {
            terminalChoice = true;
          }
          const piece = choice.delta?.content ?? choice.message?.content ?? '';
          if (!piece) continue;
          if (streamedContentChars === 0 && wallTimer) {
            clearTimeout(wallTimer);
            wallTimer = null;
          }
          aggregate += piece;
          streamedContentChars += piece.length;
          armIdle();
          options.onToken?.(piece);
          if (expectsJsonObject && hasDegenerateJsonPrefix(aggregate)) {
            throw new Error('detected degenerate non-JSON prefix in OpenAI stream; aborting');
          }
          if (repeatDetector.feed(piece)) {
            throw new Error('detected token loop in OpenAI stream (repeated identical token); aborting');
          }
          if (detectCyclicTokenLoop(aggregate)) {
            throw new Error('detected cyclic token loop in OpenAI stream (periodic tail); aborting');
          }
          if (detectRepeatedTextLoop(aggregate)) {
            throw new Error('detected repeated text loop in OpenAI stream (semantic tail repetition); aborting');
          }
          if (maxOutputChars > 0 && expectsJsonObject && aggregate.length > maxOutputChars && hasInvalidJsonPrefix(aggregate)) {
            throw new Error(`OpenAI stream exceeded ${maxOutputChars} chars without a valid JSON prefix; aborting`);
          }
          if (shouldStopByContent()) {
            done = true;
            return;
          }
        }
        if (terminalChoice || shouldStopByContent()) done = true;
      };

      try {
        while (!done) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) break;
          buf += decoder.decode(value, { stream: true });
          let sep = findSseSeparator(buf);
          while (sep) {
            const event = buf.slice(0, sep.index);
            buf = buf.slice(sep.index + sep.length);
            for (const line of event.split(/\r?\n/)) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              onData(trimmed.slice(5).trim());
              if (done) break;
            }
            if (done) break;
            sep = findSseSeparator(buf);
          }
        }
        if (done && !cancelled) {
          cancelReader();
        } else {
          buf += decoder.decode();
          for (const line of buf.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            onData(trimmed.slice(5).trim());
          }
        }
      } catch (err) {
        // 确保连接被释放；优先抛出 watchdog 的可读原因。
        ctrl.abort();
        throw abortReason ?? (err as Error);
      }
      return aggregate;
    } catch (err) {
      throw wrapOpenAIError(this.cfg, err, 'stream');
    } finally {
      cleanup();
    }
  }
}

interface OpenAIHttpFailure {
  __openAIHttpFailure: true;
  status: number;
  statusText: string;
  body: string;
}

function buildHttpError(
  cfg: OpenAIConfig,
  status: number,
  statusText: string,
  body: string,
): Error & OpenAIHttpFailure {
  const err = new Error(`OpenAI HTTP ${status}: ${sanitizeErrorText(body)}`) as Error & OpenAIHttpFailure;
  err.__openAIHttpFailure = true;
  err.status = status;
  err.statusText = statusText;
  err.body = body;
  return err;
}

function wrapOpenAIError(cfg: OpenAIConfig, err: unknown, mode: 'stream' | 'non-stream'): Error {
  if (isWrappedOpenAIError(err)) return err;
  const cause = err instanceof Error ? err : new Error(String(err));
  const provider = cfg.providerName ?? 'unnamed';
  const baseUrl = cfg.baseUrl.replace(/\/$/, '');
  const parts = [
    `OpenAI-compatible provider request failed`,
    `provider=${provider}`,
    `model=${cfg.model}`,
    `base_url=${baseUrl}`,
    `mode=${mode}`,
  ];
  if (isHttpFailure(cause)) {
    parts.push(`status=${cause.status}${cause.statusText ? ` ${cause.statusText}` : ''}`);
  }
  const detail = errorDetail(cause);
  const hint = hintForOpenAIError(cfg, cause);
  const statusCode = isHttpFailure(cause) ? cause.status : undefined;
  const code = statusCode
    ? llmFailureCodeForStatus(statusCode)
    : /timed out|idle|wall-clock/iu.test(cause.message)
      ? 'request_timeout'
      : /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND/iu.test(cause.message)
        ? 'connection_failed'
        : 'request_failed';
  return new LLMRequestError(`${parts.join(' ')}: ${detail}. ${hint}`, {
    code,
    provider,
    model: cfg.model,
    endpoint: baseUrl,
    mode,
    statusCode,
    retryable: code === 'request_timeout' || code === 'connection_failed' || code === 'rate_limited' || code === 'provider_server_error',
    switchProvider: code !== 'invalid_response',
  }, { cause });
}

function isWrappedOpenAIError(err: unknown): err is Error {
  return isLLMRequestError(err);
}

function isHttpFailure(err: Error): err is Error & OpenAIHttpFailure {
  return (err as Partial<OpenAIHttpFailure>).__openAIHttpFailure === true;
}

function errorDetail(err: Error): string {
  if (isHttpFailure(err)) {
    const body = sanitizeErrorText(err.body);
    return body ? `OpenAI HTTP ${err.status}: ${body}` : `OpenAI HTTP ${err.status}`;
  }
  const message = sanitizeErrorText(err.message || err.name);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && !message.includes(cause.message)) {
    return `${message}; cause=${sanitizeErrorText(cause.message)}`;
  }
  return message;
}

function hintForOpenAIError(cfg: OpenAIConfig, err: Error): string {
  const baseUrl = cfg.baseUrl.replace(/\/$/, '');
  const host = hostnameOf(baseUrl);
  const message = `${err.message}\n${isHttpFailure(err) ? err.body : ''}`.toLowerCase();
  const hints: string[] = [];
  if (!cfg.apiKey && knownCloudEndpointRequiresApiKey(host)) {
    hints.push('set the required API key (for OpenRouter use OPENROUTER_API_KEY or llm.providers.<name>.api_key)');
  } else if (!cfg.apiKey) {
    hints.push('this OpenAI-compatible endpoint was called without an API key; that is valid only for local/no-auth servers');
  }
  if (isHttpFailure(err)) {
    if (err.status === 401 || err.status === 403) hints.push('check authentication, account access, and model permissions');
    else if (err.status === 404) hints.push('check base_url path and model id');
    else if (err.status === 408 || err.status === 429) hints.push('check provider quota/rate limits and retry later or switch provider');
    else if (err.status >= 500) hints.push('provider server failed; retry later or switch provider');
    else hints.push('check request format, model id, and provider-specific capability limits');
  }
  if (message.includes('json_object') || message.includes('json_schema') || message.includes('response_format')) {
    hints.push('if the provider rejects structured output, set json_response_format: json_schema or none for this provider');
  }
  if (message.includes('fetch failed') || message.includes('econnrefused') || message.includes('enotfound')) {
    hints.push('check base_url, network access, DNS/proxy settings, and whether the local server is running');
  }
  if (message.includes('timed out') || message.includes('idle')) {
    if (message.includes('connect timeout')) {
      hints.push('increase connect_timeout_ms for slow DNS/TCP/TLS establishment or fix network/proxy reachability');
    } else {
      hints.push('increase request_timeout_ms/stream_first_token_timeout_ms/stream_idle_timeout_ms only if the provider is still producing valid output');
    }
  }
  if (hints.length === 0) {
    hints.push('check base_url, model id, provider quota, network access, and response_format support');
  }
  return `Hint: ${[...new Set(hints)].join('; ')}.`;
}

function knownCloudEndpointRequiresApiKey(host: string): boolean {
  return host === 'api.openai.com' || host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
}

function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function sanitizeErrorText(text: string): string {
  const redacted = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9._-]{12,}/g, 'sk-[REDACTED]')
    .replace(/sk-or-v1-[A-Za-z0-9._-]{12,}/g, 'sk-or-v1-[REDACTED]')
    .replace(/gsk_[A-Za-z0-9._-]{12,}/g, 'gsk_[REDACTED]');
  return redacted.length <= 2000 ? redacted : `${redacted.slice(0, 2000)}... [truncated ${redacted.length - 2000} chars]`;
}

function buildJsonResponseFormat(
  format: 'json_object' | 'json_schema' | 'none',
): Record<string, unknown> | undefined {
  if (format === 'none') return undefined;
  if (format === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: 'xcompiler_json_response',
      strict: false,
      schema: {
        type: 'object',
        properties: {
          thoughts: { type: 'string' },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string' },
                args: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
              required: ['tool', 'args'],
              additionalProperties: true,
            },
          },
          done: { type: 'boolean' },
        },
        additionalProperties: true,
      },
    },
  };
}

function hasDegenerateJsonPrefix(text: string): boolean {
  if (text.length < 128) return false;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  const firstJson = Math.min(
    ...['{', '['].map((char) => {
      const index = trimmed.indexOf(char);
      return index < 0 ? Number.POSITIVE_INFINITY : index;
    }),
  );
  if (Number.isFinite(firstJson) && firstJson < 128) return false;
  if (!Number.isFinite(firstJson) && trimmed.length >= 1024) return true;
  if (Number.isFinite(firstJson) && firstJson >= 1024) return true;
  const sample = trimmed.slice(0, 256);
  if (/^[0-9\s.,"'`-]+$/u.test(sample)) return true;
  const chars = [...sample.replace(/\s+/gu, '')];
  if (chars.length < 96) return false;
  const counts = new Map<string, number>();
  for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1);
  const max = Math.max(...counts.values());
  return max / chars.length >= 0.85;
}

function hasInvalidJsonPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  return trimmed.length >= 1024;
}

function findSseSeparator(buf: string): { index: number; length: number } | null {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf < 0) return crlf < 0 ? null : { index: crlf, length: 4 };
  if (crlf < 0 || lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function bindAbortSignal(
  signal: AbortSignal | undefined,
  abort: (reason: unknown) => void,
): () => void {
  if (!signal) return () => undefined;
  const listener = () => abort(signal.reason);
  if (signal.aborted) {
    listener();
    return () => undefined;
  }
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' ? reason : 'Runtime task cancelled');
  error.name = 'AbortError';
  return error;
}
