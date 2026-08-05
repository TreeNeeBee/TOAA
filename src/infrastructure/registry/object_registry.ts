import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { Workspace } from '../../workspace/workspace.js';
import { createObjectId, ObjectIdSchema, type ObjectId } from '../../domain/identity/object_id.js';
import { extractObjectEnvelope, type ObjectEnvelope } from '../../domain/objects/object_envelope.js';
import { ObjectTypeSchema, type ObjectType } from '../../domain/objects/object_type.js';

export const OBJECT_REGISTRY_KIND = 'xcompiler.object-registry';
export const OBJECT_REGISTRY_VERSION = 2;
export const OBJECT_REGISTRY_ROOT = '.xcompiler/registry';
export const OBJECT_REGISTRY_INDEX_PATH = `${OBJECT_REGISTRY_ROOT}/index.json`;
export const OBJECT_REGISTRY_EVENTS_PATH = `${OBJECT_REGISTRY_ROOT}/events.jsonl`;

const ContentHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const ObjectRegistryEntrySchema = z.object({
  id: ObjectIdSchema,
  name: z.string().trim().min(1),
  objectType: ObjectTypeSchema,
  projectId: ObjectIdSchema,
  parentId: ObjectIdSchema.optional(),
  objectRef: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  revision: z.number().int().positive(),
  contentHash: ContentHashSchema,
  state: z.string().trim().min(1).optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  tombstonedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type ObjectRegistryEntry = z.infer<typeof ObjectRegistryEntrySchema>;

const ObjectRegistrySnapshotSchema = z.object({
  kind: z.literal(OBJECT_REGISTRY_KIND),
  version: z.literal(OBJECT_REGISTRY_VERSION),
  eventSequence: z.number().int().nonnegative(),
  lastEventHash: ContentHashSchema.optional(),
  updatedAt: z.string().datetime({ offset: true }),
  entries: z.array(ObjectRegistryEntrySchema),
}).strict();

export type ObjectRegistrySnapshot = z.infer<typeof ObjectRegistrySnapshotSchema>;

const ObjectRegistryEventSchema = z.object({
  id: ObjectIdSchema,
  sequence: z.number().int().positive(),
  type: z.enum(['registered', 'updated', 'tombstoned']),
  objectId: ObjectIdSchema,
  at: z.string().datetime({ offset: true }),
  previousEventHash: ContentHashSchema.optional(),
  entry: ObjectRegistryEntrySchema,
  eventHash: ContentHashSchema,
}).strict();

type ObjectRegistryEvent = z.infer<typeof ObjectRegistryEventSchema>;

export interface RegistryIntegrityIssue {
  objectId: ObjectId;
  code: 'missing-object' | 'hash-mismatch' | 'missing-project' | 'missing-parent' | 'cross-project-parent';
  message: string;
}

export interface RegisterObjectInput {
  envelope: ObjectEnvelope;
  objectRef: string;
  contentHash: string;
  parentId?: ObjectId;
  state?: string;
}

export interface RegistryBatchOperation {
  mode: 'register' | 'update';
  input: RegisterObjectInput;
}

export class ObjectRegistry {
  private readonly entries = new Map<ObjectId, ObjectRegistryEntry>();
  private eventSequence = 0;
  private lastEventHash: string | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly workspace: Workspace) {}

  async load(): Promise<void> {
    this.entries.clear();
    this.eventSequence = 0;
    this.lastEventHash = undefined;

    const events = await this.readEvents();
    verifyEventChain(events);

    if (await this.workspace.exists(OBJECT_REGISTRY_INDEX_PATH)) {
      const snapshot = ObjectRegistrySnapshotSchema.parse(
        JSON.parse(await this.workspace.readFile(OBJECT_REGISTRY_INDEX_PATH)),
      );
      for (const entry of snapshot.entries) this.entries.set(entry.id, entry);
      this.eventSequence = snapshot.eventSequence;
      this.lastEventHash = snapshot.lastEventHash;
      if (snapshot.eventSequence > events.length) {
        throw new Error(
          `Object registry snapshot is ahead of its event log: ${snapshot.eventSequence} > ${events.length}`,
        );
      }
      const snapshotEventHash = snapshot.eventSequence > 0
        ? events[snapshot.eventSequence - 1]?.eventHash
        : undefined;
      if (snapshot.lastEventHash !== snapshotEventHash) {
        throw new Error('Object registry snapshot does not match its event log hash chain');
      }
    }

    for (const event of events) {
      if (event.sequence <= this.eventSequence) continue;
      if (event.sequence !== this.eventSequence + 1) {
        throw new Error(
          `Object registry event sequence gap: expected ${this.eventSequence + 1}, got ${event.sequence}`,
        );
      }
      this.applyEvent(event);
    }
  }

  get(id: ObjectId): ObjectRegistryEntry | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry } : undefined;
  }

  require(id: ObjectId, expectedType?: ObjectType): ObjectRegistryEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Object registry entry not found: ${id}`);
    if (expectedType && entry.objectType !== expectedType) {
      throw new Error(`Object ${id} is ${entry.objectType}, expected ${expectedType}`);
    }
    return { ...entry };
  }

  all(options: { includeTombstoned?: boolean } = {}): ObjectRegistryEntry[] {
    return [...this.entries.values()]
      .filter((entry) => options.includeTombstoned || !entry.tombstonedAt)
      .map((entry) => ({ ...entry }));
  }

  byType(type: ObjectType): ObjectRegistryEntry[] {
    return this.all().filter((entry) => entry.objectType === type);
  }

  childrenOf(parentId: ObjectId): ObjectRegistryEntry[] {
    return this.all().filter((entry) => entry.parentId === parentId);
  }

  currentEventSequence(): number {
    return this.eventSequence;
  }

  async register(input: RegisterObjectInput): Promise<ObjectRegistryEntry> {
    return this.serialize(async () => {
      const envelope = extractObjectEnvelope(input.envelope);
      if (this.entries.has(envelope.id)) {
        throw new Error(`Object id has already been registered and cannot be reused: ${envelope.id}`);
      }
      this.assertProjectAndParent(envelope, input.parentId);
      const entry = ObjectRegistryEntrySchema.parse({
        ...envelope,
        objectRef: normalizeObjectRef(input.objectRef),
        contentHash: input.contentHash,
        parentId: input.parentId,
        state: input.state,
      });
      await this.commit('registered', entry);
      return { ...entry };
    });
  }

  async update(input: RegisterObjectInput): Promise<ObjectRegistryEntry> {
    return this.serialize(async () => {
      const envelope = extractObjectEnvelope(input.envelope);
      const current = this.require(envelope.id);
      if (current.tombstonedAt) throw new Error(`Cannot update tombstoned object: ${envelope.id}`);
      if (envelope.objectType !== current.objectType || envelope.projectId !== current.projectId) {
        throw new Error(`Object identity metadata cannot change: ${envelope.id}`);
      }
      if (envelope.createdAt !== current.createdAt) {
        throw new Error(`Object createdAt cannot change: ${envelope.id}`);
      }
      if (envelope.revision !== current.revision + 1) {
        throw new Error(
          `Object ${envelope.id} revision must advance from ${current.revision} to ${current.revision + 1}`,
        );
      }
      const parentId = input.parentId ?? current.parentId;
      this.assertProjectAndParent(envelope, parentId);
      const entry = ObjectRegistryEntrySchema.parse({
        ...envelope,
        objectRef: normalizeObjectRef(input.objectRef),
        contentHash: input.contentHash,
        parentId,
        state: input.state,
      });
      await this.commit('updated', entry);
      return { ...entry };
    });
  }

  async commitBatch(operations: readonly RegistryBatchOperation[]): Promise<ObjectRegistryEntry[]> {
    if (operations.length === 0) return [];
    return this.serialize(async () => {
      const shadow = new Map(this.entries);
      const entries: ObjectRegistryEntry[] = [];
      for (const operation of operations) {
        const envelope = extractObjectEnvelope(operation.input.envelope);
        const current = shadow.get(envelope.id);
        if (operation.mode === 'register') {
          if (current) throw new Error(`Object id has already been registered and cannot be reused: ${envelope.id}`);
        } else {
          if (!current) throw new Error(`Object registry entry not found: ${envelope.id}`);
          if (current.tombstonedAt) throw new Error(`Cannot update tombstoned object: ${envelope.id}`);
          if (envelope.objectType !== current.objectType || envelope.projectId !== current.projectId) {
            throw new Error(`Object identity metadata cannot change: ${envelope.id}`);
          }
          if (envelope.createdAt !== current.createdAt) {
            throw new Error(`Object createdAt cannot change: ${envelope.id}`);
          }
          if (envelope.revision !== current.revision + 1) {
            throw new Error(
              `Object ${envelope.id} revision must advance from ${current.revision} to ${current.revision + 1}`,
            );
          }
        }
        const parentId = operation.input.parentId ?? current?.parentId;
        assertProjectAndParentIn(shadow, envelope, parentId);
        const entry = ObjectRegistryEntrySchema.parse({
          ...envelope,
          objectRef: normalizeObjectRef(operation.input.objectRef),
          contentHash: operation.input.contentHash,
          parentId,
          state: operation.input.state,
        });
        shadow.set(entry.id, entry);
        entries.push(entry);
      }

      let sequence = this.eventSequence;
      let previousEventHash = this.lastEventHash;
      const events: ObjectRegistryEvent[] = entries.map((entry, index) => {
        const eventBase = {
          id: createObjectId(),
          sequence: sequence + index + 1,
          type: operations[index]!.mode === 'register' ? 'registered' as const : 'updated' as const,
          objectId: entry.id,
          at: new Date().toISOString(),
          previousEventHash,
          entry,
        };
        const event = ObjectRegistryEventSchema.parse({
          ...eventBase,
          eventHash: hashRegistryEvent(eventBase),
        });
        previousEventHash = event.eventHash;
        return event;
      });
      await this.workspace.appendFile(
        OBJECT_REGISTRY_EVENTS_PATH,
        events.map((event) => JSON.stringify(event)).join('\n') + '\n',
      );
      for (const event of events) this.applyEvent(event);
      await this.writeSnapshot();
      return entries.map((entry) => ({ ...entry }));
    });
  }

  async tombstone(id: ObjectId, expectedRevision: number, now = new Date().toISOString()): Promise<ObjectRegistryEntry> {
    return this.serialize(async () => {
      const current = this.require(id);
      if (current.tombstonedAt) return current;
      if (current.revision !== expectedRevision) {
        throw new Error(
          `Object ${id} revision conflict: expected ${expectedRevision}, current ${current.revision}`,
        );
      }
      if (this.childrenOf(id).length > 0) {
        throw new Error(`Cannot tombstone object ${id} while active child objects exist`);
      }
      const entry = ObjectRegistryEntrySchema.parse({
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        tombstonedAt: now,
      });
      await this.commit('tombstoned', entry);
      return { ...entry };
    });
  }

  async verifyIntegrity(options: { verifyContent?: boolean } = {}): Promise<RegistryIntegrityIssue[]> {
    const issues: RegistryIntegrityIssue[] = [];
    for (const entry of this.all()) {
      const project = this.entries.get(entry.projectId);
      if (!project || project.objectType !== 'project' || project.tombstonedAt) {
        issues.push({
          objectId: entry.id,
          code: 'missing-project',
          message: `Project ${entry.projectId} is missing or inactive`,
        });
      }
      if (entry.parentId) {
        const parent = this.entries.get(entry.parentId);
        if (!parent || parent.tombstonedAt) {
          issues.push({
            objectId: entry.id,
            code: 'missing-parent',
            message: `Parent ${entry.parentId} is missing or inactive`,
          });
        } else if (parent.projectId !== entry.projectId) {
          issues.push({
            objectId: entry.id,
            code: 'cross-project-parent',
            message: `Parent ${entry.parentId} belongs to another project`,
          });
        }
      }
      if (options.verifyContent) {
        if (!(await this.workspace.exists(entry.objectRef))) {
          issues.push({
            objectId: entry.id,
            code: 'missing-object',
            message: `Object content is missing: ${entry.objectRef}`,
          });
        } else {
          const actual = sha256Content(await this.workspace.readFile(entry.objectRef));
          if (actual !== entry.contentHash) {
            issues.push({
              objectId: entry.id,
              code: 'hash-mismatch',
              message: `Object content hash does not match registry entry: ${entry.objectRef}`,
            });
          }
        }
      }
    }
    return issues;
  }

  async rebuild(): Promise<ObjectRegistrySnapshot> {
    return this.serialize(async () => {
      this.entries.clear();
      this.eventSequence = 0;
      this.lastEventHash = undefined;
      const events = await this.readEvents();
      verifyEventChain(events);
      for (const event of events) {
        if (event.sequence !== this.eventSequence + 1) {
          throw new Error(
            `Object registry event sequence gap: expected ${this.eventSequence + 1}, got ${event.sequence}`,
          );
        }
        this.applyEvent(event);
      }
      return this.writeSnapshot();
    });
  }

  private assertProjectAndParent(envelope: ObjectEnvelope, parentId?: ObjectId): void {
    assertProjectAndParentIn(this.entries, envelope, parentId);
  }

  private async commit(type: ObjectRegistryEvent['type'], entry: ObjectRegistryEntry): Promise<void> {
    const eventBase = {
      id: createObjectId(),
      sequence: this.eventSequence + 1,
      type,
      objectId: entry.id,
      at: new Date().toISOString(),
      previousEventHash: this.lastEventHash,
      entry,
    };
    const event = ObjectRegistryEventSchema.parse({
      ...eventBase,
      eventHash: hashRegistryEvent(eventBase),
    });
    await this.workspace.appendFile(OBJECT_REGISTRY_EVENTS_PATH, `${JSON.stringify(event)}\n`);
    this.applyEvent(event);
    await this.writeSnapshot();
  }

  private applyEvent(event: ObjectRegistryEvent): void {
    if (event.objectId !== event.entry.id) {
      throw new Error(`Object registry event ${event.id} references inconsistent object ids`);
    }
    this.entries.set(event.objectId, event.entry);
    this.eventSequence = event.sequence;
    this.lastEventHash = event.eventHash;
  }

  private async readEvents(): Promise<ObjectRegistryEvent[]> {
    if (!(await this.workspace.exists(OBJECT_REGISTRY_EVENTS_PATH))) return [];
    const raw = await this.workspace.readFile(OBJECT_REGISTRY_EVENTS_PATH);
    return raw.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ObjectRegistryEventSchema.parse(JSON.parse(line)));
  }

  private async writeSnapshot(): Promise<ObjectRegistrySnapshot> {
    const snapshot = ObjectRegistrySnapshotSchema.parse({
      kind: OBJECT_REGISTRY_KIND,
      version: OBJECT_REGISTRY_VERSION,
      eventSequence: this.eventSequence,
      lastEventHash: this.lastEventHash,
      updatedAt: new Date().toISOString(),
      entries: [...this.entries.values()].sort((left, right) => left.id.localeCompare(right.id)),
    });
    await this.workspace.writeFileAtomic(
      OBJECT_REGISTRY_INDEX_PATH,
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    return snapshot;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function sha256Content(content: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function hashRegistryEvent(
  event: Omit<ObjectRegistryEvent, 'eventHash'>,
): string {
  return sha256Content(JSON.stringify({
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    objectId: event.objectId,
    at: event.at,
    previousEventHash: event.previousEventHash,
    entry: event.entry,
  }));
}

function verifyEventChain(events: ObjectRegistryEvent[]): void {
  let previousEventHash: string | undefined;
  for (const [index, event] of events.entries()) {
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Object registry event sequence gap: expected ${expectedSequence}, got ${event.sequence}`,
      );
    }
    if (event.previousEventHash !== previousEventHash) {
      throw new Error(`Object registry event hash chain is broken at sequence ${event.sequence}`);
    }
    if (event.eventHash !== hashRegistryEvent(event)) {
      throw new Error(`Object registry event hash is invalid at sequence ${event.sequence}`);
    }
    previousEventHash = event.eventHash;
  }
}

