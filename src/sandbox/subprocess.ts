import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { Workspace } from '../workspace/workspace.js';
import type { AuditLogger } from '../audit/audit.js';
import { t } from '../i18n/index.js';
import type { Language } from '../core/plan.js';
import type {
  Sandbox,
  SandboxBuildOptions,
  SandboxLimits,
  ExecResult,
  ExecExtra,
  ExecProgressWatch,
} from './types.js';
import { normalizeTypeScriptTestArgs } from './test_args.js';
import { resolveTypeScriptProgramCommand, stripPythonInterpreterPrefix } from './program_args.js';

export type { SandboxLimits, ExecResult } from './types.js';

const INSTALL_IDLE_TIMEOUT_FLOOR_MS = 15 * 60_000;
const INSTALL_IDLE_TIMEOUT_MULTIPLIER = 10;
const INSTALL_PROGRESS_CHECK_INTERVAL_MS = 15_000;

interface ExecRawOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  progressWatch?: ExecProgressWatch;
}

export interface SubprocessSandboxOptions {
  ws: Workspace;
  limits: SandboxLimits;
  audit?: AuditLogger;
  /** 目标语言，决定运行时（venv/pip/pytest vs node_modules/npm/vitest）。默认 python。 */
  language?: Language;
  /**
   * 环境根目录（宿主绝对路径）。位于容器状态目录下，不在工作副本内，
   * 因此增删 worktree 不会破坏已准备好的环境。
   */
  environmentRoot: string;
  /** Shared package download cache; falls back to the environment's own when absent. */
  downloadCacheRoot?: string;
  /** Python 解释器。默认从 PATH 找 python3 / python。 */
  pythonBin?: string;
  /** Package registry for dependency resolution; unset leaves the tool's own default. */
  registry?: string;
  /** 是否继承宿主进程环境。默认 false；显式启用会把宿主凭据暴露给项目代码。 */
  inheritEnv?: boolean;
}

/**
 * SubprocessSandbox：
 *  - 在 <environmentRoot>/venv 内创建 Python 虚拟环境（环境根在容器状态目录下）
 *  - `requirements.txt` 哈希作为缓存键，未变更跳过 pip install
 *  - exec(): 强制 wall-clock 超时（subprocess 模式下 cpu/memory 仅做软限制）
 *
 * 注意：subprocess 模式不做强网络隔离；`network` 配置在该模式下仅作记录。
 * 真正的网络/资源隔离由 M4 的 DockerSandbox 提供。
 */
