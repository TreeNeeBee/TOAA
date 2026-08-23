import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SANDBOX_GUEST_ENVIRONMENT_DIR,
  sandboxDownloadCachePath,
  sandboxEnvironmentPath,
  sandboxEnvironmentRelPath,
} from '../src/sandbox/environment.js';

const projectId = '019fd0e5-5210-7e03-9b5e-4876a0541efd';
const phaseId = '019fd0e5-5210-7e41-8d33-fd207dc4de96';

describe('sandbox environment identity', () => {
  it('shares one canonical environment across every non-parallel stage', () => {
    expect(sandboxEnvironmentRelPath({ scope: 'canonical', projectId }))
      .toBe(`sandboxes/${projectId}/canonical`);
  });

  it('isolates concurrent CODE roles from each other', () => {
    const developer = sandboxEnvironmentRelPath({ scope: 'development', projectId, phaseId, roleId: 'developer' });
    const tester = sandboxEnvironmentRelPath({ scope: 'development', projectId, phaseId, roleId: 'tester' });
    expect(developer).not.toBe(tester);
    expect(developer).toBe(`sandboxes/${projectId}/${phaseId}/dev/developer`);
  });

  it('gives gate runs one environment per Phase, separate from any role', () => {
    const gate = sandboxEnvironmentRelPath({ scope: 'gate', projectId, phaseId });
    expect(gate).toBe(`sandboxes/${projectId}/${phaseId}/gate`);
    // A gate judges an independent merge candidate, so it must not observe a role's working state.
    expect(gate).not.toBe(
      sandboxEnvironmentRelPath({ scope: 'development', projectId, phaseId, roleId: 'tester' }),
    );
  });

  it('shares one download cache across every environment of a project', () => {
    const stateRoot = '/c/.xcompiler';
    const shared = sandboxDownloadCachePath(stateRoot, projectId);
    // Isolation is about installed state. Package archives are immutable and identical, so fetching
    // them once per environment means paying the same download three times over.
    for (const key of [
      { scope: 'canonical', projectId },
      { scope: 'development', projectId, phaseId, roleId: 'developer' },
      { scope: 'gate', projectId, phaseId },
    ] as const) {
      expect(sandboxDownloadCachePath(stateRoot, projectId)).toBe(shared);
      expect(sandboxEnvironmentPath(stateRoot, key)).not.toBe(shared);
    }
    // Still scoped to the project, so two projects cannot see each other's downloads.
    expect(sandboxDownloadCachePath(stateRoot, '019fd0e5-5210-7e03-9b5e-000000000000'))
      .not.toBe(shared);
  });

  it('keeps the environment out of every worktree', () => {
    const stateRoot = '/c/.xcompiler';
    const resolved = sandboxEnvironmentPath(stateRoot, { scope: 'canonical', projectId });
    expect(resolved.startsWith(stateRoot)).toBe(true);
    expect(resolved).not.toContain('worktrees');
  });

  it('refuses an identifier that would escape the environment root', () => {
    const escaped = sandboxEnvironmentRelPath({
      scope: 'development', projectId, phaseId, roleId: '../../etc',
    });
    expect(escaped).not.toContain('..');
    // The identifier must collapse to a single segment, so it cannot address another environment.
    expect(path.normalize(escaped)).toBe(escaped);
    expect(path.resolve('/state', escaped).startsWith('/state/sandboxes/')).toBe(true);
  });

  it('mounts the environment outside the working-copy mount', () => {
    expect(SANDBOX_GUEST_ENVIRONMENT_DIR.startsWith('/workspace')).toBe(false);
  });
});
