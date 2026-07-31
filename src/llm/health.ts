/**
 * 通用 LLM 可用性检查（"doctor 规则"）。
 *
 * doctor 命令、启动 preflight、以及 LLMRouter 在冷启动 / provider 切换 / 瞬时断连重试
 * 三个时机共用同一套端点探测逻辑，避免各处维护特殊分支：
 *  - ollama:            GET {base_url}/api/tags
 *  - openai 兼容端点:   GET {base_url}/models（带 Authorization）
 *
 * 可用性判定 = "端点可达"（收到任意 HTTP 响应即算在线）：部分 OpenAI 兼容服务
 * 没有实现 /models（返回 404），但这同样证明服务进程在线；只有连接被拒 / DNS 失败 /
 * 超时这类网络层错误才判为不可达。模型清单级别的校验（模型是否存在、api_key 是否
 * 有效）仍由 doctor / preflight 各自按语义处理。
 */
import { getJson } from './ollama.js';
import { t } from '../i18n/index.js';

export interface LLMProbeResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

/** 探测所需的最小 provider 形状（config ProviderSchema 的子集）。 */
export interface ProbeableLLMProvider {
  type: string;
  base_url?: string;
  api_key?: string;
  connect_timeout_ms?: number;
}

export const DEFAULT_LLM_PROBE_TIMEOUT_MS = 3000;
export const DEFAULT_OPENAI_PROBE_TIMEOUT_MS = 60_000;

/**
 * Resolve endpoint-probe timeouts from the same connection budget used by the
 * provider. Hosted OpenAI-compatible routes can legitimately take longer than
 * a local health endpoint, especially during cold starts.
 */
export function resolveLLMProbeTimeoutMs(
  provider: ProbeableLLMProvider,
  explicitTimeoutMs?: number,
): number {
  if (explicitTimeoutMs !== undefined) return explicitTimeoutMs;
  if (isOpenAICompatibleProvider(provider)) {
    return provider.connect_timeout_ms ?? DEFAULT_OPENAI_PROBE_TIMEOUT_MS;
  }
  return DEFAULT_LLM_PROBE_TIMEOUT_MS;
}

/** Providers backed by Ollama's native /api/chat protocol. */
export function isOllamaProvider(provider: Pick<ProbeableLLMProvider, 'type'>): boolean {
  return provider.type === 'ollama';
}

/** Providers backed by OpenAI-compatible /v1/chat/completions APIs. */
export function isOpenAICompatibleProvider(provider: Pick<ProbeableLLMProvider, 'type'>): boolean {
  return provider.type === 'openai';
}

/**
 * 规整 LLM provider base_url：
 *  - 空 / 仅空白 → fallback；
 *  - 去首尾空白和尾部 '/'；
 *  - 缺少 scheme 时自动补 `http://`；
 *  - 不能解析为合法 URL → fail configuration immediately.
 */
export function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return fallback;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    // 验证可解析
    new URL(withScheme);
    return withScheme;
  } catch {
    throw new Error(t().llm.invalidBaseUrl(JSON.stringify(raw), fallback));
  }
}

/** ollama `/api/tags` → 模型名数组（doctor / preflight 共用）。失败抛 Error。 */
export async function fetchOllamaTags(baseUrl: string, timeoutMs: number): Promise<string[]> {
  const url = new URL('/api/tags', baseUrl);
  const text = await getJson(url, timeoutMs);
  const parsed = JSON.parse(text) as { models?: Array<{ name?: string; model?: string }> };
  return (parsed.models ?? [])
    .map((m) => (typeof m.name === 'string' ? m.name : m.model))
    .filter((s): s is string => !!s);
}

/** openai 兼容端点 `/models` → 模型 id 数组（doctor 共用）。失败抛 Error。 */
export async function fetchOpenAIModels(baseUrl: string, apiKey: string, timeoutMs: number): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const ctrl = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? []).map((d) => d.id).filter((s): s is string => !!s);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 通用 LLM 端点可用性检查。永不抛错：任何异常都折叠为 `{ ok: false, detail }`。
 * 收到任意 HTTP 响应（包括 4xx/5xx）都视为可达。
 */
export async function probeLLMProviderAvailability(
  provider: ProbeableLLMProvider,
  timeoutMs?: number,
): Promise<LLMProbeResult> {
  const effectiveTimeoutMs = resolveLLMProbeTimeoutMs(provider, timeoutMs);
  const started = Date.now();
  const done = (ok: boolean, detail: string): LLMProbeResult => ({
    ok,
    latencyMs: Date.now() - started,
    detail,
  });
  try {
    if (isOllamaProvider(provider)) {
      const baseUrl = normalizeBaseUrl(provider.base_url, 'http://localhost:11434');
      await getJson(new URL('/api/tags', baseUrl), effectiveTimeoutMs);
      return done(true, `ollama endpoint reachable: ${baseUrl}`);
    }
    if (isOpenAICompatibleProvider(provider)) {
      const baseUrl = normalizeBaseUrl(provider.base_url, 'https://api.openai.com/v1');
      const url = `${baseUrl.replace(/\/$/, '')}/models`;
      const ctrl = new AbortController();
      const timer = effectiveTimeoutMs > 0
        ? setTimeout(
            () => ctrl.abort(new Error(`availability probe timed out after ${effectiveTimeoutMs}ms`)),
            effectiveTimeoutMs,
          )
        : null;
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: provider.api_key ? { authorization: `Bearer ${provider.api_key}` } : {},
          signal: ctrl.signal,
        });
        return done(true, `endpoint responded HTTP ${res.status}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return done(false, `unknown provider type: ${provider.type}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // getJson 对 HTTP >= 400 抛错，但收到 HTTP 响应本身即证明端点在线。
    if (/^HTTP \d{3}\b/.test(message)) return done(true, `endpoint responded ${message.slice(0, 80)}`);
    return done(false, message);
  }
}
