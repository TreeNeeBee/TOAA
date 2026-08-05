import type { XCompilerConfig } from '../config/config.js';
import type { Role } from '../core/plan.js';
import type { AuditLogger } from '../audit/audit.js';
import { OllamaClient } from './ollama.js';
import { OpenAIClient } from './openai.js';
import type { ScoreStore } from './scores.js';
import type { ChatMessage, ChatOptions, LLMClient } from './types.js';
import { t } from '../i18n/index.js';
import type { PluginHost } from '../plugins/host.js';
import {
  isOllamaProvider,
  isOpenAICompatibleProvider,
  normalizeBaseUrl,
  probeLLMProviderAvailability,
  resolveLLMProbeTimeoutMs,
  type LLMProbeResult,
} from './health.js';
import {
  normalizeContextWindowTokens,
  resolveSkillOperationWindow,
} from './window.js';
import { LLMRequestError, isLLMRequestError } from './errors.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';


type ProviderConfig = XCompilerConfig['llm']['providers'][string];

/** 可用性检查注入点（测试用）；默认走 health.probeLLMProviderAvailability。 */
export type ProviderAvailabilityProbe = (
  name: string,
  provider: ProviderConfig,
) => Promise<LLMProbeResult>;

export type TicketScoreOutcome =
  | 'quality-gap'
  | 'finding-validated'
  | 'repair-verified'
  | 'change-verified';

/** 探测结果缓存时长：同一 provider 短时间内多次切换/重试不重复发起探测。 */
const PROBE_CACHE_TTL_MS = 15_000;

export class LLMRouter {
  private readonly clients = new Map<string, LLMClient>();
  private readonly probeCache = new Map<string, { ts: number; result: LLMProbeResult }>();

  constructor(
    private readonly cfg: XCompilerConfig,
    private readonly audit?: AuditLogger,
    private readonly scores?: ScoreStore,
    private readonly unavailable: ReadonlySet<string> = new Set(),
    private readonly plugins?: PluginHost,
    private readonly probe: ProviderAvailabilityProbe = (name, provider) =>
      probeLLMProviderAvailability(provider, resolveLLMProbeTimeoutMs(provider)),
    private readonly recordReplay?: RecordReplayController,
  ) {
    for (const [name, p] of Object.entries(cfg.llm.providers)) {
      const client = createClient(name, p);
      if (client) this.clients.set(name, recordReplay?.enabled('llm')
        ? recordReplayClient(name, client, recordReplay)
        : client);
    }
  }

  /**
   * 通用可用性检查（doctor 同源规则）：供 FallbackClient 在冷启动、provider 切换、
   * 瞬时断连重试三个时机调用。结果按 maxAgeMs 缓存，永不抛错。
   */
  private async availability(name: string, maxAgeMs = PROBE_CACHE_TTL_MS): Promise<LLMProbeResult | undefined> {
    if (this.recordReplay?.mode === 'replay') {
      return { ok: true, latencyMs: 0, detail: 'offline replay' };
    }
    const provider = this.cfg.llm.providers[name];
    if (!provider) return undefined;
    const cached = this.probeCache.get(name);
    if (cached && Date.now() - cached.ts <= maxAgeMs) return cached.result;
    let result: LLMProbeResult;
    try {
      result = await this.probe(name, provider);
    } catch (err) {
      result = { ok: false, latencyMs: 0, detail: err instanceof Error ? err.message : String(err) };
    }
    this.probeCache.set(name, { ts: Date.now(), result });
    return result;
  }

