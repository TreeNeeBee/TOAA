import type { ChatMessage, ChatOptions, LLMClient } from './types.js';
import type { StreamProgress } from './errors.js';
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
/**
 * When the kernel starts probing an otherwise silent connection.
 *
 * A network that disappears mid-request leaves no RST and no FIN: the socket black-holes, and the
 * application has nothing to detect. Probes are the only thing that turns that into an error, and
 * they need no cooperation from the provider — a peer's kernel answers them whether or not its model
 * is still thinking, which is exactly what separates "the path is gone" from "the answer is slow".
 *
 * 30s, not the few seconds a liveness check would suggest: Node exposes only when probing starts,
 * not the probe interval or count, so the kernel's own defaults decide how long an unanswered
 * connection survives (macOS: 75s x 8). Probing early costs nothing and shortens nothing.
 */
export const DEFAULT_OPENAI_TCP_KEEPALIVE_MS = 30 * 1000;
/**
 * How long a streaming request may go without response headers.
 *
 * Only meaningful while streaming, and that is why it is not one of the other timeouts: a streaming
 * server writes its headers immediately and only then begins thinking, so headers arriving is a fact
 * about the connection and the first token arriving is a fact about the model. Collapsing both into
 * the first-token budget gave a dead endpoint the same five minutes as a model composing an answer.
 *
 * A non-stream request has no such split — its headers are withheld until the whole answer exists —
 * so nothing here applies to that path.
 */
export const DEFAULT_OPENAI_STREAM_HEADERS_TIMEOUT_MS = 30 * 1000;

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
  /**
   * 流式请求等待响应头的超时；默认 30 秒，0 关闭。仅对流式生效。
   *
   * 流式服务端会先写响应头再开始思考，所以「头到了」是关于连接的事实，「首个 token 到了」是关于
   * 模型的事实。非流式的响应头要等整个答案生成完才发，这道闸对它没有意义，也不会加在它上面。
   */
  streamHeadersTimeoutMs?: number;
  /**
   * 内核在连接静默多久后开始发 TCP 探活包；默认 30 秒，0 关闭。
   *
   * 与三个超时无关：它检测的是「路径还在不在」，不是「答案来没来」。断网时这是唯一能把黑洞
   * socket 变成真正连接错误的机制，且不需要对端应用层做任何配合。
   */
  tcpKeepAliveMs?: number;
  /**
   * 对端连续多久没有送来任何字节即触发一次环境诊断；不结束请求。0 关闭。
   *
   * 与三个超时是不同的量：超时决定「什么时候放弃」，这个决定「放弃时说得出原因」。
   */
  stallDiagnosisAfterMs?: number;
}

/**
 * Watches for total silence from the provider and asks the caller to explain it, once.
 *
 * Silence is measured in bytes off the socket, not in parsed tokens: a reasoning model mid-thought,
 * a gateway sending SSE comments, and a provider streaming content are all alive, and only the
 * transport sees all three the same way. Nothing here ends the request — the timeouts own that
 * decision. This exists so that when a request does fail, the failure can say whether the endpoint
 * was reachable, instead of leaving a dead network and a slow model behind the same message.
 */
