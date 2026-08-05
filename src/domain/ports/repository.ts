import type { ObjectId } from '../identity/object_id.js';
import type { ObjectType } from '../objects/object_type.js';
import type { PersistedDomainObject } from '../objects/persisted.js';
import type { Project } from '../projects/project.js';

export interface DomainRegistryEntryView {
  id: ObjectId;
  name: string;
  objectType: ObjectType;
  projectId: ObjectId;
  /** Stable content reference for the current revision; usable as a Checkpoint snapshot ref. */
  objectRef: string;
  revision: number;
  state?: string;
}

export interface DomainRegistryReader {
  require(id: ObjectId, expectedType?: ObjectType): DomainRegistryEntryView;
  byType(type: ObjectType): DomainRegistryEntryView[];
  currentEventSequence(): number;
}

export interface DomainObjectRepositoryPort {
  readonly registry: DomainRegistryReader;
  load(): Promise<void>;
  insert(object: PersistedDomainObject, state?: string): Promise<void>;
  update(object: PersistedDomainObject, state?: string): Promise<void>;
  commit(objects: readonly PersistedDomainObject[]): Promise<void>;
  read(id: ObjectId): Promise<PersistedDomainObject>;
  list(options?: { objectType?: ObjectType; projectId?: ObjectId }): Promise<PersistedDomainObject[]>;
  findProject(): Promise<Project | undefined>;
  retireProject(projectId: ObjectId): Promise<void>;
}
