import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
// Asserted against the public facade, which is the only surface adapters may use.
import { resolveCompileWorkspace, resolveEvolveWorkspace } from '../src/runtime.js';

describe('CLI workspace resolution', () => {
  it('creates a generated workspace for compile mode when no explicit path is given', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-cli-workspace-'));
    const ws = await resolveCompileWorkspace({ baseDir, name: 'sample-project' });
    expect(ws).toBe(path.join(baseDir, 'sample-project'));
  });

  it('does not carry the project name in the resolved path when one is given explicitly', async () => {
    // The trap this guards: `--name` only shapes the *generated* directory. With an explicit `-w`
    // the name is nowhere in the path, so anything that recovers a project name by parsing the
    // workspace silently loses it. The name has to travel as data.
    const explicit = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-cli-explicit-'));
    const ws = await resolveCompileWorkspace({ workspace: explicit, name: 'report-ts' });
    expect(ws).toBe(path.resolve(explicit));
    expect(ws).not.toContain('report-ts');
  });

  it('defaults evolve mode to the current working directory instead of a temp workspace', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-cli-cwd-'));
    const ws = await resolveEvolveWorkspace({ baseDir: '/tmp', name: 'ignored-name' }, cwd);
    expect(ws).toBe(path.resolve(cwd));
  });
});
