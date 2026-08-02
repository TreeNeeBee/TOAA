import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import 'dotenv/config';
import { xcEnv } from './env.js';
import { ROLES } from '../core/plan.js';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../llm/window.js';

const ProviderStringScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const OptionalProviderStringSchema = ProviderStringScalarSchema.nullish().transform((v) =>
  v == null ? '' : String(v),
);
const RequiredProviderStringSchema = ProviderStringScalarSchema.transform((v) => String(v)).pipe(
  z.string().min(1),
);
const ProviderAccessTypeSchema = z.enum(['openai', 'ollama']);
const JsonResponseFormatSchema = z.enum(['json_object', 'json_schema', 'none']);
const ProviderTagsSchema = z.array(z.string().min(1)).optional().transform((tags) =>
  tags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean),
);
const ContextWindowSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  if (!normalized) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/iu.exec(normalized);
  if (!match) return value;
  const amount = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === 'm'
    ? 1024 * 1024
    : match[2]?.toLowerCase() === 'k'
      ? 1024
      : 1;
  return Math.floor(amount * multiplier);
}, z.number().int().positive().default(DEFAULT_CONTEXT_WINDOW_TOKENS));

const ProviderSchema = z.object({
  /**
   * Transport/API family used by this provider.
   *  - openai: OpenAI-compatible /v1/chat/completions endpoint, including OpenRouter, vLLM, mlx-server.
   *  - ollama: native Ollama /api/chat endpoint.
   */
  type: ProviderAccessTypeSchema,
  api_key: OptionalProviderStringSchema,
  base_url: OptionalProviderStringSchema,
  model: RequiredProviderStringSchema,
  /** Model input+output context capacity. Empty or omitted values default to 128K tokens. */
  context_window: ContextWindowSchema,
  /**
   * Provider labels used by runtime policy.
   * - cluster: aggregated/route provider such as OpenRouter free routes. These are
   *   useful backups but should start below dedicated providers in score ranking.
   */
  tags: ProviderTagsSchema,
  /** 非流式总超时；流式请求仅在首个内容 token 前生效。默认 15 分钟。0 = 不限制。 */
  request_timeout_ms: z.number().int().nonnegative().optional(),
  /** OpenAI-compatible DNS/TCP/TLS 建连超时（毫秒）。默认 60 秒。0 = 不限制。 */
  connect_timeout_ms: z.number().int().nonnegative().optional(),
  /** 收到首个 token 后的流式空闲超时（毫秒）。默认值由 transport 决定。0 = 不限制。 */
  stream_idle_timeout_ms: z.number().int().nonnegative().optional(),
  /** 等待首个流式 token 的超时（毫秒）。默认 5 分钟。0 = 不限制。 */
  stream_first_token_timeout_ms: z.number().int().nonnegative().optional(),
  /** 流式异常保护阈值。真实有效输出不会因长度本身被截断；0 = 关闭该阈值。 */
  max_output_chars: z.number().int().nonnegative().optional(),
  /**
   * OpenAI-compatible structured JSON response format.
   * Some providers (for example selected OpenRouter routes) do not support
   * `json_object` but do support `json_schema`.
   */
  json_response_format: JsonResponseFormatSchema.optional(),
  /** Ollama thinking 模型是否启用长思考；弱服务器上的结构化任务可设为 false。 */
  think: z.boolean().optional(),
});

const LocaleSchema = z.enum(['en', 'zh']);
const SandboxModeSchema = z.enum(['subprocess', 'docker', 'firejail']);

const SandboxLimitsSchema = z
  .object({
    cpu: z.number().positive().default(1),
    memory_mb: z.number().int().positive().default(1024),
    wall_seconds: z.number().int().positive().default(60),
    /**
     * Sandbox network policy.
     *  - `off`            — no network at all (`docker --network none`).
     *  - `download-only`  — outbound traffic allowed, no inbound port publishing.
     *  - `full`           — outbound + every port in `expose_ports` is published
     *                       to `127.0.0.1` so host-side tests can reach the app.
     */
    network: z.enum(['off', 'download-only', 'full']).default('download-only'),
    /** Container ports to publish to 127.0.0.1 when `network=full`. */
    expose_ports: z.array(z.number().int().min(1).max(65535)).default([]),
  })
  .default({
    cpu: 1,
    memory_mb: 1024,
    wall_seconds: 60,
    network: 'download-only',
    expose_ports: [],
  });

