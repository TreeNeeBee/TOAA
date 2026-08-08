import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { GitRepositoryService } from '../../src/infrastructure/git/git_repository_service.js';

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-git-repo-'));
  const git = simpleGit({ baseDir: root });
  await git.init();
  await git.addConfig('user.email', 'test@local');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(root, 'README.md'), '# fixture\n');
  await git.add('.');
  await git.commit('init');
  return root;
}

describe('GitRepositoryService', () => {
  it('creates a repository on the canonical branch with a HEAD to snapshot from', async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-git-init-'));
    const service = new GitRepositoryService(fresh);
    expect(await service.hasCommits()).toBe(false);

    await service.ensureRepository(undefined, { initialBranch: 'master' });

    // The worktree layout, the merge target, and every gate verdict are keyed by this name, so the
    // host's init.defaultBranch must not decide it.
    expect((await simpleGit({ baseDir: fresh }).revparse(['--abbrev-ref', 'HEAD'])).trim())
      .toBe('master');
    // Every Step attempt starts by snapshotting the working copy, which resolves HEAD; an unborn
    // HEAD fails that with a bare `fatal: ambiguous argument 'HEAD'`.
    expect(await service.hasCommits()).toBe(true);
  });

  it('gives an already-initialized but empty repository a HEAD without re-initializing it', async () => {
    // The run path initializes through this service and then hands the same working copy to
    // GitService, so "already a repository" says nothing about whether anything is committed.
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-git-empty-'));
    await simpleGit({ baseDir: fresh }).init(['--initial-branch=master']);
    const service = new GitRepositoryService(fresh);

    const info = await service.ensureRepository(undefined, { initialBranch: 'master' });

    expect(info.ownership).toBe('pre-existing');
    expect(await service.hasCommits()).toBe(true);
  });

  it('records ownership from whether the repository already existed', async () => {
    const existing = await repository();
    expect((await new GitRepositoryService(existing).ensureRepository()).ownership)
      .toBe('pre-existing');

    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-git-new-'));
    expect((await new GitRepositoryService(fresh).ensureRepository()).ownership)
      .toBe('xcompiler-created');
  });

  it('resolves git internals identically from the main and a linked worktree', async () => {
    const root = await repository();
    const service = new GitRepositoryService(root);
    const linked = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-wt-')), 'ticket');
    await service.addWorktree({ path: linked, branch: 'xcompiler/ticket/T1', startPoint: await service.head() });

    // In a linked worktree `.git` is a file, so a path built by joining `.git` is wrong there.
    expect((await fs.stat(path.join(linked, '.git'))).isFile()).toBe(true);

    const linkedService = new GitRepositoryService(linked);
    expect(await linkedService.commonDir()).toBe(await service.commonDir());

    // `--git-path` must land inside the shared git dir, not inside the worktree.
    const exclude = await linkedService.gitPath('info/exclude');
    expect(exclude.startsWith(await linkedService.commonDir())).toBe(true);
    expect(exclude.startsWith(linked)).toBe(false);
  });

  it('reuses an existing branch instead of failing to recreate it', async () => {
    const root = await repository();
    const service = new GitRepositoryService(root);
    const head = await service.head();
    const first = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-wt-a-')), 'w');
    await service.addWorktree({ path: first, branch: 'xcompiler/ticket/T2', startPoint: head });
    await service.removeWorktree(first);

    const second = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-wt-b-')), 'w');
    await service.addWorktree({ path: second, branch: 'xcompiler/ticket/T2', startPoint: head });
    expect((await service.listWorktrees()).some((entry) => entry.branch === 'xcompiler/ticket/T2')).toBe(true);
  });

  it('prunes a worktree whose directory was deleted underneath Git', async () => {
    const root = await repository();
    const service = new GitRepositoryService(root);
    const orphan = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-wt-c-')), 'w');
    await service.addWorktree({ path: orphan, branch: 'xcompiler/ticket/T3', startPoint: await service.head() });
    await fs.rm(orphan, { recursive: true, force: true });

    // This is what a run killed mid-gate leaves behind; recovery must not throw on it.
    await expect(service.removeWorktree(orphan)).resolves.toBeUndefined();
    expect((await service.listWorktrees()).some((entry) => entry.path === orphan)).toBe(false);
  });

  it('restores a clean canonical worktree when a squash merge conflicts', async () => {
    const root = await repository();
    const git = simpleGit({ baseDir: root });
    const targetBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    await git.checkoutLocalBranch('feature');
    await fs.writeFile(path.join(root, 'README.md'), '# feature\n');
    await git.add('.');
    await git.commit('feature change');
    await git.checkout(targetBranch);
    await fs.writeFile(path.join(root, 'README.md'), '# master\n');
    await git.add('.');
    await git.commit('mainline change');
    const expectedTargetRevision = (await git.revparse(['HEAD'])).trim();
    const service = new GitRepositoryService(root);

    await expect(service.squashMerge({
      targetBranch,
      sourceBranch: 'feature',
      expectedTargetRevision,
      message: 'conflicting squash',
    })).rejects.toThrow();

    expect((await git.revparse(['HEAD'])).trim()).toBe(expectedTargetRevision);
    expect((await git.status()).isClean()).toBe(true);
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('# master\n');
  });
});

describe('GitService inside a linked worktree', () => {
  it('writes runtime excludes from a linked worktree, where .git is a file', async () => {
    const { GitService } = await import('../../src/workspace/git.js');
    const { Workspace } = await import('../../src/workspace/workspace.js');
    const root = await repository();
    const service = new GitRepositoryService(root);
    const linked = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-wt-excl-')), 'w');
    await service.addWorktree({ path: linked, branch: 'xcompiler/ticket/T4', startPoint: await service.head() });

    // Before the fix this silently did nothing, so .xcompiler artifacts could be staged.
    await new GitService(new Workspace(linked)).ensureRepo();

    const exclude = await new GitRepositoryService(linked).gitPath('info/exclude');
    expect(await fs.readFile(exclude, 'utf8')).toContain('.xcompiler/*');
  });
});
