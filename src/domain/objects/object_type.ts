import { z } from 'zod';

export const OBJECT_TYPES = [
  'project',
  'phase',
  'step',
  'ticket',
  'plan',
  'kpi',
  'checkpoint',
  'deliverable',
  'quality-assessment',
  'report',
  'changelist',
  'log',
  'audit-event',
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];
export const ObjectTypeSchema = z.enum(OBJECT_TYPES);
