import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  bindTicketWorkspace,
  type Ticket,
  type TicketWorkspaceBinding,
} from '../../domain/tickets/ticket.js';
import type { Step } from '../../domain/steps/step.js';
import {
  TicketChangeSetSchema,
  WorkspaceHandleSchema,
  releaseWorkspaceHandle,
  reviseChangeSet,
  ticketBranchName,
  type TicketChangeSet,
  type WorkspaceHandle,
} from '../../domain/workspace/change_set.js';
import type { GitWorktreePort } from './git_port.js';
import type { ProjectContainer } from '../../workspace/project_container.js';

export interface TicketWorkspace {
  /** Absent when the Ticket works directly in the canonical copy. */
  changeSet?: TicketChangeSet;
  /** The registered handle, present for Ticket and promoted gate worktrees. */
  workspace?: WorkspaceHandle;
  /** Absolute path of the working copy this Ticket executes in. */
  root: string;
  /** Fresh persisted Ticket carrying the binding used by this scope. */
  ticket: Ticket;
}

/**
 * Owns the branch, worktree, and ChangeSet that a root Ticket develops in.
 *
 * CODE opens an isolated candidate. A rejected canonical S1-S3 commit is also promoted into a
 * temporary candidate before mainline rollback. Once a Ticket is bound, corrective work follows
 * that binding across V-model Steps instead of being silently moved back to mainline.
 *
 * Corrective Tickets deliberately get no independent ownership branch. Before a generation merges,
 * they repair that generation in place. A defect found by a downstream V-model Step after the merge
 * opens the next generation from the current mainline, preserving both the original delivery and the
 * correction as independently gated commits.
 */
