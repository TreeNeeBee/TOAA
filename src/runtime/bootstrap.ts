import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { runCompile, CompileExitError } from './build.js';
import { runExecute, type ExecuteResult } from './run.js';
import { SubprocessSandbox } from '../sandbox/subprocess.js';
import { DockerSandbox } from '../sandbox/docker.js';
import type { ExecResult } from '../sandbox/types.js';
import { Workspace } from '../workspace/workspace.js';
import { t } from '../i18n/index.js';
import { GitRepositoryService } from '../infrastructure/git/git_repository_service.js';
import { CONTAINER_WORKTREES_DIR } from '../workspace/project_container.js';
import { runtimeLog, silentRuntimeIO, type RuntimeIO } from './io.js';

export interface BootstrapOptions {
  repository?: string;
  configPath?: string;
  inputFile?: string;
  topicFile?: string;
  yes?: boolean;
  force?: boolean;
  promote?: boolean;
  cleanup?: boolean;
  worktree?: string;
  /** Opt into the experimental Docker qualification runner. */
  dockerQualification?: boolean;
  terminalOutput?: boolean;
  io?: RuntimeIO;
}

export interface BootstrapQualificationOptions {
  mode?: 'subprocess' | 'docker';
  dockerBin?: string;
  dockerImage?: string;
}

export interface BootstrapCheck {
  name: string;
  command: string;
  required: boolean;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  detail: string;
}

export interface BootstrapWorkspace {
  repository: string;
  /** Temporary XCompiler project container used by Build/Run. */
  container: string;
  /** Candidate checkout at `<container>/worktrees/master`. */
  worktree: string;
  branch: string;
  baseCommit: string;
  runId: string;
}

export interface BootstrapResult extends BootstrapWorkspace {
  status: 'cancelled' | 'compile-failed' | 'execution-failed' | 'qualification-failed' | 'qualified' | 'promoted';
  candidateCommit?: string;
  reportPath: string;
  checks: BootstrapCheck[];
  changedFiles: string[];
}

/**
 * Generation-based self-bootstrap: the loaded XCompiler process (N) edits a linked worktree
 * containing candidate N+1. The host checkout is never used as the execution workspace.
 */