export class SubprocessSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  private readonly language: Language;
  private readonly sandboxAbs: string;
  private readonly downloadCacheAbs: string;
  private readonly venvAbs: string;
  private readonly cacheFile: string;
  private pyBin: string | null = null;
  private tmpDirEnv: string | undefined;

  constructor(private readonly opts: SubprocessSandboxOptions) {
    this.language = opts.language ?? 'python';
    this.sandboxAbs = opts.environmentRoot;
    this.downloadCacheAbs = opts.downloadCacheRoot ?? opts.environmentRoot;
    // 环境根路径本身已经标识了归属（project/phase/role），因此 venv 目录名固定；
    // 若沿用 workspace basename，每个 worktree 都会得到不同的 venv 名而无法共享。
    this.venvAbs = path.join(this.sandboxAbs, 'venv');
    this.cacheFile = path.join(
      this.sandboxAbs,
      this.language === 'typescript' ? 'package.sha256' : 'requirements.sha256',
    );
  }

  get root(): string {
    return this.sandboxAbs;
  }

  get pythonInVenv(): string {
    return path.join(this.venvAbs, 'bin', 'python');
  }

  get pipInVenv(): string {
    return path.join(this.venvAbs, 'bin', 'pip');
  }

  /** 解析当前可用的 system python。未找到则抛错。 */
  async resolvePython(): Promise<string> {
    if (this.pyBin) return this.pyBin;
    if (this.opts.pythonBin) {
      this.pyBin = this.opts.pythonBin;
      return this.pyBin;
    }
    for (const cand of ['python3', 'python']) {
      try {
        const r = await execRaw(cand, ['--version'], { timeoutMs: 3000 });
        if (r.exitCode === 0) {
          this.pyBin = cand;
          return cand;
        }
      } catch {
        /* try next */
      }
    }
    throw new Error('no python interpreter found in PATH (need python3 or python)');
  }

  /**
   * 构建/复用沙盒。manifestFile 为依赖清单在 workspace 内的相对路径；不存在则跳过安装。
   * Python → requirements.txt (venv + pip)；TypeScript → package.json (npm install)。
   */
  async build(
    manifestFile?: string,
    options?: SandboxBuildOptions,
  ): Promise<{ rebuilt: boolean; reason: string }> {
    await fs.mkdir(this.sandboxAbs, { recursive: true });
    if (this.opts.inheritEnv !== true) {
      await Promise.all([
        fs.mkdir(path.join(this.sandboxAbs, 'home'), { recursive: true }),
        fs.mkdir(path.join(this.sandboxAbs, 'tmp'), { recursive: true }),
        fs.mkdir(path.join(this.downloadCacheAbs, 'npm-cache'), { recursive: true }),
        fs.mkdir(path.join(this.downloadCacheAbs, 'pip-cache'), { recursive: true }),
      ]);
      await this.linkShortTmp();
    }
    if (this.language === 'typescript') {
      return this.buildNode(manifestFile ?? 'package.json', options);
    }
    return this.buildPython(manifestFile ?? 'requirements.txt');
  }

  private async buildPython(requirementsTxt: string): Promise<{ rebuilt: boolean; reason: string }> {
    const reqAbs = this.opts.ws.abs(requirementsTxt);
    const reqContent = await fs.readFile(reqAbs, 'utf8').catch(() => '');
    const sig = crypto.createHash('sha256').update(reqContent).digest('hex');
    const cached = await fs.readFile(this.cacheFile, 'utf8').catch(() => '');
    const venvExists = await fs
      .stat(this.pythonInVenv)
      .then(() => true)
      .catch(() => false);

    if (venvExists && cached === sig) {
      return { rebuilt: false, reason: 'cache hit' };
    }

    const py = await this.resolvePython();
    if (!venvExists) {
      // 优先尝试带 pip 的 venv；某些发行版（如 Debian/Ubuntu 默认 python3 不含 ensurepip）
      // 会失败，再退回 --without-pip + 手动 ensurepip。
      const r = await execRaw(py, ['-m', 'venv', this.venvAbs], { timeoutMs: 60_000 });
      if (r.exitCode !== 0) {
        const r2 = await execRaw(py, ['-m', 'venv', '--without-pip', this.venvAbs], { timeoutMs: 60_000 });
        if (r2.exitCode !== 0) {
          throw new Error(`venv creation failed: ${r.stderr || r.stdout}\n\n--without-pip retry: ${r2.stderr || r2.stdout}`);
        }
      }
    }
    // 确保 venv 内有可用 pip：bin/pip 文件可能根本不存在（python3-venv 缺包 / --without-pip）。
    // 统一通过 python -m pip 调用，并在缺失时自动 ensurepip。
    const pyVenv = this.pythonInVenv;
    const pyVenvExists = await fs.stat(pyVenv).then(() => true).catch(() => false);
    if (!pyVenvExists) {
      throw new Error(`venv python missing after creation: ${pyVenv} (install system package python3-venv / python3-virtualenv)`);
    }
    const pipCheck = await execRaw(pyVenv, ['-m', 'pip', '--version'], { timeoutMs: 30_000 });
    if (pipCheck.exitCode !== 0) {
      const ep = await execRaw(pyVenv, ['-m', 'ensurepip', '--upgrade', '--default-pip'], { timeoutMs: 60_000 });
      if (ep.exitCode !== 0) {
        throw new Error(
          `venv pip unavailable and ensurepip failed (venv=${this.venvAbs}):\n${ep.stderr || ep.stdout}\n\n` +
            'Install on the host: apt-get install python3-venv python3-pip   or   yum install python3-pip',
        );
      }
    }
    if (reqContent.trim().length > 0) {
      const progressWatch = createInstallProgressWatch(
        [this.venvAbs, path.join(this.downloadCacheAbs, 'pip-cache')],
        this.opts.limits,
        'pip install',
      );
      await this.opts.audit?.event('sandbox.exec', t().sandboxLog.command('subprocess', `pip install -r ${reqAbs}`), {
        messageId: 'sandbox.command',
        cwd: this.opts.ws.root,
        progressIdleTimeoutMs: progressWatch.idleTimeoutMs,
        progressPaths: progressWatch.paths,
      });
      const r = await execRaw(pyVenv, ['-m', 'pip', 'install', '-r', reqAbs, '--quiet', '--disable-pip-version-check'], {
        env: this.baseEnvironment(),
        progressWatch,
      });
      if (r.exitCode !== 0) {
        throw new Error(formatExecFailure(`pip install failed (venv=${this.venvAbs}, requirements=${reqAbs})`, r));
      }
    }
    await fs.writeFile(this.cacheFile, sig, 'utf8');
    await this.opts.audit?.event('sandbox.exec', t().sandboxLog.subprocessBuilt(!!reqContent), {
      messageId: 'sandbox.subprocess_built',
    });
    return { rebuilt: true, reason: venvExists ? 'requirements changed' : 'venv created' };
  }

  private async buildNode(
    manifestFile: string,
    options?: SandboxBuildOptions,
  ): Promise<{ rebuilt: boolean; reason: string }> {
    const pkgAbs = this.opts.ws.abs(manifestFile);
    const pkgContent = await fs.readFile(pkgAbs, 'utf8').catch(() => '');
    if (!pkgContent) {
      // package.json 尚未生成（HIGH_LEVEL_DESIGN 之前）→ 跳过 npm install。
      return { rebuilt: false, reason: 'no package.json yet' };
    }
    const lockAbs = this.opts.ws.abs('package-lock.json');
    const lockContent = await fs.readFile(lockAbs, 'utf8').catch(() => '');
    const sig = nodeDependencySignature(pkgContent, lockContent);
    const cached = await fs.readFile(this.cacheFile, 'utf8').catch(() => '');
    const modulesExist = await fs
      .stat(this.opts.ws.abs('node_modules'))
      .then(() => true)
      .catch(() => false);
    if (modulesExist && cached === sig) {
      return { rebuilt: false, reason: 'cache hit' };
    }
    const installArgs = lockContent.trim() && !options?.refreshLockfile
      ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
    const progressWatch = createInstallProgressWatch(
      [this.opts.ws.abs('node_modules'), path.join(this.downloadCacheAbs, 'npm-cache')],
      this.opts.limits,
      'npm install',
    );
    await this.opts.audit?.event('sandbox.exec', t().sandboxLog.command('subprocess', `npm ${installArgs.join(' ')}`), {
      messageId: 'sandbox.command',
      cwd: this.opts.ws.root,
      progressIdleTimeoutMs: progressWatch.idleTimeoutMs,
      progressPaths: progressWatch.paths,
    });
    let r = await execRaw('npm', installArgs, {
      cwd: this.opts.ws.root,
      env: this.baseEnvironment(),
      progressWatch,
    });
    // `npm ci` refuses when the manifest and the lockfile disagree, and says to run `npm install`.
    // They disagree routinely here: HIGH_LEVEL_DESIGN authors package.json by writing the file, and
    // no lockfile comes with it. Making each caller remember to ask for a refresh puts one decision
    // in three places — and all three of them were failing silently, so no environment was ever
    // updated after the manifest changed.
    const refreshArgs = installRetryArgs(installArgs, r);
    if (refreshArgs) {
      await this.opts.audit?.event(
        'sandbox.exec',
        t().sandboxLog.command('subprocess', `npm ${refreshArgs.join(' ')}`),
        {
          messageId: 'sandbox.command',
          cwd: this.opts.ws.root,
          reason: 'lockfile out of sync with the manifest',
        },
      );
      r = await execRaw('npm', refreshArgs, {
        cwd: this.opts.ws.root,
        env: this.baseEnvironment(),
        progressWatch,
      });
    }
    if (r.exitCode !== 0) {
      throw new Error(formatExecFailure(`npm dependency install failed (cwd=${this.opts.ws.root})`, r));
    }
    if (options?.refreshLockfile) {
      const validationArgs = ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'];
      await this.opts.audit?.event(
        'sandbox.exec',
        t().sandboxLog.command('subprocess', `npm ${validationArgs.join(' ')}`),
        { messageId: 'sandbox.command', cwd: this.opts.ws.root },
      );
      const validation = await execRaw('npm', validationArgs, {
        cwd: this.opts.ws.root,
        env: this.baseEnvironment(),
      });
      if (validation.exitCode !== 0) {
        throw new Error(formatExecFailure(
          `npm lockfile validation failed after dependency update (cwd=${this.opts.ws.root})`,
          validation,
        ));
      }
    }
    const finalLockContent = await fs.readFile(lockAbs, 'utf8').catch(() => '');
    const finalSignature = nodeDependencySignature(pkgContent, finalLockContent);
    await fs.writeFile(this.cacheFile, finalSignature, 'utf8');
    await this.opts.audit?.event('sandbox.exec', t().sandboxLog.subprocessNodeBuilt, {
      messageId: 'sandbox.subprocess_node_built',
    });
    return { rebuilt: true, reason: modulesExist ? 'package.json changed' : 'node_modules created' };
  }

  /** 执行任意命令（默认 cwd = workspace.root）。 */
  async exec(
    cmd: string,
    argv: string[],
    extra?: ExecExtra,
  ): Promise<ExecResult> {
    const cwd = extra?.cwd ?? this.opts.ws.root;
    const timeoutMs = extra?.timeoutMs ?? this.opts.limits.wall_seconds * 1000;
    const baseEnv = this.baseEnvironment();
    const env =
      this.language === 'typescript'
        ? {
            ...baseEnv,
            PATH: `${this.opts.ws.abs('node_modules/.bin')}:${baseEnv.PATH ?? ''}`,
            ...(extra?.env ?? {}),
          }
        : {
            ...baseEnv,
            PATH: `${path.join(this.venvAbs, 'bin')}:${baseEnv.PATH ?? ''}`,
            VIRTUAL_ENV: this.venvAbs,
            ...(extra?.env ?? {}),
          };
    await this.opts.audit?.event('sandbox.exec', t().sandboxLog.command('subprocess', `${cmd} ${argv.join(' ')}`), {
      messageId: 'sandbox.command',
      cwd,
      timeoutMs,
      progressIdleTimeoutMs: extra?.progressWatch?.idleTimeoutMs,
      progressPaths: extra?.progressWatch?.paths,
    });
    const r = await execRaw(cmd, argv, { cwd, env, timeoutMs, progressWatch: extra?.progressWatch });
    return r;
  }

  /**
   * The registry the host resolves packages from, and nothing else from its npm configuration.
   *
   * `HOME` is redirected to an empty sandbox directory so host credentials never reach a generated
   * project. That also discards `~/.npmrc`, and with it the registry endpoint: npm then falls back
   * to the public default, which a network using a mirror does not reach — measured at 181ms with
   * the host configuration and still running after five minutes without it.
   *
   * Configured rather than inherited: which registry a generated project resolves from is a project
   * decision, and an endpoint picked up silently from the host is one nobody chose. Unset leaves the
   * tool's own default in place.
   */
  /**
   * Points `TMPDIR` at a short path that leads back into the sandbox's own tmp directory.
   *
   * A Unix domain socket path is capped at 104 bytes, and the sandbox tree alone is longer than
   * that: `npx tsx` binds `$TMPDIR/tsx-<uid>/<pid>.pipe`, which came to 142 bytes and failed with
   * `listen EINVAL` before the generated product ever started. The link keeps every temporary file
   * inside the sandbox, so isolation and cleanup are unchanged — only the string handed to bind(2)
   * gets shorter. If the link cannot be made, the long path still works for everything that does
   * not open a socket, so this degrades rather than fails the build.
   */
  private async linkShortTmp(): Promise<void> {
    const target = path.join(this.sandboxAbs, 'tmp');
    const root = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const key = crypto.createHash('sha1').update(this.sandboxAbs).digest('hex').slice(0, 12);
    const link = path.join(root, `xc-tmp-${key}`);
    try {
      const existing = await fs.readlink(link).catch(() => undefined);
      if (existing === target) {
        this.tmpDirEnv = link;
        return;
      }
      if (existing !== undefined) await fs.unlink(link);
      await fs.symlink(target, link, 'dir');
      this.tmpDirEnv = link;
    } catch {
      this.tmpDirEnv = undefined;
    }
  }

  private baseEnvironment(): NodeJS.ProcessEnv {
    if (this.opts.inheritEnv === true) return { ...process.env };
    return {
      PATH: process.env.PATH ?? '',
      HOME: path.join(this.sandboxAbs, 'home'),
      TMPDIR: this.tmpDirEnv ?? path.join(this.sandboxAbs, 'tmp'),
      CI: '1',
      NO_COLOR: '1',
      NPM_CONFIG_CACHE: path.join(this.downloadCacheAbs, 'npm-cache'),
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      ...(this.opts.registry ? { NPM_CONFIG_REGISTRY: this.opts.registry } : {}),
      // Measured against a weak network: a cold install of one test runner took ten minutes, and
      // npm abandoned it at `ETIMEDOUT` on a socket read well before that. Its defaults assume a
      // fast link. Retrying longer costs nothing when the link is fast, and is the difference
      // between a project that builds and one that never gets past its first dependency.
      NPM_CONFIG_FETCH_RETRIES: '5',
      NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: '20000',
      NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: '120000',
      NPM_CONFIG_FETCH_TIMEOUT: '600000',
    };
  }

  /** 运行工程入口程序。Python → venv python；TypeScript → npx tsx。 */
  async runProgram(args: string[], extra?: ExecExtra): Promise<ExecResult> {
    if (this.language === 'typescript') {
      const command = resolveTypeScriptProgramCommand(args);
      return this.exec(command.cmd, command.argv, extra);
    }
    return this.exec(this.pythonInVenv, stripPythonInterpreterPrefix(args), extra);
  }

  /** 运行测试。Python → pytest；TypeScript → npm test（Vitest）。 */
  async runTests(args: string[] = [], extra?: ExecExtra): Promise<ExecResult> {
    if (this.language === 'typescript') {
      const normalizedArgs = normalizeTypeScriptTestArgs(args);
      const argv = normalizedArgs.length > 0 ? ['test', '--silent', '--', ...normalizedArgs] : ['test', '--silent'];
      return this.exec('npm', argv, extra);
    }
    return this.exec(this.pythonInVenv, ['-m', 'pytest', ...args], extra);
  }

  /** 安装额外依赖（不会写入依赖清单，需要由调用方自行回写）。 */
  async installDeps(packages: string[]): Promise<ExecResult> {
    const progressWatch = createInstallProgressWatch(
      [
        this.language === 'typescript' ? this.opts.ws.abs('node_modules') : this.venvAbs,
        path.join(this.downloadCacheAbs, this.language === 'typescript' ? 'npm-cache' : 'pip-cache'),
      ],
      this.opts.limits,
      this.language === 'typescript' ? 'npm install' : 'pip install',
    );
    if (this.language === 'typescript') {
      return this.exec('npm', ['install', '--no-audit', '--no-fund', ...packages], {
        timeoutMs: 0,
        progressWatch,
      });
    }
    return this.exec(this.pythonInVenv, ['-m', 'pip', 'install', ...packages, '--quiet', '--disable-pip-version-check'], {
      timeoutMs: 0,
      progressWatch,
    });
  }
}

