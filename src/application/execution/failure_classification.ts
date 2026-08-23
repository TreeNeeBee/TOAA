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
/** Classifies a reason this runtime authored, so provider phrasing in it is trustworthy. */
export function classifyAttemptFailure(reason: unknown): AttemptFailureKind {
  return classifyFailure(reason, { trustProviderText: true }).kind;
}

export interface ClassifyFailureOptions {
  /**
   * Opt in to reading provider phrasing out of the text as evidence that *our* provider failed.
   *
   * Defaults to false, because trust is a property of where the string came from and nothing at the
   * type level marks that. Only text this runtime authored about its own model calls may opt in.
   * Anything captured from the generated project is subject data: XCompiler can legitimately be
   * asked to build an LLM application whose own output says "all LLM providers failed", and reading
   * that as infrastructure would cycle providers forever instead of routing a real defect to Debug.
   */
  trustProviderText?: boolean;
}

export function classifyFailure(
  reason: unknown,
  options: ClassifyFailureOptions = {},
): AttemptFailure {
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
  if (/^permission_blocked:/iu.test(message)) {
    return {
      kind: 'infrastructure',
      category: 'internal',
      code: 'permission_blocked',
      message,
      retryable: false,
      switchProvider: false,
    };
  }
  if (options.trustProviderText === true && PROVIDER_FAILURE_TEXT.test(message)) {
    return {
      kind: 'infrastructure',
      category: 'llm-provider',
      code: 'provider_call_failed',
      message,
      retryable: true,
      switchProvider: true,
      statusCode: parseStatusCode(message),
    };
  }
  if (AGENT_EXECUTION_STALL_TEXT.test(message)) {
    return {
      kind: 'execution',
      category: 'internal',
      code: 'agent_execution_stalled',
      message,
      retryable: true,
      switchProvider: true,
    };
  }
  return {
    kind: 'execution',
    category: 'internal',
    code: 'unclassified_execution_failure',
    message,
    retryable: true,
    switchProvider: false,
  };
}

/**
 * Bounded textual fallback for provider failures that reach classification already stringified —
 * a Ticket's recorded `reason`/`failureLog` rather than a live `LLMRequestError`. Without it an
 * outage of our own model provider is recorded as a defect in the generated project.
 *
 * It deliberately matches only phrasing this runtime emits for its own provider calls. A network
 * failure produced *by the generated project* ("run_tests failed: external API returned HTTP 429")
 * must stay `execution` so it still becomes a Bug, per the failure-routing rules.
 */
const PROVIDER_FAILURE_TEXT =
  /\ball LLM providers failed\b|\bOpenAI-compatible provider request failed\b|\bprovider_call_failed\b|\bOpenAI stream \b/iu;
// Every alternative here is a prefix the runtime composes, never a description of the fault.
//
// `stream idle before first token` used to be the fourth, and it was one sentence out of the several
// a stream watchdog can produce. The same watchdog now also says "sent N reasoning chars but no
// content" and "sent no response headers" — cases it could not tell apart before — and neither would
// have matched. `OpenAI stream ` covers all of them because the transport puts it in front of every
// message it composes about a stream it ended, whatever the reason turns out to be.
//
// Most of these arrive already wrapped in `OpenAI-compatible provider request failed …`, but not
// all: some paths record only the inner message, and that is the path this alternative exists for.

const AGENT_EXECUTION_STALL_TEXT =
  /repeated read-only\/probe actions|read-only recovery mode repeated probe actions|model returned actions=\[\] and done=false|invalid completion loop|max rounds exceeded|low-quality (?:debugger )?response/iu;

function parseStatusCode(message: string): number | undefined {
  const match = /\bstatus=(\d{3})\b/u.exec(message);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}
