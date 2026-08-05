import { isLLMRequestError } from '../../llm/errors.js';
import { RecordReplayError } from '../record_replay/types.js';

export type AttemptFailureKind = 'execution' | 'infrastructure';

export interface AttemptFailure {
  kind: AttemptFailureKind;
  category: 'llm-provider' | 'tool' | 'test' | 'quality' | 'contract' | 'internal';
  code: string;
  message: string;
  retryable: boolean;
  switchProvider: boolean;
  statusCode?: number;
  details?: Record<string, unknown>;
}

/**
 * Infrastructure failures happen outside the generated project and must never
 * enter the V-model defect loop. Keep this deliberately provider-specific so a
 * network/API failure produced by the project itself still becomes a Bug.
 */
export function classifyAttemptFailure(reason: unknown): AttemptFailureKind {
  return classifyFailure(reason).kind;
}

export function classifyFailure(reason: unknown): AttemptFailure {
  if (isLLMRequestError(reason)) {
    return {
      kind: 'infrastructure',
      category: 'llm-provider',
      code: reason.failure.code,
      message: reason.message,
      retryable: reason.failure.retryable,
      switchProvider: reason.failure.switchProvider,
      statusCode: reason.failure.statusCode,
      details: reason.failure.details,
    };
  }
  if (reason instanceof RecordReplayError) {
    return {
      kind: 'execution',
      category: reason.code === 'replay_miss' ? 'test' : 'contract',
      code: reason.code,
      message: reason.message,
      retryable: false,
      switchProvider: false,
      details: reason.details,
    };
  }
  const message = reason instanceof Error ? reason.message : String(reason ?? '');
  return {
    kind: 'execution',
    category: 'internal',
    code: 'unclassified_execution_failure',
    message,
    retryable: true,
    switchProvider: false,
  };
}
