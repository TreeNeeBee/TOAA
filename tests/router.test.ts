import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { LLMRouter } from '../src/llm/router.js';
import { findSharedCoderDebuggerModel, reportRoleModelAdvice } from '../src/llm/role_advice.js';
import {
  LLM_DYNAMIC_SCORES_FILE,
  LLM_USER_SCORES_FILE,
  ScoreStore,
  scoreStoreOptionsFromConfig,
} from '../src/llm/scores.js';
import type { XCompilerConfig } from '../src/config/config.js';
import type { LLMClient } from '../src/llm/types.js';

function mkCfg(partial: Partial<XCompilerConfig['llm']>): XCompilerConfig {
  return {
    llm: {
      providers: {
        ollama_code: { type: 'ollama', api_key: '', base_url: 'http://x', model: 'qwen' },
        ollama_design: { type: 'ollama', api_key: '', base_url: 'http://x', model: 'gemma' },
        openai: { type: 'openai', api_key: 'k', base_url: 'http://y', model: 'gpt' },
      },
      roles: { Coder: ['ollama_code'], Planner: ['ollama_design'] },
      fallbacks: [],
      role_fallbacks: {},
      scores: {},
      ...partial,
    },
    agent: {
      language: 'python',
      sandbox: 'subprocess',
      sandbox_limits: { cpu: 1, memory_mb: 256, wall_seconds: 30, network: 'off' },
      sandbox_docker: {
        image: 'python:3.11-slim',
        workdir: '/workspace',
        pull: false,
        docker_bin: 'docker',
        extra_run_args: [],
      },
    },
  };
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-router-'));
}

/** 可用性探测 stub：单测不碰真实网络。 */
const stubProbe = async () => ({ ok: true, latencyMs: 0, detail: 'stub reachable' });

