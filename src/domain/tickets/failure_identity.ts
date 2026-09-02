import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ObjectIdSchema } from '../identity/object_id.js';
import { STEP_TYPES } from '../steps/step.js';

const FAILURE_CATEGORIES = [
  'llm-provider',
  'tool',
  'test',
  'quality',
  'contract',
  'internal',
] as const;

/** Stable, persisted identity used by every Bug deduplication and recurrence decision. */
export const FailureIdentitySchema = z.object({
  version: z.literal(1),
  category: z.enum(FAILURE_CATEGORIES),
  code: z.string().min(1),
  failedStepId: ObjectIdSchema,
  targetStepId: ObjectIdSchema,
  verificationStepId: ObjectIdSchema,
  operation: z.string().min(1).optional(),
  testSelectors: z.array(z.string().min(1)).default([]),
  artifactTargets: z.array(z.string().min(1)).default([]),
  exitCode: z.number().int().optional(),
  statusCode: z.number().int().optional(),
}).strict();

export type FailureIdentity = z.infer<typeof FailureIdentitySchema>;

/** The exact gate evidence that must be observed before a Bug can be verified. */
export const BugVerificationContractSchema = z.object({
  kind: z.enum(['test-gate', 'quality-gate', 'operation']),
  verificationStepId: ObjectIdSchema,
  verificationStepType: z.enum(STEP_TYPES),
  operation: z.string().min(1).optional(),
  testSelectors: z.array(z.string().min(1)).default([]),
  artifactTargets: z.array(z.string().min(1)).default([]),
}).strict();

export type BugVerificationContract = z.infer<typeof BugVerificationContractSchema>;

/** Append-only proof that one execution replayed the Bug's immutable verification contract. */
export const BugVerificationRecordSchema = z.object({
  failureIdentityKey: z.string().regex(/^[a-f0-9]{64}$/u),
  verificationStepId: ObjectIdSchema,
  verificationStepType: z.enum(STEP_TYPES),
  qualityAssessmentId: ObjectIdSchema,
  executedTestSelectors: z.array(z.string().min(1)).default([]),
  recordedAt: z.string().datetime({ offset: true }),
}).strict();

export type BugVerificationRecord = z.infer<typeof BugVerificationRecordSchema>;

export function failureIdentityKey(value: FailureIdentity): string {
  const identity = FailureIdentitySchema.parse(value);
  return createHash('sha256').update(JSON.stringify({
    ...identity,
    operation: identity.operation?.trim().toLowerCase(),
    testSelectors: canonicalStrings(identity.testSelectors, normalizeSelector),
    artifactTargets: canonicalStrings(identity.artifactTargets, normalizePath),
  })).digest('hex');
}

export function sameFailureIdentity(left: FailureIdentity, right: FailureIdentity): boolean {
  return failureIdentityKey(left) === failureIdentityKey(right);
}

function canonicalStrings(
  values: readonly string[],
  normalize: (value: string) => string,
): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))].sort();
}

function normalizeSelector(value: string): string {
  const normalized = normalizePath(value);
  return normalized.replace(/\bpytest-\d+\b/gu, 'pytest-<run>');
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '');
}