function armStallDiagnosis(cfg: OpenAIConfig, options?: ChatOptions) {
  const afterMs = cfg.stallDiagnosisAfterMs ?? 0;
  let diagnosis: string | undefined;
  let timer: NodeJS.Timeout | null = null;
  let generation = 0;
  let diagnosisStarted = false;
  let disposed = false;
  const active = afterMs > 0 && !!options?.onStall;
  const arm = () => {
    if (!active || diagnosisStarted || disposed) return;
    if (timer) clearTimeout(timer);
    const armedGeneration = ++generation;
    timer = setTimeout(() => {
      timer = null;
      diagnosisStarted = true;
      // Fire and forget: a diagnosis must never become another thing the request waits on.
      void options!.onStall!({ silentForMs: afterMs, provider: cfg.providerName, model: cfg.model })
        .then((text) => {
          if (text && !disposed && generation === armedGeneration) diagnosis = text;
        })
        .catch(() => undefined);
    }, afterMs);
  };
  arm();
  return {
    /** Any byte from the provider. Restarts the clock and discards a diagnosis it outlived. */
    seen: () => {
      diagnosis = undefined;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      arm();
    },
    diagnosis: () => diagnosis,
    cleanup: () => {
      disposed = true;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Attaches a stall diagnosis to a failure, so the reason and the evidence arrive together. */
function withStallDiagnosis(err: unknown, diagnosis: string | undefined): unknown {
  if (!diagnosis || !(err instanceof Error)) return err;
  err.message = `${err.message} Environment check while the provider was silent: ${diagnosis}`;
  return err;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string | null; reasoning?: string } }>;
  error?: { message: string };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    /**
     * `reasoning` is a reasoning model's thinking, streamed before it answers.
     *
     * It is proof the stream is alive, and it is not output. A model that thinks for ten minutes
     * before its first content token sends hundreds of these; counting only `content` reports that
     * a fully active stream has gone idle.
     */
    delta?: { content?: string; reasoning?: string };
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
  done?: boolean;
}

/**
 * The socket options this transport asks for, stated separately so they can be asserted.
 *
 * Named rather than inlined because undici binds `net.connect` when it is first imported, which puts
 * the socket out of reach of any in-process test that has already loaded this module. Keeping the
 * decision in one pure place means the choice is checkable even where the socket is not.
 */
export function openAIConnectOptions(cfg: Pick<OpenAIConfig, 'connectTimeoutMs' | 'tcpKeepAliveMs'>) {
  const keepAliveMs = cfg.tcpKeepAliveMs ?? DEFAULT_OPENAI_TCP_KEEPALIVE_MS;
  return {
    timeout: cfg.connectTimeoutMs ?? DEFAULT_OPENAI_CONNECT_TIMEOUT_MS,
    // Kernel-level, so a dead path is reported as a connection failure rather than left to expire on
    // a timeout that cannot say which of the two faults it was.
    ...(keepAliveMs > 0 ? { keepAlive: true, keepAliveInitialDelay: keepAliveMs } : {}),
  };
}

export class OpenAIClient implements LLMClient {
  readonly name: string;
  private readonly dispatcher: Agent;

  constructor(private readonly cfg: OpenAIConfig) {
    this.name = `openai:${cfg.model}`;
    this.dispatcher = new Agent({ connect: openAIConnectOptions(cfg) });
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
    // A caller may cap one request below the provider's budget; it may never raise it.
    const configuredTimeoutMs = this.cfg.requestTimeoutMs ?? DEFAULT_OPENAI_REQUEST_TIMEOUT_MS;
    const timeoutMs = options?.requestTimeoutMs !== undefined && options.requestTimeoutMs > 0
      ? Math.min(configuredTimeoutMs || options.requestTimeoutMs, options.requestTimeoutMs)
      : configuredTimeoutMs;
    const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs) : null;
    // No incremental data exists on this path, so the whole request is the silence being measured.
    const stall = armStallDiagnosis(this.cfg, options);
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
      const content = json.choices?.[0]?.message?.content;
      // A reasoning model answers with `content: null` and its text in `reasoning` when the token
      // budget ran out mid-thought. Returning '' for that reports an empty answer from a provider
      // that in fact never answered — the caller then blames the model's quality for a shape it
      // could not have known about.
      if (content === null || content === undefined) {
        const reasoning = json.choices?.[0]?.message?.reasoning;
        if (reasoning) {
          throw new Error(
            `provider returned only reasoning (${reasoning.length} chars) and no content; ` +
            'raise max_tokens or use a non-reasoning model for this role',
          );
        }
      }
      return content ?? '';
    } catch (err) {
      throw wrapOpenAIError(this.cfg, withStallDiagnosis(err, stall.diagnosis()), 'non-stream');
    } finally {
      stall.cleanup();
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
    // The transport is the only layer that can see this, so it records it rather than describing it.
    let abortProgress: StreamProgress | undefined;
    const abort = (err: Error, progress?: StreamProgress) => {
      if (!abortReason) {
        abortReason = err;
        abortProgress = progress;
      }
      ctrl.abort(err);
    };
    const currentProgress = (): StreamProgress =>
      streamedContentChars > 0 ? 'content-started' : reasoningChars > 0 ? 'reasoning-only' : 'no-bytes';
    const unbindAbort = bindAbortSignal(options.signal, (reason) => abort(abortError(reason)));

    let wallTimer =
      timeoutMs > 0
        ? setTimeout(
            // Whichever watchdog ends it, a stream that only ever sent reasoning failed for that
            // reason, and that is the fact an operator can act on. Reporting the timer instead
            // sends them to raise a limit that was never the constraint.
            () => abort(new Error(
              streamedContentChars === 0 && reasoningChars > 0
                ? `OpenAI stream sent ${reasoningChars} reasoning chars but no content within ${timeoutMs}ms; aborting`
                : `OpenAI stream wall-clock ${timeoutMs}ms exceeded; aborting`,
            ), currentProgress()),
            timeoutMs,
          )
        : null;
    let idleTimer: NodeJS.Timeout | null = null;
    const stall = armStallDiagnosis(this.cfg, options);
    let streamedContentChars = 0;
    let reasoningChars = 0;
    const armIdle = () => {
      const activeTimeoutMs = streamedContentChars === 0 ? firstTokenTimeoutMs : idleTimeoutMs;
      if (idleTimer) clearTimeout(idleTimer);
      if (activeTimeoutMs <= 0) {
        idleTimer = null;
        return;
      }
      idleTimer = setTimeout(
        () => abort(new Error(
          // A stream that delivered reasoning and then stopped is a different fault from one that
          // delivered nothing, and it needs a different answer: raising the timeout helps the
          // second and does nothing for the first. Saying "idle" for both sent a live, thinking
          // stream's failure to the one hint that could not fix it.
          streamedContentChars === 0 && reasoningChars > 0
            ? `OpenAI stream sent ${reasoningChars} reasoning chars but no content for ${activeTimeoutMs}ms; aborting`
            : streamedContentChars === 0
              ? `OpenAI stream idle before first token for ${activeTimeoutMs}ms; aborting`
              : `OpenAI stream idle for ${activeTimeoutMs}ms; aborting`,
        ), currentProgress()),
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
      // `fetch` settles when the response headers arrive, which makes this the one place the two
      // phases can be told apart without a second dispatcher or a provider-specific option.
      const headersTimeoutMs =
        this.cfg.streamHeadersTimeoutMs ?? DEFAULT_OPENAI_STREAM_HEADERS_TIMEOUT_MS;
      let headersTimer = headersTimeoutMs > 0
        ? setTimeout(
            () => abort(new Error(`OpenAI stream sent no response headers for ${headersTimeoutMs}ms; aborting`), 'no-bytes'),
            headersTimeoutMs,
          )
        : null;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
        dispatcher: this.dispatcher,
      } as RequestInit & { dispatcher: Agent }).finally(() => {
        if (headersTimer) clearTimeout(headersTimer);
        headersTimer = null;
      });
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
          if (!piece) {
            // Liveness, not output. Reasoning keeps the watchdog fed without entering `aggregate`,
            // reaching `onToken`, or advancing `streamedContentChars` — the model has not started
            // answering yet, so the first-token budget still applies, and the wall-clock timer is
            // still armed, which is what stops a model that only ever thinks.
            if (choice.delta?.reasoning) {
              reasoningChars += choice.delta.reasoning.length;
              armIdle();
            }
            continue;
          }
          if (streamedContentChars === 0 && wallTimer) {
            clearTimeout(wallTimer);
            wallTimer = null;
          }
          aggregate += piece;
          streamedContentChars += piece.length;
          armIdle();
          const embeddedProtocolError = openAIProtocolErrorEnvelope(aggregate);
          if (embeddedProtocolError) {
            throw new Error(`OpenAI error: ${embeddedProtocolError}`);
          }
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
          // Reset on bytes, not on parsed tokens: SSE comments and reasoning deltas prove the peer
          // is alive even though neither becomes output, and only here are they all just bytes.
          if (value) stall.seen();
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
      const embeddedProtocolError = openAIProtocolErrorEnvelope(aggregate);
      if (embeddedProtocolError) {
        throw new Error(`OpenAI error: ${embeddedProtocolError}`);
      }
      return aggregate;
    } catch (err) {
      throw wrapOpenAIError(this.cfg, withStallDiagnosis(err, stall.diagnosis()), 'stream', abortProgress);
    } finally {
      stall.cleanup();
      cleanup();
    }
  }
}

/**
 * Some OpenAI-compatible gateways return a provider protocol error as generated content inside a
 * successful SSE choice instead of using HTTP status or the top-level `error` field. Treat only the
 * canonical error envelope as protocol failure; ordinary user-requested JSON remains content.
 */
function openAIProtocolErrorEnvelope(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  if (envelope.type !== 'error' || !envelope.error || typeof envelope.error !== 'object') {
    return undefined;
  }
  const error = envelope.error as Record<string, unknown>;
  if (typeof error.type !== 'string' || typeof error.message !== 'string') return undefined;
  return `${error.type}: ${error.message}`;
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

function wrapOpenAIError(cfg: OpenAIConfig, err: unknown, mode: 'stream' | 'non-stream', streamProgress?: StreamProgress): Error {
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
    streamProgress,
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
