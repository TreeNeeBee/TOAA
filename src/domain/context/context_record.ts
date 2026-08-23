import { z } from 'zod';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema, type ObjectId } from '../identity/object_id.js';

export const CONTEXT_SCOPES = ['project', 'phase', 'step', 'ticket'] as const;
export type ContextScope = (typeof CONTEXT_SCOPES)[number];

const AuthoredSchema = z.object({
  actorId: ObjectIdSchema,
  at: z.string().datetime({ offset: true }),
});

export const ContextFindingSchema = AuthoredSchema.extend({
  id: z.string().min(1),
  text: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).default([]),
}).strict();

export const ContextDecisionSchema = AuthoredSchema.extend({
  id: z.string().min(1),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  /** Proposed decisions are visible but not binding until the owning authority accepts them. */
  status: z.enum(['proposed', 'accepted', 'superseded']),
}).strict();

export const ContextQuestionSchema = AuthoredSchema.extend({
  id: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1).optional(),
  status: z.enum(['open', 'resolved']),
}).strict();

export const ContextArtifactSchema = AuthoredSchema.extend({
  path: z.string().min(1),
  description: z.string().min(1),
}).strict();

export type ContextFinding = z.infer<typeof ContextFindingSchema>;
export type ContextDecision = z.infer<typeof ContextDecisionSchema>;
export type ContextQuestion = z.infer<typeof ContextQuestionSchema>;
export type ContextArtifact = z.infer<typeof ContextArtifactSchema>;

/**
 * Durable, authored knowledge about one scope of the project.
 *
 * Distinct from the two stores it sits between. Domain objects hold lifecycle state — what a Step's
 * status is; the PM projection is a derived cache that can be deleted and rebuilt. Context is
 * neither: it is what people and roles concluded, which nothing can recompute, so it is versioned
 * and audited rather than regenerated.
 *
 * The Markdown rendering that roles read is a projection of this record, not a second copy of it.
 */
export const ContextRecordSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('context-record'),
  scope: z.enum(CONTEXT_SCOPES),
  /** The Project, Phase, Step, or Ticket this context describes. */
  ownerId: ObjectIdSchema,
  summary: z.string().default(''),
  /** What the owning authority fixed: objectives, contracts, and hard limits. */
  objective: z.string().default(''),
  constraints: z.array(z.string().min(1)).default([]),
  acceptance: z.array(z.string().min(1)).default([]),
  /** What execution learned. Appended by the working role, never rewritten. */
  findings: z.array(ContextFindingSchema).default([]),
  decisions: z.array(ContextDecisionSchema).default([]),
  openQuestions: z.array(ContextQuestionSchema).default([]),
  artifacts: z.array(ContextArtifactSchema).default([]),
  progress: z.string().default(''),
}).strict();

export type ContextRecord = z.infer<typeof ContextRecordSchema>;

export class ContextRevisionConflictError extends Error {
  constructor(recordId: string, expected: number, actual: number) {
    super(
      `Context ${recordId} changed since it was read: expected revision ${expected}, found ${actual}. ` +
      'Re-read the context and reapply the update.',
    );
    this.name = 'ContextRevisionConflictError';
  }
}

export class ContextAuthorityError extends Error {
  constructor(scope: ContextScope, operation: string) {
    super(
      `${operation} on ${scope} context is reserved for the owning authority. ` +
      'An executing role may append findings, progress, artifacts, questions, and proposed decisions.',
    );
    this.name = 'ContextAuthorityError';
  }
}

export const CONTEXT_APPEND_OPERATIONS = [
  'append-finding',
  'update-progress',
  'add-artifact',
  'add-question',
  'propose-decision',
  'resolve-question',
] as const;

export const CONTEXT_AUTHORITY_OPERATIONS = [
  'set-objective',
  'set-constraints',
  'set-acceptance',
  'accept-decision',
] as const;

export type ContextOperation =
  | (typeof CONTEXT_APPEND_OPERATIONS)[number]
  | (typeof CONTEXT_AUTHORITY_OPERATIONS)[number];

/**
 * Whether an operation may be performed without the scope's owning authority.
 *
 * The split is deliberate: an executing role can record everything it learned, but cannot rewrite
 * the objective or acceptance it was given. That is what keeps context from drifting into a place
 * where work redefines its own success criteria.
 */
export function requiresAuthority(operation: ContextOperation): boolean {
  return (CONTEXT_AUTHORITY_OPERATIONS as readonly string[]).includes(operation);
}

export interface ContextUpdate {
  operation: ContextOperation;
  actorId: ObjectId;
  at: string;
  text?: string;
  rationale?: string;
  evidenceRefs?: string[];
  values?: string[];
  targetId?: string;
  path?: string;
}

/**
 * Applies one update to a record, returning a new revision.
 *
 * Every append carries its author and time, so a later reader can tell who concluded what without
 * consulting a separate log.
 */
export function applyContextUpdate(record: ContextRecord, update: ContextUpdate): ContextRecord {
  const authored = { actorId: update.actorId, at: update.at };
  const next = { ...record };
  switch (update.operation) {
    case 'append-finding':
      next.findings = [...record.findings, {
        ...authored,
        id: `F${record.findings.length + 1}`,
        text: requireText(update, 'append-finding'),
        evidenceRefs: update.evidenceRefs ?? [],
      }];
      break;
    case 'update-progress':
      next.progress = requireText(update, 'update-progress');
      break;
    case 'add-artifact':
      next.artifacts = [...record.artifacts, {
        ...authored,
        path: update.path ?? requireText(update, 'add-artifact'),
        description: requireText(update, 'add-artifact'),
      }];
      break;
    case 'add-question':
      next.openQuestions = [...record.openQuestions, {
        ...authored,
        id: `Q${record.openQuestions.length + 1}`,
        question: requireText(update, 'add-question'),
        status: 'open',
      }];
      break;
    case 'resolve-question':
      next.openQuestions = record.openQuestions.map((question) =>
        question.id === update.targetId
          ? { ...question, status: 'resolved' as const, answer: requireText(update, 'resolve-question') }
          : question);
      break;
    case 'propose-decision':
      next.decisions = [...record.decisions, {
        ...authored,
        id: `D${record.decisions.length + 1}`,
        decision: requireText(update, 'propose-decision'),
        rationale: update.rationale ?? requireText(update, 'propose-decision'),
        status: 'proposed',
      }];
      break;
    case 'accept-decision':
      next.decisions = record.decisions.map((decision) =>
        decision.id === update.targetId ? { ...decision, status: 'accepted' as const } : decision);
      break;
    case 'set-objective':
      next.objective = requireText(update, 'set-objective');
      break;
    case 'set-constraints':
      next.constraints = update.values ?? [];
      break;
    case 'set-acceptance':
      next.acceptance = update.values ?? [];
      break;
  }
  return ContextRecordSchema.parse({ ...next, ...reviseObjectEnvelope(record, { now: update.at }) });
}

function requireText(update: ContextUpdate, operation: string): string {
  if (!update.text) throw new Error(`${operation} requires text`);
  return update.text;
}
