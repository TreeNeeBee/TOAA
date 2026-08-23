import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const runtime = path.resolve(__dirname, '..', 'src', 'runtime');

describe('PM projection location', () => {
  // A live run reached the merge gate, passed it, and then died on
  // `Cannot merge into master: the working copy has uncommitted changes`. The dirty file was
  // XCompiler's own `cache/pm/project-status.json`, written into the generated project and tracked
  // by Git — its own bookkeeping blocked its own merge. The design doc already put it under
  // `.xcompiler/`; only the code disagreed.
  it('is written to container state, never into the working copy', async () => {
    const offenders: string[] = [];
    for (const name of await fs.readdir(runtime)) {
      if (!name.endsWith('.ts')) continue;
      const text = await fs.readFile(path.join(runtime, name), 'utf8');
      for (const match of text.matchAll(/new FileProjectProjectionWriter\(([^)]*)\)/gu)) {
        const argument = match[1]!.trim();
        if (!argument.includes('container.state.root')) offenders.push(`${name}: ${argument}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
