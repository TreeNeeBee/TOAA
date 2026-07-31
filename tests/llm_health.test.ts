import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM_PROBE_TIMEOUT_MS,
  DEFAULT_OPENAI_PROBE_TIMEOUT_MS,
  resolveLLMProbeTimeoutMs,
} from '../src/llm/health.js';

describe('LLM provider health probe timeout', () => {
  it('uses the provider connection timeout for OpenAI-compatible endpoints', () => {
    expect(resolveLLMProbeTimeoutMs({
      type: 'openai',
      connect_timeout_ms: 45_000,
    })).toBe(45_000);
  });

  it('uses the hosted-provider connection default when no timeout is configured', () => {
    expect(resolveLLMProbeTimeoutMs({ type: 'openai' })).toBe(DEFAULT_OPENAI_PROBE_TIMEOUT_MS);
  });

  it('keeps the short local probe default for Ollama', () => {
    expect(resolveLLMProbeTimeoutMs({
      type: 'ollama',
      connect_timeout_ms: 45_000,
    })).toBe(DEFAULT_LLM_PROBE_TIMEOUT_MS);
  });

  it('honors an explicit doctor override for every provider type', () => {
    expect(resolveLLMProbeTimeoutMs({ type: 'openai' }, 1_234)).toBe(1_234);
    expect(resolveLLMProbeTimeoutMs({ type: 'ollama' }, 1_234)).toBe(1_234);
  });
});
