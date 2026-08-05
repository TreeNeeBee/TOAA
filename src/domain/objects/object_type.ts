import { z } from 'zod';

export const OBJECT_TYPES = [
  'project',
  'phase',
  'step',
  'ticket',
  'actor-registration',
  'ticket-assignment',
  'ticket-trace-event',
  'project-management-plan',
  'risk-record',
  'decision-record',
  'interaction-request',
  'plan',
  'kpi',
  'checkpoint',
  'deliverable',
  'quality-assessment',
  'report',
  'changelist',
  'log',
  'audit-event',
  'domain-event',
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];
export const ObjectTypeSchema = z.enum(OBJECT_TYPES);
