import { promises as fs } from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { GitRepositoryService } from '../infrastructure/git/git_repository_service.js';
import type { Workspace } from './workspace.js';

/**
 * What a generated project produces by running rather than by being written.
 *
 * Two rules follow from that, and both were learned from runs that stopped on them. A merge refuses
 * a working copy with tracked changes, so a product that rewrites its own output on every delivery
 * gate makes its next merge impossible — and the artifact then reaches the corrective flow as a
 * Change Request against a file nobody owns. Whatever appears here is excluded, and anything already
 * tracked is untracked on the next snapshot, which repairs a workspace that predates the entry.
 *
 * Entries are matched two ways and both must agree: written into the project's `.gitignore` and the
 * repository's own exclude file, and matched by `isRuntimeArtifactPath` when untracking. Keep the
 * shapes simple — a leading directory, a suffix, or a path segment — so one predicate can serve both.
 */
const RUNTIME_EXCLUDE_PATTERNS = [
  // XCompiler's own working state inside the project.
  '.xcw/',
  '.sandbox/',
  // What the product writes when it runs. `output/` is the conventional directory a generated CLI
  // is told to write to, and a log is never a deliverable.
  'output/',
  'dist/',
  'build/',
  '*.log',
  // TypeScript.
  'node_modules/',
  'coverage/',
  '*.tsbuildinfo',
  '.tsbuildinfo',
  // Python.
  '.pytest_cache/',
  '**/__pycache__/',
  '*.pyc',
  '.coverage',
  '.mypy_cache/',
  '.ruff_cache/',
  '*.egg-info/',
  '.venv/',
];

/** The project-visible ignore file, so the deliverable carries the same rules the runtime enforces. */
const PROJECT_GITIGNORE = '.gitignore';

/**
 * GitService 基于 simple-git 提供 XCompiler 运行时所需的最小集：init / snapshot / revert / log。
 * 所有操作都局限在 workspace.root 内，提交带 [xcompiler] 前缀便于审计。
 */
export class GitService {
  private readonly git: SimpleGit;
  private readonly repository: GitRepositoryService;

  constructor(private readonly ws: Workspace) {
    this.git = simpleGit({ baseDir: ws.root });
    this.repository = new GitRepositoryService(ws.root);
  }

  /** 若仓库不存在则 git init + 首次空提交。幂等。 */
  async ensureRepo(): Promise<void> {
    if (!await this.git.checkIsRepo().catch(() => false)) await this.git.init();
    // 配置最小 user 以便能 commit；仅在缺省时设置
    const local = await this.git.listConfig('local').catch(() => null);
    const has = (k: string) => !!local?.all?.[k];
    if (!has('user.email')) await this.git.addConfig('user.email', 'xcompiler@local');
    if (!has('user.name')) await this.git.addConfig('user.name', 'XCompiler');
    await this.ensureProjectGitignore();
    await this.ensureRuntimeExcludes();
    // The condition is an unborn HEAD, not a missing repository: the run path initializes the
    // repository through GitRepositoryService before this ever executes, so guarding on "is a
    // repository" skipped the initial commit and left every snapshot resolving HEAD against
    // nothing.
    if (await this.repository.hasCommits()) return;
    await this.prepareSnapshotIndex();
    // Project state lives in the container, not in the working copy, so there is no placeholder to
    // commit; an empty initial commit is the honest representation of an empty working copy.
    await this.git.commit('[xcompiler] init workspace', undefined, { '--allow-empty': null });
  }

  /** 在某个 Step 的某次重试前打快照；返回 commit sha。 */
  async snapshot(stepId: string, retry: number, message?: string): Promise<string> {
    await this.ensureRepo();
    await this.prepareSnapshotIndex();
    const tag = `[xcompiler] ${stepId}#${retry}${message ? ` ${message}` : ''}`;
    // 没有变化也产生一个空 commit，便于精准 revert；同时避免 status/diff 在损坏 HEAD tree 上失败。
    const r = await this.git.commit(tag, undefined, { '--allow-empty': null });
    return r.commit;
  }

  private async prepareSnapshotIndex(): Promise<void> {
    await this.ensureRuntimeExcludes();
    await this.untrackRuntimeArtifacts();
    await this.git.raw(['add', '-A', '--', '.']);
    await this.untrackRuntimeArtifacts();
  }

