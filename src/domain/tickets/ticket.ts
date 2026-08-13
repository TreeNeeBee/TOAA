import { z } from 'zod';
import { assertStateTransition, type StateTransitions } from '../../util/state_machine.js';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema, type ObjectId } from '../identity/object_id.js';
import { DomainRoleSchema, ExecutionAgentSchema } from '../workflow/role.js';
import { PendingReasonSchema } from '../workflow/pending_reason.js';
import { STEP_TYPES } from '../steps/step.js';

export const TICKET_TYPES = [
  'epic',
  'story',
  'task',
  'bug',
  'enhancement',
  'change-request',
] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const TICKET_STATES = [
  'created',
  'in_progress',
  'pending',
  'resolved',
  'reopened',
  'cancelled',
  'closed',
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

const TICKET_TRANSITIONS: StateTransitions<TicketState> = {
  created: ['in_progress', 'pending', 'cancelled'],
  in_progress: ['pending', 'resolved', 'cancelled'],
  pending: ['in_progress', 'cancelled'],
  resolved: ['closed', 'reopened'],
  reopened: ['in_progress', 'cancelled'],
  cancelled: ['reopened', 'closed'],
  closed: [],
};

/** A Git commit is an external artifact, referenced by its native id rather than registered. */
const GitRevisionSchema = z.string().regex(/^[0-9a-f]{7,40}$/u, 'Git revision must be a commit sha');

export const TICKET_COMMIT_KINDS = ['baseline', 'attempt', 'verified'] as const;
export type TicketCommitKind = (typeof TICKET_COMMIT_KINDS)[number];

export const TicketCommitSchema = z.object({
  revision: GitRevisionSchema,
  /**
   * `baseline` marks where an attempt started, and is therefore the target that attempt rolls back
   * to. `attempt` is a rejected candidate preserved for diagnosis and incremental correction.
   * `verified` survived its gate.
   */
  kind: z.enum(TICKET_COMMIT_KINDS),
  attempt: z.number().int().nonnegative(),
  stepId: ObjectIdSchema,
  summary: z.string().min(1),
  recordedAt: z.string().datetime({ offset: true }),
}).strict();

export type TicketCommit = z.infer<typeof TicketCommitSchema>;

export const TICKET_PRIORITY_MIN = 0;
export const TICKET_PRIORITY_MAX = 255;
export const TICKET_PRIORITY = {
  low: 64,
  normal: 128,
  high: 192,
  critical: 255,
} as const;

export const TicketSolutionSchema = z.object({
  status: z.enum(['proposed', 'applied', 'verified', 'rejected']),
  approach: z.string().min(1),
  rationale: z.string().min(1),
  changes: z.array(z.string().min(1)).default([]),
  verification: z.array(z.string().min(1)).default([]),
  rejectedReason: z.string().min(1).optional(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export type TicketSolution = z.infer<typeof TicketSolutionSchema>;

export const TicketSourceSchema = z.object({
  kind: z.enum(['plan', 'runtime', 'quality-gate', 'pm-intake']),
  correlationId: ObjectIdSchema,
  causationId: ObjectIdSchema.optional(),
  externalId: z.string().min(1).optional(),
}).strict();

export type TicketSource = z.infer<typeof TicketSourceSchema>;

const TicketBaseSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('ticket'),
  type: z.enum(TICKET_TYPES),
  phaseId: ObjectIdSchema,
  stepId: ObjectIdSchema.optional(),
  role: DomainRoleSchema,
  agent: ExecutionAgentSchema,
  creatorActorId: ObjectIdSchema,
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  priority: z.number().int().min(TICKET_PRIORITY_MIN).max(TICKET_PRIORITY_MAX),
  parentTicketId: ObjectIdSchema.optional(),
  rootTicketId: ObjectIdSchema,
  description: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  checkpointIds: z.array(ObjectIdSchema).default([]),
  dependencyTicketIds: z.array(ObjectIdSchema).default([]),
  blockedByTicketIds: z.array(ObjectIdSchema).default([]),
  relatedTicketIds: z.array(ObjectIdSchema).default([]),
  logIds: z.array(ObjectIdSchema).default([]),
  changelistIds: z.array(ObjectIdSchema).default([]),
  assignmentIds: z.array(ObjectIdSchema).default([]),
  activeAssignmentId: ObjectIdSchema.optional(),
  traceFirstEventId: ObjectIdSchema.optional(),
  traceLastEventId: ObjectIdSchema.optional(),
  traceEventCount: z.number().int().nonnegative().default(0),
  traceChainHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
  /**
   * Commit this Ticket's work started from, and the append-only record of every commit made under
   * it. Rollback used to depend on a baseline held only in memory for the duration of one attempt,
   * so a crash between snapshot and rollback left the working copy changed with nothing recording
   * where to return. Persisting both makes rollback recoverable and auditable, and lets a Ticket be
   * unwound as a whole rather than only one attempt at a time.
   */
  baselineRevision: GitRevisionSchema.optional(),
  commits: z.array(TicketCommitSchema).default([]),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  state: z.enum(TICKET_STATES),
  pendingReason: PendingReasonSchema.optional(),
  source: TicketSourceSchema,
  submittedAt: z.string().datetime({ offset: true }),
  registeredAt: z.string().datetime({ offset: true }).optional(),
  solution: TicketSolutionSchema.optional(),
  resolvedAt: z.string().datetime({ offset: true }).optional(),
  closedAt: z.string().datetime({ offset: true }).optional(),
  cancelledAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export const WorkTicketSchema = TicketBaseSchema.extend({
  type: z.enum(['epic', 'story', 'task']),
  workKind: z.enum(['phase', 'v-model-step', 'planned-work', 'delivery']),
  verificationTicketId: ObjectIdSchema.optional(),
  pairedSourceTicketId: ObjectIdSchema.optional(),
}).strict();

export const BugFailureSchema = z.object({
    category: z.enum(['llm-provider', 'tool', 'test', 'quality', 'contract', 'internal']),
    code: z.string().min(1),
    message: z.string().min(1),
    summary: z.string().min(1),
    retryable: z.boolean(),
    switchProvider: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
    rawEvidenceRef: z.string().min(1).optional(),
    failedStepId: ObjectIdSchema,
    failedStepType: z.enum(STEP_TYPES),
    targetStepId: ObjectIdSchema,
    targetStepType: z.enum(STEP_TYPES),
    verificationStepId: ObjectIdSchema,
    verificationStepType: z.enum(STEP_TYPES),
    tool: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    statusCode: z.number().int().optional(),
  }).strict();

/** A discovering role proved that the failed verification contract, not the reported product gap, is defective. */
export const VALIDATION_CONTRACT_DEFECT_CODE = 'validation_contract_defect' as const;

export const BugTicketSchema = TicketBaseSchema.extend({
  type: z.literal('bug'),
  bugKind: z.enum([
    'stage-execution',
    'test-failure',
    'quality-gate',
    'delivery-gate',
    'infrastructure',
    'exception',
  ]),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  failure: BugFailureSchema,
  enhancementTicketId: ObjectIdSchema.optional(),
  changeRequestTicketIds: z.array(ObjectIdSchema).default([]),
  debugWikiCandidateEntryIds: z.array(z.string().min(1)).default([]),
  debugWikiResolutionEntryIds: z.array(z.string().min(1)).default([]),
}).strict();

export const EnhancementTicketSchema = TicketBaseSchema.extend({
  type: z.literal('enhancement'),
  /** Step that discovered the quality gap; this determines whether CODE already existed. */
  stepId: ObjectIdSchema,
  enhancementKind: z.enum(['functional-gap', 'test-incomplete', 'quality-shortfall']),
  finding: z.string().min(1),
  sourceBugTicketId: ObjectIdSchema.optional(),
  sourceQualityAssessmentId: ObjectIdSchema.optional(),
  targetStepId: ObjectIdSchema,
  verificationStepId: ObjectIdSchema,
  changeRequestTicketIds: z.array(ObjectIdSchema).default([]),
}).strict();

export const ChangeRequestApplicationDecisionSchema = z.object({
  outcome: z.enum(['applied', 'not-applicable']).default('applied'),
  reasonCategory: z.enum([
    'contract-applied',
    'already-aligned',
    'outside-step-scope',
    'downstream-owned',
    'diagnosis-contradicted',
  ]).optional(),
  rationale: z.string().min(1).optional(),
  inspectedArtifacts: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([]),
}).strict();

export const ChangeRequestTicketSchema = TicketBaseSchema.extend({
  type: z.literal('change-request'),
  sourceTicketId: ObjectIdSchema,
  parentChangeRequestId: ObjectIdSchema.optional(),
  triggerStepId: ObjectIdSchema,
  sourceStepId: ObjectIdSchema,
  /**
   * The one Step this Change Request is applied to.
   *
   * Each downstream Step receives its own CR, linked by `parentChangeRequestId`, and records either
   * an incremental change or an explicit no-op verification. One Step cannot decide that later
   * owners and verification gates are unaffected merely because it did not edit a file.
   */
  targetStepId: ObjectIdSchema,
  /** Immutable failure evidence that caused a corrective CR chain. */
  originFailure: BugFailureSchema.optional(),
  contractDelta: z.object({
    summary: z.string().min(1),
    before: z.array(z.string().min(1)).default([]),
    after: z.array(z.string().min(1)).default([]),
    affectedArtifacts: z.array(z.string().min(1)).default([]),
  }).strict(),
  implementationPlan: z.array(z.string().min(1)).min(1),
  verificationGate: z.array(z.string().min(1)).min(1),
  applications: z.array(ChangeRequestApplicationDecisionSchema.extend({
    stepId: ObjectIdSchema,
    changelistId: ObjectIdSchema,
    verificationAssessmentId: ObjectIdSchema.optional(),
    appliedAt: z.string().datetime({ offset: true }),
  }).strict()).default([]),
}).strict();

export const TicketSchema = z.discriminatedUnion('type', [
  WorkTicketSchema,
  BugTicketSchema,
  EnhancementTicketSchema,
  ChangeRequestTicketSchema,
]);

export type Ticket = z.infer<typeof TicketSchema>;
export type WorkTicket = z.infer<typeof WorkTicketSchema>;
export type BugTicket = z.infer<typeof BugTicketSchema>;
export type EnhancementTicket = z.infer<typeof EnhancementTicketSchema>;
export type ChangeRequestTicket = z.infer<typeof ChangeRequestTicketSchema>;
export type ChangeRequestApplicationDecision = z.infer<typeof ChangeRequestApplicationDecisionSchema>;

export function transitionTicket(
  ticket: Ticket,
  next: TicketState,
  options: { pendingReason?: z.infer<typeof PendingReasonSchema>; now?: string } = {},
): Ticket {
  return transitionTicketPath(ticket, [next], options);
}

export function transitionTicketPath(
  ticket: Ticket,
  path: readonly TicketState[],
  options: { pendingReason?: z.infer<typeof PendingReasonSchema>; now?: string } = {},
): Ticket {
  if (path.length === 0) return ticket;
  let current = ticket.state;
  for (const next of path) {
    if (!assertStateTransition('ticket', ticket.id, current, next, TICKET_TRANSITIONS)) continue;
    if (next === 'pending' && !options.pendingReason) {
      throw new Error(`Ticket ${ticket.id} requires pendingReason when entering pending`);
    }
    if (
      next === 'resolved' &&
      ['bug', 'enhancement', 'change-request'].includes(ticket.type) &&
      ticket.solution?.status !== 'verified'
    ) {
      throw new Error(`Ticket ${ticket.id} requires a verified solution before resolution`);
    }
    if (next === 'in_progress' && !ticket.activeAssignmentId) {
      throw new Error(`Ticket ${ticket.id} requires an accepted active assignment before execution`);
    }
    current = next;
  }
  if (current === ticket.state) return ticket;
  const now = options.now ?? new Date().toISOString();
  const envelope = reviseObjectEnvelope(ticket, { now });
  return TicketSchema.parse({
    ...ticket,
    ...envelope,
    state: current,
    pendingReason: current === 'pending' ? options.pendingReason : undefined,
    resolvedAt: path.includes('resolved') ? now : ticket.resolvedAt,
    closedAt: path.includes('closed') ? now : ticket.closedAt,
    cancelledAt: path.includes('cancelled') ? now : ticket.cancelledAt,
  });
}

export function isActiveTicket(ticket: Ticket): boolean {
  return ticket.state !== 'closed' && ticket.state !== 'cancelled';
}

/**
 * The Step where this Ticket's work is performed, which is what its `role` and
 * `requiredCapabilities` describe.
 *
 * For corrective Tickets this is not `stepId`: a Bug found in UNIT_TEST is repaired in the paired
 * CODE Step, so `stepId` records where the problem was observed while the target Step records where
 * it is fixed. Routing and scheduling must both use this Step, otherwise a Bug is matched against
 * the verifying role instead of the repairing one.
 */
/**
 * Records a commit against a Ticket. The list is append-only: rejected candidates keep their
 * entries so the history shows what was tried and gives corrective work an exact starting point.
 *
 * The first commit recorded also fixes `baselineRevision`, which is where unwinding the whole
 * Ticket returns to.
 */
export function appendTicketCommit<T extends Ticket>(ticket: T, commit: TicketCommit): T {
  return TicketSchema.parse({
    ...ticket,
    baselineRevision: ticket.baselineRevision ?? (commit.kind === 'baseline' ? commit.revision : undefined),
    commits: [...ticket.commits, commit],
  }) as T;
}

/**
 * Where the given attempt must roll back to: the baseline recorded when it started.
 *
 * Reading it from the Ticket rather than from a variable held across the attempt is what makes
 * rollback survive a crash, and what keeps a shared Ticket worktree correct — a corrective Ticket
 * reusing the worktree unwinds only its own attempt, never a predecessor's verified work.
 */
export function attemptBaselineRevision(ticket: Ticket, attempt: number): string | undefined {
  return [...ticket.commits]
    .reverse()
    .find((commit) => commit.kind === 'baseline' && commit.attempt === attempt)
    ?.revision;
}

/** The last commit that passed its gate, used when unwinding to the last known-good state. */
export function lastVerifiedRevision(ticket: Ticket): string | undefined {
  return [...ticket.commits].reverse().find((commit) => commit.kind === 'verified')?.revision;
}

export function workStepId(ticket: Ticket): ObjectId | undefined {
  if (ticket.type === 'bug') return ticket.failure.targetStepId;
  if (ticket.type === 'enhancement') return ticket.targetStepId;
  return ticket.stepId;
}
