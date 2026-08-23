import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { GitRepositoryService } from '../../src/infrastructure/git/git_repository_service.js';

async function repository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-merge-'));
  const git = simpleGit({ baseDir: root });
  await git.init(['--initial-branch=master']);
  await git.addConfig('user.email', 'test@local');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(root, 'README.md'), '# fixture\n');
  await git.add('.');
  await git.commit('init');
  return { root, git, service: new GitRepositoryService(root) };
}

async function ticketBranch(root: string, service: GitRepositoryService, name: string) {
  const worktree = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-mw-')), 'w');
  await service.addWorktree({ path: worktree, branch: name, startPoint: await service.head() });
  const git = simpleGit({ baseDir: worktree });
  for (const step of ['one', 'two']) {
    await fs.writeFile(path.join(worktree, `${step}.txt`), `${step}\n`);
    await git.add('.');
    await git.commit(`[xcompiler] attempt ${step}`);
  }
  return { worktree, git };
}

describe('squash merge onto the mainline', () => {
  it('lands one commit per ChangeSet and keeps the attempt history on the branch', async () => {
    const { root, git, service } = await repository();
    const branch = 'xcompiler/ticket/T1';
    await ticketBranch(root, service, branch);

    const before = await service.revision('master');
    const merged = await service.squashMerge({
      targetBranch: 'master',
      sourceBranch: branch,
      expectedTargetRevision: before,
      message: '[xcompiler] T1',
    });

    const mainline = (await git.log(['master'])).all;
    expect(mainline).toHaveLength(2);
    expect(mainline[0]!.message).toBe('[xcompiler] T1');
    expect(merged).not.toBe(before);
    // Both files land, so the squash carried the whole ChangeSet.
    expect(await fs.readFile(path.join(root, 'two.txt'), 'utf8')).toBe('two\n');
    // The per-attempt commits remain on the branch for audit.
    expect((await git.log([branch])).all.length).toBeGreaterThan(2);
  });

  it('refuses to merge when the mainline moved after the gate looked at it', async () => {
    const { root, git, service } = await repository();
    const branch = 'xcompiler/ticket/T2';
    await ticketBranch(root, service, branch);
    const gateSawTarget = await service.revision('master');

    // Someone else lands on the mainline between the gate passing and the merge running.
    await fs.writeFile(path.join(root, 'other.txt'), 'other\n');
    await git.add('.');
    await git.commit('unrelated mainline work');

    await expect(service.squashMerge({
      targetBranch: 'master',
      sourceBranch: branch,
      expectedTargetRevision: gateSawTarget,
      message: '[xcompiler] T2',
    })).rejects.toThrow(/moved from .* to /);
  });

  it('refuses to merge into a dirty mainline', async () => {
    const { root, service } = await repository();
    const branch = 'xcompiler/ticket/T3';
    await ticketBranch(root, service, branch);
    await fs.writeFile(path.join(root, 'scratch.txt'), 'uncommitted\n');

    await expect(service.squashMerge({
      targetBranch: 'master',
      sourceBranch: branch,
      expectedTargetRevision: await service.revision('master'),
      message: '[xcompiler] T3',
    })).rejects.toThrow(/uncommitted changes/);
  });
});
