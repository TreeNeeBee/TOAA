import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ContainerLayoutError,
  findProjectContainer,
  ProjectContainer,
  assertProjectContainer,
} from '../src/workspace/project_container.js';

describe('project container layout', () => {
  it('keeps shared state outside every worktree', async () => {
    const container = new ProjectContainer('/tmp/xc-container');
    const canonical = container.canonical();
    // The point of the split: nothing a sandbox mounts can reach project state.
    expect(path.relative(canonical.workspace.root, container.state.root).startsWith('..')).toBe(true);
    expect(container.state.root).toBe(path.join(container.root, '.xcompiler'));
    expect(canonical.workspace.root).toBe(path.join(container.root, 'worktrees', 'master'));
    expect(canonical.localState.root).toBe(path.join(canonical.workspace.root, '.xcw'));
  });

  it('places ticket and gate worktrees beside the canonical one', () => {
    const container = new ProjectContainer('/tmp/xc-container');
    expect(container.ticket('TKT-1', 'xcompiler/ticket/TKT-1').workspace.root)
      .toBe(path.join(container.root, 'worktrees', 'tickets', 'TKT-1'));
    expect(container.gate('MR-1', 'run-1', 'xcompiler/ticket/TKT-1').workspace.root)
      .toBe(path.join(container.root, 'worktrees', 'gates', 'MR-1', 'run-1'));
  });

  it('carries the project identity on the container, not on the working copy', async () => {
    // The working copy is always named after the canonical branch, so anything deriving a project
    // name from it would call every 0.3 project "master". `--name` and `--base-dir` resolve to the
    // container path, which is where the identity actually lives.
    const container = new ProjectContainer('/tmp/news-ts');
    expect(path.basename(container.root)).toBe('news-ts');
    expect(path.basename(container.canonical().workspace.root)).toBe('master');
    expect(path.basename(new ProjectContainer('/tmp/news-ts', 'trunk').canonical().workspace.root))
      .toBe('trunk');
  });

  it('rejects a pre-container workspace with rebuild guidance instead of reinterpreting it', async () => {
    // An earlier workspace has .xcompiler beside the code, with no worktrees/ directory.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-legacy-'));
    await fs.mkdir(path.join(root, '.xcompiler'), { recursive: true });
    await expect(assertProjectContainer(new ProjectContainer(root)))
      .rejects.toBeInstanceOf(ContainerLayoutError);
    await expect(assertProjectContainer(new ProjectContainer(root)))
      .rejects.toThrow(/worktrees\/master\/ is missing/);
  });

  it('finds the owning container from the container, a worktree, or a file inside one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-find-'));
    await fs.mkdir(path.join(root, '.xcompiler'), { recursive: true });
    const canonical = path.join(root, 'worktrees', 'master');
    const ticket = path.join(root, 'worktrees', 'tickets', 'T-1', 'src', 'deep');
    await fs.mkdir(canonical, { recursive: true });
    await fs.mkdir(ticket, { recursive: true });
    await fs.writeFile(path.join(canonical, 'phasePlan.json'), '{}');

    // The three callers each hold a different one of these: `-w` names the container, the plan path
    // printed by build points into the canonical worktree, and a Ticket worktree sits deeper still.
    for (const start of [root, canonical, ticket, path.join(canonical, 'phasePlan.json')]) {
      const found = await findProjectContainer(start);
      expect(found?.root, start).toBe(path.resolve(root));
    }
  });

  it('returns nothing rather than a wrong container when no layout matches', async () => {
    const stray = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-stray-'));
    await fs.mkdir(path.join(stray, 'worktrees', 'master'), { recursive: true });
    // worktrees/ alone is not a container: without .xcompiler there is no state to resolve, and
    // guessing would point every later read at an empty registry.
    expect(await findProjectContainer(path.join(stray, 'worktrees', 'master'))).toBeUndefined();
  });

  it('accepts a container that has both roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-container-'));
    await fs.mkdir(path.join(root, '.xcompiler'), { recursive: true });
    await fs.mkdir(path.join(root, 'worktrees', 'master'), { recursive: true });
    await expect(assertProjectContainer(new ProjectContainer(root))).resolves.toBeUndefined();
  });
});
