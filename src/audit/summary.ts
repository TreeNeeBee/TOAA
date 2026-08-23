import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { AuditEvent } from './audit.js';

interface IndexedAuditEvent {
  line: number;
  event: AuditEvent;
}

interface SessionSummary {
  command: string;
  start?: IndexedAuditEvent;
  end?: IndexedAuditEvent;
  counts: Map<string, number>;
  signals: IndexedAuditEvent[];
  signalCount: number;
}

const SIGNAL_LIMIT_PER_SESSION = 80;

/**
 * Rebuilds the compact audit index from the append-only JSONL source of truth.
 *
 * The summary is deliberately disposable. It never feeds state back into the Runtime, and a failed
 * rebuild cannot damage or shorten the original record.
 */
export async function rebuildAuditSummary(jsonlPath: string, summaryPath: string): Promise<void> {
  const objectRefs = await loadObjectRefs(summaryPath);
  const sessions: SessionSummary[] = [];
  let current = newSession('(unknown)');
  let totalRecords = 0;
  let malformedRecords = 0;

  const input = createReadStream(jsonlPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const raw of lines) {
    totalRecords += 1;
    let event: AuditEvent;
    try {
      event = JSON.parse(raw) as AuditEvent;
    } catch {
      malformedRecords += 1;
      continue;
    }
    const indexed = { line: totalRecords, event };
    if (event.kind === 'session.start') {
      if (current.start || current.end || current.counts.size > 0) sessions.push(current);
      current = newSession(readString(event.data?.command) ?? commandFromMessage(event.message));
      current.start = indexed;
    }
    current.counts.set(event.kind, (current.counts.get(event.kind) ?? 0) + 1);
    if (isHighSignal(event)) {
      current.signalCount += 1;
      current.signals.push(indexed);
      if (current.signals.length > SIGNAL_LIMIT_PER_SESSION) current.signals.shift();
    }
    if (event.kind === 'session.end') current.end = indexed;
  }
  if (current.start || current.end || current.counts.size > 0) sessions.push(current);

  const relativeRaw = `./${path.basename(jsonlPath)}`;
  const rendered = [
    '# Audit Summary',
    '',
    '> Generated index only. The complete append-only audit remains in ' +
      `[${path.basename(jsonlPath)}](${relativeRaw}).`,
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Raw records: ${totalRecords}`,
    `- Sessions: ${sessions.length}`,
    `- Malformed records: ${malformedRecords}`,
    '',
    ...sessions.flatMap((session, index) => renderSession(session, index + 1, relativeRaw, objectRefs)),
  ].join('\n');

  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  const temporary = `${summaryPath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${rendered}\n`, 'utf8');
  await fs.rename(temporary, summaryPath);
}

function newSession(command: string): SessionSummary {
  return { command, counts: new Map(), signals: [], signalCount: 0 };
}

function renderSession(
  session: SessionSummary,
  index: number,
  raw: string,
  objectRefs: ReadonlyMap<string, string>,
): string[] {
  const first = session.start?.line ?? session.signals[0]?.line;
  const last = session.end?.line ?? session.signals.at(-1)?.line ?? first;
  const status = readString(session.end?.event.data?.status) ?? (session.end ? 'ended' : 'interrupted');
  const counts = [...session.counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}=${count}`)
    .join(', ');
  const range = first === undefined
    ? '(no valid record range)'
    : `[raw L${first}-L${last}](${raw}#L${first})`;
  const signalLines = session.signals.length === 0
    ? ['- Key records: none']
    : [
        ...(session.signalCount > session.signals.length
          ? [`- ${session.signalCount - session.signals.length} earlier high-signal record(s) are indexed by the raw session range above.`]
          : []),
        ...session.signals.map(({ line, event }) => {
        const objects = objectLinks(event.data, objectRefs);
        return `- [L${line}](${raw}#L${line}) \`${event.kind}\` ${escapeMarkdown(event.message)}` +
          (objects.length > 0 ? ` (${objects.join(', ')})` : '');
        }),
      ];
  return [
    `## Session ${index}: ${escapeMarkdown(session.command)}`,
    '',
    `- Status: ${escapeMarkdown(status)}`,
    `- Time: ${session.start?.event.ts ?? '(unknown)'} -> ${session.end?.event.ts ?? '(interrupted)'}`,
    `- Records: ${range}`,
    `- Event counts: ${counts || '(none)'}`,
    '',
    '### Key Records',
    '',
    ...signalLines,
    '',
  ];
}

function objectLinks(
  data: Record<string, unknown> | undefined,
  objectRefs: ReadonlyMap<string, string>,
): string[] {
  if (!data) return [];
  const mappings: Array<[string, string]> = [
    ['projectId', 'project'],
    ['phaseId', 'phase'],
    ['stepId', 'step'],
    ['ticketId', 'ticket'],
    ['qualityAssessmentId', 'quality-assessment'],
    ['changelistId', 'changelist'],
  ];
  return mappings.flatMap(([field, type]) => {
    const id = readString(data[field]);
    if (!id) return [];
    const objectRef = objectRefs.get(id);
    if (!objectRef || !objectRef.startsWith(`objects/${type}/${id}/`)) return [];
    return [`[${field}](../${objectRef.split('/').map(encodeURIComponent).join('/')})`];
  });
}

async function loadObjectRefs(summaryPath: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const registryPath = path.resolve(path.dirname(summaryPath), '..', 'registry', 'index.json');
  try {
    const raw = JSON.parse(await fs.readFile(registryPath, 'utf8')) as {
      entries?: Array<{ id?: unknown; objectRef?: unknown }>;
    };
    for (const entry of raw.entries ?? []) {
      const id = readString(entry.id);
      const objectRef = readString(entry.objectRef)?.replaceAll('\\', '/');
      if (id && objectRef && !path.isAbsolute(objectRef) && !objectRef.split('/').includes('..')) {
        refs.set(id, objectRef);
      }
    }
  } catch {
    // The registry is optional for standalone audit users. Raw line links remain authoritative.
  }
  return refs;
}

function isHighSignal(event: AuditEvent): boolean {
  if (['llm.error', 'ticket.bug.created', 'ticket.bug.routed', 'ticket.bug.closed',
    'ticket.enhancement.created', 'ticket.enhancement.closed', 'ticket.change-request.created',
    'ticket.change-request.revised', 'ticket.change-request.closed', 'quality.gate.bug',
    'quality.gate.enhancement', 'phase.delivery_gate', 'session.end'].includes(event.kind)) return true;
  if (event.kind === 'phase.end') return !/\b(?:ok|passed|delivered|complete)\b/iu.test(event.message);
  if (event.kind === 'tool.result') {
    return event.data?.ok === false || /\b(?:failed|error|denied|timeout)\b/iu.test(event.message);
  }
  return false;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function commandFromMessage(message: string): string {
  const match = message.match(/\b(xcompiler[_ -][a-z-]+)\b/iu);
  return match?.[1] ?? '(unknown)';
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>|])/gu, '\\$1').replace(/\r?\n/gu, ' ');
}
