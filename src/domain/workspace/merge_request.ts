import { z } from 'zod';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { assertStateTransition, type StateTransitions } from '../../util/state_machine.js';

const GitRevisionSchema = z.string().regex(/^[0-9a-f]{7,40}$/u, 'Git revision must be a commit sha');

export const MERGE_REQUEST_STATES = [
  'draft',
  'ready',
  'validating',
  'changes-requested',
  'approved',
  'mergeable',
  'merged',
  'closed',
] as const;
export type MergeRequestState = (typeof MERGE_REQUEST_STATES)[number];

const MERGE_REQUEST_TRANSITIONS: StateTransitions<MergeRequestState> = {
  draft: ['ready', 'closed'],
  ready: ['validating', 'closed'],
  validating: ['changes-requested', 'approved', 'ready', 'closed'],
  'changes-requested': ['ready', 'closed'],
  approved: ['mergeable', 'changes-requested', 'ready', 'closed'],
  mergeable: ['merged', 'ready', 'closed'],
  merged: [],
  closed: [],
};

/**
 * A merge request that exists locally, independent of any hosting service.
 *
 * Modelled here rather than delegated to GitHub or GitLab because the mainline must be protected
 * even when XCompiler runs entirely offline. A remote provider can later mirror this object; it is
 * never the source of truth for whether a change may land.
 */
export const MergeRequestSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('merge-request'),
  changeSetId: ObjectIdSchema,
  rootTicketId: ObjectIdSchema,
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  baseRevision: GitRevisionSchema,
  sourceRevision: GitRevisionSchema,
  targetRevision: GitRevisionSchema.optional(),
  gateRunIds: z.array(ObjectIdSchema).default([]),
  mergedRevision: GitRevisionSchema.optional(),
  state: z.enum(MERGE_REQUEST_STATES),
}).strict();

export type MergeRequest = z.infer<typeof MergeRequestSchema>;

export const GATE_RUN_STATUSES = [
  'running',
  'passed',
  'failed',
  'stale',
  'blocked',
  'infrastructure-failed',
] as const;
export type GateRunStatus = (typeof GATE_RUN_STATUSES)[number];

export const GateCheckResultSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  summary: z.string().min(1),
  /**
   * Infrastructure failures never open a Bug against the generated project; they block the merge
   * request until the environment recovers.
   */
  kind: z.enum(['execution', 'infrastructure']).default('execution'),
}).strict();

export type GateCheckResult = z.infer<typeof GateCheckResultSchema>;

/**
 * One validation of a merge candidate, pinned to the revisions it judged.
 *
 * A gate result is only meaningful for the exact pair of revisions it saw. If either side moves the
 * verdict says nothing about what would land now, so the run becomes `stale` rather than being
 * reused — this is the property that stops a passing gate from authorizing a different change.
 */
export const MergeGateRunSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('merge-gate-run'),
  mergeRequestId: ObjectIdSchema,
  sourceRevision: GitRevisionSchema,
  targetRevision: GitRevisionSchema,
  candidateRevision: GitRevisionSchema.optional(),
  /** Path of the disposable gate worktree, relative to the container root. */
  worktreePath: z.string().min(1).optional(),
  status: z.enum(GATE_RUN_STATUSES),
  checkResults: z.array(GateCheckResultSchema).default([]),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type MergeGateRun = z.infer<typeof MergeGateRunSchema>;

export function transitionMergeRequest(
  request: MergeRequest,
  next: MergeRequestState,
  now = new Date().toISOString(),
): MergeRequest {
  if (!assertStateTransition(
    'merge-request', request.id, request.state, next, MERGE_REQUEST_TRANSITIONS,
  )) {
    return request;
  }
  return MergeRequestSchema.parse({
    ...request,
    ...reviseObjectEnvelope(request, { now }),
    state: next,
  });
}

/**
 * Applies a state change and the fields that change with it as one revision.
 *
 * A Merge Request is a registered object, so the registry accepts exactly one revision step per
 * write. Composing `transitionMergeRequest` with `reviseMergeRequest` produces two, which the
 * registry rejects — the state change and the facts that caused it are one event and must be
 * written as one.
 *
 * `path` is walked hop by hop so an illegal route still throws; only the arithmetic is collapsed.
 */
export function advanceMergeRequest(
  request: MergeRequest,
  path: readonly MergeRequestState[],
  changes: Partial<Omit<MergeRequest, 'id' | 'objectType' | 'projectId' | 'createdAt' | 'revision' | 'state'>> = {},
  now = new Date().toISOString(),
): MergeRequest {
  let state = request.state;
  for (const next of path) {
    if (assertStateTransition('merge-request', request.id, state, next, MERGE_REQUEST_TRANSITIONS)) {
      state = next;
    }
  }
  return MergeRequestSchema.parse({
    ...request,
    ...changes,
    ...reviseObjectEnvelope(request, { now }),
    state,
  });
}

/**
 * The route a Merge Request takes into gate validation.
 *
 * `draft` and `changes-requested` are not directly validatable: both must be re-declared ready
 * first, which is what makes "a gate is running against this" a distinct, observable state rather
 * than something inferred from the presence of a run.
 */
export function gateValidationPath(from: MergeRequestState): MergeRequestState[] {
  if (from === 'validating') return [];
  return from === 'ready' ? ['validating'] : ['ready', 'validating'];
}

export function reviseMergeRequest(
  request: MergeRequest,
  changes: Partial<Omit<MergeRequest, 'id' | 'objectType' | 'projectId' | 'createdAt' | 'revision'>>,
  now = new Date().toISOString(),
): MergeRequest {
  return MergeRequestSchema.parse({
    ...request,
    ...changes,
    ...reviseObjectEnvelope(request, { now }),
  });
}

/**
 * Whether a gate verdict still describes what would land.
 *
 * Both sides matter: a new commit on the Ticket branch changes what is being merged, and a new
 * commit on the mainline changes what it is being merged into.
 */
export function isGateCurrent(
  run: MergeGateRun,
  heads: { source: string; target: string },
): boolean {
  return run.sourceRevision === heads.source && run.targetRevision === heads.target;
}

export function gateOutcome(checks: readonly GateCheckResult[]): GateRunStatus {
  if (checks.length === 0) return 'failed';
  if (checks.some((check) => !check.ok && check.kind === 'infrastructure')) return 'infrastructure-failed';
  return checks.every((check) => check.ok) ? 'passed' : 'failed';
}