const LocalSandboxSchema = z
  .object({
    sandbox_dir: z.string().min(1).optional(),
    python_bin: z.string().min(1).optional(),
    inherit_env: z.boolean().default(false),
    limits: SandboxLimitsSchema,
  })
  .default(() => ({ inherit_env: false, limits: defaultSandboxLimits() }));

const DockerSandboxSchema = z
  .object({
    image: z.string().default('python:3.11-slim'),
    workdir: z.string().default('/workspace'),
    pull: z.boolean().default(false),
    docker_bin: z.string().default('docker'),
    extra_run_args: z.array(z.string()).default([]),
    sandbox_dir: z.string().min(1).optional(),
    limits: SandboxLimitsSchema,
  })
  .default({
    image: 'python:3.11-slim',
    workdir: '/workspace',
    pull: false,
    docker_bin: 'docker',
    extra_run_args: [],
    limits: defaultSandboxLimits(),
  });

const LanguageSandboxSchema = z
  .object({
    mode: SandboxModeSchema.default('subprocess'),
    local: LocalSandboxSchema,
    docker: DockerSandboxSchema,
  })
  .default(() => ({
    mode: 'subprocess' as const,
    local: { inherit_env: false, limits: defaultSandboxLimits() },
    docker: {
      image: 'python:3.11-slim',
      workdir: '/workspace',
      pull: false,
      docker_bin: 'docker',
      extra_run_args: [],
      limits: defaultSandboxLimits(),
    },
  }));

const SandboxesSchema = z
  .object({
    python: LanguageSandboxSchema.optional(),
    typescript: LanguageSandboxSchema.optional(),
  })
  .default({})
  .transform((sandboxes) => ({
    python: mergeLanguageSandbox(
      defaultLanguageSandbox('python', 'subprocess', defaultSandboxLimits()),
      sandboxes.python,
    ),
    typescript: mergeLanguageSandbox(
      defaultLanguageSandbox('typescript', 'subprocess', defaultSandboxLimits()),
      sandboxes.typescript,
    ),
  }));

const LlmSchema = z.object({
  providers: z.record(z.string(), ProviderSchema),
  /**
   * 角色 → provider 数组的映射。
   * 数组形式 `Coder: [ollama_code, openai]` 表示该角色的候选 LLM 池；
   * 实际选择顺序由 ScoreStore 有效评分降序决定；有效评分为用户覆盖优先，否则使用动态评分。
   */
  roles: z.record(z.string(), z.array(z.string())).default({}),
  /** 全局 fallback 链：当主 provider 调用报错时依次尝试 */
  fallbacks: z.array(z.string()).default([]),
  /** 可选：按角色指定 fallback 链（覆盖全局） */
  role_fallbacks: z.record(z.string(), z.array(z.string())).default({}),
  /**
   * Providers tagged `cluster` (for example aggregated free routes) use this
   * narrower dynamic score range so they naturally remain backup choices.
   */
  cluster_score_min: z.number().min(0.1).max(1).optional(),
  cluster_score_max: z.number().min(0.1).max(1).optional(),
}).strict().superRefine((llm, ctx) => {
  for (const role of ROLES) {
    const explicit = llm.role_fallbacks[role] ?? [];
    const pool = llm.roles[role] ?? [];
    if (explicit.length === 0 && pool.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles', role],
        message:
          `llm.roles.${role} must list at least one provider: ` +
          'model selection is manual (llm.default has been removed).',
      });
    }
  }
  const min = llm.cluster_score_min ?? 0.2;
  const max = llm.cluster_score_max ?? 0.5;
  if (min > max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cluster_score_min'],
      message: 'cluster_score_min must be less than or equal to cluster_score_max',
    });
  }
});

const AgentSchema = z.object({
    max_rounds_per_step: z.number().int().positive().default(6),
    max_debug_rounds_per_step: z.number().int().positive().optional(),
    max_edit_lines_per_step: z.union([z.literal('auto'), z.number().int().positive()]).default('auto'),
    max_write_chunk_bytes: z.union([z.literal('auto'), z.number().int().positive()]).default('auto'),
    sandboxes: SandboxesSchema,
  }).strict();

const ConfigSchema = z.object({
  /** CLI / prompt locale. Accepts 'en' (default) or 'zh'. */
  locale: LocaleSchema.default('en'),
  llm: LlmSchema,
  agent: AgentSchema,
}).strict();

