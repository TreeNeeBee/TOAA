import { z } from 'zod';

export const PENDING_REASONS = [
  'dependency',
  'permission',
  'external-service',
  'scheduled',
  'manual-review',
  'defect',
  'quality-gap',
] as const;

export type PendingReason = (typeof PENDING_REASONS)[number];
export const PendingReasonSchema = z.enum(PENDING_REASONS);
