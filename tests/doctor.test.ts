import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { runDoctor } from '../src/core/doctor.js';
import { setLocale } from '../src/i18n/index.js';

setLocale('en');

function allRoles(provider: string): Record<string, string[]> {
  return {
    Planner: [provider],
    Architect: [provider],
    Coder: [provider],
    Tester: [provider],
    Debugger: [provider],
  };
}

async function writeCfg(overrides: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-doctor-'));
  const cfgPath = path.join(dir, 'config.yaml');
  const base = {
    locale: 'en',
    llm: {
      providers: {
        ollama_code: { type: 'ollama', api_key: '', base_url: 'http://localhost:11434', model: 'qwen' },
      },
      roles: allRoles('ollama_code'),
      fallbacks: [],
      role_fallbacks: {},
    },
    agent: {
      sandboxes: {
        python: { mode: 'subprocess' },
        typescript: { mode: 'subprocess' },
      },
    },
    ...overrides,
  };
  await fs.writeFile(cfgPath, YAML.stringify(base), 'utf8');
  return cfgPath;
}

describe('doctor', () => {
  it('reports config-load failure as a single fail item', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-doctor-'));
    const cfgPath = path.join(dir, 'config.yaml');
    await fs.writeFile(cfgPath, 'this is: not: valid: yaml: [', 'utf8');
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    expect(r.fails).toBeGreaterThanOrEqual(1);
    expect(r.sections[0]!.items[0]!.message).toMatch(/failed to load config/i);
  });

  it('reports OK for sane config when network probes are skipped', async () => {
    const cfgPath = await writeCfg({});
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    const titles = r.sections.map((s) => s.title);
    expect(titles).toContain('[config]');
    expect(titles).toContain('[LLM]');
    expect(titles).toContain('[sandbox]');
    expect(titles).toContain('[skills]');
  });

  it('flags openai provider with empty api_key', async () => {
    const cfgPath = await writeCfg({
      llm: {
        providers: {
          openai: { type: 'openai', api_key: '', base_url: 'https://api.openai.com/v1', model: 'gpt-4' },
        },
        roles: allRoles('openai'),
        fallbacks: [],
        role_fallbacks: {},
      },
    });
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    const llm = r.sections.find((s) => s.title === '[LLM]')!;
    expect(llm.items.some((i) => i.level === 'fail' && /api_key empty/i.test(i.message))).toBe(true);
  });

  it('flags OpenRouter provider with empty api_key', async () => {
    const cfgPath = await writeCfg({
      llm: {
        providers: {
          openrouter_free: {
            type: 'openai',
            api_key: '',
            base_url: 'https://openrouter.ai/api/v1',
            model: 'openrouter/free',
          },
        },
        roles: allRoles('openrouter_free'),
        fallbacks: [],
        role_fallbacks: {},
      },
    });
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    const llm = r.sections.find((s) => s.title === '[LLM]')!;
    expect(llm.items.some((i) => i.level === 'fail' && /api_key empty/i.test(i.message))).toBe(true);
    expect(llm.items.some((i) => i.level === 'fail' && /no live provider/i.test(i.message))).toBe(true);
  });

  it('allows local OpenAI-compatible provider without api_key', async () => {
    const cfgPath = await writeCfg({
      llm: {
        providers: {
          local_openai: {
            type: 'openai',
            api_key: '',
            base_url: 'http://127.0.0.1:8000/v1',
            model: 'local-model',
          },
        },
        roles: allRoles('local_openai'),
        fallbacks: [],
        role_fallbacks: {},
      },
    });
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    const llm = r.sections.find((s) => s.title === '[LLM]')!;
    expect(llm.items.some((i) => /api_key empty/i.test(i.message))).toBe(false);
    expect(llm.items.some((i) => i.level === 'ok' && /local_openai/u.test(i.message))).toBe(true);
  });

  it('only warns for an unused openai provider with empty api_key', async () => {
    const cfgPath = await writeCfg({
      llm: {
        providers: {
          ollama_code: { type: 'ollama', api_key: '', base_url: 'http://localhost:11434', model: 'qwen' },
          openai: { type: 'openai', api_key: '', base_url: 'https://api.openai.com/v1', model: 'gpt-4' },
        },
        roles: allRoles('ollama_code'),
        fallbacks: [],
        role_fallbacks: {},
      },
    });
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    const llm = r.sections.find((s) => s.title === '[LLM]')!;
    expect(llm.items.some((i) => i.level === 'warn' && /api_key empty/i.test(i.message))).toBe(true);
    expect(llm.items.some((i) => i.level === 'fail' && /api_key empty/i.test(i.message))).toBe(false);
  });

  it('flags role with no live provider (score=0)', async () => {
    const cfgPath = await writeCfg({
      llm: {
        providers: {
          ollama_code: { type: 'ollama', api_key: '', base_url: 'http://localhost:11434', model: 'qwen' },
        },
        roles: allRoles('ollama_code'),
        fallbacks: [],
        role_fallbacks: {},
      },
    });
    await fs.writeFile(
      path.join(path.dirname(cfgPath), 'llm_scores_user.yaml'),
      'ollama_code: 0\n',
      'utf8',
    );
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    const llm = r.sections.find((s) => s.title === '[LLM]')!;
    expect(llm.items.some((i) => i.level === 'fail' && /no live provider/i.test(i.message))).toBe(true);
  });

  it('does not report an unreachable OpenAI provider as live for any role', async () => {
    const cfgPath = await writeCfg({
      llm: {
        providers: {
          unreachable: {
            type: 'openai',
            api_key: '',
            base_url: 'http://127.0.0.1:1/v1',
            model: 'missing',
            connect_timeout_ms: 100,
          },
        },
        roles: allRoles('unreachable'),
        fallbacks: [],
        role_fallbacks: {},
      },
    });
    const r = await runDoctor({ configPath: cfgPath, probeTimeoutMs: 100 });
    const llm = r.sections.find((s) => s.title === '[LLM]')!;
    expect(llm.items.some((i) => i.level === 'fail' && /models check failed/i.test(i.message))).toBe(true);
    expect(llm.items.filter((i) => i.level === 'fail' && /no live provider/i.test(i.message))).toHaveLength(5);
    expect(llm.items.some((i) => i.level === 'ok' && /role .* ->/i.test(i.message))).toBe(false);
  });

  it('checks node/npm/npx prerequisites for TypeScript subprocess sandbox', async () => {
    const cfgPath = await writeCfg({
      agent: {
        sandboxes: {
          python: { mode: 'subprocess' },
          typescript: { mode: 'subprocess' },
        },
      },
    });
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    const sandbox = r.sections.find((s) => s.title === '[sandbox]')!;
    expect(sandbox.items.some((i) => /node OK/i.test(i.message))).toBe(true);
    expect(sandbox.items.some((i) => /npm OK/i.test(i.message))).toBe(true);
    expect(sandbox.items.some((i) => /npx OK/i.test(i.message))).toBe(true);
  });
});