  /**
   * 返回某角色的 LLM 客户端：自动包含按评分排序的候选链。
   *
   * 候选集合：roles[role] (数组) ∪ role_fallbacks[role] ∪ fallbacks，去重。
   * 模型选择必须在配置中手动指定；不再存在隐式的 default provider。
   * 排序：按 ScoreStore 的评分降序；评分 = 0 的 provider 直接剔除。
   * 链中第一个调用成功即返回；失败 → 自动降评分并尝试下一个。
   */
  for(role: Role): LLMClient {
    const candidates = this.resolveChain(role);
    if (candidates.length === 0) {
      throw new LLMRequestError(`LLM provider not configured for role: ${role}`, {
        code: 'provider_not_configured', mode: 'router', retryable: false, switchProvider: false,
      });
    }
    const ranked = this.rankByScore(candidates);
    if (ranked.length === 0) {
      throw new LLMRequestError(
        `No usable LLM provider for role ${role}: candidates [${candidates.join(', ')}] ` +
          `are disabled or unreachable in this run. Run preflight or restore at least one provider in config.`,
        { code: 'provider_unavailable', mode: 'router', retryable: true, switchProvider: true },
      );
    }
    const clients = ranked
      .map((name) => ({
        name,
        client: this.clients.get(name),
        contextWindowTokens: normalizeContextWindowTokens(this.cfg.llm.providers[name]?.context_window),
      }))
      .filter((x): x is { name: string; client: LLMClient; contextWindowTokens: number } => !!x.client);
    if (clients.length === 0) {
      throw new LLMRequestError(`No usable LLM provider in chain for role ${role}: [${ranked.join(', ')}]`, {
        code: 'provider_unavailable', mode: 'router', retryable: true, switchProvider: true,
      });
    }
    const composite = new FallbackClient(
      clients,
      this.audit,
      String(role),
      this.scores,
      (name, maxAgeMs) => this.availability(name, maxAgeMs),
    );
    const observable = this.audit
      ? wrapWithAudit(composite, String(role), this.audit)
      : composite;
    return this.plugins && this.plugins.size > 0
      ? this.plugins.wrapLLM(observable, String(role))
      : observable;
  }

  /** 返回某角色按当前评分/可用性解析后的首选 provider 与模型，供启动诊断使用。 */
  primarySelection(role: Role): { provider: string; model: string } | undefined {
    const ranked = this.rankByScore(this.resolveChain(role));
    for (const provider of ranked) {
      const config = this.cfg.llm.providers[provider];
      if (config && this.clients.has(provider)) return { provider, model: config.model };
    }
    return undefined;
  }

  /** Context window for the currently ranked primary provider. */
  primaryContextWindow(role: Role): number {
    const ranked = this.rankByScore(this.resolveChain(role));
    const provider = ranked.find((name) => this.clients.has(name));
    return normalizeContextWindowTokens(provider ? this.cfg.llm.providers[provider]?.context_window : undefined);
  }

  /**
   * Apply quality feedback only after a Ticket establishes the outcome.
   * Enhance findings penalize the attributed author; verified Bug/CR work
   * rewards the models that produced the accepted repair or change.
   */
  recordTicketOutcome(
    providers: readonly string[],
    outcome: TicketScoreOutcome,
    ticketId: string,
  ): void {
    if (!this.scores) return;
    for (const provider of [...new Set(providers)]) {
      if (!this.cfg.llm.providers[provider]) continue;
      const reason = `${outcome} from ${ticketId}`;
      if (outcome === 'quality-gap') {
        this.scores.decay(provider, reason);
      } else {
        this.scores.boost(provider, reason);
      }
    }
  }

  private resolveChain(role: Role): string[] {
    const out: string[] = [];
    const push = (n: string | undefined) => {
      if (n && !out.includes(n)) out.push(n);
    };
    const explicit = this.cfg.llm.role_fallbacks?.[role];
    if (explicit && explicit.length > 0) {
      for (const n of explicit) push(n);
      return out;
    }
    // roles[role] 现已是数组形式（schema transform 强制）
    for (const n of this.cfg.llm.roles?.[role] ?? []) push(n);
    for (const f of this.cfg.llm.fallbacks ?? []) push(f);
    return out;
  }

  /** 按评分降序排序；评分 = 0 的剔除；并列保持声明顺序（稳定排序）。 */
  private rankByScore(names: string[]): string[] {
    if (!this.scores) return names.filter((name) => !this.unavailable.has(name));
    const scored = names.map((n, i) => ({ n, i, s: this.scores!.get(n) }));
    return scored
      .filter((x) => x.s > 0 && !this.unavailable.has(x.n))
      .sort((a, b) => (b.s - a.s) || (a.i - b.i))
      .map((x) => x.n);
  }
}

/**
 * 顺序尝试 provider，第一个成功即返回。
 * Provider/transport 故障可以切换候选；调用方契约校验失败先把精确错误
 * 反馈给当前 provider 纠错一次，仍失败才按质量故障切换候选。
 */
class FallbackClient implements LLMClient {
  readonly name: string;
  private static readonly MAX_TRANSIENT_PROVIDER_ATTEMPTS = 2;
  /** 冷启动可用性检查的新鲜度：进程内首次使用后长时间复用。 */
  private static readonly COLD_START_PROBE_MAX_AGE_MS = 10 * 60_000;
  /** 瞬时断连重试门控的新鲜度：必须接近实时。 */
  private static readonly RETRY_GATE_PROBE_MAX_AGE_MS = 5_000;