export class TicketChangeSetService {
  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    private readonly container: ProjectContainer,
    private readonly git: GitWorktreePort,
  ) {}

  /**
   * Resolves the ChangeSet a Ticket develops in, creating the branch, worktree, and records the
   * first time its root Ticket needs them.
   *
   * Idempotent: an interrupted run re-enters here and finds the existing ChangeSet rather than
   * opening a second branch for the same work.
   */
  async ensureFor(ticket: Ticket, step: Step): Promise<TicketWorkspace> {
    const current = await this.requireTicket(ticket.id);
    const bound = await this.resolveBinding(current, step);
    if (bound) return bound;

    const inherited = await this.findLineageChangeSet(current);
    if (inherited) {
      const workspace = await this.requireWorkspace(inherited.workspaceId);
      const resolved = await this.reconcileWorktree(inherited, workspace);
      const tracked = await this.trackCorrective(inherited, current, inherited.rootTicketId);
      const revision = await this.gitRevision(tracked.sourceBranch, tracked.currentRevision);
      const boundTicket = await this.saveBinding(
        current,
        { ...this.changeSetBinding(tracked, workspace, 'inherited'), revision },
      );
      return { ...resolved, changeSet: tracked, ticket: boundTicket };
    }

    if (step.type !== 'CODE') {
      return this.bindCanonical(current, current.workspaceBinding ? 'recovered' : 'initial');
    }
    const rootTicketId = await this.codeStoryId(step, current);
    const existing = await this.findActiveChangeSet(current.projectId, rootTicketId);
    if (existing) {
      const workspace = await this.requireWorkspace(existing.workspaceId);
      const resolved = await this.reconcileWorktree(existing, workspace);
      const tracked = await this.trackCorrective(existing, current, rootTicketId);
      const boundTicket = await this.saveBinding(
        current,
        this.changeSetBinding(tracked, workspace, 'change-set'),
      );
      return { ...resolved, changeSet: tracked, ticket: boundTicket };
    }
    return this.create(current, rootTicketId);
  }

  /**
   * Turns a rejected commit made on canonical into a temporary corrective candidate.
   *
   * The attempt records the rejected commit before restoring canonical to `baseRevision`. Without
   * this promotion the commit is only audit evidence: the corrective Ticket inherits canonical and
   * has to regenerate every rejected artifact. Pinning a branch and worktree to the commit makes the
   * exact failed state recoverable while canonical remains the sole authoritative product tree.
   */
  async preserveRejectedCandidate(input: {
    ticketId: ObjectId;
    candidateRevision: string;
    baseRevision: string;
  }): Promise<TicketWorkspace> {
    const ticket = await this.requireTicket(input.ticketId);
    const active = await this.findActiveChangeSet(ticket.projectId, ticket.id);
    if (active) {
      const branchRevision = await this.git.revision(active.sourceBranch);
      if (branchRevision !== input.candidateRevision) {
        throw new Error(
          `Active ChangeSet ${active.name} points to ${branchRevision}, not rejected candidate ` +
          input.candidateRevision,
        );
      }
      const tracked = active.currentRevision === branchRevision
        ? active
        : await this.recordRevision(active.id, branchRevision);
      const workspace = await this.requireWorkspace(tracked.workspaceId);
      const resolved = await this.reconcileWorktree(tracked, workspace);
      const boundTicket = await this.saveBinding(
        ticket,
        this.changeSetBinding(tracked, workspace, 'recovered'),
      );
      return { ...resolved, changeSet: tracked, ticket: boundTicket };
    }
    return this.create(ticket, ticket.id, {
      baseRevision: input.baseRevision,
      currentRevision: input.candidateRevision,
    });
  }

  private async resolveBinding(ticket: Ticket, step: Step): Promise<TicketWorkspace | undefined> {
    const binding = ticket.workspaceBinding;
    if (!binding) return undefined;
    if (binding.kind === 'canonical') {
      // A correction routed from canonical into CODE opens a new isolated generation. All other
      // Steps continue on canonical and refresh the pinned head before execution.
      return step.type === 'CODE' ? undefined : this.bindCanonical(ticket, 'recovered');
    }
    if (!binding.changeSetId || !binding.workspaceId) {
      return binding.kind === 'gate' ? this.promoteGateBinding(ticket, binding) : undefined;
    }
    const changeSet = await this.requireChangeSet(binding.changeSetId);
    // ChangeSet is authoritative after a failed gate is promoted. Other Tickets may still carry
    // the previous workspaceId until they are scheduled; following that stale handle would either
    // recreate a released tree or send a non-CODE correction back to canonical.
    const workspace = await this.requireWorkspace(changeSet.workspaceId);
    if (
      changeSet.state === 'merged' ||
      changeSet.state === 'abandoned' ||
      workspace.state === 'released'
    ) {
      return undefined;
    }
    const resolved = await this.reconcileWorktree(changeSet, workspace);
    const tracked = await this.trackCorrective(changeSet, ticket, changeSet.rootTicketId);
    const revision = await this.gitRevision(tracked.sourceBranch, tracked.currentRevision);
    const boundTicket = await this.saveBinding(ticket, {
      ...this.changeSetBinding(tracked, workspace, 'recovered'),
      revision,
      mergeGateRunId: workspace.kind === 'gate' ? binding.mergeGateRunId : undefined,
    });
    return { ...resolved, changeSet: tracked, ticket: boundTicket };
  }

  /**
   * The Ticket that owns the branch for a CODE Step: that Step's V-model Story.
   *
   * Keying on the Story rather than on whoever happens to be executing keeps one active delivery
   * generation per CODE Step. Tasks and corrections join that generation until it merges; later
   * downstream corrections start the next generation from the updated mainline.
   */
  private async codeStoryId(step: Step, ticket: Ticket): Promise<ObjectId> {
    const tickets = await this.repository.list({ objectType: 'ticket', projectId: ticket.projectId });
    const story = tickets.find((object) =>
      object.objectType === 'ticket' &&
      object.type === 'story' &&
      object.workKind === 'v-model-step' &&
      object.stepId === step.id);
    if (!story) throw new Error(`CODE Step ${step.name} has no V-model Story to own its branch`);
    return story.id;
  }

  private async create(
    ticket: Ticket,
    rootTicketId: ObjectId,
    revisions?: { baseRevision: string; currentRevision: string },
  ): Promise<TicketWorkspace> {
    const generation = await this.nextGeneration(ticket.projectId, rootTicketId);
    const branch = ticketBranchName(rootTicketId, generation);
    const handle = this.container.ticket(rootTicketId, branch, generation);
    const baseRevision = revisions?.baseRevision ?? await this.git.head();
    const currentRevision = revisions?.currentRevision ?? baseRevision;
    await this.git.addWorktree({
      path: handle.workspace.root,
      branch,
      startPoint: currentRevision,
    });

    const now = new Date().toISOString();
    const workspace = WorkspaceHandleSchema.parse({
      ...createObjectEnvelope({
        name: `workspace-${rootTicketId}`,
        objectType: 'workspace-handle',
        projectId: ticket.projectId,
        now,
      }),
      kind: 'ticket',
      relativePath: this.relativePath(handle.workspace.root),
      branch,
      ownerTicketId: rootTicketId,
      state: 'active',
      createdRevision: currentRevision,
    });
    const changeSet = TicketChangeSetSchema.parse({
      ...createObjectEnvelope({
        name: `changeset-${rootTicketId}-r${generation}`,
        objectType: 'ticket-change-set',
        projectId: ticket.projectId,
        now,
      }),
      rootTicketId,
      generation,
      correctiveTicketIds: ticket.id === rootTicketId ? [] : [ticket.id],
      sourceBranch: branch,
      workspaceId: workspace.id,
      baseRevision,
      currentRevision,
      state: 'developing',
    });
    const binding = this.changeSetBinding(changeSet, workspace, 'change-set');
    const rootTicket = ticket.id === rootTicketId ? ticket : await this.requireTicket(rootTicketId);
    const boundRoot = bindTicketWorkspace(rootTicket, binding);
    const boundTicket = ticket.id === rootTicketId
      ? boundRoot
      : bindTicketWorkspace(ticket, { ...binding, reason: 'inherited' });
    await this.repository.commit([
      workspace,
      changeSet,
      boundRoot,
      ...(boundTicket.id === boundRoot.id ? [] : [boundTicket]),
    ]);
    return { changeSet, workspace, root: handle.workspace.root, ticket: boundTicket };
  }

  /**
   * Re-creates a worktree that is registered but no longer on disk.
   *
   * A run killed mid-flight, or a user deleting the directory, leaves the record without its
   * working copy. Recreating from the branch is safe because the branch holds the commits — the
   * worktree is only a checkout of them.
   */
  private async reconcileWorktree(
    changeSet: TicketChangeSet,
    workspace: WorkspaceHandle,
  ): Promise<TicketWorkspace> {
    const root = path.join(this.container.root, workspace.relativePath);
    await this.reconcilePhysicalWorktree(root, changeSet.sourceBranch, changeSet.currentRevision);
    return { changeSet, workspace, root, ticket: await this.requireTicket(changeSet.rootTicketId) };
  }

  private async reconcilePhysicalWorktree(
    root: string,
    branch: string,
    revision: string,
  ): Promise<void> {
    // Registration is not presence, and presence is the question this function exists to answer: a
    // worktree deleted underneath the run stays registered, which is exactly the state to repair.
    // Asking git whether it knows the path returns early on the one case that needs the work.
    //
    // macOS hid it. `listWorktrees` reports canonical paths, the container root reaches through a
    // symlink (`/var` -> `/private/var`), and `realpath` cannot canonicalize a directory that is no
    // longer there — so the comparison failed and the worktree was recreated by accident. On Linux
    // the two paths are identical, the check returned early, and the branch content never arrived.
    const present = await fs.stat(root).then((entry) => entry.isDirectory()).catch(() => false);
    if (present) {
      // `listWorktrees` reports canonical paths, so the computed path must be canonicalized too or a
      // symlinked container root never matches and the worktree is recreated on every call.
      const canonicalRoot = await fs.realpath(root).catch(() => root);
      const known = await this.git.listWorktrees();
      if (known.some((entry) => entry.path === canonicalRoot)) return;
    }
    await this.git.pruneWorktrees();
    await this.git.addWorktree({ path: root, branch, startPoint: revision });
  }

  /**
   * A failed merge gate becomes the correction worktree for its ChangeSet.
   *
   * The candidate already contains both the Ticket branch and the target branch. Keeping it avoids
   * debugging a different tree from the one that failed; changing the ChangeSet source ensures the
   * eventual merge includes the repair rather than re-validating the old source branch.
   */
  private async promoteGateBinding(
    ticket: Ticket,
    binding: TicketWorkspaceBinding,
  ): Promise<TicketWorkspace | undefined> {
    if (!binding.changeSetId || !binding.mergeGateRunId) {
      throw new Error(`Gate workspace binding on ${ticket.name} lacks ChangeSet or GateRun identity`);
    }
    let changeSet = await this.requireChangeSet(binding.changeSetId);
    if (changeSet.state === 'merged' || changeSet.state === 'abandoned') return undefined;
    const root = path.join(this.container.root, binding.relativePath);
    await this.reconcilePhysicalWorktree(root, binding.branch, binding.revision);

    const now = new Date().toISOString();
    const workspace = WorkspaceHandleSchema.parse({
      ...createObjectEnvelope({
        name: `workspace-gate-${binding.mergeGateRunId}`,
        objectType: 'workspace-handle',
        projectId: ticket.projectId,
        now,
      }),
      kind: 'gate',
      relativePath: binding.relativePath,
      branch: binding.branch,
      ownerTicketId: ticket.id,
      state: 'active',
      createdRevision: binding.revision,
    });
    const oldWorkspace = await this.requireWorkspace(changeSet.workspaceId);
    if (oldWorkspace.state === 'active' && oldWorkspace.id !== workspace.id) {
      const oldRoot = path.join(this.container.root, oldWorkspace.relativePath);
      await this.git.removeWorktree(oldRoot, { force: true });
    }
    const released = oldWorkspace.state === 'active'
      ? releaseWorkspaceHandle(oldWorkspace, now)
      : undefined;
    changeSet = reviseChangeSet(changeSet, {
      sourceBranch: binding.branch,
      workspaceId: workspace.id,
      currentRevision: binding.revision,
      correctiveTicketIds: [...new Set([...changeSet.correctiveTicketIds, ticket.id])],
    }, now);
    const promotedBinding: TicketWorkspaceBinding = {
      ...binding,
      workspaceId: workspace.id,
      reason: 'merge-gate',
      boundAt: now,
    };
    const rootTicket = await this.requireTicket(changeSet.rootTicketId);
    const boundRoot = bindTicketWorkspace(rootTicket, promotedBinding, now);
    const boundTicket = ticket.id === boundRoot.id
      ? boundRoot
      : bindTicketWorkspace(ticket, promotedBinding, now);
    await this.repository.commit([
      ...(released ? [released] : []),
      workspace,
      changeSet,
      boundRoot,
      ...(boundTicket.id === boundRoot.id ? [] : [boundTicket]),
    ]);
    return { changeSet, workspace, root, ticket: boundTicket };
  }

  private async trackCorrective(
    changeSet: TicketChangeSet,
    ticket: Ticket,
    rootTicketId: ObjectId,
  ): Promise<TicketChangeSet> {
    if (ticket.id === rootTicketId || changeSet.correctiveTicketIds.includes(ticket.id)) {
      return changeSet;
    }
    const updated = reviseChangeSet(changeSet, {
      correctiveTicketIds: [...changeSet.correctiveTicketIds, ticket.id],
    });
    await this.repository.update(updated, updated.state);
    return updated;
  }

  /** Records the branch head after work lands, so recovery knows what the ChangeSet contains. */
  async recordRevision(changeSetId: ObjectId, revision: string): Promise<TicketChangeSet> {
    const changeSet = await this.requireChangeSet(changeSetId);
    if (changeSet.currentRevision === revision) return changeSet;
    const updated = reviseChangeSet(changeSet, { currentRevision: revision });
    await this.repository.update(updated, updated.state);
    return updated;
  }

  async linkChangelist(changeSetId: ObjectId, changelistId: ObjectId): Promise<TicketChangeSet> {
    const changeSet = await this.requireChangeSet(changeSetId);
    if (changeSet.changelistIds.includes(changelistId)) return changeSet;
    const updated = reviseChangeSet(changeSet, {
      changelistIds: [...changeSet.changelistIds, changelistId],
    });
    await this.repository.update(updated, updated.state);
    return updated;
  }

  /** Releases the physical checkout after its generation has reached a terminal state. */
  async release(changeSetId: ObjectId): Promise<WorkspaceHandle> {
    const changeSet = await this.requireChangeSet(changeSetId);
    if (changeSet.state !== 'merged' && changeSet.state !== 'abandoned') {
      throw new Error(`Cannot release ${changeSet.name} while it is ${changeSet.state}`);
    }
    const workspace = await this.requireWorkspace(changeSet.workspaceId);
    if (workspace.state === 'released') return workspace;
    const root = path.join(this.container.root, workspace.relativePath);
    await this.git.removeWorktree(root, { force: true });
    const released = releaseWorkspaceHandle(workspace);
    await this.repository.update(released, released.state);
    return released;
  }

  private async findActiveChangeSet(
    projectId: ObjectId,
    rootTicketId: ObjectId,
  ): Promise<TicketChangeSet | undefined> {
    const objects = await this.repository.list({ objectType: 'ticket-change-set', projectId });
    return objects
      .filter((object): object is TicketChangeSet =>
        object.objectType === 'ticket-change-set' &&
        object.rootTicketId === rootTicketId &&
        object.state !== 'merged' &&
        object.state !== 'abandoned')
      .sort((left, right) => right.generation - left.generation)[0];
  }

  /**
   * Recovers an unbound corrective Ticket from its causal Ticket chain.
   *
   * This also covers Tickets already persisted when workspace binding was introduced: a dependency
   * CR points at the CODE Story that discovered it, and a Bug raised while processing that CR points
   * at the CR. Walking those explicit links finds the active candidate without guessing from Step.
   */
  private async findLineageChangeSet(ticket: Ticket): Promise<TicketChangeSet | undefined> {
    const changeSets = (await this.repository.list({
      objectType: 'ticket-change-set',
      projectId: ticket.projectId,
    })).filter((object): object is TicketChangeSet =>
      object.objectType === 'ticket-change-set' &&
      object.state !== 'merged' &&
      object.state !== 'abandoned');
    if (changeSets.length === 0) return undefined;

    const seen = new Set<ObjectId>();
    const queue: ObjectId[] = [ticket.id];
    while (queue.length > 0 && seen.size < 32) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const matched = changeSets
        .filter((candidate) =>
          candidate.rootTicketId === id || candidate.correctiveTicketIds.includes(id))
        .sort((left, right) => right.generation - left.generation)[0];
      if (matched) return matched;
      const object = await this.repository.read(id).catch(() => undefined);
      if (!object || object.objectType !== 'ticket') continue;
      if (object.parentTicketId) queue.push(object.parentTicketId);
      if (object.source.causationId) queue.push(object.source.causationId);
      if (object.type === 'change-request') queue.push(object.sourceTicketId);
    }
    return undefined;
  }

  private async nextGeneration(projectId: ObjectId, rootTicketId: ObjectId): Promise<number> {
    const objects = await this.repository.list({ objectType: 'ticket-change-set', projectId });
    return objects.reduce((highest, object) =>
      object.objectType === 'ticket-change-set' && object.rootTicketId === rootTicketId
        ? Math.max(highest, object.generation)
        : highest, 0) + 1;
  }

  private async requireChangeSet(id: ObjectId): Promise<TicketChangeSet> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'ticket-change-set') throw new Error(`Object ${id} is not a ChangeSet`);
    return object;
  }

  private async requireWorkspace(id: ObjectId): Promise<WorkspaceHandle> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'workspace-handle') throw new Error(`Object ${id} is not a Workspace`);
    return object;
  }

  private async requireTicket(id: ObjectId): Promise<Ticket> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'ticket') throw new Error(`Object ${id} is not a Ticket`);
    return object;
  }

  private async bindCanonical(
    ticket: Ticket,
    reason: TicketWorkspaceBinding['reason'],
  ): Promise<TicketWorkspace> {
    const root = this.container.canonical().workspace.root;
    const bound = await this.saveBinding(ticket, {
      kind: 'canonical',
      relativePath: this.relativePath(root),
      branch: this.container.canonicalBranch,
      revision: await this.git.head(),
      reason,
      boundAt: new Date().toISOString(),
    });
    return { root, ticket: bound };
  }

  private changeSetBinding(
    changeSet: TicketChangeSet,
    workspace: WorkspaceHandle,
    reason: TicketWorkspaceBinding['reason'],
  ): TicketWorkspaceBinding {
    return {
      kind: workspace.kind,
      relativePath: workspace.relativePath,
      branch: changeSet.sourceBranch,
      revision: changeSet.currentRevision,
      workspaceId: workspace.id,
      changeSetId: changeSet.id,
      reason,
      boundAt: new Date().toISOString(),
    };
  }

  private async saveBinding(
    ticket: Ticket,
    binding: TicketWorkspaceBinding,
  ): Promise<Ticket> {
    const bound = bindTicketWorkspace(ticket, binding);
    if (bound === ticket) return ticket;
    await this.repository.update(bound, bound.state);
    return bound;
  }

  private async gitRevision(ref: string, fallback: string): Promise<string> {
    return this.git.revision(ref).catch(() => fallback);
  }

  private relativePath(absolute: string): string {
    return path.relative(this.container.root, absolute).split(path.sep).join('/');
  }
}