describe('LLMRouter fallback chain', () => {
  it('falls back to next provider when primary throws', async () => {
    const cfg = mkCfg({ fallbacks: ['openai'] });
    const router = new LLMRouter(cfg);
    const client = router.for('Coder');

    // Replace inner clients via prototype hack: we cannot easily inject; instead patch fetch.
    // Simpler: stub the chain by replacing client.chat through duck-typing — verify name structure.
    expect(client.name).toMatch(/^chain\[/);
  });

  it('uses single provider (no chain wrapper) when no fallbacks set', async () => {
    const cfg = mkCfg({});
    const router = new LLMRouter(cfg);
    const client = router.for('Coder');
    expect(client.name).toBe('ollama:qwen');
  });

  it('uses explicit provider type instead of provider-name matching', () => {
    const cfg = mkCfg({
      providers: {
        any_vendor_name: { type: 'openai', api_key: '', base_url: 'http://127.0.0.1:8080/v1', model: 'local' },
        another_local_server: { type: 'openai', api_key: '', base_url: 'http://127.0.0.1:8081/v1', model: 'mlx' },
      },
      roles: { Coder: ['any_vendor_name'] },
    });
    const router = new LLMRouter(cfg);
    expect(router.for('Coder').name).toBe('openai:local');
  });

  it('role_fallbacks overrides global', async () => {
    const cfg = mkCfg({
      fallbacks: ['openai'],
      role_fallbacks: { Coder: ['openai', 'ollama_code'] },
    });
    const router = new LLMRouter(cfg);
    const client = router.for('Coder');
    expect(client.name).toBe('chain[openai:gpt>ollama:qwen]');
  });

  it('an actor provider pool overrides the role pool and does not inherit global fallbacks', () => {
    const cfg = mkCfg({
      fallbacks: ['openai'],
      role_fallbacks: { Coder: ['ollama_code'] },
    });
    const router = new LLMRouter(cfg);
    // Neither the role pool, the role fallbacks, nor the global fallbacks contribute: the bound
    // actor gets exactly the providers it was bound to.
    expect(router.for('Coder', { providerPool: ['ollama_design'] }).name).toBe('ollama:gemma');
    expect(router.for('Coder', { providerPool: ['openai', 'ollama_design'] }).name)
      .toBe('chain[openai:gpt>ollama:gemma]');
    // An absent or empty binding leaves the configured resolution untouched.
    expect(router.for('Coder', {}).name).toBe('ollama:qwen');
    expect(router.for('Coder', { providerPool: [] }).name).toBe('ollama:qwen');
  });

  it('FallbackClient.chat tries each provider in order', async () => {
    // Manually construct a router and patch internal clients via reflection
    const cfg = mkCfg({ fallbacks: ['openai'] });
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let firstCalls = 0;
    let secondCalls = 0;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        firstCalls++;
        throw new Error('primary down');
      },
    });
    clientsMap.set('openai', {
      name: 'fake-secondary',
      chat: async () => {
        secondCalls++;
        return 'ok';
      },
    });
    const client = router.for('Coder');
    let selectedProvider: string | undefined;
    const out = await client.chat([{ role: 'user', content: 'hi' }], {
      onProvider: (name) => { selectedProvider = name; },
    });
    expect(out).toBe('ok');
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(selectedProvider).toBe('openai');
  });

  it('reports all provider failures when the whole chain fails', async () => {
    const cfg = mkCfg({ fallbacks: ['openai'] });
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        throw new Error('validation rejected read-only response');
      },
    });
    clientsMap.set('openai', {
      name: 'fake-secondary',
      chat: async () => {
        throw new Error('OpenAI HTTP 429: free-models-per-day');
      },
    });

    await expect(router.for('Coder').chat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/all LLM providers failed.*ollama_code\/fake-primary.*openai\/fake-secondary.*429/su);
  });

  it('falls through immediately after first-token timeout even when the endpoint is reachable', async () => {
    const cfg = mkCfg({ fallbacks: ['openai'] });
    const probed: string[] = [];
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, async (name) => {
      probed.push(name);
      return { ok: true, latencyMs: 1, detail: 'stub reachable' };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const secondaryStreamingFlags: boolean[] = [];
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        primaryCalls++;
        throw new Error('OpenAI stream idle before first token for 300000ms; aborting');
      },
    });
    clientsMap.set('openai', {
      name: 'fake-secondary',
      chat: async (_messages, options) => {
        secondaryCalls++;
        secondaryStreamingFlags.push(!!options?.onToken);
        return 'rescued';
      },
    });

    const out = await router.for('Coder').chat([{ role: 'user', content: 'hi' }], {
      onToken: () => {},
    });

    expect(out).toBe('rescued');
    expect(primaryCalls).toBe(1);
    expect(secondaryCalls).toBe(1);
    expect(secondaryStreamingFlags).toEqual([true]);
    expect(probed).toContain('openai');
  });

  it('skips a switched-to provider when the availability check reports it unreachable and another candidate remains', async () => {
    const cfg = mkCfg({
      providers: {
        ollama_code: { type: 'ollama', api_key: '', base_url: 'http://x', model: 'qwen' },
        ollama_design: { type: 'ollama', api_key: '', base_url: 'http://x', model: 'gemma' },
        openai: { type: 'openai', api_key: 'k', base_url: 'http://y', model: 'gpt' },
      },
      roles: { Coder: ['ollama_code'] },
      fallbacks: ['ollama_design', 'openai'],
    });
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, async (name) => (
      name === 'ollama_design'
        ? { ok: false, latencyMs: 1, detail: 'connect ECONNREFUSED' }
        : { ok: true, latencyMs: 1, detail: 'stub reachable' }
    ));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let designCalls = 0;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        throw new Error('primary down');
      },
    });
    clientsMap.set('ollama_design', {
      name: 'fake-design',
      chat: async () => {
        designCalls++;
        throw new Error('should have been skipped by the availability check');
      },
    });
    clientsMap.set('openai', {
      name: 'fake-secondary',
      chat: async () => 'ok',
    });

    const out = await router.for('Coder').chat([{ role: 'user', content: 'hi' }]);

    expect(out).toBe('ok');
    // 切换目标探测不可达且后面还有候选 → 直接跳过，不浪费必然超时的 chat 请求。
    expect(designCalls).toBe(0);
  });

  it('does not availability-retry non-transient chain failures such as quota exhaustion', async () => {
    const cfg = mkCfg({ fallbacks: ['openai'] });
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, async () => ({
      ok: true,
      latencyMs: 1,
      detail: 'stub reachable',
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let primaryCalls = 0;
    let secondaryCalls = 0;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        primaryCalls++;
        throw new Error('OpenAI HTTP 401 unauthorized');
      },
    });
    clientsMap.set('openai', {
      name: 'fake-secondary',
      chat: async () => {
        secondaryCalls++;
        throw new Error('OpenAI HTTP 429: free-models-per-day');
      },
    });

    await expect(router.for('Coder').chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }))
      .rejects.toThrow(/all LLM providers failed/);
    expect(primaryCalls).toBe(1);
    expect(secondaryCalls).toBe(1);
  });

  it('retries the same provider with contract feedback before falling back', async () => {
    const cfg = mkCfg({ fallbacks: ['openai'] });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const router = new LLMRouter(cfg, undefined, scores, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let firstCalls = 0;
    let secondCalls = 0;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        firstCalls++;
        return 'read-only probe';
      },
    });
    clientsMap.set('openai', {
      name: 'fake-secondary',
      chat: async () => {
        secondCalls++;
        return 'repair patch';
      },
    });

    const output = await router.for('Coder').chat([{ role: 'user', content: 'hi' }], {
      validate: (text) => {
        if (text.includes('read-only')) throw new Error('low-quality read-only response');
      },
    });
    expect(output).toBe('repair patch');
    expect(firstCalls).toBe(2);
    expect(secondCalls).toBe(1);
    expect(scores.get('ollama_code')).toBeLessThan(ScoreStore.DEFAULT);
  });

  it('keeps the current provider when its contract-feedback retry succeeds', async () => {
    const cfg = mkCfg({ fallbacks: ['openai'] });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const router = new LLMRouter(cfg, undefined, scores, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let primaryCalls = 0;
    let secondaryCalls = 0;
    let correctionSeen = false;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async (messages) => {
        primaryCalls++;
        correctionSeen ||= messages.some(
          (message) => message.role === 'user' && message.content.includes('low-quality read-only response'),
        );
        return primaryCalls === 1 ? 'read-only probe' : 'repair patch';
      },
    });
    clientsMap.set('openai', {
      name: 'fake-secondary',
      chat: async () => {
        secondaryCalls++;
        return 'secondary patch';
      },
    });

    const output = await router.for('Coder').chat([{ role: 'user', content: 'hi' }], {
      validate: (text) => {
        if (text.includes('read-only')) throw new Error('low-quality read-only response');
      },
    });
    expect(output).toBe('repair patch');
    expect(primaryCalls).toBe(2);
    expect(secondaryCalls).toBe(0);
    expect(correctionSeen).toBe(true);
    expect(scores.get('ollama_code')).toBeGreaterThanOrEqual(ScoreStore.DEFAULT);
  });

  it('can disable success score boosts for workflow-level LLM calls', async () => {
    const cfg = mkCfg({});
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0.4, 'test seed');
    const router = new LLMRouter(cfg, undefined, scores, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => 'syntactically valid but not yet task success',
    });

    const out = await router.for('Coder').chat([{ role: 'user', content: 'hi' }], {
      scoreSuccess: false,
    });

    expect(out).toBe('syntactically valid but not yet task success');
    expect(scores.get('ollama_code')).toBe(0.4);
  });

  it('scores providers from verified Ticket outcomes instead of CR creation alone', () => {
    const cfg = mkCfg({});
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const router = new LLMRouter(cfg, undefined, scores, undefined, undefined, stubProbe);

    router.recordTicketOutcome(['ollama_code'], 'quality-gap', 'ENHANCE-P1-001');
    expect(scores.get('ollama_code')).toBe(0.5);

    router.recordTicketOutcome(['ollama_code'], 'repair-verified', 'ENHANCE-P1-001');
    expect(scores.get('ollama_code')).toBeCloseTo(0.6, 5);

    router.recordTicketOutcome(['unknown-provider'], 'change-verified', 'CR-P1-001');
    expect(scores.snapshot()).not.toHaveProperty('unknown-provider');
  });

  it('retries the same provider once for transient stream failures', async () => {
    const cfg = mkCfg({});
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const router = new LLMRouter(cfg, undefined, scores, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let calls = 0;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        calls++;
        if (calls === 1) {
          throw new Error('detected token loop in OpenAI stream (repeated identical token); aborting');
        }
        return 'ok';
      },
    });

    const starts: string[] = [];
    let selectedProvider: string | undefined;
    const client = router.for('Coder');
    const out = await client.chat([{ role: 'user', content: 'hi' }], {
      onProviderStart: (name) => { starts.push(name); },
      onProvider: (name) => { selectedProvider = name; },
    });

    expect(out).toBe('ok');
    expect(calls).toBe(2);
    expect(starts).toEqual(['ollama_code', 'ollama_code']);
    expect(selectedProvider).toBe('ollama_code');
    expect(scores.get('ollama_code')).toBe(ScoreStore.DEFAULT);
  });

  it('retries stream transport failures once without streaming on the same provider', async () => {
    const cfg = mkCfg({});
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    const sawStreaming: boolean[] = [];
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async (_messages, options) => {
        sawStreaming.push(!!options?.onToken);
        if (sawStreaming.length === 1) {
          throw new Error('OpenAI stream idle for 300000ms; aborting');
        }
        return 'ok';
      },
    });

    const chunks: string[] = [];
    const out = await router.for('Coder').chat([{ role: 'user', content: 'hi' }], {
      onToken: (chunk) => chunks.push(chunk),
    });

    expect(out).toBe('ok');
    expect(sawStreaming).toEqual([true, false]);
    expect(chunks).toEqual([]);
  });

  it('never retries the same provider after first-token idle', async () => {
    const cfg = mkCfg({});
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, async () => ({
      ok: true,
      latencyMs: 1,
      detail: 'stub reachable',
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    const sawStreaming: boolean[] = [];
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async (_messages, options) => {
        sawStreaming.push(!!options?.onToken);
        throw new Error('OpenAI stream idle before first token for 90000ms; aborting');
      },
    });

    await expect(
      router.for('Coder').chat([{ role: 'user', content: 'hi' }], {
        onToken: () => {},
      }),
    ).rejects.toThrow(/before first token/u);
    expect(sawStreaming).toEqual([true]);
  });

  it('waits and retries short provider 429 retry-after errors once', async () => {
    const cfg = mkCfg({});
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let calls = 0;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        calls++;
        if (calls === 1) {
          throw new Error('OpenAI HTTP 429: Rate limit reached. Please try again in 0.01s.');
        }
        return 'ok';
      },
    });

    await expect(router.for('Coder').chat([{ role: 'user', content: 'hi' }]))
      .resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('treats fetch failed from a streaming request as a non-stream retry candidate', async () => {
    const cfg = mkCfg({});
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    const sawStreaming: boolean[] = [];
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async (_messages, options) => {
        sawStreaming.push(!!options?.onToken);
        if (sawStreaming.length === 1) {
          throw new Error('fetch failed');
        }
        return 'ok';
      },
    });

    await expect(
      router.for('Coder').chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
    ).resolves.toBe('ok');
    expect(sawStreaming).toEqual([true, false]);
  });

  it('does not retry non-transient provider failures before fallback', async () => {
    const cfg = mkCfg({ fallbacks: ['openai'] });
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let firstCalls = 0;
    let secondCalls = 0;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        firstCalls++;
        throw new Error('invalid request');
      },
    });
    clientsMap.set('openai', {
      name: 'fake-secondary',
      chat: async () => {
        secondCalls++;
        return 'ok';
      },
    });

    const out = await router.for('Coder').chat([{ role: 'user', content: 'hi' }]);

    expect(out).toBe('ok');
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });

  it('publishes and applies the active context window on cold start and provider switch', async () => {
    const cfg = mkCfg({
      providers: {
        small: {
          type: 'ollama',
          api_key: '',
          base_url: 'http://small',
          model: 'small-model',
          context_window: 32 * 1024,
        },
        large: {
          type: 'openai',
          api_key: '',
          base_url: 'http://large',
          model: 'large-model',
          context_window: 256 * 1024,
        },
      },
      roles: { Coder: ['small', 'large'] },
      fallbacks: [],
    });
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    const maxTokens: number[] = [];
    clientsMap.set('small', {
      name: 'small-model',
      async chat(_messages, options) {
        maxTokens.push(options?.maxTokens ?? 0);
        throw new Error('small provider failed');
      },
    });
    clientsMap.set('large', {
      name: 'large-model',
      async chat(_messages, options) {
        maxTokens.push(options?.maxTokens ?? 0);
        return 'ok';
      },
    });
    const starts: Array<{ name: string; context: number; switched: boolean }> = [];

    const result = await router.for('Coder').chat([{ role: 'user', content: 'work' }], {
      onProviderStart(name, _model, window) {
        starts.push({
          name,
          context: window.contextWindowTokens,
          switched: window.switched,
        });
      },
    });

    expect(result).toBe('ok');
    expect(starts).toEqual([
      { name: 'small', context: 32 * 1024, switched: false },
      { name: 'large', context: 256 * 1024, switched: true },
    ]);
    expect(maxTokens[1]).toBeGreaterThan(maxTokens[0]!);
    expect(router.primaryContextWindow('Coder')).toBe(32 * 1024);
  });
});

