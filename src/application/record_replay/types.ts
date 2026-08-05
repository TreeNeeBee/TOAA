export const RECORD_REPLAY_MODES = ['off', 'record', 'replay', 'auto', 'refresh'] as const;
export type RecordReplayMode = (typeof RECORD_REPLAY_MODES)[number];
export type RecordReplayChannel = 'http' | 'llm' | 'subprocess' | 'tool';

export interface RecordReplayEntry {
  version: 2;
  id: string;
  channel: RecordReplayChannel;
  operation: string;
  requestKey: string;
  request: unknown;
  response: unknown;
  responseHash: string;
  supersedesEntryIds: string[];
  previousEntryHash?: string;
  entryHash: string;
  recordedAt: string;
}

export interface RecordReplayStore {
  find(channel: RecordReplayChannel, requestKey: string): Promise<RecordReplayEntry[]>;
  list(): Promise<RecordReplayEntry[]>;
  append(entry: RecordReplayEntry): Promise<void>;
}

export interface RecordReplayRequest<TRequest> {
  channel: RecordReplayChannel;
  operation: string;
  request: TRequest;
}

export type RecordReplayFailureCode =
  | 'replay_miss'
  | 'replay_ambiguous'
  | 'record_corrupt'
  | 'secret_detected';

export class RecordReplayError extends Error {
  constructor(
    public readonly code: RecordReplayFailureCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RecordReplayError';
  }
}
