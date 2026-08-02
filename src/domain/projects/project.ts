import { z } from 'zod';
import { assertStateTransition, type StateTransitions } from '../../util/state_machine.js';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { PendingReasonSchema } from '../workflow/pending_reason.js';

export const PROJECT_STATES = [
  'created',
  'planning',
  'in_progress',
  'pending',
  'delivered',
  'cancelled',
  'closed',
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

const PROJECT_TRANSITIONS: StateTransitions<ProjectState> = {
  created: ['planning', 'cancelled'],
  planning: ['in_progress', 'pending', 'cancelled'],
  in_progress: ['pending', 'delivered', 'cancelled'],
  pending: ['planning', 'in_progress', 'cancelled'],
  delivered: ['closed', 'in_progress', 'planning'],
  cancelled: ['planning', 'closed'],
  closed: ['planning'],
};

export const ProjectSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('project'),
  topic: z.object({
    text: z.string().min(1),
    sourceRef: z.string().min(1).optional(),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  state: z.enum(PROJECT_STATES),
  pendingReason: PendingReasonSchema.optional(),
  language: z.enum(['python', 'typescript']),
  intent: z.enum(['greenfield', 'feature', 'refactor', 'self']),
  projectType: z.enum(['application', 'library', 'mixed']),
  projectPlanId: ObjectIdSchema,
  phaseIds: z.array(ObjectIdSchema).min(1),
  currentPhaseId: ObjectIdSchema.optional(),
  kpiIds: z.array(ObjectIdSchema).default([]),
  qualityAssessmentId: ObjectIdSchema.optional(),
  deliverableIds: z.array(ObjectIdSchema).default([]),
  checkpointIds: z.array(ObjectIdSchema).default([]),
  reportIds: z.array(ObjectIdSchema).default([]),
  auditEventIds: z.array(ObjectIdSchema).default([]),
}).strict().superRefine((project, ctx) => {
  if (project.projectId !== project.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['projectId'],
      message: 'Project projectId must equal id',
    });
  }
  if (project.currentPhaseId && !project.phaseIds.includes(project.currentPhaseId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['currentPhaseId'],
      message: 'Project currentPhaseId must reference one of phaseIds',
    });
  }
});

export type Project = z.infer<typeof ProjectSchema>;

export function transitionProject(
  project: Project,
  next: ProjectState,
  options: { pendingReason?: z.infer<typeof PendingReasonSchema>; now?: string } = {},
): Project {
  if (!assertStateTransition('project', project.id, project.state, next, PROJECT_TRANSITIONS)) return project;
  if (next === 'pending' && !options.pendingReason) {
    throw new Error(`Project ${project.id} requires pendingReason when entering pending`);
  }
  const envelope = reviseObjectEnvelope(project, { now: options.now });
  return ProjectSchema.parse({
    ...project,
    ...envelope,
    state: next,
    pendingReason: next === 'pending' ? options.pendingReason : undefined,
  });
}
