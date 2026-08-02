import { describe, expect, it } from 'vitest';
import {
  createObjectId,
  isObjectId,
  objectIdTimestamp,
  parseObjectId,
} from '../src/domain/identity/object_id.js';

describe('ObjectId', () => {
  it('creates globally unique UUIDv7 identities carrying their timestamp', () => {
    const now = Date.parse('2026-08-01T10:20:30.123Z');
    const ids = Array.from({ length: 100 }, () => createObjectId(now));

    expect(new Set(ids)).toHaveLength(ids.length);
    expect(ids.every(isObjectId)).toBe(true);
    expect(ids.every((id) => objectIdTimestamp(id) === now)).toBe(true);
    expect(ids.every((id) => id[14] === '7')).toBe(true);
    expect(ids.every((id) => ['8', '9', 'a', 'b'].includes(id[19]!))).toBe(true);
  });

  it('rejects display names and UUID versions other than v7', () => {
    expect(() => parseObjectId('P1-S004')).toThrow(/UUIDv7/u);
    expect(() => parseObjectId('550e8400-e29b-41d4-a716-446655440000')).toThrow(/UUIDv7/u);
  });
});
