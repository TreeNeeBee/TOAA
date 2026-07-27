import type { XCompilerConfig } from '../config/config.js';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from './window.js';
import type { AuditLogger } from '../audit/audit.js';
import { t } from '../i18n/index.js';
import { fetchOllamaTags, isOllamaProvider, normalizeBaseUrl } from './health.js';
import { ScoreStore } from './scores.js';

export interface PreflightOptions {
  /** 探活超时（毫秒），默认 3000。 */
  probeTimeoutMs?: number;
  /** 注入器（测试用）：覆盖默认的 HTTP getJson。返回模型名字符串数组。 */
  fetchTags?: (baseUrl: string, timeoutMs: number) => Promise<string[]>;
}

export interface PreflightResult {
  /** 探活后模型缺失的 provider；当前运行会跳过，并把动态评分降到最低值。 */
  zeroed: string[];
  /** 本次探活不可达或模型缺失的 provider；只影响当前运行，不持久化为 score=0。 */
  unreachable: string[];
  /** 历史动态快照把非 ollama provider 置 0，但当前没有其他活候选时恢复的 provider；用户覆盖 score=0 不恢复。 */
  revived: string[];
  /** 自动加入的合成 provider（key=合成名, value=模型名）。 */
  autoAdded: Record<string, string>;
  /** 每个 ollama base_url 的可达模型清单（探活成功才有）。 */
  tags: Record<string, string[]>;
}

/**
 * 启动期 LLM 自检：
 *  1. 对每个 ollama provider，GET `${base_url}/api/tags`，比对配置的 model 是否存在。
 *  2. 不存在 → 当前运行跳过该 provider，并把 ScoreStore 降到最低动态分。
 *     存在但当前评分=0 且不是用户显式禁用 → 恢复为 1，让用户手工拉模型后无需再编辑动态快照。
 *  3. 全部 ollama provider 都不可用时（任何角色都没活着的候选），从可达 ollama 服务器扫描
 *     全量 tags，把每个模型注册为合成 provider `auto_<sanitized>`，加入到所有现存角色的
 *     候选数组里。完成后再次校验：若仍有角色为空，抛错让 CLI 退出（exit code 7）。
 *
 * 该函数会**就地更新** cfg.llm.providers 与 cfg.llm.roles 中的当前运行候选。
 */
