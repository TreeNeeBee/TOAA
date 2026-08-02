import { z } from 'zod';
import { ObjectIdSchema, type ObjectId } from '../identity/object_id.js';
import { ObjectTypeSchema, type ObjectType } from './object_type.js';

export interface ObjectRef<TType extends ObjectType = ObjectType> {
  id: ObjectId;
  objectType: TType;
}

export const ObjectRefSchema = z.object({
  id: ObjectIdSchema,
  objectType: ObjectTypeSchema,
}).strict();

export function objectRef<TType extends ObjectType>(
  id: ObjectId,
  objectType: TType,
): ObjectRef<TType> {
  return { id, objectType };
}
