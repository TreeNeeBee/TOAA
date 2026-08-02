import { z } from 'zod';
import { ObjectEnvelopeSchema } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';

export const ProjectPlanSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('plan'),
  planKind: z.literal('project'),
  requirementDigest: z.string().min(1),
  complexity: z.object({
    level: z.enum(['simple', 'moderate', 'complex']),
    rationale: z.string().min(1),
  }).strict(),
  phasePlanIds: z.array(ObjectIdSchema).min(1),
  activePhaseId: ObjectIdSchema,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;

export const PhasePlanSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('plan'),
  planKind: z.literal('phase'),
  phaseId: ObjectIdSchema,
  objective: z.string().min(1),
  scope: z.array(z.string().min(1)).default([]),
  dependencyPhaseIds: z.array(ObjectIdSchema).default([]),
  stepIds: z.array(ObjectIdSchema).default([]),
  verificationGate: z.array(z.string().min(1)).min(1),
  materialized: z.boolean(),
}).strict();

export type PhasePlan = z.infer<typeof PhasePlanSchema>;
