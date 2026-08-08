import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { Ticket } from '../../domain/tickets/ticket.js';
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
  /**
   * Absent when the Step works directly in the canonical copy, which is every Step except CODE.
   *
   * A Step with no ChangeSet has nothing to merge: its commits are already on the mainline.
   */
  changeSet?: TicketChangeSet;
  /** The registered handle, present only alongside a ChangeSet. */
  workspace?: WorkspaceHandle;
  /** Absolute path of the working copy this Ticket executes in. */
  root: string;
}

/**
 * Owns the branch, worktree, and ChangeSet that a root Ticket develops in.
 *
 * Only CODE develops in isolation. V-model Steps are sequentially dependent — DETAILED_DESIGN reads
 * the high-level design, CODE reads both and the manifest — so isolating every Step branched them
 * all from the same mainline commit and each one worked blind. CODE is also the only Step with
 * concurrent workers, which is what isolation exists for.
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
    // Decided by the Step being executed, not by the Ticket's root. A Change Request propagates
    // across downstream Steps, so the same CR writes design one moment and product code the next;
    // its root stays wherever it was opened and says nothing about the work in hand.
    if (step.type !== 'CODE') {
      return { root: this.container.canonical().workspace.root };
    }
    const rootTicketId = await this.codeStoryId(step, ticket);
    const existing = await this.findActiveChangeSet(ticket.projectId, rootTicketId);
    if (existing) {
      const workspace = await this.requireWorkspace(existing.workspaceId);
      const resolved = await this.reconcileWorktree(existing, workspace);
      return { ...resolved, changeSet: await this.trackCorrective(existing, ticket, rootTicketId) };
    }
    return this.create(ticket, rootTicketId);
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

  private async create(ticket: Ticket, rootTicketId: ObjectId): Promise<TicketWorkspace> {
    const generation = await this.nextGeneration(ticket.projectId, rootTicketId);
    const branch = ticketBranchName(rootTicketId, generation);
    const handle = this.container.ticket(rootTicketId, branch, generation);
    const baseRevision = await this.git.head();
    await this.git.addWorktree({ path: handle.workspace.root, branch, startPoint: baseRevision });

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
      createdRevision: baseRevision,
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
      currentRevision: baseRevision,
      state: 'developing',
    });
    await this.repository.commit([workspace, changeSet]);
    return { changeSet, workspace, root: handle.workspace.root };
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
    // `listWorktrees` reports canonical paths, so the computed path must be canonicalized too or a
    // symlinked container root (macOS `/var` -> `/private/var`) never matches and the worktree is
    // recreated on every call.
    const canonicalRoot = await fs.realpath(root).catch(() => root);
    const known = await this.git.listWorktrees();
    if (!known.some((entry) => entry.path === canonicalRoot)) {
      await this.git.pruneWorktrees();
      await this.git.addWorktree({
        path: root,
        branch: changeSet.sourceBranch,
        startPoint: changeSet.currentRevision,
      });
    }
    return { changeSet, workspace, root };
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

  private relativePath(absolute: string): string {
    return path.relative(this.container.root, absolute).split(path.sep).join('/');
  }
}
