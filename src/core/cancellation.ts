/** Recognizes host, prompt, and AbortSignal cancellation without classifying it as project failure. */
export function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' ||
    error.name === 'ExitPromptError' ||
    /(?:task cancelled|cancelled by SIGINT|force closed the prompt with SIGINT)/iu.test(error.message);
}
