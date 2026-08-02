import { z } from 'zod';
import { ObjectEnvelopeSchema } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { ObjectRefSchema } from '../objects/object_ref.js';

export const CheckpointSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('checkpoint'),
  subject: ObjectRefSchema,
  eventSequence: z.number().int().nonnegative(),
  snapshotRefs: z.array(z.string().min(1)).min(1),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  reason: z.string().min(1),
}).strict();

export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const ChangelistEntrySchema = z.object({
  path: z.string().min(1),
  operation: z.enum(['create', 'update', 'delete', 'rename']),
  previousPath: z.string().min(1).optional(),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
}).strict();

export const ChangelistSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('changelist'),
  ticketId: ObjectIdSchema,
  stepId: ObjectIdSchema,
  /** Verification-only applications legitimately have no file mutation. */
  entries: z.array(ChangelistEntrySchema),
  commit: z.string().min(1).optional(),
  summary: z.string().min(1),
  verification: z.array(z.string().min(1)).default([]),
}).strict();

export type Changelist = z.infer<typeof ChangelistSchema>;

export const DeliverableSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('deliverable'),
  owner: ObjectRefSchema,
  paths: z.array(z.string().min(1)).min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  verifiedByAssessmentId: ObjectIdSchema.optional(),
}).strict();

export type Deliverable = z.infer<typeof DeliverableSchema>;
