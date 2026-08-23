import { jsonrepair } from 'jsonrepair';

export interface LLMAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface LLMTurn {
  thoughts?: string;
  bugResolutionPlan?: string;
  bugResolutionDisposition?: unknown;
  bug_resolution_disposition?: unknown;
  bug_resolution_plan?: string;
  resolutionPlan?: string;
  handlingPlan?: string;
  fixPlan?: string;
  validationDefect?: string | null;
  validation_defect?: string | null;
  validationFailure?: string | null;
  validation_failure?: string | null;
  qualityAssessment?: unknown;
  quality_assessment?: unknown;
  changeRequestDisposition?: unknown;
  change_request_disposition?: unknown;
  actions?: unknown;
  done?: boolean;
}

export interface ChangeRequestDisposition {
  outcome: 'applied' | 'not-applicable';
  reasonCategory:
    | 'contract-applied'
    | 'already-aligned'
    | 'outside-step-scope'
    | 'downstream-owned'
    | 'diagnosis-contradicted';
  rationale: string;
  inspectedArtifacts: string[];
  evidence: string[];
}

export interface BugResolutionDisposition {
  outcome: 'deferred';
  reasonCategory: 'downstream-owned' | 'external-dependency';
  rationale: string;
  affectedArtifacts: string[];
  evidence: string[];
}

const CHANGE_REQUEST_REASON_CATEGORIES = new Set<ChangeRequestDisposition['reasonCategory']>([
  'contract-applied',
  'already-aligned',
  'outside-step-scope',
  'downstream-owned',
  'diagnosis-contradicted',
]);

const EXECUTION_TURN_ROOT_KEYS = new Set([
  'thoughts',
  'bugResolutionPlan',
  'bugResolutionDisposition',
  'bug_resolution_disposition',
  'bug_resolution_plan',
  'resolutionPlan',
  'handlingPlan',
  'fixPlan',
  'validationDefect',
  'validation_defect',
  'validationFailure',
  'validation_failure',
  'qualityAssessment',
  'quality_assessment',
  'changeRequestDisposition',
  'change_request_disposition',
  'actions',
  'done',
  // Provider-native single tool calls are normalized by parseTurn.
  'type',
  'tool',
  'name',
  'function',
  'id',
]);

const PROVIDER_ENVELOPE_ROOT_KEYS = new Set([
  'messages',
  'choices',
  'model',
  'usage',
  'object',
  'created',
  'system_fingerprint',
  'request',
  'input',
  'response',
  'output',
]);

export function parseTurn(text: string): LLMTurn {
  const cleaned = stripFence(text).trim();
  const direct = tryParseTurnCandidate(cleaned);
  if (direct) return direct;
  const first = extractJsonObjectAt(cleaned, cleaned.indexOf('{'));
  if (first) {
    const parsed = tryParseTurnCandidate(first);
    if (parsed) {
      const firstEnd = cleaned.indexOf(first) + first.length;
      const hasTrailingDone = /"done"\s*:/u.test(cleaned.slice(firstEnd));
      if (typeof parsed.done === 'boolean' || !hasTrailingDone) return parsed;
    }
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const parsed = tryParseTurnCandidate(cleaned.slice(start, end + 1));
    if (parsed) return parsed;
  }
  return salvageMalformedTurn(cleaned) ?? {};
}

export function isCompleteTurnJson(text: string): boolean {
  const cleaned = stripFence(text).trim();
  if (!/"done"\s*:/u.test(cleaned) || !['}', ']'].includes(cleaned.at(-1) ?? '')) return false;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  const turn = isTurnObject(tryParseJson(cleaned.slice(start, end + 1)));
  return !!turn && typeof turn.done === 'boolean' && Array.isArray(turn.actions);
}