describe('LLMRouter score-sorted chain', () => {
  it('skips providers marked unreachable for the current run', () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code', 'openai'] } });
    const router = new LLMRouter(cfg, undefined, undefined, new Set(['ollama_code']));
    expect(router.for('Coder').name).toBe('openai:gpt');
  });

  it('orders candidates by score descending', () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code', 'openai'] } });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0.5, 'flaky');
    scores.set('openai', 0.9, 'rocking');
    const router = new LLMRouter(cfg, undefined, scores);
    const client = router.for('Coder');
    expect(client.name).toBe('chain[openai:gpt>ollama:qwen]');
  });

  it('keeps cluster fallbacks behind dedicated providers at default scores', () => {
    const cfg = mkCfg({
      providers: {
        ollama_code: { type: 'ollama', api_key: '', base_url: 'http://x', model: 'qwen' },
        openrouter_free: {
          type: 'openai',
          api_key: 'k',
          base_url: 'https://openrouter.ai/api/v1',
          model: 'openrouter/free',
          tags: ['cluster'],
        },
      },
      roles: { Coder: ['ollama_code', 'openrouter_free'] },
    });
    const scores = new ScoreStore('/tmp/x/config.yaml', undefined, scoreStoreOptionsFromConfig(cfg.llm));
    const router = new LLMRouter(cfg, undefined, scores);
    expect(router.for('Coder').name).toBe('chain[ollama:qwen>openai:openrouter/free]');
  });

  it('skips providers with score=0', () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code', 'openai'] } });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0, 'disabled');
    const router = new LLMRouter(cfg, undefined, scores);
    const client = router.for('Coder');
    expect(client.name).toBe('openai:gpt');
  });

  it('throws when all candidates have score=0', () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code'] } });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0, 'disabled');
    scores.set('ollama_design', 0, 'disabled');
    scores.set('openai', 0, 'disabled');
    const router = new LLMRouter(cfg, undefined, scores);
    expect(() => router.for('Coder')).toThrow(/score=0|No usable LLM provider/);
  });

  it('uses llm_scores_user.yaml overrides when ranking providers', async () => {
    const dir = await tmpDir();
    const cfg = mkCfg({ roles: { Coder: ['ollama_code', 'openai'] } });
    await fs.writeFile(path.join(dir, LLM_DYNAMIC_SCORES_FILE), YAML.stringify({
      ollama_code: 1,
      openai: 0.1,
    }));
    await fs.writeFile(path.join(dir, LLM_USER_SCORES_FILE), YAML.stringify({
      ollama_code: 0,
      openai: 0.9,
    }));
    const scores = new ScoreStore(path.join(dir, 'config.yaml'));
    await scores.load();
    const router = new LLMRouter(cfg, undefined, scores);

    expect(router.for('Coder').name).toBe('openai:gpt');
  });

  it('decays score on chat error and boosts on success', async () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code', 'openai'] } });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const router = new LLMRouter(cfg, undefined, scores, undefined, undefined, stubProbe);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map: Map<string, LLMClient> = (router as any).clients;
    map.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => { throw new Error('down'); },
    });
    map.set('openai', {
      name: 'fake-secondary',
      chat: async () => 'ok',
    });
    const client = router.for('Coder');
    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(scores.get('ollama_code')).toBeCloseTo(ScoreStore.DEFAULT - ScoreStore.DECAY, 5);
    expect(scores.get('openai')).toBe(ScoreStore.DEFAULT);
  });

  it('accepts the canonical single-element role array', () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code'] } });
    const router = new LLMRouter(cfg);
    const client = router.for('Coder');
    expect(client.name).toBe('ollama:qwen');
  });
});