function nodeDependencySignature(packageJson: string, lockfile: string): string {
  return crypto.createHash('sha256').update(packageJson + '\n' + lockfile).digest('hex');
}

/** 把任意 workspace 目录名规整为 venv 安全名（保留 [A-Za-z0-9._-]，回退到 'venv'）。 */
export function sanitizeVenvName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'venv';
}

/**
 * npm's own signal that the lockfile no longer matches the manifest.
 *
 * `EUSAGE` is npm's error code for it, so the code is the test and the sentence is only the
 * fallback for a version that stops emitting one.
 */
/**
 * The command to run instead when an install failed for a reason the next command fixes.
 *
 * Only one case so far, and npm names it itself: `npm ci` refuses when the manifest and the lockfile
 * disagree and tells you to run `npm install`. They disagree routinely here, because
 * HIGH_LEVEL_DESIGN authors package.json by writing the file and no lockfile comes with it.
 *
 * Decided here rather than at each caller. Three sync paths would otherwise each have to remember to
 * ask for a lockfile refresh, and all three were failing this way at once — silently, so no
 * environment was ever updated after the manifest changed.
 */
export function installRetryArgs(
  attempted: readonly string[],
  result: { exitCode: number; stderr: string },
): string[] | undefined {
  if (result.exitCode === 0 || attempted[0] !== 'ci') return undefined;
  if (!isLockfileOutOfSync(result.stderr)) return undefined;
  return ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
}

