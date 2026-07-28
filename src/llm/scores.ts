import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { AuditLogger } from '../audit/audit.js';
import { t } from '../i18n/index.js';
import type { XCompilerConfig } from '../config/config.js';

export const CLUSTER_PROVIDER_TAG = 'cluster';
export const LLM_DYNAMIC_SCORES_FILE = 'llm_scores.yaml';
export const LLM_USER_SCORES_FILE = 'llm_scores_user.yaml';

export interface ScoreStoreOptions {
  /** Providers tagged as aggregated/route pools such as OpenRouter free mode. */
  clusterProviderNames?: string[];
  /** Dynamic score floor for cluster providers. Defaults to 0.2. */
  clusterScoreMin?: number;
  /** Dynamic score cap and default score for cluster providers. Defaults to 0.5. */
  clusterScoreMax?: number;
}

/**
 * 每个 LLM provider 的运行时评分（默认 1.0）。
 *
 * 设计动机：
 *  - 配置允许给一个角色挂多个 provider；运行时按评分降序选择当前"最可信"的。
 *  - 评分会随成功/失败动态调整：失败 -0.5 直到 0.1；成功 +0.1 直到 cap=1。
 *  - Workflow 输出关闭自动响应加分，改由 Enhance 归因、Bug 修复验证和 CR 门禁结果反馈。
 *  - `llm_scores.yaml` 是 XCompiler 维护的动态快照；它不是用户策略文件。
 *  - 用户手动覆盖写在 `llm_scores_user.yaml`；其中 score=0 表示禁用，并且优先生效。
 *  - preflight 检测到 ollama 服务器上**模型不存在**会在当前运行跳过该 provider，并把评分降到 0.1。
 *  - 动态评分持久化到 config 同目录的 sidecar 文件 `llm_scores.yaml`，避免改写用户的 config.yaml。
 */
export class ScoreStore {
  static readonly DEFAULT = 1.0;
  static readonly DISABLED = 0;
  static readonly MIN = 0.1;
  static readonly MAX = 1.0;
  static readonly CLUSTER_MIN = 0.2;
  static readonly CLUSTER_MAX = 0.5;
  static readonly DECAY = 0.5;
  static readonly BOOST = 0.1;

  private readonly dynamicScores = new Map<string, number>();
  private readonly userScores = new Map<string, number>();
  private readonly clusterProviders: Set<string>;
  private readonly clusterMin: number;
  private readonly clusterMax: number;
  private dirty = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly sidecarPath: string;
  private readonly userScoresPath: string;

  constructor(
    configPath: string,
    private readonly audit?: AuditLogger,
    opts: ScoreStoreOptions = {},
  ) {
    const configDir = path.dirname(configPath);
    this.sidecarPath = path.join(configDir, LLM_DYNAMIC_SCORES_FILE);
    this.userScoresPath = path.join(configDir, LLM_USER_SCORES_FILE);
    this.clusterProviders = new Set(opts.clusterProviderNames ?? []);
    const bounds = normalizeClusterBounds(opts.clusterScoreMin, opts.clusterScoreMax);
    this.clusterMin = bounds.min;
    this.clusterMax = bounds.max;
  }

  /** Load XCompiler-maintained dynamic scores and explicit user overrides. */
  async load(): Promise<void> {
    await this.loadDynamicScores();
    await this.loadUserScores();
  }

