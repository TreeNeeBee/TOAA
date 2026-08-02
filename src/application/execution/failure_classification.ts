export type AttemptFailureKind = 'execution' | 'infrastructure';

/**
 * Infrastructure failures happen outside the generated project and must never
 * enter the V-model defect loop. Keep this deliberately provider-specific so a
 * network/API failure produced by the project itself still becomes a Bug.
 */
export function classifyAttemptFailure(reason: unknown): AttemptFailureKind {
  const message = reason instanceof Error ? reason.message : String(reason ?? '');
  if (
    /all LLM providers failed for role/iu.test(message) ||
    /OpenAI-compatible provider request failed/iu.test(message) ||
    /LLM provider not configured for role/iu.test(message) ||
    /No usable LLM provider in chain for role/iu.test(message) ||
    /OpenAI stream (?:idle|wall-clock)/iu.test(message) ||
    /(?:Ollama|LLM provider)[^\n]*(?:request timed out|stream idle|stream wall-clock|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND)/iu.test(message)
  ) {
    return 'infrastructure';
  }
  return 'execution';
}