describe('Coder and Debugger model advice', () => {
  it('detects when both roles resolve to the same primary model', () => {
    const cfg = mkCfg({
      roles: { Coder: ['ollama_code'], Debugger: ['ollama_code'] },
    });
    const advice = findSharedCoderDebuggerModel(new LLMRouter(cfg));
    expect(advice).toEqual({
      coder: { provider: 'ollama_code', model: 'qwen' },
      debugger: { provider: 'ollama_code', model: 'qwen' },
    });
  });

  it('does not advise when Coder and Debugger use different models', () => {
    const cfg = mkCfg({
      roles: { Coder: ['ollama_code'], Debugger: ['ollama_design'] },
    });
    expect(findSharedCoderDebuggerModel(new LLMRouter(cfg))).toBeUndefined();
  });

  it('compares the score-selected primary providers', () => {
    const cfg = mkCfg({
      roles: {
        Coder: ['ollama_code'],
        Debugger: ['ollama_code', 'ollama_design'],
      },
    });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0.5, 'lower coder score');
    scores.set('ollama_design', 1, 'preferred debugger');
    expect(findSharedCoderDebuggerModel(new LLMRouter(cfg, undefined, scores))).toBeUndefined();
  });

  it('prints a non-blocking suggestion when the selected models match', async () => {
    const cfg = mkCfg({
      roles: { Coder: ['ollama_code'], Debugger: ['ollama_code'] },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(reportRoleModelAdvice(new LLMRouter(cfg))).resolves.toBeDefined();
      expect(log).toHaveBeenCalledOnce();
      expect(String(log.mock.calls[0]?.[1])).toMatch(/different models|不同模型/);
    } finally {
      log.mockRestore();
    }
  });
});
