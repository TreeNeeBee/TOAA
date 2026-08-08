import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  transitionChangeSet,
  type TicketChangeSet,
} from '../../domain/workspace/change_set.js';
import {
  advanceMergeRequest,
  type GateCheckResult,
} from '../../domain/workspace/merge_request.js';
import type { MergeGateService } from './merge_gate_service.js';
import { MergeConflictError, type GitMergePort } from './git_port.js';

export type IntegrationStatus =
  | 'merged'
  | 'nothing-to-merge'
  | 'failed'
  | 'blocked'
  | 'awaiting-authorization';

export interface IntegrationOutcome {
  status: IntegrationStatus;
  reason?: string;
  failureLog?: string;
  mergedRevisions: string[];
}

/** Runs the project's own gates against a merge candidate checked out at `root`. */
export type GateCheckRunner = (root: string) => Promise<GateCheckResult[]>;
export type MergeAuthorizer = (changeSet: TicketChangeSet) => Promise<{
  approved: boolean;
  reason?: string;
}>;

export interface MergeIntegrationOptions {
  repository: DomainObjectRepositoryPort;
  gates: MergeGateService;
  git: GitMergePort;
  runChecks: GateCheckRunner;
  targetBranch: string;
  /**
   * Whether XCompiler may write to the mainline of this repository.
   *
   * False for a repository that already existed when XCompiler was pointed at it: its branch policy
   * belongs to whoever created it, so a validated change waits for explicit authorization instead
   * of being merged automatically.
   */
  mayMerge: boolean;
  /** Requests explicit authorization when repository ownership does not grant automatic merging. */
  authorizeMerge?: MergeAuthorizer;
  /** Releases the Ticket worktree after the generation has been durably marked merged. */
  releaseChangeSet: (changeSetId: ObjectId) => Promise<void>;
}

/**
 * Carries a Phase's completed work onto the mainline.
 *
 * Runs at the point a Phase would otherwise be delivered, because that is when the work is finished
 * and before anything downstream depends on it having landed. Each ChangeSet is validated as a
 * merge candidate and squashed, so the mainline gains one commit per ChangeSet generation.
 */
export class MergeIntegrationService {
  constructor(private readonly options: MergeIntegrationOptions) {}

  /**
   * Lands one Ticket's change as its Step delivers.
   *
   * Merging at delivery rather than at Phase end is what lets the next Step read this one's work:
   * V-model Steps are sequentially dependent, and a change still sitting on its own branch is
   * invisible to everything that follows.
   */
  async integrateTicket(projectId: ObjectId, ticketId: ObjectId): Promise<IntegrationOutcome> {
    const objects = await this.options.repository.list({
      objectType: 'ticket-change-set',
      projectId,
    });
    // Either the Ticket that owns the generation, or a corrective Ticket recorded against it.
    const changeSet = objects.find((object) =>
      object.objectType === 'ticket-change-set' &&
      (object.rootTicketId === ticketId || object.correctiveTicketIds.includes(ticketId)) &&
      object.state !== 'merged' &&
      object.state !== 'abandoned');
    // Every Step but CODE works in the canonical copy, so most deliveries have nothing to merge.
    if (!changeSet || changeSet.objectType !== 'ticket-change-set') {
      return { status: 'nothing-to-merge', mergedRevisions: [] };
    }
    const mergedRevisions: string[] = [];
    const outcome = await this.integrate(changeSet, mergedRevisions);
    return outcome ?? { status: 'merged', mergedRevisions };
  }

  async integratePhase(projectId: ObjectId, phaseId: ObjectId): Promise<IntegrationOutcome> {
    const pending = await this.pendingChangeSets(projectId, phaseId);
    if (pending.length === 0) return { status: 'nothing-to-merge', mergedRevisions: [] };

    const mergedRevisions: string[] = [];
    for (const changeSet of pending) {
      const outcome = await this.integrate(changeSet, mergedRevisions);
      if (outcome) return outcome;
    }
    return { status: 'merged', mergedRevisions };
  }