export function isLockfileOutOfSync(stderr: string): boolean {
  return /\bEUSAGE\b/u.test(stderr) ||
    /can only install packages when your package\.json and package-lock\.json/iu.test(stderr);
}

export function createInstallProgressWatch(
  paths: string[],
  limits: SandboxLimits,
  label = 'dependency install',
): ExecProgressWatch {
  const idleTimeoutMs = Math.max(
    limits.wall_seconds * 1000 * INSTALL_IDLE_TIMEOUT_MULTIPLIER,
    INSTALL_IDLE_TIMEOUT_FLOOR_MS,
  );
  return {
    paths: dedupPaths(paths),
    idleTimeoutMs,
    checkIntervalMs: INSTALL_PROGRESS_CHECK_INTERVAL_MS,
    label,
  };
}

export function formatExecFailure(label: string, r: ExecResult): string {
  const parts = [
    `${label} (exit=${r.exitCode}, timedOut=${r.timedOut ? 'true' : 'false'}, durationMs=${r.durationMs}${
      r.timeoutReason ? `, reason=${r.timeoutReason}` : ''
    }):`,
  ];
  const stdout = clipExecOutput(r.stdout);
  const stderr = clipExecOutput(r.stderr);
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  if (!stdout && !stderr) parts.push('(no stdout/stderr captured)');
  return parts.join('\n');
}

