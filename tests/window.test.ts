import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  resolveSkillOperationWindow,
  updateOperationWindow,
} from '../src/llm/window.js';

describe('model operation window', () => {
  it('uses 128K when context_window is not supplied', () => {
    const window = resolveSkillOperationWindow();
    expect(window.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it('scales read, write, feedback, and response windows with model context', () => {
    const small = resolveSkillOperationWindow({
      contextWindowTokens: 32 * 1024,
      promptChars: 10_000,
    });
    const large = resolveSkillOperationWindow({
      contextWindowTokens: 256 * 1024,
      promptChars: 10_000,
    });
    const veryLarge = resolveSkillOperationWindow({
      contextWindowTokens: 1024 * 1024,
      promptChars: 10_000,
    });
    expect(large.responseTokenBudget).toBeGreaterThan(small.responseTokenBudget);
    expect(large.feedbackCharBudget).toBeGreaterThan(small.feedbackCharBudget);
    expect(large.readChunkBytes).toBeGreaterThan(small.readChunkBytes);
    expect(large.writeChunkBytes).toBeGreaterThan(small.writeChunkBytes);
    expect(veryLarge.responseTokenBudget).toBeGreaterThan(large.responseTokenBudget);
    expect(veryLarge.writeChunkBytes).toBeGreaterThan(large.writeChunkBytes);
  });

  it('derives every window from the active context and rewrites them on a provider switch', () => {
    const target: Record<string, number | undefined> = { writeChunkBytes: 7777 };
    const window = updateOperationWindow(target, {
      contextWindowTokens: 64 * 1024,
      promptChars: 20_000,
    });
    // 0.3 removed the standalone byte-limit configuration: no stale override survives, every
    // budget comes from the context window of the provider now in use.
    expect(window.writeChunkBytes).not.toBe(7777);
    expect(window.writeChunkBytes).toBeGreaterThan(1024);
    expect(target).toMatchObject({
      contextWindowTokens: 64 * 1024,
      writeChunkBytes: window.writeChunkBytes,
      readChunkBytes: window.readChunkBytes,
      feedbackCharBudget: window.feedbackCharBudget,
    });

    const switched = updateOperationWindow(target, {
      contextWindowTokens: 200 * 1024,
      promptChars: 20_000,
    });
    expect(switched.writeChunkBytes).toBeGreaterThan(window.writeChunkBytes);
    expect(target.writeChunkBytes).toBe(switched.writeChunkBytes);
  });
});
