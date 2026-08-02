import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_UUID_V7_TIMESTAMP = 0xffff_ffff_ffff;

declare const OBJECT_ID_BRAND: unique symbol;

/** Globally unique, time-sortable identity used by every persisted domain object. */
export type ObjectId = string & { readonly [OBJECT_ID_BRAND]: 'ObjectId' };

export const ObjectIdSchema: z.ZodType<ObjectId> = z.string().regex(
  UUID_V7_PATTERN,
  'Object id must be a UUIDv7',
).transform((value) => value as ObjectId);

export function createObjectId(now = Date.now()): ObjectId {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_UUID_V7_TIMESTAMP) {
    throw new Error(`UUIDv7 timestamp is outside the 48-bit range: ${now}`);
  }

  const bytes = randomBytes(16);
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }

  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-') as ObjectId;
}

export function parseObjectId(value: string): ObjectId {
  return ObjectIdSchema.parse(value);
}

export function isObjectId(value: unknown): value is ObjectId {
  return typeof value === 'string' && UUID_V7_PATTERN.test(value);
}

export function objectIdTimestamp(id: ObjectId): number {
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}