/** 不依赖沙盒的底层 spawn 封装。 */
export async function execRaw(
  cmd: string,
  argv: string[],
  opts: ExecRawOptions = {},
): Promise<ExecResult> {
  const start = Date.now();
  const executable = await resolveExecutableOnPath(cmd, opts.env ?? process.env);
  return new Promise((resolve) => {
    const child = spawn(executable, argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutReason: string | undefined;
    let settled = false;
    let progressTimer: NodeJS.Timeout | null = null;
    let progressStopped = false;
    const t = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          timeoutReason = `wall-clock timeout after ${opts.timeoutMs}ms`;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      progressStopped = true;
      if (t) clearTimeout(t);
      if (progressTimer) clearTimeout(progressTimer);
      resolve(result);
    };
    if (opts.progressWatch?.paths.length) {
      const watch = opts.progressWatch;
      let lastProgressAt = start;
      let lastObservedSize: number | null = null;
      const checkProgress = async () => {
        if (progressStopped) return;
        const observedAt = Date.now();
        const currentSize = await directoryTreeSize(watch.paths);
        if (progressStopped) return;
        if (lastObservedSize !== null && currentSize > lastObservedSize) {
          lastProgressAt = observedAt;
        }
        lastObservedSize = currentSize;
        if (observedAt - lastProgressAt >= watch.idleTimeoutMs) {
          timedOut = true;
          timeoutReason = `${watch.label ?? 'process'} progress idle for ${watch.idleTimeoutMs}ms; watched paths did not grow: ${watch.paths.join(', ')}`;
          child.kill('SIGKILL');
          return;
        }
        progressTimer = setTimeout(checkProgress, watch.checkIntervalMs ?? INSTALL_PROGRESS_CHECK_INTERVAL_MS);
      };
      progressTimer = setTimeout(checkProgress, watch.checkIntervalMs ?? INSTALL_PROGRESS_CHECK_INTERVAL_MS);
    }
    child.stdout.on('data', (b) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    child.on('error', (err) => {
      finish({
        exitCode: -1,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        timedOut,
        ...(timeoutReason ? { timeoutReason } : {}),
        durationMs: Date.now() - start,
      });
    });
    child.on('close', (code) => {
      finish({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
        ...(timeoutReason ? { timeoutReason } : {}),
        durationMs: Date.now() - start,
      });
    });
  });
}

/** Resolve bare host commands before spawning them, including from native pkg executables. */
export async function resolveExecutableOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return command;
  }
  const pathValue = env.PATH ?? env.Path ?? env.path ?? process.env.PATH ?? '';
  if (!pathValue) return command;
  const extensions = process.platform === 'win32'
    ? executableExtensions(command, env.PATHEXT ?? process.env.PATHEXT)
    : [''];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH in declaration order.
      }
    }
  }
  return command;
}

function executableExtensions(command: string, rawPathExt?: string): string[] {
  if (path.extname(command)) return [''];
  const values = (rawPathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return ['', ...values, ...values.map((value) => value.toLowerCase())];
}

async function directoryTreeSize(paths: string[]): Promise<number> {
  let total = 0;
  for (const p of dedupPaths(paths)) {
    total += await pathTreeSize(p);
  }
  return total;
}

async function pathTreeSize(abs: string): Promise<number> {
  let stat;
  try {
    stat = await fs.lstat(abs);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) {
    return stat.isFile() ? stat.size : 0;
  }

  let total = stat.size;
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const entry of entries) {
    total += await pathTreeSize(path.join(abs, entry.name));
  }
  return total;
}

function dedupPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((p) => path.resolve(p)).filter(Boolean)));
}

function clipExecOutput(text: string, max = 6000): string {
  const normalized = String(text ?? '').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}\n...[truncated ${normalized.length - max} chars]`;
}