export async function preflightProviders(
  cfg: XCompilerConfig,
  scores: ScoreStore,
  audit?: AuditLogger,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const probeTimeoutMs = options.probeTimeoutMs ?? 3000;
  const fetchTags = options.fetchTags ?? fetchOllamaTags;
  const result: PreflightResult = { zeroed: [], unreachable: [], revived: [], autoAdded: {}, tags: {} };

  // 1) 收集所有 ollama provider 及其 base_url
  const ollamaProviders: Array<{ name: string; baseUrl: string; model: string }> = [];
  for (const [name, p] of Object.entries(cfg.llm.providers)) {
    if (isOllamaProvider(p)) {
      ollamaProviders.push({
        name,
        baseUrl: normalizeBaseUrl(p.base_url, 'http://localhost:11434'),
        model: p.model,
      });
    }
  }

  // 2) 按 baseUrl 聚合并探活，缓存 tags
  const baseUrls = [...new Set(ollamaProviders.map((p) => p.baseUrl))];
  for (const baseUrl of baseUrls) {
    try {
      const tags = await fetchTags(baseUrl, probeTimeoutMs);
      result.tags[baseUrl] = tags;
      await audit?.event('llm.score', t().llm.preflightOllamaReachable(baseUrl, tags.length), {
        messageId: 'llm.preflight_ollama_reachable',
        baseUrl, tagsCount: tags.length, tags,
      });
    } catch (err) {
      for (const provider of ollamaProviders) {
        if (provider.baseUrl === baseUrl && !result.unreachable.includes(provider.name)) {
          result.unreachable.push(provider.name);
        }
      }
      await audit?.event('llm.error', t().llm.preflightOllamaUnreachable(baseUrl, (err as Error).message), {
        messageId: 'llm.preflight_ollama_unreachable',
        baseUrl, error: (err as Error).message,
      });
    }
  }

  // 3) 对每个 ollama provider 校验模型是否存在
  for (const p of ollamaProviders) {
    const tags = result.tags[p.baseUrl];
    if (!tags) {
      // 服务器不可达，沿用现有评分（不强制置 0，避免临时网络故障一次性废掉所有 provider）
      continue;
    }
    if (!tags.includes(p.model)) {
      scores.set(p.name, ScoreStore.MIN, `preflight: model "${p.model}" not on ${p.baseUrl}`);
      result.zeroed.push(p.name);
      if (!result.unreachable.includes(p.name)) result.unreachable.push(p.name);
    } else if (scores.get(p.name) === 0 && !scores.isUserDisabled(p.name)) {
      // 之前被动态置 0 过，现在模型回来了且不是用户显式禁用 → 恢复为 1
      scores.set(p.name, 1, `preflight: model "${p.model}" returned to ${p.baseUrl}`);
    }
  }

  // 4) 检查每个角色是否还有活着的候选；若没有，触发 auto-import
  const unavailable = new Set(result.unreachable);
  let rolesNeedingRescue = listRolesWithoutLiveProvider(cfg, scores, unavailable);
  if (rolesNeedingRescue.length > 0) {
    result.revived = reviveScoreZeroNonOllamaCandidates(cfg, scores, unavailable, rolesNeedingRescue);
    if (result.revived.length > 0) {
      await audit?.event('llm.score', `Revived score-zero non-Ollama providers: ${result.revived.join(', ')}`, {
        messageId: 'llm.preflight_provider_revived',
        providers: result.revived,
        roles: rolesNeedingRescue,
      });
      rolesNeedingRescue = listRolesWithoutLiveProvider(cfg, scores, unavailable);
    }
  }
  if (rolesNeedingRescue.length > 0) {
    const reachable = baseUrls.filter((u) => result.tags[u] && result.tags[u]!.length > 0);
    if (reachable.length === 0) {
      throw new Error(
        `LLM preflight failed: 角色 [${rolesNeedingRescue.join(', ')}] 没有可用的 provider，` +
          `且没有任何 ollama 服务器可达。请检查 config.yaml 的 base_url / 启动 ollama 服务后重试。`,
      );
    }
    // 4a) 在第一个可达的 server 上把所有模型注册为合成 provider
    const sourceUrl = reachable[0]!;
    const tags = result.tags[sourceUrl]!;
    for (const model of tags) {
      const synthName = `auto_${model.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
      if (cfg.llm.providers[synthName]) continue; // 已经加过了
      cfg.llm.providers[synthName] = {
        type: 'ollama',
        api_key: '',
        base_url: sourceUrl,
        model,
        context_window: DEFAULT_CONTEXT_WINDOW_TOKENS,
        tags: undefined,
      };
      result.autoAdded[synthName] = model;
      // 默认评分 1
      scores.set(synthName, 1, `preflight: auto-imported from ${sourceUrl}`);
    }
    // 4b) 把合成 provider 追加到所有需要救援的角色
    for (const role of rolesNeedingRescue) {
      const cur = cfg.llm.roles[role] ?? [];
      const merged = [...cur];
      for (const synthName of Object.keys(result.autoAdded)) {
        if (!merged.includes(synthName)) merged.push(synthName);
      }
      cfg.llm.roles[role] = merged;
    }
    await audit?.event('llm.score', t().llm.preflightAutoAdded(Object.keys(result.autoAdded).length, rolesNeedingRescue.join(', ')), {
      messageId: 'llm.preflight_auto_added',
      sourceUrl, autoAdded: result.autoAdded, rescuedRoles: rolesNeedingRescue,
    });

    // 4c) 再次校验：仍为空就退出
    const stillEmpty = listRolesWithoutLiveProvider(cfg, scores, unavailable);
    if (stillEmpty.length > 0) {
      throw new Error(
        `LLM preflight failed: ollama server ${sourceUrl} 已加载，但角色 [${stillEmpty.join(', ')}] ` +
          `仍无可用 provider（自动导入后评分仍全为 0）。`,
      );
    }
  }

  return result;
}

/** 角色 → 候选 provider 数组（模型选择必须手动指定；roles[role] + fallbacks，无隐式 default）。 */
function candidatesForRole(cfg: XCompilerConfig, role: string): string[] {
  const explicit = cfg.llm.role_fallbacks?.[role];
  if (explicit && explicit.length > 0) return explicit;
  return [...(cfg.llm.roles?.[role] ?? []), ...(cfg.llm.fallbacks ?? [])];
}

function listRolesWithoutLiveProvider(
  cfg: XCompilerConfig,
  scores: ScoreStore,
  unavailable: ReadonlySet<string> = new Set(),
): string[] {
  // 检查所有显式声明过的角色
  const rolesToCheck = new Set<string>([
    ...Object.keys(cfg.llm.roles ?? {}),
    ...Object.keys(cfg.llm.role_fallbacks ?? {}),
  ]);
  const out: string[] = [];
  for (const r of rolesToCheck) {
    const cands = candidatesForRole(cfg, r);
    const live = cands.filter(
      (n) => !unavailable.has(n) && scores.get(n) > 0 && cfg.llm.providers[n],
    );
    if (live.length === 0) out.push(r);
  }
  return out;
}

function reviveScoreZeroNonOllamaCandidates(
  cfg: XCompilerConfig,
  scores: ScoreStore,
  unavailable: ReadonlySet<string>,
  rolesNeedingRescue: string[],
): string[] {
  const revived: string[] = [];
  for (const role of rolesNeedingRescue) {
    for (const name of candidatesForRole(cfg, role)) {
      if (revived.includes(name)) continue;
      if (unavailable.has(name)) continue;
      const provider = cfg.llm.providers[name];
      if (!provider) continue;
      if (isOllamaProvider(provider)) continue;
      if (scores.get(name) !== 0) continue;
      if (scores.isUserDisabled(name)) continue;
      scores.set(name, 1, `preflight: revived non-Ollama provider for role ${role}`);
      revived.push(name);
    }
  }
  return revived;
}
