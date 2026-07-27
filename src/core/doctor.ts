/**
 * Startup environment self-check ("doctor"):
 *  - config: load config.yaml and report parse / schema errors.
 *  - LLM:    enumerate providers → probe ollama /api/tags or openai /models →
 *            verify each provider's model is actually available → check that
 *            every declared role has at least one live (reachable + enabled)
 *            provider.
 *  - sandbox: verify the configured Python and TypeScript sandbox profiles.
 *  - skills: build the default skill registry and verify every referenced tool
 *            is registered in the default tool registry.
 */
import { loadConfigWithPath, type XCompilerConfig } from '../config/config.js';
import {
  fetchOllamaTags,
  fetchOpenAIModels,
  isOllamaProvider,
  isOpenAICompatibleProvider,
  normalizeBaseUrl,
} from '../llm/health.js';
import { execRaw } from '../sandbox/subprocess.js';
import { isRunningInContainer } from '../sandbox/factory.js';
import { buildDefaultRegistry } from '../tools/index.js';
import { buildDefaultSkills } from '../skills/skill.js';
import { ScoreStore, scoreStoreOptionsFromConfig } from '../llm/scores.js';
import { t } from '../i18n/index.js';
import type { Language } from './plan.js';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckItem {
  level: CheckLevel;
  message: string;
}

export interface CheckSection {
  title: string;
  items: CheckItem[];
}

export interface DoctorReport {
  sections: CheckSection[];
  fails: number;
  warns: number;
}

export interface DoctorOptions {
  configPath?: string;
  /** Probe timeout for LLM endpoints (ms). Default 3000. */
  probeTimeoutMs?: number;
  /** Skip outbound network probes (used by tests). */
  skipNetwork?: boolean;
  /** Override score lookup (defaults to config.llm.scores). */
  scoreStore?: ScoreStore;
}