export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const prepared = await prepareBootstrapWorkspace(opts.repository, opts.worktree);
  const io = opts.io ?? silentRuntimeIO;
  await runtimeLog(io, 'success', t().bootstrap.worktreeReady(prepared.worktree, prepared.branch));

  const configPath = await resolveBootstrapConfig(prepared.repository, opts.configPath);
  const inputFile = opts.inputFile ? path.resolve(opts.inputFile) : undefined;
  const topicFile = opts.topicFile ? path.resolve(opts.topicFile) : undefined;

  await runtimeLog(io, 'accent', t().bootstrap.compileStarted);
  let compiled;
  try {
    compiled = await runCompile({
      workspace: prepared.container,
      configPath,
      inputFile,
      topicFile,
      intent: 'self',
      yes: !!opts.yes && (!!inputFile || !!topicFile),
      force: !!opts.force,
      io,
    });
  } catch (error) {
    const code = error instanceof CompileExitError ? error.exitCode : 1;
    const message = error instanceof Error ? error.message : String(error);
    await runtimeLog(io, 'error', t().bootstrap.compileFailed(code, message));
    return finishBootstrap(prepared, 'compile-failed', [], [], opts);
  }

  if (!compiled.planPath) {
    await runtimeLog(io, 'warning', t().bootstrap.compileCancelled);
    return finishBootstrap(prepared, 'cancelled', [], [], opts);
  }

  await runtimeLog(io, 'accent', t().bootstrap.executeStarted);
  let execution: ExecuteResult;
  try {
    execution = await runExecute({
      planPath: compiled.planPath,
      workspace: prepared.container,
      configPath,
      force: !!opts.force,
      terminalOutput: opts.terminalOutput ?? io.terminalOutput ?? false,
      io,
    });
  } catch (error) {
    execution = {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (execution.status !== 'ok') {
    await runtimeLog(io, 'error', t().bootstrap.executeFailed(execution.status));
    return finishBootstrap(prepared, 'execution-failed', [], [], opts);
  }

  const candidateGit = simpleGit({ baseDir: prepared.worktree });
  const candidateCommit = (await candidateGit.revparse(['HEAD'])).trim();
  const initialCandidateStatus = await candidateGit.status();
  await runtimeLog(io, 'accent', t().bootstrap.qualificationStarted);
  if (opts.dockerQualification) {
    await runtimeLog(io, 'warning', t().bootstrap.qualificationDockerExperimental);
  }
  let checks: BootstrapCheck[];
  if (!initialCandidateStatus.isClean()) {
    checks = [{
      name: 'candidate-integrity',
      command: 'git status --porcelain',
      required: true,
      ok: false,
      exitCode: -1,
      durationMs: 0,
      detail: t().bootstrap.candidateDirty(candidateStatusPaths(initialCandidateStatus)),
    }];
  } else {
    try {
      checks = await qualifyBootstrapCandidate(prepared.worktree, {
        mode: opts.dockerQualification ? 'docker' : 'subprocess',
      });
    } catch (error) {
      checks = [{
        name: 'qualification',
        command: 'bootstrap qualification',
        required: true,
        ok: false,
        exitCode: -1,
        durationMs: 0,
        detail: error instanceof Error ? error.message : String(error),
      }];
    }

    const candidateCommitAfter = (await candidateGit.revparse(['HEAD'])).trim();
    const candidateStatusAfter = await candidateGit.status();
    const integrityOk = candidateCommitAfter === candidateCommit && candidateStatusAfter.isClean();
    checks.push({
      name: 'candidate-integrity',
      command: 'git status --porcelain && git rev-parse HEAD',
      required: true,
      ok: integrityOk,
      exitCode: integrityOk ? 0 : -1,
      durationMs: 0,
      detail: candidateCommitAfter !== candidateCommit
        ? t().bootstrap.candidateMoved(candidateCommit, candidateCommitAfter)
        : candidateStatusAfter.isClean()
          ? ''
          : t().bootstrap.candidateDirty(candidateStatusPaths(candidateStatusAfter)),
    });
  }
  for (const check of checks) {
    const message = check.ok
      ? t().bootstrap.checkPassed(check.name, check.durationMs)
      : t().bootstrap.checkFailed(check.name, check.exitCode);
    await runtimeLog(io, check.ok ? 'success' : check.required ? 'error' : 'warning', message);
  }

  const changedFiles = (await candidateGit.raw(['diff', '--name-only', prepared.baseCommit, candidateCommit]))
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
  const qualified = checks.every((check) => !check.required || check.ok);
  if (!qualified) {
    await runtimeLog(io, 'error', t().bootstrap.promotionBlocked);
    return finishBootstrap(
      { ...prepared, candidateCommit },
      'qualification-failed',
      checks,
      changedFiles,
      opts,
    );
  }

  let status: BootstrapResult['status'] = 'qualified';
  if (opts.promote) {
    await promoteBootstrapCandidate(prepared, candidateCommit);
    status = 'promoted';
    await runtimeLog(io, 'success', t().bootstrap.promoted(prepared.branch));
  } else {
    await runtimeLog(io, 'success', t().bootstrap.candidateReady(prepared.branch));
  }
  return finishBootstrap(
    { ...prepared, candidateCommit },
    status,
    checks,
    changedFiles,
    opts,
  );
}

export async function prepareBootstrapWorkspace(
  repository: string = process.cwd(),
  requestedWorktree?: string,
): Promise<BootstrapWorkspace> {
  const requested = path.resolve(repository);
  const requestedService = new GitRepositoryService(requested);
  if (!(await requestedService.isRepository())) {
    throw new Error(t().bootstrap.notGitRepository(requested));
  }
  const root = await requestedService.root();
  const service = new GitRepositoryService(root);
  if (!await service.isClean()) {
    const status = await service.raw().status();
    throw new Error(t().bootstrap.dirtyRepository(status.files.map((file) => file.path).join(', ')));
  }

  const runId = createRunId();
  const branch = `xcompiler/bootstrap/${runId}`;
  const baseCommit = await service.head();
  const container = requestedWorktree
    ? path.resolve(requestedWorktree)
    : path.join(root, '.xcompiler', 'bootstrap', 'containers', runId);
  const worktree = path.join(container, CONTAINER_WORKTREES_DIR, 'master');
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  await service.addWorktree({ path: worktree, branch, startPoint: baseCommit });
  return { repository: root, container, worktree, branch, baseCommit, runId };
}

export async function qualifyBootstrapCandidate(
  worktree: string,
  options: BootstrapQualificationOptions = {},
): Promise<BootstrapCheck[]> {
  const pkg = JSON.parse(await fs.readFile(path.join(worktree, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
    bin?: string | Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  const specs: Array<{ name: string; cmd: string; argv: string[]; required: boolean }> = [];
  const checks: BootstrapCheck[] = [];
  for (const script of ['version:check', 'typecheck', 'test', 'build', 'lint'] as const) {
    if (scripts[script]) {
      specs.push({ name: script, cmd: 'npm', argv: ['run', '--silent', script], required: true });
    } else {
      checks.push({
        name: script,
        command: `npm run --silent ${script}`,
        required: true,
        ok: false,
        exitCode: -1,
        durationMs: 0,
        detail: t().bootstrap.missingScript(script),
      });
    }
  }
  const binEntry = firstBinEntry(pkg.bin);
  if (binEntry) {
    specs.push({ name: 'cli-smoke', cmd: 'node', argv: [binEntry, '--help'], required: true });
    specs.push({ name: 'bootstrap-smoke', cmd: 'node', argv: [binEntry, 'bootstrap', '--help'], required: true });
  } else {
    checks.push({
      name: 'cli-smoke',
      command: 'node <package.json.bin> --help',
      required: true,
      ok: false,
      exitCode: -1,
      durationMs: 0,
      detail: t().bootstrap.missingBin,
    });
    checks.push({
      name: 'bootstrap-smoke',
      command: 'node <package.json.bin> bootstrap --help',
      required: true,
      ok: false,
      exitCode: -1,
      durationMs: 0,
      detail: t().bootstrap.missingBin,
    });
  }
  specs.push({
    name: 'package-dry-run',
    cmd: 'npm',
    argv: ['pack', '--dry-run', '--json', '--ignore-scripts'],
    required: true,
  });

  const execute = await createQualificationExecutor(worktree, options);
  for (const spec of specs) {
    const result = await execute(spec.cmd, spec.argv);
    checks.push({
      name: spec.name,
      command: [spec.cmd, ...spec.argv].join(' '),
      required: spec.required,
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      durationMs: result.durationMs ?? 0,
      detail: tail(result.stderr || result.stdout),
    });
  }
  return checks;
}

async function createQualificationExecutor(
  worktree: string,
  options: BootstrapQualificationOptions,
): Promise<(cmd: string, argv: string[]) => Promise<ExecResult>> {
  const mode = options.mode ?? 'subprocess';
  const environment = {
    CI: '1',
    NO_COLOR: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };

  const workspace = new Workspace(worktree);
  if (mode === 'subprocess') {
    const sandbox = new SubprocessSandbox({
      ws: workspace,
      language: 'typescript',
      environmentRoot: path.join(worktree, '.sandbox', 'bootstrap-qualification'),
      inheritEnv: false,
      limits: {
        cpu: 2,
        memory_mb: 2048,
        wall_seconds: 180,
        network: 'off',
        expose_ports: [],
      },
    });
    await sandbox.build('package.json');
    return (cmd, argv) => sandbox.exec(cmd, argv, {
      timeoutMs: 180_000,
      env: environment,
    });
  }

  const sandbox = new DockerSandbox({
    ws: workspace,
    language: 'typescript',
    environmentRoot: path.join(worktree, '.sandbox', 'bootstrap-qualification'),
    image: options.dockerImage ?? 'node:24-slim',
    dockerBin: options.dockerBin,
    limits: {
      cpu: 2,
      memory_mb: 2048,
      wall_seconds: 180,
      network: 'off',
      expose_ports: [],
    },
    extraRunArgs: ['--cap-drop=ALL', '--security-opt=no-new-privileges'],
  });
  await sandbox.build('package.json');
  return (cmd, argv) => sandbox.exec(cmd, argv, {
    timeoutMs: 180_000,
    env: {
      ...environment,
      NPM_CONFIG_CACHE: '/workspace/.sandbox/bootstrap-qualification/npm-cache',
    },
  });
}

export async function promoteBootstrapCandidate(
  prepared: BootstrapWorkspace,
  expectedCandidateCommit: string,
): Promise<void> {
  const git = simpleGit({ baseDir: prepared.repository });
  const candidateGit = simpleGit({ baseDir: prepared.worktree });
  const candidateHead = (await candidateGit.revparse(['HEAD'])).trim();
  const branchHead = (await git.revparse([prepared.branch])).trim();
  const candidateStatus = await candidateGit.status();
  if (!candidateStatus.isClean()) {
    throw new Error(t().bootstrap.candidateDirty(candidateStatusPaths(candidateStatus)));
  }
  if (candidateHead !== expectedCandidateCommit || branchHead !== expectedCandidateCommit) {
    throw new Error(
      t().bootstrap.candidateMoved(
        expectedCandidateCommit,
        candidateHead === branchHead ? candidateHead : `${candidateHead} / ${branchHead}`,
      ),
    );
  }
  const basedOnBase = await git.raw([
    'merge-base',
    '--is-ancestor',
    prepared.baseCommit,
    expectedCandidateCommit,
  ]).then(() => true).catch(() => false);
  if (!basedOnBase) {
    throw new Error(t().bootstrap.candidateNotBasedOnBase(expectedCandidateCommit, prepared.baseCommit));
  }
  const currentHead = (await git.revparse(['HEAD'])).trim();
  const status = await git.status();
  if (currentHead !== prepared.baseCommit || !status.isClean()) {
    throw new Error(
      t().bootstrap.dirtyRepository(
        status.files.map((file) => file.path).join(', ') || t().bootstrap.hostHeadChanged,
      ),
    );
  }
  await git.raw(['merge', '--ff-only', expectedCandidateCommit]);
  const promotedHead = (await git.revparse(['HEAD'])).trim();
  if (promotedHead !== expectedCandidateCommit) {
    throw new Error(t().bootstrap.promotionVerificationFailed(expectedCandidateCommit, promotedHead));
  }
}

async function finishBootstrap(
  prepared: BootstrapWorkspace & { candidateCommit?: string },
  status: BootstrapResult['status'],
  checks: BootstrapCheck[],
  changedFiles: string[],
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  const io = opts.io ?? silentRuntimeIO;
  const reportDir = path.join(prepared.repository, '.xcompiler', 'bootstrap', 'reports');
  const reportPath = path.join(reportDir, `${prepared.runId}.md`);
  const candidateGit = simpleGit({ baseDir: prepared.worktree });
  const candidateCommit = prepared.candidateCommit ?? (await candidateGit.revparse(['HEAD'])).trim();
  if (changedFiles.length === 0 && candidateCommit !== prepared.baseCommit) {
    changedFiles = (await candidateGit.raw(['diff', '--name-only', prepared.baseCommit, candidateCommit]))
      .split('\n')
      .map((file) => file.trim())
      .filter(Boolean);
  }
  const result: BootstrapResult = {
    ...prepared,
    candidateCommit,
    status,
    reportPath,
    checks,
    changedFiles,
  };
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, renderBootstrapReport(result), 'utf8');
  await runtimeLog(io, 'success', t().bootstrap.reportWritten(reportPath));
  if (opts.cleanup) {
    await simpleGit({ baseDir: prepared.repository }).raw(['worktree', 'remove', '--force', prepared.worktree]);
    await runtimeLog(io, 'success', t().bootstrap.cleanupDone(prepared.worktree));
  }
  return result;
}

export function renderBootstrapReport(result: BootstrapResult): string {
  const M = t().bootstrap;
  const L = M.reportLabels;
  const checkLines = result.checks.length > 0
    ? result.checks.map((check) =>
        `- ${check.ok ? 'PASS' : check.required ? 'FAIL' : 'WARN'} \`${check.command}\` (${check.durationMs}ms)` +
        (check.detail && !check.ok ? `\n  - ${check.detail.replace(/\n/g, '\n    ')}` : ''),
      )
    : [`- ${M.reportNone}`];
  const fileLines = result.changedFiles.length > 0
    ? result.changedFiles.map((file) => `- \`${file}\``)
    : [`- ${M.reportNone}`];
  const nextStep = result.status === 'qualified'
    ? M.reportNextQualified(result.repository, result.candidateCommit ?? '')
    : result.status === 'promoted'
      ? M.reportNextPromoted
      : M.reportNextFailed;
  return [
    `# ${M.reportTitle}`,
    '',
    `- ${L.status}: ${result.status}`,
    `- ${L.repository}: \`${result.repository}\``,
    `- ${L.baseCommit}: \`${result.baseCommit}\``,
    `- ${L.candidateCommit}: \`${result.candidateCommit ?? ''}\``,
    `- ${L.branch}: \`${result.branch}\``,
    `- Container: \`${result.container}\``,
    `- ${L.worktree}: \`${result.worktree}\``,
    `- ${L.createdAt}: ${new Date().toISOString()}`,
    '',
    `## ${L.checks}`,
    '',
    ...checkLines,
    '',
    `## ${L.changedFiles}`,
    '',
    ...fileLines,
    '',
    `## ${L.nextStep}`,
    '',
    `\`${nextStep}\``,
    '',
  ].join('\n');
}

function firstBinEntry(bin: string | Record<string, string> | undefined): string | undefined {
  if (typeof bin === 'string' && bin.trim()) return bin;
  if (bin && typeof bin === 'object') return Object.values(bin).find((value) => value.trim());
  return undefined;
}

async function resolveBootstrapConfig(repository: string, explicit?: string): Promise<string | undefined> {
  if (explicit) return path.resolve(explicit);
  for (const file of ['config.yaml', 'config.example.yaml']) {
    const candidate = path.join(repository, file);
    if (await fs.stat(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return undefined;
}

function createRunId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomBytes(3).toString('hex')}`;
}

function tail(value: string, lines: number = 30): string {
  return value.trim().split('\n').slice(-lines).join('\n');
}

function candidateStatusPaths(status: Awaited<ReturnType<ReturnType<typeof simpleGit>['status']>>): string {
  return status.files.map((file) => file.path).join(', ') || t().bootstrap.candidateStatusUnknown;
}