  private async loadDynamicScores(): Promise<void> {
    try {
      const raw = await fs.readFile(this.sidecarPath, 'utf8');
      const parsed = YAML.parse(raw) as Record<string, number> | null;
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v)) {
            this.dynamicScores.set(k, this.clampPersistedDynamic(k, v));
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 文件存在但解析失败：保留 ctor 初值，记一笔 audit 但不阻断启动。
        await this.audit?.event('llm.error', t().llm.scoreReadFailed(this.sidecarPath, (err as Error).message), {
          messageId: 'llm.score_read_failed',
          sidecarPath: this.sidecarPath,
        });
      }
    }
  }

  private async loadUserScores(): Promise<void> {
    try {
      const raw = await fs.readFile(this.userScoresPath, 'utf8');
      const parsed = YAML.parse(raw) as Record<string, number> | null;
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v)) {
            this.userScores.set(k, this.clampUserScore(v));
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.audit?.event('llm.error', t().llm.scoreReadFailed(this.userScoresPath, (err as Error).message), {
          messageId: 'llm.user_score_read_failed',
          sidecarPath: this.userScoresPath,
        });
      }
    }
  }

  get(name: string): number {
    if (this.userScores.has(name)) return this.userScores.get(name)!;
    return this.dynamicScores.has(name) ? this.dynamicScores.get(name)! : this.defaultFor(name);
  }

  /** 主动设置动态评分；用户覆盖只从配置或 llm_scores_user.yaml 读取。 */
  set(name: string, value: number, reason?: string): void {
    const v = value === ScoreStore.DISABLED ? ScoreStore.DISABLED : this.clampDynamic(name, value);
    const prev = this.dynamicScores.get(name);
    if (prev === v) return;
    this.dynamicScores.set(name, v);
    this.dirty = true;
    void this.audit?.event('llm.score', t().llm.scoreChanged(name, v.toFixed(2), (prev ?? this.defaultFor(name)).toFixed(2)), {
      messageId: 'llm.score_changed', provider: name, score: v, previous: prev ?? this.defaultFor(name), reason: reason ?? 'set',
    });
    this.scheduleSave();
  }

  decay(name: string, reason: string): void {
    if (this.isUserDisabled(name)) return;
    const cur = this.dynamicScore(name);
    if (cur === ScoreStore.DISABLED) return;
    this.set(name, Math.max(this.minFor(name), cur - ScoreStore.DECAY), reason);
  }

  boost(name: string, reason: string): void {
    if (this.isUserDisabled(name)) return;
    const cur = this.dynamicScore(name);
    if (cur === ScoreStore.DISABLED) return;
    if (cur >= this.maxFor(name)) return;
    this.set(name, Math.min(this.maxFor(name), cur + ScoreStore.BOOST), reason);
  }

  /** True only for providers explicitly disabled by user config or llm_scores_user.yaml. */
  isUserDisabled(name: string): boolean {
    return this.userScores.get(name) === ScoreStore.DISABLED;
  }

  /** 动态评分快照（用于持久化、测试与 audit 输出；不包含用户覆盖）。 */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.dynamicScores) out[k] = v;
    return out;
  }

  /** 用户覆盖快照（用于测试/诊断；运行时不会改写用户文件）。 */
  userSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.userScores) out[k] = v;
    return out;
  }

  /** 等待待写入完成（CLI 退出前调用，确保评分已落盘）。 */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private scheduleSave(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.writeQueue = this.writeQueue.then(() => this.persist()).catch(async (err) => {
      await this.audit?.event('llm.error', t().llm.scorePersistFailed((err as Error).message), {
        messageId: 'llm.score_persist_failed',
        sidecarPath: this.sidecarPath,
      });
    });
  }

  private async persist(): Promise<void> {
    const data = this.snapshot();
    const yaml =
      `${t().llm.scoreFileHeader}\n` +
      `${t().llm.scoreFileSemantics}\n` +
      YAML.stringify(data);
    const tmp = `${this.sidecarPath}.tmp`;
    await fs.writeFile(tmp, yaml, 'utf8');
    await fs.rename(tmp, this.sidecarPath);
  }

  private defaultFor(name: string): number {
    return this.isClusterProvider(name) ? this.clusterMax : ScoreStore.DEFAULT;
  }

  private minFor(name: string): number {
    return this.isClusterProvider(name) ? this.clusterMin : ScoreStore.MIN;
  }

  private maxFor(name: string): number {
    return this.isClusterProvider(name) ? this.clusterMax : ScoreStore.MAX;
  }

  private isClusterProvider(name: string): boolean {
    return this.clusterProviders.has(name);
  }

  private dynamicScore(name: string): number {
    return this.dynamicScores.has(name) ? this.dynamicScores.get(name)! : this.defaultFor(name);
  }

  private clampDynamic(name: string, v: number): number {
    if (!Number.isFinite(v)) return this.defaultFor(name);
    if (v <= ScoreStore.DISABLED) return this.minFor(name);
    if (v < this.minFor(name)) return this.minFor(name);
    if (v > this.maxFor(name)) return this.maxFor(name);
    return v;
  }

  private clampPersistedDynamic(name: string, v: number): number {
    if (!Number.isFinite(v)) return this.defaultFor(name);
    if (v === ScoreStore.DISABLED) return ScoreStore.DISABLED;
    return this.clampDynamic(name, v);
  }

  private clampUserScore(v: number): number {
    if (!Number.isFinite(v)) return ScoreStore.DEFAULT;
    if (v <= ScoreStore.DISABLED) return ScoreStore.DISABLED;
    if (v < ScoreStore.MIN) return ScoreStore.MIN;
    if (v > ScoreStore.MAX) return ScoreStore.MAX;
    return v;
  }
}

function normalizeClusterBounds(rawMin?: number, rawMax?: number): { min: number; max: number } {
  const min = clampBound(rawMin ?? ScoreStore.CLUSTER_MIN);
  const max = clampBound(rawMax ?? ScoreStore.CLUSTER_MAX);
  return min <= max ? { min, max } : { min: max, max: min };
}

function clampBound(v: number): number {
  if (!Number.isFinite(v)) return ScoreStore.CLUSTER_MIN;
  if (v < ScoreStore.MIN) return ScoreStore.MIN;
  if (v > ScoreStore.MAX) return ScoreStore.MAX;
  return v;
}

export function scoreStoreOptionsFromConfig(llm: XCompilerConfig['llm']): ScoreStoreOptions {
  return {
    clusterProviderNames: Object.entries(llm.providers)
      .filter(([, provider]) => (provider.tags ?? []).includes(CLUSTER_PROVIDER_TAG))
      .map(([name]) => name),
    clusterScoreMin: llm.cluster_score_min,
    clusterScoreMax: llm.cluster_score_max,
  };
}
