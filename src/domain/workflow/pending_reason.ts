import { z } from 'zod';

export const PENDING_REASONS = [
  'dependency',
  'permission',
  'external-service',
  'scheduled',
  'manual-review',
  'defect',
  'quality-gap',
  /** PM identified this Ticket as another report of active authoritative work. */
  'duplicate',
  /** The run that started this work died before the attempt completed. */
  'interrupted',
] as const;

export type PendingReason = (typeof PENDING_REASONS)[number];
export const PendingReasonSchema = z.enum(PENDING_REASONS);