  /**
   * Writes the same rules into the project's own `.gitignore`.
   *
   * The repository exclude file is local and invisible: it keeps XCompiler's merges working while
   * leaving the delivered project without the one file every project has. Anyone who clones the
   * result, or any Step that inspects it, sees runtime output as source. Entries already present are
   * left alone, so a project that wrote its own ignore rules keeps them.
   */
  private async ensureProjectGitignore(): Promise<void> {
    const file = path.join(this.ws.root, PROJECT_GITIGNORE);
    const current = await fs.readFile(file, 'utf8').catch(() => '');
    const lines = current.split(/\r?\n/u);
    const missing = RUNTIME_EXCLUDE_PATTERNS.filter((pattern) => !lines.includes(pattern));
    if (missing.length === 0) return;
    const prefix = current === '' ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    await fs.appendFile(
      file,
      `${prefix}# Build output and runtime artifacts\n${missing.join('\n')}\n`,
      'utf8',
    );
  }

  private async ensureRuntimeExcludes(): Promise<void> {
    // `.git` is a file inside a linked worktree, so joining it against the working copy silently
    // resolves to nothing there and runtime artifacts would start being staged. `--git-path` returns
    // the right location whichever kind of worktree this is.
    const excludePath = await this.repository.gitPath('info/exclude').catch(() => undefined);
    if (!excludePath) return;
    let current = '';
    try {
      current = await fs.readFile(excludePath, 'utf8');
    } catch {
      await fs.mkdir(path.dirname(excludePath), { recursive: true }).catch(() => undefined);
      current = '';
    }
    const missing = RUNTIME_EXCLUDE_PATTERNS.filter((pattern) => !current.split(/\r?\n/u).includes(pattern));
    if (missing.length === 0) return;
    const prefix = current.endsWith('\n') ? '\n' : '\n\n';
    await fs.appendFile(
      excludePath,
      `${prefix}# XCompiler runtime artifacts\n${missing.join('\n')}\n`,
      'utf8',
    );
  }

  private async untrackRuntimeArtifacts(): Promise<void> {
    const tracked = await this.git.raw(['ls-files', '-z']).catch(() => '');
    const files = tracked.split('\0').filter((file) => isRuntimeArtifactPath(file));
    for (let i = 0; i < files.length; i += 100) {
      const chunk = files.slice(i, i + 100);
      await this.git.raw(['rm', '--cached', '-r', '--ignore-unmatch', '--', ...chunk]);
    }
  }

  /** 硬重置到指定 ref；用于 DEBUG 失败回滚。 */
  async revertTo(ref: string): Promise<void> {
    await this.git.reset(['--hard', ref]);
    // The baseline snapshot committed every project file that existed before the attempt. Any
    // remaining untracked, non-ignored path was therefore created by the failed attempt and must be
    // removed as part of the same rollback. Runtime state, sandboxes, dependency caches, and other
    // excluded paths remain untouched because `git clean` respects Git ignore/exclude rules here.
    await this.git.raw(['clean', '-fd']);
  }

  /** 返回最近 N 条 [xcompiler] 提交。 */
  async recentXCompilerCommits(n = 20): Promise<Array<{ sha: string; message: string; date: string }>> {
    const log = await this.git.log({ n });
    return log.all
      .filter((c) => c.message.startsWith('[xcompiler]'))
      .map((c) => ({ sha: c.hash, message: c.message, date: c.date }));
  }

  /** 暴露底层 git，仅供高级用法。 */
  raw(): SimpleGit {
    return this.git;
  }

  /** 返回相对 workspace 的路径，用于审计。 */
  rel(p: string): string {
    return path.relative(this.ws.root, path.resolve(this.ws.root, p));
  }
}

/**
 * Whether a tracked path is a runtime artifact, derived from the same list the ignore rules use.
 *
 * Deriving it rather than restating it is the point: the two drifted before, so a directory could be
 * ignored for new files while an already-tracked copy stayed in the index and kept blocking merges.
 */
export function isRuntimeArtifactPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  if (!normalized) return false;
  return RUNTIME_EXCLUDE_PATTERNS.some((pattern) => {
    if (pattern.endsWith('/')) {
      const segment = pattern.replace(/^\*\*\//u, '').slice(0, -1);
      return normalized.startsWith(`${segment}/`) || normalized.split('/').includes(segment);
    }
    if (pattern.startsWith('*')) return normalized.endsWith(pattern.slice(1));
    return normalized === pattern;
  });
}