/**
 * Returns a known provider/request envelope key as soon as a streamed JSON object exposes it.
 * Unknown keys are ordinary invalid model content and must reach the caller's validation hook so
 * the same provider receives actionable repair feedback. Only known envelopes are stopped early
 * because an echoed request can otherwise reproduce the entire prompt before validation runs.
 */
export function rejectedExecutionTurnEnvelopeKey(text: string): string | undefined {
  const cleaned = stripFence(text).trimStart();
  const match = /^\{\s*"((?:\\.|[^"\\])*)"\s*:/u.exec(cleaned);
  if (!match?.[1]) return undefined;
  const key = parseJsonStringLiteral(match[1]);
  return key &&
    !EXECUTION_TURN_ROOT_KEYS.has(key) &&
    PROVIDER_ENVELOPE_ROOT_KEYS.has(key)
    ? key
    : undefined;
}

export function extractBugResolutionPlan(turn: LLMTurn): string | undefined {
  return firstBoundedText([
    turn.bugResolutionPlan,
    turn.bug_resolution_plan,
    turn.resolutionPlan,
    turn.handlingPlan,
    turn.fixPlan,
  ]);
}

export function extractBugResolutionDisposition(
  turn: LLMTurn,
): BugResolutionDisposition | undefined {
  const raw = turn.bugResolutionDisposition ?? turn.bug_resolution_disposition;
  if (!isPlainRecord(raw) || raw.outcome !== 'deferred') return undefined;
  const reasonCategory = raw.reasonCategory ?? raw.reason_category;
  if (reasonCategory !== 'downstream-owned' && reasonCategory !== 'external-dependency') {
    return undefined;
  }
  if (typeof raw.rationale !== 'string' || raw.rationale.trim().length < 20) return undefined;
  const affectedArtifacts = stringArray(raw.affectedArtifacts ?? raw.affected_artifacts);
  const evidence = stringArray(raw.evidence);
  if (affectedArtifacts.length === 0 || evidence.length === 0) return undefined;
  return {
    outcome: 'deferred',
    reasonCategory,
    rationale: raw.rationale.trim(),
    affectedArtifacts,
    evidence,
  };
}

export function extractValidationDefect(turn: LLMTurn): string | undefined {
  return firstBoundedText([
    turn.validationDefect,
    turn.validation_defect,
    turn.validationFailure,
    turn.validation_failure,
  ]);
}

export function extractChangeRequestDisposition(
  turn: LLMTurn,
): ChangeRequestDisposition | undefined {
  const raw = turn.changeRequestDisposition ?? turn.change_request_disposition;
  if (!isPlainRecord(raw)) return undefined;
  if (raw.outcome !== 'applied' && raw.outcome !== 'not-applicable') return undefined;
  const reasonCategory = raw.reasonCategory ?? raw.reason_category;
  if (
    typeof reasonCategory !== 'string' ||
    !CHANGE_REQUEST_REASON_CATEGORIES.has(reasonCategory as ChangeRequestDisposition['reasonCategory'])
  ) return undefined;
  if ((raw.outcome === 'applied') !== (reasonCategory === 'contract-applied')) return undefined;
  if (typeof raw.rationale !== 'string' || raw.rationale.trim().length < 20) return undefined;
  const inspectedArtifacts = stringArray(raw.inspectedArtifacts ?? raw.inspected_artifacts);
  const evidence = stringArray(raw.evidence);
  if (inspectedArtifacts.length === 0 || evidence.length === 0) return undefined;
  return {
    outcome: raw.outcome,
    reasonCategory: reasonCategory as ChangeRequestDisposition['reasonCategory'],
    rationale: raw.rationale.trim(),
    inspectedArtifacts,
    evidence,
  };
}