  private async integrate(
    changeSet: TicketChangeSet,
    mergedRevisions: string[],
  ): Promise<IntegrationOutcome | undefined> {
    let request;
    try {
      request = await this.options.gates.open(changeSet);
    } catch (error) {
      return blockedOutcome('merge request could not be opened', error, mergedRevisions);
    }
    // Every write below re-reads first. Opening the Merge Request links it onto this ChangeSet and
    // so advances it, and the gate run in between writes again; the registry accepts exactly one
    // revision step per write, so anything written through the copy captured above is rejected.
    // `MergeGateService.open` already guards itself this way — the hazard was only unhandled here.
    let tracked = await this.freshChangeSet(changeSet.id);
    if (tracked.state === 'developing') {
      tracked = transitionChangeSet(tracked, 'reviewing');
      await this.options.repository.update(tracked, tracked.state);
    }
    let candidate;
    try {
      candidate = await this.options.gates.start(request.id);
    } catch (error) {
      if (error instanceof MergeConflictError) {
        return {
          status: 'failed',
          reason: `merge candidate conflicts with ${this.options.targetBranch}`,
          failureLog: error.message,
          mergedRevisions,
        };
      }
      return blockedOutcome('merge gate candidate could not be created', error, mergedRevisions);
    }
    let checks: GateCheckResult[];
    try {
      checks = await this.options.runChecks(candidate.root);
    } catch (error) {
      checks = [{
        name: 'gate-execution',
        ok: false,
        kind: 'infrastructure',
        summary: errorMessage(error),
      }];
    }
    let run;
    try {
      run = await this.options.gates.complete(candidate.run.id, checks);
    } catch (error) {
      return blockedOutcome('merge gate result could not be completed', error, mergedRevisions);
    }

    if (run.status === 'infrastructure-failed') {
      // Nothing about the project was shown to be wrong, so this blocks the merge rather than
      // opening a defect against the generated code.
      return {
        status: 'blocked',
        reason: `merge gate could not run: ${failedSummary(checks)}`,
        mergedRevisions,
      };
    }
    if (run.status !== 'passed') {
      return {
        status: 'failed',
        reason: `merge gate failed for ${changeSet.sourceBranch}`,
        failureLog: failedSummary(checks),
        mergedRevisions,
      };
    }

    // Record that the gate passed before deciding whether we may merge, so a change waiting on
    // authorization still shows it was validated.
    tracked = await this.freshChangeSet(changeSet.id);
    if (tracked.state !== 'gate-passed') {
      tracked = transitionChangeSet(tracked, 'gate-passed');
      await this.options.repository.update(tracked, tracked.state);
    }

    if (!this.options.mayMerge) {
      if (!this.options.authorizeMerge) {
        return {
          status: 'awaiting-authorization',
          reason:
            `${changeSet.sourceBranch} passed its gate but this repository already existed when ` +
            'XCompiler was pointed at it, so merging into its mainline needs explicit authorization',
          mergedRevisions,
        };
      }
      let decision;
      try {
        decision = await this.options.authorizeMerge(changeSet);
      } catch (error) {
        return blockedOutcome('merge authorization could not be completed', error, mergedRevisions);
      }
      if (!decision.approved) {
        return {
          status: 'awaiting-authorization',
          reason: decision.reason ?? `merge authorization denied for ${changeSet.sourceBranch}`,
          mergedRevisions,
        };
      }
    }

    const verdict = await this.options.gates.currentVerdict(request.id);
    if (!verdict.ok) {
      // The mainline moved between the gate passing and this merge, so the verdict no longer
      // describes what would land.
      return { status: 'failed', reason: verdict.reason, mergedRevisions };
    }

    // `mergeable` is not a formality: it is the recorded fact that a passing gate was confirmed
    // still current, which is the only condition under which the squash below is authorized.
    const approvedRequest = await this.repositoryRead(request.id);
    const mergeable = advanceMergeRequest(approvedRequest, ['mergeable']);
    await this.options.repository.update(mergeable, mergeable.state);

    // A merge that cannot run is reported, not thrown. Every other verdict here returns an outcome
    // the orchestrator handles; letting this one escape killed the process instead, after the gate
    // had already passed and the Merge Request was recorded as mergeable — the most expensive point
    // in the run to lose. Nothing about the project was shown to be wrong, so it blocks.
    let merged: string;
    try {
      merged = await this.options.git.squashMerge({
        targetBranch: this.options.targetBranch,
        sourceBranch: changeSet.sourceBranch,
        expectedTargetRevision: run.targetRevision,
        message: `[xcompiler] ${changeSet.name}`,
      });
    } catch (error) {
      return {
        status: 'blocked',
        reason: `merge could not be applied for ${changeSet.sourceBranch}: ${(error as Error).message}`,
        mergedRevisions,
      };
    }
    mergedRevisions.push(merged);

    await this.options.repository.commit([
      advanceMergeRequest(mergeable, ['merged'], { mergedRevision: merged }),
      transitionChangeSet(await this.freshChangeSet(changeSet.id), 'merged', {
        mergedRevision: merged,
      }),
    ]);
    try {
      await this.options.releaseChangeSet(changeSet.id);
    } catch (error) {
      return {
        status: 'merged',
        reason: `merged successfully but worktree cleanup failed: ${errorMessage(error)}`,
        mergedRevisions,
      };
    }
    return undefined;
  }

  /** ChangeSets whose work belongs to this Phase and has not landed yet. */
  private async pendingChangeSets(
    projectId: ObjectId,
    phaseId: ObjectId,
  ): Promise<TicketChangeSet[]> {
    const objects = await this.options.repository.list({
      objectType: 'ticket-change-set',
      projectId,
    });
    const pending: TicketChangeSet[] = [];
    for (const object of objects) {
      if (object.objectType !== 'ticket-change-set') continue;
      if (object.state === 'merged' || object.state === 'abandoned') continue;
      const root = await this.options.repository.read(object.rootTicketId);
      if (root.objectType === 'ticket' && root.phaseId === phaseId) pending.push(object);
    }
    return pending;
  }

  private async freshChangeSet(id: ObjectId): Promise<TicketChangeSet> {
    const object = await this.options.repository.read(id);
    if (object.objectType !== 'ticket-change-set') {
      throw new Error(`Object ${id} is not a Ticket ChangeSet`);
    }
    return object;
  }

  private async repositoryRead(id: ObjectId) {
    const object = await this.options.repository.read(id);
    if (object.objectType !== 'merge-request') throw new Error(`Object ${id} is not a Merge Request`);
    return object;
  }
}

function blockedOutcome(
  operation: string,
  error: unknown,
  mergedRevisions: string[],
): IntegrationOutcome {
  return {
    status: 'blocked',
    reason: `${operation}: ${errorMessage(error)}`,
    mergedRevisions,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedSummary(checks: readonly GateCheckResult[]): string {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) return 'no check reported a reason';
  return failed.map((check) => `${check.name}: ${check.summary}`).join('\n');
}
