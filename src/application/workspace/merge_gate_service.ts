import path from 'node:path';
import { createObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  MergeGateRunSchema,
  MergeRequestSchema,
  advanceMergeRequest,
  gateOutcome,
  gateValidationPath,
  isGateCurrent,
  reviseMergeRequest,
  type GateCheckResult,
  type MergeGateRun,
  type MergeRequest,
} from '../../domain/workspace/merge_request.js';
import { reviseChangeSet, type TicketChangeSet } from '../../domain/workspace/change_set.js';
import type { ProjectContainer } from '../../workspace/project_container.js';
import type { GitMergePort } from './git_port.js';

export interface GateCandidate {
  run: MergeGateRun;
  /** Absolute path of the disposable gate worktree. */
  root: string;
}

export class MergeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeBlockedError';
  }
}

/**
 * Owns merge requests and the gate runs that validate them.
 *
 * The revision locking here is the same rule the self-bootstrap promote already proved: a verdict
 * is bound to the source and target it judged, and any movement on either side invalidates it. What
 * this generalizes is the scope — from one bootstrap candidate to every Ticket ChangeSet.
 */
export class MergeGateService {
  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    private readonly container: ProjectContainer,
    private readonly git: GitMergePort,
    private readonly targetBranch: string,
  ) {}

  /** Opens the merge request for a ChangeSet, or returns the one already open for it. */
  async open(changeSet: TicketChangeSet): Promise<MergeRequest> {
    const existing = await this.findOpen(changeSet);
    if (existing) {
      const current = await this.requireChangeSet(changeSet.id);
      if (
        existing.sourceBranch === current.sourceBranch &&
        existing.sourceRevision === current.currentRevision
      ) {
        return existing;
      }
      // A failed gate can be promoted into the correction branch. Keep the existing MR and its
      // evidence, but point the next validation at the branch that now owns the ChangeSet.
      const refreshed = reviseMergeRequest(existing, {
        sourceBranch: current.sourceBranch,
        sourceRevision: current.currentRevision,
        baseRevision: current.baseRevision,
      });
      await this.repository.update(refreshed, refreshed.state);
      return refreshed;
    }
    // Re-read rather than write through the caller's copy. Opening an MR naturally follows commits
    // on the branch, each of which advanced this ChangeSet, so the argument is routinely a stale
    // revision and linking through it would be rejected by the registry.
    const current = await this.requireChangeSet(changeSet.id);
    const request = MergeRequestSchema.parse({
      ...createObjectEnvelope({
        name: `mr-${current.rootTicketId}`,
        objectType: 'merge-request',
        projectId: current.projectId,
      }),
      changeSetId: current.id,
      rootTicketId: current.rootTicketId,
      sourceBranch: current.sourceBranch,
      targetBranch: this.targetBranch,
      baseRevision: current.baseRevision,
      sourceRevision: current.currentRevision,
      state: 'draft',
    });
    const linked = reviseChangeSet(current, { mergeRequestId: request.id });
    await this.repository.commit([request, linked]);
    return request;
  }

  private async requireChangeSet(id: ObjectId): Promise<TicketChangeSet> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'ticket-change-set') {
      throw new Error(`Object ${id} is not a Ticket ChangeSet`);
    }
    return object;
  }

  /**
   * Creates a gate run and its disposable worktree, pinned to the current source and target heads.
   *
   * The candidate is the merge of both, so a gate validates what would actually land rather than
   * the Ticket branch in isolation — a change that passes alone can still break against a mainline
   * that moved.
   */
  async start(requestId: ObjectId): Promise<GateCandidate> {
    const request = await this.require(requestId);
    const source = await this.git.revision(request.sourceBranch);
    const target = await this.git.revision(request.targetBranch);
    const runId = createObjectEnvelope({
      name: `gate-${request.name}`,
      objectType: 'merge-gate-run',
      projectId: request.projectId,
    });
    const handle = this.container.gate(request.id, runId.id, request.sourceBranch);
    const gateBranch = `xcompiler/gate/${runId.id}`;
    let candidateRevision: string;
    try {
      await this.git.addWorktree({
        path: handle.workspace.root,
        branch: gateBranch,
        startPoint: target,
      });
      candidateRevision = await this.git.mergeInto(handle.workspace.root, source);
    } catch (error) {
      await this.cleanupGate(handle.workspace.root, gateBranch, error);
      throw error;
    }

    const run = MergeGateRunSchema.parse({
      ...runId,
      mergeRequestId: request.id,
      sourceRevision: source,
      targetRevision: target,
      candidateRevision,
      worktreePath: path.relative(this.container.root, handle.workspace.root).split(path.sep).join('/'),
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    const validating = advanceMergeRequest(
      request,
      gateValidationPath(request.state),
      { sourceRevision: source, targetRevision: target },
    );
    try {
      await this.repository.commit([run, validating]);
    } catch (error) {
      await this.cleanupGate(handle.workspace.root, gateBranch, error);
      throw error;
    }
    return { run, root: handle.workspace.root };
  }

  /** Records the checks; a failed candidate is retained so the resulting Bug can repair it. */
  async complete(runId: ObjectId, checks: readonly GateCheckResult[]): Promise<MergeGateRun> {
    const run = await this.requireRun(runId);
    const status = gateOutcome(checks);
    const finished = MergeGateRunSchema.parse({
      ...run,
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
      status,
      checkResults: checks,
      finishedAt: new Date().toISOString(),
    });
    const request = await this.require(run.mergeRequestId);
    // Infrastructure failure leaves the state alone: nothing about the change was shown to be
    // wrong, so it is neither approved nor sent back for changes.
    const outcomePath = status === 'passed'
      ? ['approved' as const]
      : status === 'infrastructure-failed'
        ? []
        : ['changes-requested' as const];
    let persistenceError: unknown;
    try {
      await this.repository.commit([finished, advanceMergeRequest(request, outcomePath, {
        gateRunIds: [...new Set([...request.gateRunIds, run.id])],
      })]);
    } catch (error) {
      persistenceError = error;
    }
    const gateBranch = `xcompiler/gate/${run.id}`;
    const gateRoot = run.worktreePath
      ? path.join(this.container.root, run.worktreePath)
      : this.container.gate(request.id, run.id, request.sourceBranch).workspace.root;
    // A product failure must be debugged against the exact candidate that failed. Passing and
    // infrastructure-only candidates carry no corrective work and remain disposable.
    if (status !== 'failed' || persistenceError) {
      await this.cleanupGate(gateRoot, gateBranch, persistenceError);
    }
    if (persistenceError) {
      throw persistenceError;
    }
    return finished;
  }

  private async cleanupGate(root: string, branch: string, priorError?: unknown): Promise<void> {
    const failures: unknown[] = priorError ? [priorError] : [];
    try {
      await this.git.removeWorktree(root, { force: true });
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.git.deleteBranch(branch, { force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > (priorError ? 1 : 0)) {
      throw new AggregateError(failures, `Could not clean up merge gate worktree ${root}`);
    }
  }

  /**
   * Whether a gate verdict authorizes merging right now.
   *
   * Re-read from Git rather than trusted from the record: the whole point of pinning revisions is
   * that the answer can change without anything in XCompiler being told.
   */
  async currentVerdict(requestId: ObjectId): Promise<{ ok: boolean; reason?: string; run?: MergeGateRun }> {
    const request = await this.require(requestId);
    const runs = (await this.repository.list({ objectType: 'merge-gate-run', projectId: request.projectId }))
      .filter((object): object is MergeGateRun =>
        object.objectType === 'merge-gate-run' && object.mergeRequestId === requestId);
    const latest = runs.at(-1);
    if (!latest) return { ok: false, reason: 'no gate run has validated this merge request' };
    if (latest.status !== 'passed') {
      return { ok: false, reason: `latest gate run is ${latest.status}`, run: latest };
    }
    const heads = {
      source: await this.git.revision(request.sourceBranch),
      target: await this.git.revision(request.targetBranch),
    };
    if (!isGateCurrent(latest, heads)) {
      const stale = MergeGateRunSchema.parse({
        ...latest,
        revision: latest.revision + 1,
        updatedAt: new Date().toISOString(),
        status: 'stale',
      });
      await this.repository.update(stale, stale.status);
      return { ok: false, reason: 'source or target moved since the gate passed', run: stale };
    }
    return { ok: true, run: latest };
  }

  private async findOpen(changeSet: TicketChangeSet): Promise<MergeRequest | undefined> {
    const objects = await this.repository.list({
      objectType: 'merge-request',
      projectId: changeSet.projectId,
    });
    return objects.find(
      (object): object is MergeRequest =>
        object.objectType === 'merge-request' &&
        object.changeSetId === changeSet.id &&
        object.state !== 'merged' &&
        object.state !== 'closed',
    );
  }

  private async require(id: ObjectId): Promise<MergeRequest> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'merge-request') throw new Error(`Object ${id} is not a Merge Request`);
    return object;
  }

  private async requireRun(id: ObjectId): Promise<MergeGateRun> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'merge-gate-run') throw new Error(`Object ${id} is not a Gate Run`);
    return object;
  }
}
