export type LLMFailureCode =
  | 'provider_not_configured'
  | 'provider_unavailable'
  | 'authentication_failed'
  | 'permission_denied'
  | 'model_not_found'
  | 'rate_limited'
  | 'provider_server_error'
  | 'request_timeout'
  | 'connection_failed'
  | 'invalid_response'
  | 'all_providers_failed'
  | 'request_failed';

export interface LLMFailureDetails {
  code: LLMFailureCode;
  provider?: string;
  model?: string;
  endpoint?: string;
  mode?: 'stream' | 'non-stream' | 'probe' | 'router';
  statusCode?: number;
  retryable: boolean;
  switchProvider: boolean;
  details?: Record<string, unknown>;
}

export class LLMRequestError extends Error {
  readonly failure: LLMFailureDetails;

  constructor(message: string, failure: LLMFailureDetails, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LLMRequestError';
    this.failure = failure;
  }
}

export function isLLMRequestError(error: unknown): error is LLMRequestError {
  return error instanceof LLMRequestError;
}

/**
 * Whether every provider refused the model's content rather than failing itself.
 *
 * The caller's own turn contract runs as provider-side validation, so a turn nobody would accept
 * exhausts the chain and arrives looking exactly like an outage. It is not one: the round can still
 * be fed back to the model, and treating it as infrastructure stopped a live run twice with every
 * provider healthy.
 */
export function isContentRejectionExhausted(error: unknown): error is LLMRequestError {
  return isLLMRequestError(error) &&
    error.failure.code === 'all_providers_failed' &&
    error.failure.details?.contentRejectedOnly === true;
}

export function llmFailureCodeForStatus(status: number): LLMFailureCode {
  if (status === 401) return 'authentication_failed';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'model_not_found';
  if (status === 408) return 'request_timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_server_error';
  return 'request_failed';
}
