import type { ObjectId } from '../../domain/identity/object_id.js';
import type { PersistedDomainObject } from '../../domain/objects/persisted.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';

const STAGNANT_OBSERVATION_LIMIT = 3;

export interface ProgressObservation {
  stalled: boolean;
  unchangedObservations: number;
}

/** Stops scheduler loops only when the persisted domain graph has stopped making semantic progress. */
export class ProjectProgressGuard {
  private previous?: string;
  private unchangedObservations = 0;

  constructor(private readonly repository: DomainObjectRepositoryPort) {}

  async observe(projectId: ObjectId, phaseId: ObjectId): Promise<ProgressObservation> {
    const objects = await this.repository.list({ projectId });
    const fingerprint = JSON.stringify(
      objects
        .filter((object) => belongsToPhase(object, phaseId))
        .map(progressProjection)
        .filter((value): value is Record<string, unknown> => value !== undefined)
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
    );
    if (fingerprint === this.previous) this.unchangedObservations += 1;
    else this.unchangedObservations = 0;
    this.previous = fingerprint;
    return {
      stalled: this.unchangedObservations >= STAGNANT_OBSERVATION_LIMIT,
      unchangedObservations: this.unchangedObservations,
    };
  }
}

function belongsToPhase(object: PersistedDomainObject, phaseId: ObjectId): boolean {
  if (object.objectType === 'phase') return object.id === phaseId;
  if ('phaseId' in object && object.phaseId === phaseId) return true;
  return object.objectType === 'ticket-change-set' ||
    object.objectType === 'merge-request' ||
    object.objectType === 'merge-gate-run';
}

function progressProjection(object: PersistedDomainObject): Record<string, unknown> | undefined {
  switch (object.objectType) {
    case 'phase':
      return {
        id: object.id,
        type: object.objectType,
        state: object.state,
        stepIds: object.stepIds,
        qualityAssessmentId: object.qualityAssessmentId,
        reportIds: object.reportIds,
      };
    case 'step':
      return {
        id: object.id,
        type: object.objectType,
        state: object.state,
        qualityAssessmentId: object.qualityAssessmentId,
      };
    case 'ticket':
      return {
        id: object.id,
        type: object.objectType,
        state: object.state,
        attempts: object.attempts,
        maxAttempts: object.maxAttempts,
        activeAssignmentId: object.activeAssignmentId,
        blockers: object.blockedByTicketIds,
        changes: object.changelistIds,
        applications: object.type === 'change-request' ? object.applications : undefined,
        solution: object.solution ? [object.solution.status, object.solution.updatedAt] : undefined,
      };
    case 'ticket-change-set':
      return {
        id: object.id,
        type: object.objectType,
        state: object.state,
        currentRevision: object.currentRevision,
        mergedRevision: object.mergedRevision,
      };
    case 'merge-request':
      return { id: object.id, type: object.objectType, state: object.state, mergedRevision: object.mergedRevision };
    case 'merge-gate-run':
      return { id: object.id, type: object.objectType, status: object.status };
    default:
      return undefined;
  }
}
