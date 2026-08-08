import { createObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  ContextAuthorityError,
  ContextRecordSchema,
  ContextRevisionConflictError,
  applyContextUpdate,
  requiresAuthority,
  type ContextOperation,
  type ContextRecord,
  type ContextScope,
} from '../../domain/context/context_record.js';

export interface ContextUpdateCommand {
  scope: ContextScope;
  ownerId: ObjectId;
  /** Revision the caller read. Rejecting a mismatch is what stops one role overwriting another. */
  expectedRevision: number;
  operation: ContextOperation;
  actorId: ObjectId;
  /** True when the actor owns this scope; required for objective, constraints, and acceptance. */
  hasAuthority?: boolean;
  text?: string;
  rationale?: string;
  evidenceRefs?: string[];
  values?: string[];
  targetId?: string;
  path?: string;
}

/**
 * The only way context is written.
 *
 * Roles never touch context files directly. Going through commands is what makes two things
 * possible at once: every change carries an author, and a concurrent change is refused rather than
 * silently overwritten — the failure mode a shared Markdown file cannot avoid.
 */
export class ContextService {
  constructor(private readonly repository: DomainObjectRepositoryPort) {}

  /** Reads the record for a scope, creating an empty one the first time it is needed. */
  async ensure(projectId: ObjectId, scope: ContextScope, ownerId: ObjectId): Promise<ContextRecord> {
    const existing = await this.find(projectId, scope, ownerId);
    if (existing) return existing;
    const record = ContextRecordSchema.parse({
      ...createObjectEnvelope({
        name: `context-${scope}-${ownerId}`,
        objectType: 'context-record',
        projectId,
      }),
      scope,
      ownerId,
    });
    await this.repository.insert(record, scope);
    return record;
  }

  async find(
    projectId: ObjectId,
    scope: ContextScope,
    ownerId: ObjectId,
  ): Promise<ContextRecord | undefined> {
    const objects = await this.repository.list({ objectType: 'context-record', projectId });
    return objects.find(
      (object): object is ContextRecord =>
        object.objectType === 'context-record' && object.scope === scope && object.ownerId === ownerId,
    );
  }

  async apply(projectId: ObjectId, command: ContextUpdateCommand): Promise<ContextRecord> {
    if (requiresAuthority(command.operation) && !command.hasAuthority) {
      throw new ContextAuthorityError(command.scope, command.operation);
    }
    const record = await this.ensure(projectId, command.scope, command.ownerId);
    if (record.revision !== command.expectedRevision) {
      throw new ContextRevisionConflictError(record.id, command.expectedRevision, record.revision);
    }
    const updated = applyContextUpdate(record, {
      operation: command.operation,
      actorId: command.actorId,
      at: new Date().toISOString(),
      text: command.text,
      rationale: command.rationale,
      evidenceRefs: command.evidenceRefs,
      values: command.values,
      targetId: command.targetId,
      path: command.path,
    });
    await this.repository.update(updated, updated.scope);
    return updated;
  }
}
