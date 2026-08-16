import type { Workspace } from '../../workspace/workspace.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { ObjectType } from '../../domain/objects/object_type.js';
import type { ObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { Project } from '../../domain/projects/project.js';
import {
  PersistedDomainObjectSchema,
  type PersistedDomainObject,
} from '../../domain/objects/persisted.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  ObjectRegistry,
  sha256Content,
  type RegistryBatchOperation,
} from '../registry/object_registry.js';

/**
 * Object files are written once per revision at `<stateRoot>/objects/<type>/<id>/r<revision>.json`,
 * so a given ref never changes content and a read cache needs no invalidation: a new revision is a
 * new ref. The cache matters because PM repeatedly re-reads the object graph (routing, projections,
 * blocker sweeps), which is otherwise a file read per object per query.
 */
const OBJECT_CACHE_LIMIT = 4096;

export class DomainObjectRepository implements DomainObjectRepositoryPort {
  readonly registry: ObjectRegistry;
  private commitQueue: Promise<void> = Promise.resolve();
  private readonly objectCache = new Map<string, PersistedDomainObject>();

  constructor(private readonly workspace: Workspace) {
    this.registry = new ObjectRegistry(workspace);
  }

  private cacheObject(objectRef: string, object: PersistedDomainObject): void {
    if (this.objectCache.size >= OBJECT_CACHE_LIMIT) {
      const oldest = this.objectCache.keys().next();
      if (!oldest.done) this.objectCache.delete(oldest.value);
    }
    this.objectCache.set(objectRef, object);
  }

  async load(): Promise<void> {
    await this.registry.load();
  }

  async insert(object: PersistedDomainObject, state?: string): Promise<void> {
    await this.commitObjects([{ object, state, mode: 'register' }]);
  }

  async update(object: PersistedDomainObject, state?: string): Promise<void> {
    const parsed = PersistedDomainObjectSchema.parse(object);
    if (parsed.objectType === 'checkpoint' || parsed.objectType === 'ticket-trace-event') {
      throw new Error(`${parsed.objectType} ${parsed.id} is immutable and cannot be updated`);
    }
    this.registry.require(parsed.id, parsed.objectType);
    await this.commitObjects([{ object: parsed, state, mode: 'update' }]);
  }

  async commit(objects: readonly PersistedDomainObject[]): Promise<void> {
    const operations = objects.map((object) => ({
      object,
      state: objectState(object),
      mode: this.registry.get(object.id) ? 'update' as const : 'register' as const,
    }));
    await this.commitObjects(operations);
  }

  async read(id: ObjectId): Promise<PersistedDomainObject> {
    const entry = this.registry.require(id);
    const cached = this.objectCache.get(entry.objectRef);
    if (cached) return cached;
    const object = PersistedDomainObjectSchema.parse(
      JSON.parse(await this.workspace.readFile(entry.objectRef)),
    );
    if (object.id !== id || object.objectType !== entry.objectType) {
      throw new Error(`Domain object ${id} does not match its registry entry`);
    }
    this.cacheObject(entry.objectRef, object);
    return object;
  }

  async list(options: {
    objectType?: ObjectType;
    projectId?: ObjectId;
  } = {}): Promise<PersistedDomainObject[]> {
    const entries = options.objectType
      ? this.registry.byType(options.objectType)
      : this.registry.all();
    const selected = entries.filter((entry) =>
      !options.projectId || entry.projectId === options.projectId,
    );
    return Promise.all(selected.map((entry) => this.read(entry.id)));
  }

  async findProject(): Promise<Project | undefined> {
    const projects = await this.list({ objectType: 'project' });
    if (projects.length > 1) {
      throw new Error(`Workspace contains multiple active Projects: ${projects.map((item) => item.id).join(', ')}`);
    }
    const project = projects[0];
    if (!project) return undefined;
    if (project.objectType !== 'project') throw new Error(`Object ${project.id} is not a Project`);
    return project;
  }