/**
 * Run the full environment check. Always returns a report — does not throw.
 * Fatal config-load errors are recorded as a single fail item under [config].
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const M = t().doctor;
  const sections: CheckSection[] = [];
  const probeTimeoutMs = opts.probeTimeoutMs ?? 3000;

  // 1) config
  const cfgSection: CheckSection = { title: M.sectionConfig, items: [] };
  let cfg: XCompilerConfig;
  let cfgPath: string;
  try {
    const loaded = await loadConfigWithPath(opts.configPath);
    cfg = loaded.config;
    cfgPath = loaded.path;
    cfgSection.items.push({ level: 'ok', message: M.configLoadOk(loaded.path) });
    cfgSection.items.push({ level: 'ok', message: M.configLocale(cfg.locale) });
  } catch (err) {
    cfgSection.items.push({ level: 'fail', message: M.configLoadFail((err as Error).message) });
    sections.push(cfgSection);
    return finalize(sections);
  }
  sections.push(cfgSection);

  const scores = opts.scoreStore ?? new ScoreStore(cfgPath, undefined, scoreStoreOptionsFromConfig(cfg.llm));
  await scores.load().catch(() => undefined);

  // 2) LLM
  sections.push(await checkLlm(cfg, scores, probeTimeoutMs, !!opts.skipNetwork));

  // 3) sandbox
  sections.push(await checkSandbox(cfg, !!opts.skipNetwork));

  // 4) skills
  sections.push(checkSkills());

  return finalize(sections);
}

function finalize(sections: CheckSection[]): DoctorReport {
  let fails = 0;
  let warns = 0;
  for (const s of sections) {
    for (const it of s.items) {
      if (it.level === 'fail') fails++;
      else if (it.level === 'warn') warns++;
    }
  }
  return { sections, fails, warns };
}

async function checkLlm(
  cfg: XCompilerConfig,
  scores: ScoreStore,
  probeTimeoutMs: number,
  skipNetwork: boolean,
): Promise<CheckSection> {
  const M = t().doctor;
  const sec: CheckSection = { title: M.sectionLLM, items: [] };
  const providers = Object.entries(cfg.llm.providers);
  if (providers.length === 0) {
    sec.items.push({ level: 'fail', message: M.llmNoProviders });
    return sec;
  }
  sec.items.push({ level: 'ok', message: M.llmProviderListed(providers.length) });

  const referencedProviders = new Set<string>([
    ...(cfg.llm.fallbacks ?? []),
    ...Object.values(cfg.llm.roles ?? {}).flat(),
    ...Object.values(cfg.llm.role_fallbacks ?? {}).flat(),
  ]);

  // Group ollama providers by base_url so we only probe each server once.
  const ollamaByUrl = new Map<string, Array<{ name: string; model: string }>>();
  const openaiList: Array<{ name: string; baseUrl: string; apiKey: string; model: string; requiresApiKey: boolean }> = [];
  for (const [name, p] of providers) {
    if (isOllamaProvider(p)) {
      const url = normalizeBaseUrl(p.base_url, 'http://localhost:11434');
      const arr = ollamaByUrl.get(url) ?? [];
      arr.push({ name, model: p.model });
      ollamaByUrl.set(url, arr);
    } else if (isOpenAICompatibleProvider(p)) {
      const baseUrl = normalizeBaseUrl(p.base_url, 'https://api.openai.com/v1');
      openaiList.push({
        name,
        baseUrl,
        apiKey: p.api_key ?? '',
        model: p.model,
        requiresApiKey: openAIEndpointRequiresApiKey(baseUrl),
      });
    }
  }

  // 2a) ollama: connection + model scan
  const ollamaTags = new Map<string, string[] | null>(); // null = unreachable
  for (const [baseUrl, group] of ollamaByUrl) {
    if (skipNetwork) {
      ollamaTags.set(baseUrl, []);
      continue;
    }
    try {
      const tags = await fetchOllamaTags(baseUrl, probeTimeoutMs);
      ollamaTags.set(baseUrl, tags);
      sec.items.push({ level: 'ok', message: M.ollamaReachable(baseUrl, tags.length) });
    } catch (err) {
      ollamaTags.set(baseUrl, null);
      sec.items.push({ level: 'fail', message: M.ollamaUnreachable(baseUrl, (err as Error).message) });
    }
    for (const p of group) {
      const tags = ollamaTags.get(baseUrl);
      if (!tags) continue; // unreachable — already reported
      if (!tags.includes(p.model)) {
        sec.items.push({ level: 'fail', message: M.ollamaModelMissing(p.name, p.model, baseUrl) });
      } else {
        sec.items.push({ level: 'ok', message: M.ollamaModelOk(p.name, p.model) });
      }
    }
  }

  // 2b) openai: api_key + connection (+ model membership warn)
  for (const p of openaiList) {
    if (p.requiresApiKey && !p.apiKey) {
      sec.items.push({
        level: referencedProviders.has(p.name) ? 'fail' : 'warn',
        message: M.openaiKeyMissing(p.name),
      });
      continue;
    }
    if (skipNetwork) continue;
    try {
      const models = await fetchOpenAIModels(p.baseUrl, p.apiKey, probeTimeoutMs);
      sec.items.push({ level: 'ok', message: M.openaiReachable(p.name, p.baseUrl) });
      if (models.length > 0 && !models.includes(p.model)) {
        sec.items.push({ level: 'warn', message: M.openaiModelListMissing(p.name, p.model) });
      }
    } catch (err) {
      sec.items.push({
        level: 'fail',
        message: M.openaiUnreachable(p.name, p.baseUrl, (err as Error).message),
      });
    }
  }

  // 2c) provider scores
  for (const [name] of providers) {
    if (scores.get(name) === 0) {
      sec.items.push({ level: 'warn', message: M.providerScoreZero(name) });
    }
  }

  // 2d) role coverage
  const roles = new Set<string>([
    ...Object.keys(cfg.llm.roles ?? {}),
    ...Object.keys(cfg.llm.role_fallbacks ?? {}),
  ]);
  for (const role of roles) {
    const cands = candidatesForRole(cfg, role);
    const live = cands.find((n) => {
      if (scores.get(n) === 0) return false;
      const prov = cfg.llm.providers[n];
      if (!prov) return false;
      if (isOllamaProvider(prov)) {
        const url = normalizeBaseUrl(prov.base_url, 'http://localhost:11434');
        const tags = ollamaTags.get(url);
        if (!tags) return false;
        return tags.includes(prov.model);
      }
      if (isOpenAICompatibleProvider(prov)) {
        const baseUrl = normalizeBaseUrl(prov.base_url, 'https://api.openai.com/v1');
        return !openAIEndpointRequiresApiKey(baseUrl) || (prov.api_key ?? '').length > 0;
      }
      return false;
    });
    if (!live) {
      sec.items.push({ level: 'fail', message: M.roleNoLiveProvider(role) });
    } else {
      sec.items.push({ level: 'ok', message: M.roleOk(role, live) });
    }
  }

  return sec;
}

function candidatesForRole(cfg: XCompilerConfig, role: string): string[] {
  const explicit = cfg.llm.role_fallbacks?.[role];
  if (explicit && explicit.length > 0) return explicit;
  return [...(cfg.llm.roles?.[role] ?? []), ...(cfg.llm.fallbacks ?? [])];
}

function openAIEndpointRequiresApiKey(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.openai.com' || host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

async function checkSandbox(cfg: XCompilerConfig, skipNetwork: boolean): Promise<CheckSection> {
  const M = t().doctor;
  const sec: CheckSection = { title: M.sectionSandbox, items: [] };
  for (const language of ['python', 'typescript'] as const) {
    const sandbox = cfg.agent.sandboxes[language];
    const kind = sandbox.mode;
    const limits = kind === 'docker' ? sandbox.docker.limits : sandbox.local.limits;
    const ports = limits.expose_ports ?? [];
    sec.items.push({ level: 'ok', message: M.sandboxKind(`${language}/${kind}`) });
    sec.items.push({ level: 'ok', message: M.sandboxNetworkPolicy(limits.network, ports) });
    if (limits.network === 'full' && ports.length === 0) {
      sec.items.push({ level: 'warn', message: M.sandboxFullNoPorts });
    }
    if (kind === 'subprocess') {
      await checkSubprocessLanguage(sec, language);
    } else if (kind === 'docker') {
      await checkDockerSandbox(sec, sandbox.docker.docker_bin || 'docker', skipNetwork);
    }
  }
  return sec;
}

async function checkSubprocessLanguage(sec: CheckSection, language: Language): Promise<void> {
  const M = t().doctor;
  if (language === 'typescript') {
    const node = await execRaw('node', ['--version'], { timeoutMs: 5_000 });
    if (node.exitCode !== 0) {
      sec.items.push({ level: 'fail', message: M.sandboxNodeMissing });
      return;
    }
    sec.items.push({ level: 'ok', message: M.sandboxNodeOk((node.stdout || node.stderr).trim()) });
    const npm = await execRaw('npm', ['--version'], { timeoutMs: 5_000 });
    if (npm.exitCode !== 0) {
      sec.items.push({ level: 'fail', message: M.sandboxNpmMissing });
      return;
    }
    sec.items.push({ level: 'ok', message: M.sandboxNpmOk((npm.stdout || npm.stderr).trim()) });
    const npx = await execRaw('npx', ['--version'], { timeoutMs: 5_000 });
    if (npx.exitCode !== 0) {
      sec.items.push({ level: 'fail', message: M.sandboxNpxMissing });
      return;
    }
    sec.items.push({ level: 'ok', message: M.sandboxNpxOk((npx.stdout || npx.stderr).trim()) });
    return;
  }
  const v = await execRaw('python3', ['--version'], { timeoutMs: 5_000 });
  if (v.exitCode !== 0) {
    sec.items.push({ level: 'fail', message: M.sandboxPythonMissing });
    return;
  }
  sec.items.push({ level: 'ok', message: M.sandboxPythonOk((v.stdout || v.stderr).trim()) });
  const venv = await execRaw('python3', ['-m', 'venv', '--help'], { timeoutMs: 5_000 });
  if (venv.exitCode !== 0) {
    sec.items.push({ level: 'fail', message: M.sandboxVenvMissing });
  } else {
    sec.items.push({ level: 'ok', message: M.sandboxVenvOk });
  }
}

async function checkDockerSandbox(sec: CheckSection, bin: string, skipNetwork: boolean): Promise<void> {
  const M = t().doctor;
  if (isRunningInContainer()) {
    sec.items.push({ level: 'fail', message: M.sandboxInContainerWarn });
  }
  const v = await execRaw(bin, ['--version'], { timeoutMs: 5_000 });
  if (v.exitCode !== 0) {
    sec.items.push({ level: 'fail', message: M.sandboxDockerMissing(bin) });
    return;
  }
  sec.items.push({ level: 'ok', message: M.sandboxDockerOk((v.stdout || v.stderr).trim()) });
  if (skipNetwork) return;
  const info = await execRaw(bin, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 5_000 });
  if (info.exitCode !== 0) {
    sec.items.push({
      level: 'fail',
      message: M.sandboxDockerDaemonDown((info.stderr || info.stdout || '').trim().slice(0, 200)),
    });
  }
}

function checkSkills(): CheckSection {
  const M = t().doctor;
  const sec: CheckSection = { title: M.sectionSkills, items: [] };
  const tools = buildDefaultRegistry();
  const known = new Set(tools.list().map((t) => t.name));
  const skills = buildDefaultSkills().list();
  let referenced = 0;
  let bad = 0;
  for (const s of skills) {
    for (const tn of s.tools) {
      referenced++;
      if (!known.has(tn)) {
        bad++;
        sec.items.push({ level: 'fail', message: M.skillToolMissing(s.name, tn) });
      }
    }
  }
  if (bad === 0) {
    sec.items.push({ level: 'ok', message: M.skillOk(skills.length, referenced) });
  }
  return sec;
}
