import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import {
  prepareBootstrapWorkspace,
  promoteBootstrapCandidate,
  qualifyBootstrapCandidate,
  renderBootstrapReport,
  type BootstrapResult,
} from '../src/runtime/bootstrap.js';

const cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function createRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-bootstrap-repo-'));
  cleanup.push(root);
  await fs.writeFile(path.join(root, 'README.md'), '# test\n');
  const git = simpleGit({ baseDir: root });
  await git.init();
  await git.addConfig('user.email', 'test@xcompiler.local');
  await git.addConfig('user.name', 'XCompiler Test');
  await git.add(['.']);
  await git.commit('initial');
  return root;
}

describe('self-bootstrap worktree', () => {
  it('creates an isolated candidate and promotes only by fast-forward', async () => {
    const repository = await createRepository();
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-bootstrap-candidate-'));
    await fs.rm(worktree, { recursive: true, force: true });
    cleanup.push(worktree);
    const prepared = await prepareBootstrapWorkspace(repository, worktree);

    expect(prepared.worktree).not.toBe(repository);
    expect(prepared.branch).toMatch(/^xcompiler\/bootstrap\//u);
    await fs.writeFile(path.join(worktree, 'candidate.txt'), 'N+1\n');
    const candidateGit = simpleGit({ baseDir: worktree });
    await candidateGit.add(['candidate.txt']);
    await candidateGit.commit('candidate');
    const candidateCommit = (await candidateGit.revparse(['HEAD'])).trim();

    await promoteBootstrapCandidate(prepared, candidateCommit);
    await expect(fs.readFile(path.join(repository, 'candidate.txt'), 'utf8')).resolves.toBe('N+1\n');
  }, 15_000);

  it('rejects promotion when the candidate branch moved after qualification', async () => {
    const repository = await createRepository();
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-bootstrap-candidate-'));
    await fs.rm(worktree, { recursive: true, force: true });
    cleanup.push(worktree);
    const prepared = await prepareBootstrapWorkspace(repository, worktree);
    const candidateGit = simpleGit({ baseDir: worktree });
    await fs.writeFile(path.join(worktree, 'candidate.txt'), 'qualified\n');
    await candidateGit.add(['candidate.txt']);
    await candidateGit.commit('qualified candidate');
    const qualifiedCommit = (await candidateGit.revparse(['HEAD'])).trim();

    await fs.writeFile(path.join(worktree, 'candidate.txt'), 'changed later\n');
    await candidateGit.add(['candidate.txt']);
    await candidateGit.commit('move candidate branch');

    await expect(promoteBootstrapCandidate(prepared, qualifiedCommit)).rejects.toThrow(/changed|漂移/u);
    await expect(fs.stat(path.join(repository, 'candidate.txt'))).rejects.toThrow();
  });

  it('rejects promotion from a dirty candidate worktree', async () => {
    const repository = await createRepository();
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-bootstrap-candidate-'));
    await fs.rm(worktree, { recursive: true, force: true });
    cleanup.push(worktree);
    const prepared = await prepareBootstrapWorkspace(repository, worktree);
    const candidateGit = simpleGit({ baseDir: worktree });
    const candidateCommit = (await candidateGit.revparse(['HEAD'])).trim();
    await fs.writeFile(path.join(worktree, 'uncommitted.txt'), 'dirty\n');

    await expect(promoteBootstrapCandidate(prepared, candidateCommit)).rejects.toThrow(/uncommitted|未提交/u);
  });

  it('rejects a dirty host checkout', async () => {
    const repository = await createRepository();
    await fs.writeFile(path.join(repository, 'dirty.txt'), 'pending\n');
    await expect(prepareBootstrapWorkspace(repository)).rejects.toThrow(/clean|干净/u);
  });
});

describe('bootstrap qualification', () => {
  it('runs every gate as required in the default subprocess sandbox', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-bootstrap-gates-'));
    cleanup.push(root);
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    await fs.writeFile(path.join(root, 'dist', 'cli.js'), 'console.log("ok")\n');
    await fs.writeFile(path.join(root, 'README.md'), '# package\n');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'bootstrap-fixture',
      version: '1.0.0',
      bin: { fixture: './dist/cli.js' },
      scripts: {
        'version:check': 'node -e "process.exit(0)"',
        typecheck: 'node -e "process.exit(process.env.XCOMPILER_BOOTSTRAP_TEST_SECRET ? 1 : 0)"',
        test: 'node -e "process.exit(0)"',
        build: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
      },
    }));

    process.env.XCOMPILER_BOOTSTRAP_TEST_SECRET = 'must-not-leak';
    let checks: Awaited<ReturnType<typeof qualifyBootstrapCandidate>>;
    try {
      checks = await qualifyBootstrapCandidate(root);
    } finally {
      delete process.env.XCOMPILER_BOOTSTRAP_TEST_SECRET;
    }
    expect(checks.filter((check) => check.required && !check.ok)).toEqual([]);
    expect(checks.find((check) => check.name === 'lint')).toMatchObject({ required: true, ok: true });
    expect(checks.map((check) => check.name)).toContain('package-dry-run');
    expect(checks.find((check) => check.name === 'bootstrap-smoke')).toMatchObject({ required: true, ok: true });
  });

  it('uses a network-disabled Docker sandbox only when explicitly requested', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-bootstrap-docker-gates-'));
    cleanup.push(root);
    const fakeDocker = path.join(root, 'fake-docker');
    await fs.writeFile(fakeDocker, [
      '#!/bin/sh',
      'echo "$@" >> "$0.calls"',
      'exit 0',
    ].join('\n'));
    await fs.chmod(fakeDocker, 0o755);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'docker-bootstrap-fixture',
      version: '1.0.0',
      bin: { fixture: './dist/cli.js' },
      scripts: {
        'version:check': 'exit 99',
        typecheck: 'exit 99',
        test: 'exit 99',
        build: 'exit 99',
        lint: 'exit 99',
      },
    }));
    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
      name: 'docker-bootstrap-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {},
    }));

    const checks = await qualifyBootstrapCandidate(root, { mode: 'docker', dockerBin: fakeDocker });
    expect(checks.every((check) => check.ok)).toBe(true);
    const calls = await fs.readFile(`${fakeDocker}.calls`, 'utf8');
    expect(calls).toContain('npm ci --ignore-scripts');
    expect(calls).toContain('--network none');
    expect(calls).toContain('--cap-drop=ALL');
    expect(calls).not.toContain('exit 99');
  }, 15_000);

  it('renders a reproducible report', () => {
    const result: BootstrapResult = {
      repository: '/repo', worktree: '/candidate', branch: 'xcompiler/bootstrap/x',
      baseCommit: 'abc', candidateCommit: 'def', runId: 'x', status: 'qualified',
      reportPath: '/repo/.xcompiler/bootstrap/reports/x.md', changedFiles: ['src/a.ts'], checks: [],
    };
    const report = renderBootstrapReport(result);
    expect(report).toContain('xcompiler/bootstrap/x');
    expect(report).toContain('src/a.ts');
    expect(report).toContain('def');
  });

  it('treats missing scripts and CLI entry as failed required gates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-bootstrap-gates-'));
    cleanup.push(root);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'incomplete-bootstrap-fixture',
      version: '1.0.0',
    }));

    const checks = await qualifyBootstrapCandidate(root);
    expect(checks.filter((check) => check.required && !check.ok).map((check) => check.name)).toEqual(
      expect.arrayContaining(['version:check', 'typecheck', 'test', 'build', 'lint', 'cli-smoke', 'bootstrap-smoke']),
    );
  });
});
