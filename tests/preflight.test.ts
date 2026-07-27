import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightProviders } from '../src/llm/preflight.js';
import { ScoreStore } from '../src/llm/scores.js';
import type { XCompilerConfig } from '../src/config/config.js';

function mkCfg(overrides: Partial<XCompilerConfig['llm']> = {}): XCompilerConfig {
  return {
    llm: {
      providers: {
        ollama_code: { type: 'ollama', api_key: '', base_url: 'http://srv', model: 'qwen' },
        ollama_design: { type: 'ollama', api_key: '', base_url: 'http://srv', model: 'gemma' },
      },
      roles: { Coder: ['ollama_code'], Planner: ['ollama_design'] },
      fallbacks: [],
      role_fallbacks: {},
      ...overrides,
    },
    agent: {
      max_steps: 1,
      max_debug_retries: 1,
      max_rounds_per_step: 6,
      max_edit_lines_per_step: 100,
      max_write_chunk_bytes: 'auto',
      sandboxes: {
        python: {
          mode: 'subprocess',
          local: { inherit_env: false, limits: { cpu: 1, memory_mb: 256, wall_seconds: 30, network: 'download-only', expose_ports: [] } },
          docker: { image: 'python:3.11-slim', workdir: '/workspace', pull: false, docker_bin: 'docker', extra_run_args: [], limits: { cpu: 1, memory_mb: 256, wall_seconds: 30, network: 'download-only', expose_ports: [] } },
        },
        typescript: {
          mode: 'subprocess',
          local: { inherit_env: false, limits: { cpu: 1, memory_mb: 256, wall_seconds: 30, network: 'download-only', expose_ports: [] } },
          docker: { image: 'node:24-slim', workdir: '/workspace', pull: false, docker_bin: 'docker', extra_run_args: [], limits: { cpu: 1, memory_mb: 256, wall_seconds: 30, network: 'download-only', expose_ports: [] } },
        },
      },
    },
  } as unknown as XCompilerConfig;
}

describe('preflightProviders', () => {
  it('marks provider unavailable and lowers score when its model is missing on the server', async () => {
    const cfg = mkCfg();
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const result = await preflightProviders(cfg, scores, undefined, {
      // server has only "qwen", "gemma" missing
      fetchTags: async () => ['qwen'],
    });
    expect(result.zeroed).toContain('ollama_design');
    expect(result.unreachable).toContain('ollama_design');
    expect(scores.get('ollama_design')).toBe(ScoreStore.MIN);
    expect(scores.get('ollama_code')).toBeGreaterThan(0);
  });

  it('restores score=1 when previously zeroed model returns', async () => {
    const cfg = mkCfg();
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_design', 0, 'previously missing');
    await preflightProviders(cfg, scores, undefined, {
      fetchTags: async () => ['qwen', 'gemma'],
    });
    expect(scores.get('ollama_design')).toBe(1);
  });

  it('auto-imports all server tags when a role has no live provider', async () => {
    // Coder role only has ollama_code, but the model is missing on the server.
    // Server offers two other models: 'mistral' and 'phi'.
    const cfg = mkCfg();
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const result = await preflightProviders(cfg, scores, undefined, {
      fetchTags: async () => ['mistral', 'phi'],
    });
    expect(result.zeroed).toContain('ollama_code');
    expect(result.zeroed).toContain('ollama_design');
    expect(Object.keys(result.autoAdded).length).toBeGreaterThanOrEqual(2);
    // Roles must now include the synthetic providers
    expect(cfg.llm.roles.Coder.some((n) => n.startsWith('auto_'))).toBe(true);
    expect(cfg.llm.roles.Planner.some((n) => n.startsWith('auto_'))).toBe(true);
    // The synthetic providers must exist with score=1
    for (const synth of Object.keys(result.autoAdded)) {
      expect(scores.get(synth)).toBe(1);
      expect(cfg.llm.providers[synth]).toBeTruthy();
    }
  });

  it('throws when no ollama server is reachable AND a role is empty', async () => {
    const cfg = mkCfg();
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0, 'pre-disabled');
    scores.set('ollama_design', 0, 'pre-disabled');
    await expect(
      preflightProviders(cfg, scores, undefined, {
        fetchTags: async () => {
          throw new Error('connection refused');
        },
      }),
    ).rejects.toThrow(/没有可用的 provider|没有任何 ollama 服务器可达/);
  });

  it('fails fast without permanently zeroing scores when all servers are unreachable', async () => {
    const cfg = mkCfg();
    const scores = new ScoreStore('/tmp/x/config.yaml');
    await expect(
      preflightProviders(cfg, scores, undefined, {
        fetchTags: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toThrow(/没有任何 ollama 服务器可达/);
    // A transient outage blocks this run but does not persistently disable providers.
    expect(scores.get('ollama_code')).toBe(1);
    expect(scores.get('ollama_design')).toBe(1);
  });

  it('continues with a configured fallback while excluding unreachable Ollama providers', async () => {
    const cfg = mkCfg({
      providers: {
        ollama_code: { type: 'ollama', api_key: '', base_url: 'http://srv', model: 'qwen' },
        ollama_design: { type: 'ollama', api_key: '', base_url: 'http://srv', model: 'gemma' },
        openai: { type: 'openai', api_key: 'k', base_url: 'http://openai', model: 'gpt' },
      },
      fallbacks: ['openai'],
    });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const result = await preflightProviders(cfg, scores, undefined, {
      fetchTags: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(result.unreachable).toEqual(['ollama_code', 'ollama_design']);
    expect(scores.get('ollama_code')).toBe(1);
  });

  it('revives a non-Ollama provider disabled by historical sidecar score', async () => {
    const cfg = mkCfg({
      providers: {
        openai: { type: 'openai', api_key: 'k', base_url: 'http://openai', model: 'gpt' },
      },
      roles: { Planner: ['openai'] },
    });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('openai', 0, 'previous transient failures');

    const result = await preflightProviders(cfg, scores);

    expect(result.revived).toEqual(['openai']);
    expect(scores.get('openai')).toBe(1);
  });

  it('respects an explicit user score=0 for non-Ollama providers', async () => {
    const cfg = mkCfg({
      providers: {
        openai: { type: 'openai', api_key: 'k', base_url: 'http://openai', model: 'gpt' },
      },
      roles: { Planner: ['openai'] },
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-preflight-'));
    await fs.writeFile(path.join(dir, 'llm_scores_user.yaml'), 'openai: 0\n');
    const scores = new ScoreStore(path.join(dir, 'config.yaml'));
    await scores.load();

    await expect(preflightProviders(cfg, scores)).rejects.toThrow(/没有可用的 provider|没有任何 ollama 服务器可达/);
    expect(scores.get('openai')).toBe(0);
  });
});