function assertProjectAndParentIn(
  entries: ReadonlyMap<ObjectId, ObjectRegistryEntry>,
  envelope: ObjectEnvelope,
  parentId?: ObjectId,
): void {
  if (envelope.objectType === 'project') {
    if (envelope.projectId !== envelope.id) {
      throw new Error('Project object must use its own id as projectId');
    }
    if (parentId) throw new Error('Project object cannot have a parent');
    return;
  }

  const project = entries.get(envelope.projectId);
  if (!project || project.objectType !== 'project' || project.tombstonedAt) {
    throw new Error(`Active project must be registered before child objects: ${envelope.projectId}`);
  }
  if (!parentId) return;
  const parent = entries.get(parentId);
  if (!parent || parent.tombstonedAt) {
    throw new Error(`Active parent object is not registered: ${parentId}`);
  }
  if (parent.projectId !== envelope.projectId) {
    throw new Error(`Parent ${parentId} belongs to another project`);
  }
  let ancestor: ObjectRegistryEntry | undefined = parent;
  while (ancestor) {
    if (ancestor.id === envelope.id) {
      throw new Error(`Parent relationship would create a cycle for object ${envelope.id}`);
    }
    ancestor = ancestor.parentId ? entries.get(ancestor.parentId) : undefined;
  }
}

function normalizeObjectRef(value: string): string {
  const normalized = value.trim().replace(/\\/gu, '/');
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-z]:\//iu.test(normalized)) {
    throw new Error('Object reference must be a non-empty workspace-relative path');
  }
  const clean = path.posix.normalize(normalized);
  if (clean === '..' || clean.startsWith('../')) {
    throw new Error('Object reference cannot escape the workspace');
  }
  return clean.replace(/^\.\//u, '');
}
