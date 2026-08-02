import { z } from 'zod';
import { ObjectIdSchema } from '../identity/object_id.js';
import { ObjectEnvelopeSchema } from '../objects/object_envelope.js';
import { ObjectRefSchema } from '../objects/object_ref.js';

export const ReportSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('report'),
  subject: ObjectRefSchema,
  reportType: z.enum(['step', 'phase', 'project', 'delivery']),
  path: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  verdict: z.enum(['passed', 'failed', 'partial', 'informational']),
  relatedObjectIds: z.array(ObjectIdSchema).default([]),
  generatedAt: z.string().datetime({ offset: true }),
}).strict();

export type Report = z.infer<typeof ReportSchema>;

export const DomainLogSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('log'),
  subject: ObjectRefSchema.optional(),
  level: z.enum(['debug', 'info', 'warning', 'error']),
  message: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
  correlationId: ObjectIdSchema,
  causationId: ObjectIdSchema.optional(),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export type DomainLog = z.infer<typeof DomainLogSchema>;

export const DomainAuditEventSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('audit-event'),
  subject: ObjectRefSchema.optional(),
  kind: z.string().min(1),
  actor: z.string().min(1),
  correlationId: ObjectIdSchema,
  causationId: ObjectIdSchema.optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export type DomainAuditEvent = z.infer<typeof DomainAuditEventSchema>;
