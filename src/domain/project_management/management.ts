import { z } from 'zod';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { assertStateTransition, type StateTransitions } from '../../util/state_machine.js';
import { FileTreePolicySchema } from '../workspace/file_tree.js';

export const PROJECT_MANAGEMENT_PLAN_STATES = [
  'draft',
  'baselined',
  'active',
  'delivered',
  'closed',
] as const;
export type ProjectManagementPlanState = (typeof PROJECT_MANAGEMENT_PLAN_STATES)[number];

const PROJECT_MANAGEMENT_PLAN_TRANSITIONS: StateTransitions<ProjectManagementPlanState> = {
  draft: ['baselined'],
  baselined: ['active'],
  active: ['delivered'],
  delivered: ['closed', 'active'],
  closed: ['baselined'],
};

export const ProjectManagementPlanSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('project-management-plan'),
  pmActorId: ObjectIdSchema,
  objective: z.string().min(1),
  scopeBaseline: z.array(z.string().min(1)).min(1),
  successCriteria: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)).default([]),
  stakeholderRefs: z.array(z.string().min(1)).default([]),
  milestonePhaseIds: z.array(ObjectIdSchema).min(1),
  actorRegistrationIds: z.array(ObjectIdSchema).min(1),
  riskRecordIds: z.array(ObjectIdSchema).default([]),
  decisionRecordIds: z.array(ObjectIdSchema).default([]),
  interactionRequestIds: z.array(ObjectIdSchema).default([]),
  // The tree is referenced, not embedded, for the same reason risks and decisions are: it is
  // rewritten on every file a Step writes, and a plan carrying that state would take a revision per
  // write on the object the orchestrator is also writing. Ownership stays here; the churn does not.
  fileTree: FileTreePolicySchema.optional(),
  scheduleToleranceMs: z.number().int().nonnegative().default(0),
  tokenBudget: z.number().int().positive().optional(),
  costBudget: z.number().nonnegative().optional(),
  status: z.enum(PROJECT_MANAGEMENT_PLAN_STATES),
  baselinedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type ProjectManagementPlan = z.infer<typeof ProjectManagementPlanSchema>;

export const RiskRecordSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('risk-record'),
  ownerActorId: ObjectIdSchema,
  category: z.enum(['scope', 'schedule', 'cost', 'quality', 'resource', 'technical', 'external', 'security']),
  description: z.string().min(1),
  probability: z.number().min(0).max(1),
  impact: z.number().min(0).max(1),
  status: z.enum(['identified', 'mitigating', 'accepted', 'realized', 'closed']),
  mitigation: z.array(z.string().min(1)).min(1),
  trigger: z.string().min(1).optional(),
  relatedTicketIds: z.array(ObjectIdSchema).default([]),
}).strict();

export type RiskRecord = z.infer<typeof RiskRecordSchema>;

export type RiskRecordState = RiskRecord['status'];
const RISK_RECORD_TRANSITIONS: StateTransitions<RiskRecordState> = {
  identified: ['mitigating', 'accepted', 'realized', 'closed'],
  mitigating: ['accepted', 'realized', 'closed'],
  accepted: ['realized', 'closed'],
  realized: ['mitigating', 'closed'],
  closed: [],
};

export const DecisionRecordSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('decision-record'),
  decisionType: z.enum(['routing', 'phase', 'change', 'risk', 'budget', 'permission', 'delivery']),
  decidedByActorId: ObjectIdSchema,
  authority: z.enum(['domain', 'policy', 'user', 'pm-advisor', 'project-manager']),
  options: z.array(z.string().min(1)).min(1),
  selected: z.string().min(1),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  correlationId: ObjectIdSchema,
  causationId: ObjectIdSchema.optional(),
  decidedAt: z.string().datetime({ offset: true }),
}).strict();

export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const InteractionRequestSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('interaction-request'),
  requestedByActorId: ObjectIdSchema,
  interactionType: z.enum(['clarification', 'confirmation', 'permission', 'change-approval', 'risk-acceptance']),
  status: z.enum(['pending', 'answered', 'expired', 'cancelled']),
  prompt: z.string().min(1),
  choices: z.array(z.string().min(1)).default([]),
  risk: z.string().min(1),
  relatedTicketId: ObjectIdSchema.optional(),
  correlationId: ObjectIdSchema,
  response: z.string().min(1).optional(),
  requestedAt: z.string().datetime({ offset: true }),
  respondedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;

export type InteractionRequestState = InteractionRequest['status'];
const INTERACTION_REQUEST_TRANSITIONS: StateTransitions<InteractionRequestState> = {
  pending: ['answered', 'expired', 'cancelled'],
  answered: [],
  expired: [],
  cancelled: [],
};

export function reviseManagementPlan(
  plan: ProjectManagementPlan,
  changes: Partial<Omit<ProjectManagementPlan, 'id' | 'objectType' | 'projectId' | 'createdAt' | 'revision'>>,
): ProjectManagementPlan {
  return ProjectManagementPlanSchema.parse({ ...plan, ...changes, ...reviseObjectEnvelope(plan) });
}

export function transitionManagementPlan(
  plan: ProjectManagementPlan,
  next: ProjectManagementPlanState,
  now = new Date().toISOString(),
): ProjectManagementPlan {
  if (!assertStateTransition('project-management-plan', plan.id, plan.status, next, PROJECT_MANAGEMENT_PLAN_TRANSITIONS)) {
    return plan;
  }
  return ProjectManagementPlanSchema.parse({
    ...plan,
    ...reviseObjectEnvelope(plan, { now }),
    status: next,
    baselinedAt: next === 'baselined' ? now : plan.baselinedAt,
  });
}

export function transitionRiskRecord(
  risk: RiskRecord,
  next: RiskRecordState,
  changes: { mitigation?: string[] } = {},
): RiskRecord {
  if (!assertStateTransition('risk-record', risk.id, risk.status, next, RISK_RECORD_TRANSITIONS)) return risk;
  return RiskRecordSchema.parse({
    ...risk,
    ...changes,
    ...reviseObjectEnvelope(risk),
    status: next,
  });
}

export function transitionInteractionRequest(
  request: InteractionRequest,
  next: InteractionRequestState,
  input: { response?: string; now?: string } = {},
): InteractionRequest {
  if (!assertStateTransition(
    'interaction-request',
    request.id,
    request.status,
    next,
    INTERACTION_REQUEST_TRANSITIONS,
  )) return request;
  const now = input.now ?? new Date().toISOString();
  if (next === 'answered' && !input.response) {
    throw new Error(`Interaction Request ${request.id} requires a response`);
  }
  return InteractionRequestSchema.parse({
    ...request,
    ...reviseObjectEnvelope(request, { now }),
    status: next,
    response: next === 'answered' ? input.response : request.response,
    respondedAt: next === 'answered' ? now : request.respondedAt,
  });
}
