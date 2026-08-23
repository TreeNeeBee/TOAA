import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { containerOwnershipRecord, GitRepositoryService } from '../src/infrastructure/git/git_repository_service.js';
import { Workspace } from '../src/workspace/workspace.js';

async function world() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ownership-'));
  const repo = path.join(root, 'worktrees', 'master');
  await fs.mkdir(repo, { recursive: true });
  const state = new Workspace(path.join(root, '.xcompiler'));
  return { repo, record: containerOwnershipRecord(state), state };
}

describe('repository ownership', () => {
  // A live run was interrupted by a provider outage and resumed. The second invocation found the
  // repository already there, called it `pre-existing`, and refused to merge into a mainline
  // XCompiler had created itself one command earlier — after the gate had passed. Ownership is a
  // fact about the repository, not about the call that looked.
  it('survives a second run of the same workspace', async () => {
    const { repo, record } = await world();
    const first = await new GitRepositoryService(repo)
      .ensureRepository(undefined, { initialBranch: 'master', ownershipRecord: record });
    expect(first.ownership).toBe('xcompiler-created');

    const second = await new GitRepositoryService(repo)
      .ensureRepository(undefined, { initialBranch: 'master', ownershipRecord: record });
    expect(second.ownership).toBe('xcompiler-created');
  });

  it('still recognises a repository XCompiler did not create', async () => {
    const { repo, record } = await world();
    await new GitRepositoryService(repo).raw().init(['--initial-branch=master']);

    const info = await new GitRepositoryService(repo)
      .ensureRepository(undefined, { initialBranch: 'master', ownershipRecord: record });
    expect(info.ownership).toBe('pre-existing');
  });

  it('rediscovers cautiously when the record is unreadable', async () => {
    const { repo, record, state } = await world();
    await new GitRepositoryService(repo)
      .ensureRepository(undefined, { initialBranch: 'master', ownershipRecord: record });
    await state.writeFile('repository-ownership.json', 'not json\n');

    // The repository exists by now, so rediscovery answers `pre-existing` — the answer that
    // withholds the merge rather than the one that takes it.
    const info = await new GitRepositoryService(repo)
      .ensureRepository(undefined, { initialBranch: 'master', ownershipRecord: record });
    expect(info.ownership).toBe('pre-existing');
  });
});
