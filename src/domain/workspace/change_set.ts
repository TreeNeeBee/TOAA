import { z } from 'zod';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { assertStateTransition, type StateTransitions } from '../../util/state_machine.js';

/** A Git commit is an external artifact, referenced by its native id rather than registered. */
const GitRevisionSchema = z.string().regex(/^[0-9a-f]{7,40}$/u, 'Git revision must be a commit sha');

export const WORKSPACE_KINDS = ['canonical', 'ticket', 'gate'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const WORKSPACE_STATES = ['active', 'released'] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

/**
 * A working copy XCompiler manages, registered so it survives a crash.
 *
 * Git's own worktree list is the physical truth, but it cannot say which Ticket a worktree belongs
 * to or why it exists. Reconciliation compares the two: a registration whose directory is gone is
 * pruned, and a directory Git still knows about but no registration claims is an orphan from an
 * interrupted run.
 */
export const WorkspaceHandleSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('workspace-handle'),
  kind: z.enum(WORKSPACE_KINDS),
  /** Path relative to the container root, so moving a container does not invalidate the record. */
  relativePath: z.string().min(1),
  branch: z.string().min(1),
  ownerTicketId: ObjectIdSchema.optional(),
  state: z.enum(WORKSPACE_STATES),
  createdRevision: GitRevisionSchema,
}).strict();

export type WorkspaceHandle = z.infer<typeof WorkspaceHandleSchema>;

export function releaseWorkspaceHandle(
  workspace: WorkspaceHandle,
  now = new Date().toISOString(),
): WorkspaceHandle {
  if (workspace.state === 'released') return workspace;
  return WorkspaceHandleSchema.parse({
    ...workspace,
    ...reviseObjectEnvelope(workspace, { now }),
    state: 'released',
  });
}

export const CHANGE_SET_STATES = [
  'developing',
  'reviewing',
  'changes-requested',
  'gate-passed',
  'merged',
  'abandoned',
] as const;
export type ChangeSetState = (typeof CHANGE_SET_STATES)[number];

const CHANGE_SET_TRANSITIONS: StateTransitions<ChangeSetState> = {
  developing: ['reviewing', 'abandoned'],
  reviewing: ['changes-requested', 'gate-passed', 'abandoned'],
  'changes-requested': ['developing', 'reviewing', 'abandoned'],
  'gate-passed': ['merged', 'reviewing', 'abandoned'],
  merged: [],
  abandoned: [],
};

/**
 * One delivery generation that a root Ticket contributes to the mainline: its branch, worktree,
 * corrective Tickets, and commits.
 *
 * Corrections discovered before this generation merges stay in it. A correction discovered by a
 * downstream verification Step after it merges starts a new generation linked to the same root
 * Ticket, because a terminal merge cannot be mutated or silently replayed.
 *
 * Distinct from `Changelist`, which records the file-level evidence of one application. A ChangeSet
 * aggregates many of those.
 */
export const TicketChangeSetSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('ticket-change-set'),
  rootTicketId: ObjectIdSchema,
  /** Monotonic delivery generation for one CODE Story. Each merged repair starts a new generation. */
  generation: z.number().int().positive(),
  correctiveTicketIds: z.array(ObjectIdSchema).default([]),
  changelistIds: z.array(ObjectIdSchema).default([]),
  sourceBranch: z.string().min(1),
  workspaceId: ObjectIdSchema,
  /** Assigned when the change is submitted for merge; absent while it is still being developed. */
  mergeRequestId: ObjectIdSchema.optional(),
  baseRevision: GitRevisionSchema,
  currentRevision: GitRevisionSchema,
  mergedRevision: GitRevisionSchema.optional(),
  state: z.enum(CHANGE_SET_STATES),
}).strict();

export type TicketChangeSet = z.infer<typeof TicketChangeSetSchema>;

/**
 * Moves a ChangeSet to `next`, optionally recording the facts that go with the move.
 *
 * `changes` exists because the registry accepts exactly one revision step per write, and both this
 * and `reviseChangeSet` advance the revision — so composing them to land a state and a field
 * together silently asked for two. It went unnoticed because the caller was also writing through a
 * copy that was one revision behind, and the two errors cancelled.
 */
export function transitionChangeSet(
  changeSet: TicketChangeSet,
  next: ChangeSetState,
  changes: Partial<Omit<TicketChangeSet, 'id' | 'objectType' | 'projectId' | 'createdAt' | 'revision' | 'state'>> = {},
  now = new Date().toISOString(),
): TicketChangeSet {
  if (!assertStateTransition(
    'ticket-change-set', changeSet.id, changeSet.state, next, CHANGE_SET_TRANSITIONS,
  )) {
    return changeSet;
  }
  return TicketChangeSetSchema.parse({
    ...changeSet,
    ...changes,
    ...reviseObjectEnvelope(changeSet, { now }),
    state: next,
  });
}

export function reviseChangeSet(
  changeSet: TicketChangeSet,
  changes: Partial<Omit<TicketChangeSet, 'id' | 'objectType' | 'projectId' | 'createdAt' | 'revision'>>,
  now = new Date().toISOString(),
): TicketChangeSet {
  return TicketChangeSetSchema.parse({
    ...changeSet,
    ...changes,
    ...reviseObjectEnvelope(changeSet, { now }),
  });
}

/** Branch name for a root Ticket. One namespace, so XCompiler branches are recognizable in any repository. */
export function ticketBranchName(ticketId: string, generation = 1): string {
  const root = `xcompiler/ticket/${ticketId}`;
  return generation === 1 ? root : `${root}-r${generation}`;
}
