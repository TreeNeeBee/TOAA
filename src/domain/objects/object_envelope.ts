import { z } from 'zod';
import {
  createObjectId,
  ObjectIdSchema,
  type ObjectId,
} from '../identity/object_id.js';
import { ObjectTypeSchema, type ObjectType } from './object_type.js';

export const ObjectEnvelopeSchema = z.object({
  id: ObjectIdSchema,
  /** Human-readable display label. It is never used as identity or a foreign key. */
  name: z.string().trim().min(1),
  objectType: ObjectTypeSchema,
  projectId: ObjectIdSchema,
  schemaVersion: z.number().int().positive(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export type ObjectEnvelope = z.infer<typeof ObjectEnvelopeSchema>;

export function createObjectEnvelope<TType extends ObjectType>(input: {
  name: string;
  objectType: TType;
  projectId?: ObjectId;
  schemaVersion?: number;
  now?: string;
}): ObjectEnvelope & { objectType: TType } {
  const id = createObjectId();
  const now = input.now ?? new Date().toISOString();
  const projectId = input.objectType === 'project'
    ? id
    : input.projectId;
  if (!projectId) {
    throw new Error(`${input.objectType} object requires projectId`);
  }
  return ObjectEnvelopeSchema.parse({
    id,
    name: input.name,
    objectType: input.objectType,
    projectId,
    schemaVersion: input.schemaVersion ?? 1,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }) as ObjectEnvelope & { objectType: TType };
}

export function reviseObjectEnvelope(
  current: ObjectEnvelope,
  changes: { name?: string; now?: string } = {},
): ObjectEnvelope {
  return ObjectEnvelopeSchema.parse({
    id: current.id,
    name: changes.name ?? current.name,
    objectType: current.objectType,
    projectId: current.projectId,
    schemaVersion: current.schemaVersion,
    revision: current.revision + 1,
    createdAt: current.createdAt,
    updatedAt: changes.now ?? new Date().toISOString(),
  });
}

export function extractObjectEnvelope(value: ObjectEnvelope): ObjectEnvelope {
  return ObjectEnvelopeSchema.parse({
    id: value.id,
    name: value.name,
    objectType: value.objectType,
    projectId: value.projectId,
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}
