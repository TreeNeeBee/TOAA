import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const testsRoot = path.resolve(__dirname);

async function testFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Vitest never descends into these, and neither should the audit.
      return entry.name.startsWith('.') || entry.name === 'node_modules' ? [] : testFiles(full);
    }
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [full] : [];
  }));
  return found.flat();
}

/**
 * Which capability profile in vitest.config.ts claims a given test file.
 *
 * `core` deliberately matches only the top level (`tests/*.test.ts`), so a file added under any
 * other directory would belong to no project and be skipped in silence — `npm test` would still
 * report success. This mirrors the profile globs so a mismatch fails loudly instead.
 */
function profileFor(relative: string): 'core' | 'integration' | 'e2e' | undefined {
  const segments = relative.split(path.sep);
  if (segments.length === 1) return 'core';
  if (segments[0] === 'integration') return 'integration';
  if (segments[0] === 'e2e') return 'e2e';
  return undefined;
}

describe('test profile coverage', () => {
  it('claims every test file for exactly one capability profile', async () => {
    const files = await testFiles(testsRoot);
    expect(files.length).toBeGreaterThan(0);
    const unclaimed = files
      .map((file) => path.relative(testsRoot, file))
      .filter((relative) => profileFor(relative) === undefined);
    expect(unclaimed, 'add these to a profile in vitest.config.ts or they never run').toEqual([]);
  });
});
