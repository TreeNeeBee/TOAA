export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128 * 1024;

const ESTIMATED_CHARS_PER_TOKEN = 3;
const RESPONSE_WINDOW_RATIO = 0.125;
const FEEDBACK_WINDOW_RATIO = 0.2;
const CONTEXT_SAFETY_RATIO = 0.05;

export interface OperationWindowInput {
  contextWindowTokens?: number | null;
  promptChars?: number;
}

export interface SkillOperationWindow {
  contextWindowTokens: number;
  promptTokens: number;
  safetyTokens: number;
  remainingTokens: number;
  responseTokenBudget: number;
  feedbackCharBudget: number;
  readChunkBytes: number;
  writeChunkBytes: number;
}

export interface OperationWindowTarget {
  contextWindowTokens?: number;
  responseTokenBudget?: number;
  feedbackCharBudget?: number;
  readChunkBytes?: number;
  writeChunkBytes?: number;
}

export function normalizeContextWindowTokens(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function estimateTextTokens(chars: number): number {
  return Math.max(0, Math.ceil(Math.max(0, chars) / ESTIMATED_CHARS_PER_TOKEN));
}

/**
 * Resolve all model-facing operation budgets from one context window.
 *
 * `context_window` is an input+output capacity. The prompt and a safety margin
 * are removed first; response and tool-feedback windows then share what remains.
 * Read, write, response, and feedback windows are all derived from the active
 * provider context. No independent byte-limit configuration is accepted.
 */
export function resolveSkillOperationWindow(input: OperationWindowInput = {}): SkillOperationWindow {
  const contextWindowTokens = normalizeContextWindowTokens(input.contextWindowTokens);
  const promptTokens = estimateTextTokens(input.promptChars ?? 0);
  const safetyTokens = Math.max(1024, Math.ceil(contextWindowTokens * CONTEXT_SAFETY_RATIO));
  const availableTokens = Math.max(512, contextWindowTokens - promptTokens - safetyTokens);
  const responseTokenBudget = Math.max(
    512,
    Math.min(
      Math.floor(contextWindowTokens * RESPONSE_WINDOW_RATIO),
      Math.floor(availableTokens * 0.45),
    ),
  );
  const feedbackAvailableTokens = Math.max(512, availableTokens - responseTokenBudget);
  const feedbackTokens = Math.max(
    512,
    Math.min(
      Math.floor(contextWindowTokens * FEEDBACK_WINDOW_RATIO),
      Math.floor(feedbackAvailableTokens * 0.35),
    ),
  );
  const feedbackCharBudget = feedbackTokens * ESTIMATED_CHARS_PER_TOKEN;
  const readChunkBytes = Math.max(1024, Math.floor(feedbackCharBudget * 0.7));
  const writeChunkBytes = Math.max(
    1024,
    Math.floor(responseTokenBudget * ESTIMATED_CHARS_PER_TOKEN * 0.72),
  );

  return {
    contextWindowTokens,
    promptTokens,
    safetyTokens,
    remainingTokens: availableTokens,
    responseTokenBudget,
    feedbackCharBudget,
    readChunkBytes,
    writeChunkBytes,
  };
}

/** Mutate a live ToolContext-compatible target when the active provider changes. */
export function updateOperationWindow(
  target: OperationWindowTarget,
  input: OperationWindowInput = {},
): SkillOperationWindow {
  const window = resolveSkillOperationWindow(input);
  target.contextWindowTokens = window.contextWindowTokens;
  target.responseTokenBudget = window.responseTokenBudget;
  target.feedbackCharBudget = window.feedbackCharBudget;
  target.readChunkBytes = window.readChunkBytes;
  target.writeChunkBytes = window.writeChunkBytes;
  return window;
}
