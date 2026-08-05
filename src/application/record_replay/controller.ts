import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  RecordReplayError,
  type RecordReplayChannel,
  type RecordReplayEntry,
  type RecordReplayMode,
  type RecordReplayRequest,
  type RecordReplayStore,
} from './types.js';

export interface RecordReplayControllerOptions {
  mode: RecordReplayMode;
  store: RecordReplayStore;
  enabledChannels?: readonly RecordReplayChannel[];
  redactedFields?: readonly string[];
}

export class RecordReplayController {
  private readonly channels: ReadonlySet<RecordReplayChannel>;
  private readonly redactedFields: ReadonlySet<string>;
  private readonly modeScope = new AsyncLocalStorage<RecordReplayMode>();

  constructor(private readonly options: RecordReplayControllerOptions) {
    this.channels = new Set(options.enabledChannels ?? ['http', 'llm']);
    this.redactedFields = new Set([
      'authorization',
      'proxy-authorization',
      'cookie',
      'set-cookie',
      'api_key',
      'apikey',
      'token',
      'password',
      ...(options.redactedFields ?? []).map((field) => field.toLowerCase()),
    ]);
  }

  get mode(): RecordReplayMode {
    return this.modeScope.getStore() ?? this.options.mode;
  }

  runWithMode<T>(mode: RecordReplayMode, operation: () => Promise<T>): Promise<T> {
    return this.modeScope.run(mode, operation);
  }

  enabled(channel: RecordReplayChannel): boolean {
    return this.mode !== 'off' && this.channels.has(channel);
  }

  async execute<TRequest, TResponse>(
    input: RecordReplayRequest<TRequest>,
    live: () => Promise<TResponse>,
  ): Promise<TResponse> {
    if (!this.enabled(input.channel)) return live();
    const request = redactAndCanonicalize(input.request, this.redactedFields);
    assertNoObviousSecret(request);
    const requestKey = hashValue({ channel: input.channel, operation: input.operation, request });
    const entries = await this.options.store.find(input.channel, requestKey);
    const valid = verifyEntryChain(entries);
    const active = activeEntries(valid);
    const distinctResponses = new Map(active.map((entry) => [entry.responseHash, entry]));
    if (distinctResponses.size > 1 && this.mode !== 'refresh') {
      throw new RecordReplayError(
        'replay_ambiguous',
        `Multiple recorded responses match ${input.channel}:${input.operation}`,
        { requestKey, entryIds: active.map((entry) => entry.id) },
      );
    }
    const match = active.at(-1);
    if (match && (this.mode === 'replay' || this.mode === 'auto')) {
      return structuredClone(match.response) as TResponse;
    }
    if (this.mode === 'replay') {
      throw new RecordReplayError(
        'replay_miss',
        `No recording matches ${input.channel}:${input.operation}`,
        { requestKey },
      );
    }
    const response = await live();
    const safeResponse = redactAndCanonicalize(response, this.redactedFields);
    assertNoObviousSecret(safeResponse);
    const previous = valid.at(-1);
    const base = {
      version: 2 as const,
      id: randomUUID(),
      channel: input.channel,
      operation: input.operation,
      requestKey,
      request,
      response: safeResponse,
      responseHash: hashValue(safeResponse),
      supersedesEntryIds: this.mode === 'refresh' ? active.map((entry) => entry.id) : [],
      previousEntryHash: previous?.entryHash,
      recordedAt: new Date().toISOString(),
    };
    const entry: RecordReplayEntry = { ...base, entryHash: hashValue(base) };
    await this.options.store.append(entry);
    return response;
  }
}

export function verifyEntry(entry: RecordReplayEntry): RecordReplayEntry {
  if (entry.version !== 2 || !Array.isArray(entry.supersedesEntryIds)) {
    throw new RecordReplayError(
      'record_corrupt',
      `Recording ${entry.id ?? '(unknown)'} is not a version 2 fixture; rebuild it with XCompiler 0.3`,
    );
  }
  if (entry.responseHash !== hashValue(entry.response)) {
    throw new RecordReplayError('record_corrupt', `Recording ${entry.id} response hash is invalid`);
  }
  const { entryHash, ...base } = entry;
  if (entryHash !== hashValue(base)) {
    throw new RecordReplayError('record_corrupt', `Recording ${entry.id} entry hash is invalid`);
  }
  return entry;
}

export function verifyEntryChain(entries: readonly RecordReplayEntry[]): RecordReplayEntry[] {
  if (entries.length === 0) return [];
  const verified = entries.map(verifyEntry);
  const roots = verified.filter((entry) => !entry.previousEntryHash);
  if (roots.length !== 1) {
    throw new RecordReplayError('record_corrupt', 'Recording chain must contain exactly one root', {
      rootEntryIds: roots.map((entry) => entry.id),
    });
  }
  const children = new Map<string, RecordReplayEntry[]>();
  for (const entry of verified) {
    if (!entry.previousEntryHash) continue;
    const values = children.get(entry.previousEntryHash) ?? [];
    values.push(entry);
    children.set(entry.previousEntryHash, values);
  }
  const ordered: RecordReplayEntry[] = [];
  let current: RecordReplayEntry | undefined = roots[0];
  while (current) {
    ordered.push(current);
    const next = children.get(current.entryHash) ?? [];
    if (next.length > 1) {
      throw new RecordReplayError('record_corrupt', `Recording chain forks after ${current.id}`, {
        childEntryIds: next.map((entry) => entry.id),
      });
    }
    current = next[0];
  }
  if (ordered.length !== verified.length) {
    throw new RecordReplayError('record_corrupt', 'Recording chain contains disconnected entries');
  }
  const seen = new Set<string>();
  for (const entry of ordered) {
    for (const supersededId of entry.supersedesEntryIds) {
      if (!seen.has(supersededId)) {
        throw new RecordReplayError(
          'record_corrupt',
          `Recording ${entry.id} supersedes an unknown or future entry ${supersededId}`,
        );
      }
    }
    seen.add(entry.id);
  }
  return ordered;
}

export function activeEntries(entries: readonly RecordReplayEntry[]): RecordReplayEntry[] {
  const superseded = new Set(entries.flatMap((entry) => entry.supersedesEntryIds));
  return entries.filter((entry) => !superseded.has(entry.id));
}

export function hashValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function redactAndCanonicalize(value: unknown, redactedFields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => redactAndCanonicalize(item, redactedFields));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [
        key,
        redactedFields.has(key.toLowerCase())
          ? '[REDACTED]'
          : redactAndCanonicalize(item, redactedFields),
      ]));
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
      .replace(/\b(?:sk|gsk|xai|hf)_[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED]');
  }
  return value;
}

function assertNoObviousSecret(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (/Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{12,}/iu.test(serialized)) {
    throw new RecordReplayError('secret_detected', 'Refusing to persist a recording containing a bearer secret');
  }
}