export type XCompilerConfig = z.infer<typeof ConfigSchema>;

type NormalizedSandboxLimits = z.infer<typeof SandboxLimitsSchema>;
type NormalizedLanguageSandbox = z.infer<typeof LanguageSandboxSchema>;

function defaultSandboxLimits(): NormalizedSandboxLimits {
  return {
    cpu: 1,
    memory_mb: 1024,
    wall_seconds: 60,
    network: 'download-only',
    expose_ports: [],
  };
}

function defaultLanguageSandbox(
  language: 'python' | 'typescript',
  mode: 'subprocess' | 'docker' | 'firejail',
  limits: NormalizedSandboxLimits,
): NormalizedLanguageSandbox {
  return {
    mode,
    local: {
      sandbox_dir: `.sandbox/${language}`,
      inherit_env: false,
      limits: { ...limits, expose_ports: [...(limits.expose_ports ?? [])] },
    },
    docker: {
      image: language === 'typescript' ? 'node:24-slim' : 'python:3.11-slim',
      workdir: '/workspace',
      pull: false,
      docker_bin: 'docker',
      extra_run_args: [],
      sandbox_dir: `.sandbox/${language}`,
      limits: { ...limits, expose_ports: [...(limits.expose_ports ?? [])] },
    },
  };
}

function mergeLanguageSandbox(
  defaults: NormalizedLanguageSandbox,
  override?: NormalizedLanguageSandbox,
): NormalizedLanguageSandbox {
  const dockerOverride = override?.docker;
  return {
    mode: override?.mode ?? defaults.mode,
    local: {
      ...defaults.local,
      ...(override?.local ?? {}),
      limits: override?.local?.limits ?? defaults.local.limits,
    },
    docker: {
      ...defaults.docker,
      ...(dockerOverride ?? {}),
      limits: dockerOverride?.limits ?? defaults.docker.limits,
    },
  };
}

/**
 * 配置文件查找顺序（优先级从高到低）：
 *   1. 显式 --config / explicitPath
 *   2. 当前目录 ./config.yaml
 *   3. $XC_PATH/config.yaml            （安装/全局配置目录，默认 ~/.xc）
 *   4. 当前目录 ./config.example.yaml  （仓库 fallback）
 *   5. $XC_PATH/config.example.yaml
 */
export function getXCompilerPath(): string {
  const env = xcEnv('PATH');
  if (env && env.trim()) return path.resolve(env.trim());
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/root';
  return path.join(home, '.xc');
}

function defaultSearchPaths(): string[] {
  const xcompilerPath = getXCompilerPath();
  return [
    path.resolve('config.yaml'),
    path.join(xcompilerPath, 'config.yaml'),
    path.resolve('config.example.yaml'),
    path.join(xcompilerPath, 'config.example.yaml'),
  ];
}

export async function loadConfig(explicitPath?: string): Promise<XCompilerConfig> {
  const r = await loadConfigWithPath(explicitPath);
  return r.config;
}

export interface LoadedConfig {
  config: XCompilerConfig;
  /** 实际命中的 config 文件绝对路径（供 ScoreStore 在同目录下落盘 sidecar 评分文件）。 */
  path: string;
  /** Referenced environment variables that were absent and expanded to empty strings. */
  missingEnv: string[];
}

export async function loadConfigWithPath(explicitPath?: string): Promise<LoadedConfig> {
  const tried: string[] = [];
  const candidates = explicitPath ? [path.resolve(explicitPath)] : defaultSearchPaths();
  for (const abs of candidates) {
    tried.push(abs);
    try {
      const raw = await fs.readFile(abs, 'utf8');
      const expanded = expandEnv(raw);
      const data = YAML.parse(expanded.text);
      return { config: ConfigSchema.parse(data), path: abs, missingEnv: expanded.missing };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  throw new Error(
    `No config file found. Tried (in order):\n  ${tried.join('\n  ')}\n` +
      `\nHint: set XC_PATH to point at a directory containing config.yaml, ` +
      `or create a local config.yaml from config.example.yaml before running XCompiler. ` +
      `The npm package ships config.example.yaml as a template; config.yaml is your local runtime config.`,
  );
}

function expandEnv(s: string): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const out = s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined || v === '') {
      missing.add(name);
      return '';
    }
    return v;
  });
  return { text: out, missing: [...missing] };
}