  constructor(
    private readonly chain: { name: string; client: LLMClient; contextWindowTokens: number }[],
    private readonly audit: AuditLogger | undefined,
    private readonly role: string,
    private readonly scores?: ScoreStore,
    private readonly availability?: (name: string, maxAgeMs?: number) => Promise<LLMProbeResult | undefined>,
  ) {
    this.name = chain.length === 1
      ? chain[0]!.client.name
      : `chain[${chain.map((c) => c.client.name).join('>')}]`;
  }

  /**
   * 通用可用性规则（替代早期的特殊非流式救援请求）：
   *  1. 冷启动 —— 本次 chat 的首选 provider 在使用前做一次 doctor 同源的端点探测，
   *     结果仅审计记录（不阻断首选，避免探测误判把唯一可用链路提前判死）。
   *  2. 切换 —— 故障转移到下一个 provider 前先探测：不可达且后面还有候选 → 直接跳过，
   *     不再把时间耗在必然超时的 chat 请求上；是最后一个候选时仍然一试。
   *  3. 断连重试 —— chat 抛连接类瞬时错误（首 token 超时/建连失败/断连等）时，
   *     先探测确认端点在线再重试一次（流式错误降级为非流式）；端点不可达 → 立即切换。
   */
  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    let lastErr: unknown;
    const failures: string[] = [];
    for (let i = 0; i < this.chain.length; i++) {
      const c = this.chain[i]!;
      // 冷启动 / 切换时的可用性检查（规则 1 / 2）。
      const isSwitch = i > 0;
      const health = await this.availability?.(
        c.name,
        isSwitch ? PROBE_CACHE_TTL_MS : FallbackClient.COLD_START_PROBE_MAX_AGE_MS,
      );
      if (health && !health.ok) {
        await this.audit?.event(
          'note',
          `${this.role} availability check failed for ${c.client.name}: ${health.detail}`,
          {
            messageId: 'llm.provider_probe_unreachable',
            provider: c.name,
            switch: isSwitch,
            latencyMs: health.latencyMs,
            detail: health.detail,
          },
        );
        if (isSwitch && i < this.chain.length - 1) {
          failures.push(`${c.name}/${c.client.name}: availability check failed: ${health.detail}`);
          continue;
        }
      }
      let attemptOptions = options;
      let providerMessages = messages;
      for (let providerAttempt = 1; providerAttempt <= FallbackClient.MAX_TRANSIENT_PROVIDER_ATTEMPTS; providerAttempt++) {
        let out: string;
        try {
          options?.onProviderStart?.(c.name, c.client.name, {
            contextWindowTokens: c.contextWindowTokens,
            switched: isSwitch,
          });
        } catch { /* display only */ }
        const operationWindow = resolveSkillOperationWindow({
          contextWindowTokens: c.contextWindowTokens,
          promptChars: messages.reduce((sum, message) => sum + message.content.length, 0),
        });
        if (providerAttempt === 1) {
          await this.audit?.event(
            'note',
            `${this.role} operation window updated for ${c.name}: context=${operationWindow.contextWindowTokens} tokens`,
            {
              messageId: 'llm.operation_window_updated',
              provider: c.name,
              model: c.client.name,
              switched: isSwitch,
              contextWindowTokens: operationWindow.contextWindowTokens,
              promptTokens: operationWindow.promptTokens,
              responseTokenBudget: operationWindow.responseTokenBudget,
              readChunkBytes: operationWindow.readChunkBytes,
              writeChunkBytes: operationWindow.writeChunkBytes,
              feedbackCharBudget: operationWindow.feedbackCharBudget,
            },
          );
        }
        const providerOptions: ChatOptions = {
          ...attemptOptions,
          maxTokens:
            typeof attemptOptions?.maxTokens === 'number'
              ? Math.min(attemptOptions.maxTokens, operationWindow.responseTokenBudget)
              : operationWindow.responseTokenBudget,
        };
        try {
          out = await c.client.chat(providerMessages, providerOptions);
        } catch (err) {
          lastErr = err;
          const retryDelayMs = retryDelayForLLMError(err);
          if (
            providerAttempt < FallbackClient.MAX_TRANSIENT_PROVIDER_ATTEMPTS &&
            isRetryableLLMError(err)
          ) {
            const retryWithoutStreaming = shouldRetryWithoutStreaming(err, attemptOptions);
            if (retryWithoutStreaming) {
              attemptOptions = withoutStreamingOptions(attemptOptions);
            }
            await this.audit?.event(
              'note',
              retryWithoutStreaming
                ? `${this.role} retrying ${c.client.name} without streaming after transient LLM stream failure`
                : `${this.role} retrying ${c.client.name} after transient LLM stream failure`,
              {
                messageId: retryWithoutStreaming ? 'llm.provider_retry_non_stream' : 'llm.provider_retry',
                provider: c.name,
                attempt: i + 1,
                providerAttempt,
                remaining: this.chain.length - i - 1,
                error: errorMessage(err),
                retryDelayMs,
              },
            );
            if (retryDelayMs > 0) {
              await delay(retryDelayMs);
            }
            continue;
          }
          // 规则 3：连接类瞬时错误（不含首 token 超时）→
          // 用可用性检查门控一次重试：端点确认在线才重试（流式降级为非流式），
          // 端点不可达则立即故障转移。
          if (
            providerAttempt < FallbackClient.MAX_TRANSIENT_PROVIDER_ATTEMPTS &&
            isTransientConnectivityLLMError(err)
          ) {
            const gate = await this.availability?.(c.name, FallbackClient.RETRY_GATE_PROBE_MAX_AGE_MS);
            if (gate?.ok) {
              attemptOptions = withoutStreamingOptions(attemptOptions);
              await this.audit?.event(
                'note',
                `${this.role} availability check confirmed ${c.client.name} is reachable; retrying without streaming after transient connectivity failure`,
                {
                  messageId: 'llm.provider_probe_retry',
                  provider: c.name,
                  attempt: i + 1,
                  providerAttempt,
                  probeLatencyMs: gate.latencyMs,
                  error: errorMessage(err),
                },
              );
              continue;
            }
          }
          this.scores?.decay(c.name, `chat threw in role ${this.role}: ${errorMessage(err).slice(0, 120)}`);
          failures.push(formatProviderFailure(c.name, c.client.name, err));
          await this.audit?.event(
            'llm.error',
            t().llm.providerCallFailed(this.role, c.client.name),
            {
              messageId: 'llm.provider_call_failed',
              provider: c.name,
              attempt: i + 1,
              providerAttempt,
              remaining: this.chain.length - i - 1,
              error: errorMessage(err),
            },
          );
          break;
        }
        if (options?.validate) {
          try {
            options.validate(out);
          } catch (vErr) {
            const validationError = errorMessage(vErr);
            await this.audit?.event(
              'llm.error',
              t().llm.providerValidationFailed(this.role, c.client.name),
              {
                messageId: 'llm.provider_validation_failed',
                provider: c.name,
                attempt: i + 1,
                providerAttempt,
                remaining: this.chain.length - i - 1,
                error: validationError,
                output_preview: out.slice(0, 400),
              },
            );
            if (providerAttempt < FallbackClient.MAX_TRANSIENT_PROVIDER_ATTEMPTS) {
              providerMessages = [
                ...messages,
                { role: 'assistant', content: validationOutputForRetry(out, operationWindow.feedbackCharBudget) },
                { role: 'user', content: t().llm.providerValidationRepairPrompt(validationError) },
              ];
              await this.audit?.event(
                'note',
                t().llm.providerValidationRetry(this.role, c.client.name),
                {
                  messageId: 'llm.provider_validation_retry',
                  provider: c.name,
                  attempt: i + 1,
                  providerAttempt,
                  remaining: this.chain.length - i - 1,
                  error: validationError,
                },
              );
              lastErr = vErr;
              continue;
            }
            this.scores?.decay(c.name, `validate failed in role ${this.role}`);
            lastErr = vErr;
            failures.push(formatProviderFailure(c.name, c.client.name, vErr));
            break;
          }
        }
        if (options?.scoreSuccess !== false) {
          this.scores?.boost(c.name, `success in role ${this.role}`);
        }
        try { options?.onProvider?.(c.name); } catch { /* observability must not fail the call */ }
        return out;
      }
    }
    if (failures.length > 0) {
      throw new LLMRequestError(
        `all LLM providers failed for role ${this.role}: ${failures.map((f) => truncateFailure(f, 500)).join(' | ')}`,
        {
          code: 'all_providers_failed',
          mode: 'router',
          retryable: true,
          switchProvider: true,
          details: { role: this.role, failures },
        },
        { cause: lastErr },
      );
    }
    throw lastErr instanceof Error ? lastErr : new Error('all LLM providers failed');
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatProviderFailure(provider: string, model: string, err: unknown): string {
  return `${provider}/${model}: ${errorMessage(err)}`;
}

function truncateFailure(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... [truncated ${text.length - max} chars]`;
}

function validationOutputForRetry(text: string, feedbackBudget: number): string {
  const max = Math.max(1_000, Math.min(16_000, feedbackBudget));
  return truncateFailure(text, max);
}

function withoutStreamingOptions(options?: ChatOptions): ChatOptions | undefined {
  if (!options?.onToken) return options;
  const next: ChatOptions = { ...options };
  delete next.onToken;
  delete next.streamStopWhen;
  return next;
}

function shouldRetryWithoutStreaming(err: unknown, options?: ChatOptions): boolean {
  if (!options?.onToken) return false;
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes('stream idle before first token')) return false;
  return (
    msg.includes('stream idle') ||
    msg.includes('degenerate non-json prefix') ||
    msg.includes('stream response aborted') ||
    msg.includes('response aborted before completion') ||
    msg.includes('fetch failed') ||
    msg.includes('terminated')
  );
}

function isRetryableLLMError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes('stream idle before first token')) return false;
  return (
    retryDelayForLLMError(err) > 0 ||
    msg.includes('token loop') ||
    msg.includes('degenerate non-json prefix') ||
    msg.includes('stream idle') ||
    msg.includes('stream response aborted') ||
    msg.includes('response aborted') ||
    msg.includes('fetch failed') ||
    msg.includes('terminated')
  );
}

/**
 * 可安全重试的连接类瞬时错误。
 *
 * 首 token 超时表示端点可达但当前模型没有及时产出。健康探针无法证明同一模型
 * 的下一次生成会更快，因此必须立即切换 provider，避免再等待一个完整首 token 窗口。
 */
function isTransientConnectivityLLMError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes('stream idle before first token')) return false;
  return (
    msg.includes('stream idle') ||
    msg.includes('stream wall-clock') ||
    msg.includes('timed out') ||
    msg.includes('fetch failed') ||
    msg.includes('terminated') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('stream response aborted') ||
    msg.includes('response aborted')
  );
}

function retryDelayForLLMError(err: unknown): number {
  const msg = errorMessage(err);
  if (!/\b(?:http\s*)?429\b/i.test(msg)) return 0;
  if (/free-models-per-day|insufficient credits|quota exceeded/i.test(msg)) return 0;
  const seconds =
    msg.match(/try again in\s+([0-9]+(?:\.[0-9]+)?)s/i)?.[1] ??
    msg.match(/retry_after_seconds["']?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1] ??
    msg.match(/retry-after["']?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1];
  if (!seconds) return 0;
  const ms = Math.ceil(Number(seconds) * 1000) + 250;
  return Number.isFinite(ms) && ms > 0 && ms <= 60_000 ? ms : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wrapWithAudit(inner: LLMClient, role: string, audit: AuditLogger): LLMClient {
  return {
    name: inner.name,
    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      await audit.llmRequest(role, inner.name, messages, options);
      try {
        const out = await inner.chat(messages, options);
        await audit.llmResponse(role, inner.name, out);
        return out;
      } catch (err) {
        await audit.llmError(role, inner.name, err);
        throw err;
      }
    },
  };
}

function createClient(
  name: string,
  p: ProviderConfig,
): LLMClient | null {
  if (isOllamaProvider(p)) {
    return new OllamaClient({
      baseUrl: normalizeBaseUrl(p.base_url, 'http://localhost:11434'),
      model: p.model,
      requestTimeoutMs: p.request_timeout_ms,
      streamIdleTimeoutMs: p.stream_idle_timeout_ms,
      maxOutputChars: p.max_output_chars,
      think: p.think,
    });
  }
  if (isOpenAICompatibleProvider(p)) {
    return new OpenAIClient({
      providerName: name,
      apiKey: p.api_key ?? '',
      baseUrl: normalizeBaseUrl(p.base_url, 'https://api.openai.com/v1'),
      model: p.model,
      jsonResponseFormat: p.json_response_format,
      requestTimeoutMs: p.request_timeout_ms,
      connectTimeoutMs: p.connect_timeout_ms,
      streamIdleTimeoutMs: p.stream_idle_timeout_ms,
      streamFirstTokenTimeoutMs: p.stream_first_token_timeout_ms,
      maxOutputChars: p.max_output_chars,
    });
  }
  return null;
}

function recordReplayClient(
  provider: string,
  inner: LLMClient,
  controller: RecordReplayController,
): LLMClient {
  return {
    name: inner.name,
    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      return controller.execute({
        channel: 'llm',
        operation: 'chat',
        request: {
          provider,
          model: inner.name,
          messages,
          options: {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
            responseFormat: options?.responseFormat,
          },
        },
      }, () => inner.chat(messages, options));
    },
  };
}