function salvageMalformedTurn(text: string): LLMTurn | null {
  const actions: unknown[] = [];
  const expression = /\{\s*"tool"\s*:/gu;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text))) {
    const candidate = extractJsonObjectAt(text, match.index);
    if (!candidate) continue;
    const parsed = tryParseJson(repairJsonCandidate(candidate));
    if (isPlainRecord(parsed) && typeof parsed.tool === 'string') actions.push(parsed);
    expression.lastIndex = match.index + Math.max(1, candidate.length);
  }
  if (actions.length === 0) return null;
  const thoughtMatch = text.match(/"thoughts"\s*:\s*"((?:\\.|[^"\\])*)"/u);
  const doneMatch = [...text.matchAll(/"done"\s*:\s*(true|false)/gu)].at(-1);
  return {
    thoughts: thoughtMatch ? parseJsonStringLiteral(thoughtMatch[1] ?? '') : undefined,
    actions,
    done: doneMatch ? doneMatch[1] === 'true' : false,
  };
}

function tryParseTurnCandidate(candidate: string): LLMTurn | null {
  const exact = isTurnObject(tryParseJson(candidate));
  if (exact) return exact;
  const trimmed = candidate.trim();
  if (extractJsonObjectAt(trimmed, trimmed.indexOf('{')) !== trimmed) return null;
  const repaired = repairJsonCandidate(candidate);
  return repaired === candidate ? null : isTurnObject(tryParseJson(repaired));
}

function isTurnObject(value: unknown): LLMTurn | null {
  if (!isPlainRecord(value)) return null;
  const nativeTool = normalizeNativeToolUse(value);
  return nativeTool
    ? { thoughts: 'execute provider-native tool request', actions: [nativeTool], done: false }
    : value as LLMTurn;
}

function normalizeNativeToolUse(value: Record<string, unknown>): LLMAction | undefined {
  if (
    (value.type === 'tool_use' || value.type === 'tool_call') &&
    typeof value.name === 'string' &&
    isPlainRecord(value.input ?? value.arguments)
  ) {
    return { tool: value.name, args: (value.input ?? value.arguments) as Record<string, unknown> };
  }
  if (typeof value.tool === 'string' && isPlainRecord(value.args)) {
    return { tool: value.tool, args: value.args };
  }
  if (value.type === 'tool_call' && isPlainRecord(value.function)) {
    const fn = value.function;
    if (typeof fn.name !== 'string') return undefined;
    if (isPlainRecord(fn.arguments)) return { tool: fn.name, args: fn.arguments };
    if (typeof fn.arguments === 'string') {
      const parsed = tryParseJson(fn.arguments);
      if (isPlainRecord(parsed)) return { tool: fn.name, args: parsed };
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function extractJsonObjectAt(text: string, start: number): string | null {
  if (start < 0 || text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function repairJsonCandidate(text: string): string {
  const normalized = normalizeJsonLikeStrings(text).trim();
  try {
    return jsonrepair(normalized).trim();
  } catch {
    return normalized;
  }
}

function normalizeJsonLikeStrings(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
    } else if (character === '\\') {
      output += character;
      escaped = true;
    } else if (character === '\r') {
      continue;
    } else if (character === '\n') {
      output += '\\n';
    } else if (character === '"') {
      const next = nextNonWhitespaceChar(text, index + 1);
      if ([':', ',', '}', ']', ''].includes(next)) {
        output += character;
        inString = false;
      } else {
        output += '\\"';
      }
    } else {
      output += character;
    }
  }
  return output;
}

function parseJsonStringLiteral(value: string): string | undefined {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return undefined;
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstBoundedText(values: readonly unknown[]): string | undefined {
  const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
  return typeof value === 'string' ? truncate(value.trim(), 2400) : undefined;
}

function stripFence(value: string): string {
  return value.replace(/^```(?:json)?\s*\n?/iu, '').replace(/\n?```\s*$/iu, '');
}

function nextNonWhitespaceChar(text: string, start: number): string {
  for (let index = start; index < text.length; index++) {
    const character = text[index]!;
    if (!/\s/u.test(character)) return character;
  }
  return '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n... [truncated ${value.length - limit} chars]` : value;
}
