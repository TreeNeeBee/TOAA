import {
  activeEntries,
  verifyEntryChain,
} from './controller.js';
import {
  RecordReplayError,
  type RecordReplayChannel,
  type RecordReplayEntry,
  type RecordReplayStore,
} from './types.js';

export interface FixtureGroupInspection {
  channel: RecordReplayChannel | string;
  requestKey: string;
  entries: number;
  activeEntries: number;
  supersededEntries: number;
  activeResponseCount: number;
  valid: boolean;
  issue?: string;
}

export interface FixtureInspectionReport {
  ok: boolean;
  totalEntries: number;
  totalGroups: number;
  channels: Partial<Record<RecordReplayChannel, number>>;
  groups: FixtureGroupInspection[];
}

export class FixtureService {
  constructor(private readonly store: RecordReplayStore) {}

  async inspect(): Promise<FixtureInspectionReport> {
    const entries = await this.store.list();
    const grouped = groupEntries(entries);
    const groups = [...grouped.values()].map(inspectGroup);
    const channels: Partial<Record<RecordReplayChannel, number>> = {};
    for (const entry of entries) {
      if (!isChannel(entry.channel)) continue;
      channels[entry.channel] = (channels[entry.channel] ?? 0) + 1;
    }
    return {
      ok: groups.every((group) => group.valid),
      totalEntries: entries.length,
      totalGroups: groups.length,
      channels,
      groups: groups.sort((left, right) =>
        left.channel.localeCompare(right.channel) || left.requestKey.localeCompare(right.requestKey),
      ),
    };
  }

  async verify(): Promise<FixtureInspectionReport> {
    const report = await this.inspect();
    if (!report.ok) {
      throw new RecordReplayError('record_corrupt', 'Record/replay fixture verification failed', {
        invalidGroups: report.groups.filter((group) => !group.valid),
      });
    }
    return report;
  }
}

function groupEntries(entries: readonly RecordReplayEntry[]): Map<string, RecordReplayEntry[]> {
  const groups = new Map<string, RecordReplayEntry[]>();
  for (const entry of entries) {
    const key = `${String(entry.channel)}:${String(entry.requestKey)}`;
    const current = groups.get(key) ?? [];
    current.push(entry);
    groups.set(key, current);
  }
  return groups;
}

function inspectGroup(entries: readonly RecordReplayEntry[]): FixtureGroupInspection {
  const first = entries[0]!;
  try {
    const ordered = verifyEntryChain(entries);
    const active = activeEntries(ordered);
    const activeResponseCount = new Set(active.map((entry) => entry.responseHash)).size;
    if (activeResponseCount > 1) {
      throw new RecordReplayError(
        'replay_ambiguous',
        `Fixture group has ${activeResponseCount} active responses`,
      );
    }
    return {
      channel: String(first.channel),
      requestKey: String(first.requestKey),
      entries: entries.length,
      activeEntries: active.length,
      supersededEntries: entries.length - active.length,
      activeResponseCount,
      valid: true,
    };
  } catch (error) {
    return {
      channel: String(first.channel),
      requestKey: String(first.requestKey),
      entries: entries.length,
      activeEntries: 0,
      supersededEntries: 0,
      activeResponseCount: 0,
      valid: false,
      issue: (error as Error).message,
    };
  }
}

function isChannel(value: unknown): value is RecordReplayChannel {
  return value === 'http' || value === 'llm' || value === 'subprocess' || value === 'tool';
}