  private commitObjects(operations: readonly {
    object: PersistedDomainObject;
    state?: string;
    mode: 'register' | 'update';
  }[]): Promise<void> {
    const commit = async () => {
      const registryOperations: RegistryBatchOperation[] = [];
      for (const operation of operations) {
        const parsed = PersistedDomainObjectSchema.parse(operation.object);
        if (
          operation.mode === 'update' &&
          (parsed.objectType === 'checkpoint' || parsed.objectType === 'ticket-trace-event')
        ) {
          throw new Error(`${parsed.objectType} ${parsed.id} is immutable and cannot be updated`);
        }
        const objectRef = domainObjectPath(parsed);
        const content = `${JSON.stringify(parsed, null, 2)}\n`;
        await this.workspace.writeFileAtomic(objectRef, content);
        // Safe even if the registry batch below fails: the registry would still point at the
        // previous ref, so this entry simply never gets looked up.
        this.cacheObject(objectRef, parsed);
        registryOperations.push({
          mode: operation.mode,
          input: {
            envelope: parsed,
            objectRef,
            contentHash: sha256Content(content),
            parentId: registryParentId(parsed),
            state: operation.state ?? objectState(parsed),
          },
        });
      }
      await this.registry.commitBatch(registryOperations);
    };
    const result = this.commitQueue.then(commit, commit);
    this.commitQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async retireProject(projectId: ObjectId): Promise<void> {
    const active = this.registry.all().filter((entry) => entry.projectId === projectId);
    if (active.length === 0) return;
    const remaining = new Map(active.map((entry) => [entry.id, entry]));
    while (remaining.size > 0) {
      const leaves = [...remaining.values()].filter((candidate) =>
        ![...remaining.values()].some((entry) => entry.parentId === candidate.id),
      );
      if (leaves.length === 0) {
        throw new Error(`Cannot retire Project ${projectId}: registry parent cycle detected`);
      }
      for (const entry of leaves) {
        await this.registry.tombstone(entry.id, entry.revision);
        remaining.delete(entry.id);
      }
    }
  }
}

export function domainObjectPath(object: ObjectEnvelope): string {
  return `objects/${object.objectType}/${object.id}/r${object.revision}.json`;
}

function registryParentId(object: PersistedDomainObject): ObjectId | undefined {
  switch (object.objectType) {
    case 'project':
      return undefined;
    case 'phase':
      return object.projectId;
    case 'step':
      return object.phaseId;
    case 'ticket':
      return object.parentTicketId ?? object.phaseId;
    case 'actor-registration':
      return object.projectId;
    case 'ticket-assignment':
      return object.ticketId;
    case 'ticket-trace-event':
      return object.ticketId;
    case 'workspace-handle':
      return object.ownerTicketId ?? object.projectId;
    case 'ticket-change-set':
      return object.rootTicketId;
    case 'merge-request':
      return object.changeSetId;
    case 'merge-gate-run':
      return object.mergeRequestId;
    case 'context-record':
      return object.scope === 'project' ? object.projectId : object.ownerId;
    case 'role-definition':
      return object.projectId;
    case 'project-management-plan':
      return object.projectId;
    case 'file-tree':
      // The master tree belongs to the Project, not to any workspace or Phase. Falling off this
      // switch registered it with no parent at all, so it hung outside the object graph that
      // integrity checks and `childrenOf` traversals walk.
      return object.projectId;
    case 'risk-record':
      return object.projectId;
    case 'decision-record':
      return object.projectId;
    case 'interaction-request':
      return object.relatedTicketId ?? object.projectId;
    case 'kpi':
      return object.subjectId;
    case 'quality-assessment':
      return object.subject.id;
    case 'checkpoint':
      return object.subject.id;
    case 'changelist':
      return object.ticketId;
    case 'deliverable':
      return object.owner.id;
    case 'plan':
      return object.planKind === 'phase' ? object.phaseId : object.projectId;
    case 'report':
      return object.subject.id;
    case 'log':
    case 'audit-event':
      return object.subject?.id ?? object.projectId;
    case 'domain-event':
      return object.aggregate.id;
  }
}

function objectState(object: PersistedDomainObject): string | undefined {
  if ('state' in object && typeof object.state === 'string') return object.state;
  if ('status' in object && typeof object.status === 'string') return object.status;
  if (object.objectType === 'plan') return object.planKind === 'phase' && !object.materialized
    ? 'planned'
    : 'materialized';
  return undefined;
}
