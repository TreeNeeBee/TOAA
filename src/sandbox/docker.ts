import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace } from '../workspace/workspace.js';
import type { AuditLogger } from '../audit/audit.js';
import { t } from '../i18n/index.js';
import type { Language } from '../core/plan.js';
import type { Sandbox, SandboxBuildOptions, SandboxLimits, ExecResult, ExecExtra } from './types.js';
import { SANDBOX_GUEST_ENVIRONMENT_DIR } from './environment.js';
import { normalizeTypeScriptTestArgs } from './test_args.js';
import { resolveTypeScriptProgramCommand } from './program_args.js';
import { createInstallProgressWatch, execRaw, formatExecFailure } from './subprocess.js';

export interface DockerSandboxOptions {
  ws: Workspace;
  limits: SandboxLimits;
  audit?: AuditLogger;
  /** 目标语言，决定运行时与默认镜像。默认 python。 */
  language?: Language;
  /** 镜像名，默认按语言推导（python:3.11-slim / node:24-slim） */
  image?: string;
  /** 容器内挂载点，默认 /workspace */
  workdir?: string;
  /**
   * 环境根目录（宿主绝对路径），单独 bind-mount 进容器。
   * 不能再放在工作副本挂载内：那样每个 worktree 都会各自重建一份环境。
   */
  environmentRoot: string;
  /** docker 可执行路径，默认 PATH 中的 docker */
  dockerBin?: string;
  /** 是否在 build 时强制 docker pull（拉取最新镜像） */
  pull?: boolean;
  /** 额外 docker run 参数（高级用户） */
  extraRunArgs?: string[];
}

/**
 * DockerSandbox：使用系统 docker daemon，将工程目录 bind-mount 到容器内运行。
 *
 * - 不构建自定义镜像。直接以 `python:3.11-slim`（或 cfg.image）为基底，
 *   在 bind-mount 的工程目录下创建 `.sandbox/venv` 并 `pip install -r requirements.txt`，
 *   把"环境构建产物"全部落在挂载卷里 → 重启容器后立即复用，无 docker volume 黏性。
 * - exec/runPython/runPytest：每次起一个临时容器（--rm），cgroup 限制由 --cpus / --memory 提供，
 *   wall-clock 超时由 host 端 spawn 控制。
 * - "debug 时直接修改工程代码"：因为是 bind mount，XCompiler 工具在宿主机上的写入会瞬时反映到容器；
 *   下一次 exec 直接看到新代码，无需重新构建镜像。
 *
 * 网络策略：
 *   - `off`        → `--network none`
 *   - `download-only` → 允许出站，但不发布端口
 *   - `full`       → 默认网络
 *   build 阶段必须能联网拉取依赖；exec 阶段若设 `off` 则完全断网。
 */
export class DockerSandbox implements Sandbox {
  readonly kind = 'docker' as const;

  private readonly language: Language;
  private readonly image: string;
  private readonly workdir: string;
  private readonly cacheRel: string;
  private readonly dockerBin: string;
  private readonly extraRunArgs: string[];
  private readonly pull: boolean;
  private readonly venvName: string;

  constructor(private readonly opts: DockerSandboxOptions) {
    this.language = opts.language ?? 'python';
    this.image = opts.image ?? (this.language === 'typescript' ? 'node:24-slim' : 'python:3.11-slim');
    this.workdir = opts.workdir ?? '/workspace';
    this.cacheRel = this.language === 'typescript' ? 'package.sha256' : 'requirements.sha256';
    this.dockerBin = opts.dockerBin ?? 'docker';
    this.extraRunArgs = opts.extraRunArgs ?? [];
    this.pull = !!opts.pull;
    // 与 SubprocessSandbox 一致：环境根已标识归属，venv 名固定。
    this.venvName = 'venv';
  }

  /** 容器内 venv 路径 */
  private get venvInContainer(): string {
    return `${SANDBOX_GUEST_ENVIRONMENT_DIR}/${this.venvName}`;
  }

  private get pythonInContainer(): string {
    return `${this.venvInContainer}/bin/python`;
  }

  private get pipInContainer(): string {
    return `${this.venvInContainer}/bin/pip`;
  }

  /** 检查 docker 是否可用 */
  async assertDocker(): Promise<void> {
    const r = await execRaw(this.dockerBin, ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 5000,
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `docker daemon not reachable via ${this.dockerBin}: ${r.stderr || r.stdout || 'unknown error'}`,
      );
    }
  }

  /**
   * 构建/复用环境：
   * 1. 哈希依赖清单 → 命中缓存（venv/node_modules 存在 + sha 一致）则直接返回；
   * 2. 否则起一次性容器，在 bind-mount 的工程目录内安装依赖。
   */
  async build(
    manifestFile?: string,
    options?: SandboxBuildOptions,
  ): Promise<{ rebuilt: boolean; reason: string }> {
    await this.assertDocker();
    const sandboxAbs = this.opts.environmentRoot;
    await fs.mkdir(sandboxAbs, { recursive: true });
    if (this.language === 'typescript') {
      return this.buildNode(manifestFile ?? 'package.json', options);
    }
    return this.buildPython(manifestFile ?? 'requirements.txt');
  }

  private async buildPython(requirementsTxt: string): Promise<{ rebuilt: boolean; reason: string }> {
    const sandboxAbs = this.opts.environmentRoot;
    const reqAbs = this.opts.ws.abs(requirementsTxt);
    const reqContent = await fs.readFile(reqAbs, 'utf8').catch(() => '');
    const sig = crypto.createHash('sha256').update(this.image + '\n' + reqContent).digest('hex');
    const cacheAbs = path.join(this.opts.environmentRoot, this.cacheRel);
    const cached = await fs.readFile(cacheAbs, 'utf8').catch(() => '');
    const venvExists = await fs
      .stat(path.join(sandboxAbs, this.venvName, 'bin', 'python'))
      .then(() => true)
      .catch(() => false);

    if (venvExists && cached === sig) {
      return { rebuilt: false, reason: 'cache hit' };
    }

    if (this.pull) {
      const r = await execRaw(this.dockerBin, ['pull', this.image], { timeoutMs: 300_000 });
      if (r.exitCode !== 0) {
        throw new Error(`docker pull ${this.image} failed: ${r.stderr || r.stdout}`);
      }
    }

    const reqInContainer = `${this.workdir}/${requirementsTxt}`;
    const installCmd =
      reqContent.trim().length > 0
        ? `python -m venv ${this.venvInContainer} && ${this.pipInContainer} install --quiet -r ${reqInContainer}`
        : `python -m venv ${this.venvInContainer}`;
    const progressWatch = createInstallProgressWatch(
      [path.join(sandboxAbs, this.venvName)],
      this.opts.limits,
      'docker pip install',
    );

    const r = await execRaw(
      this.dockerBin,
      [
        'run',
        '--rm',
        '-v',
        `${this.opts.ws.root}:${this.workdir}`,
        '-v',
        `${this.opts.environmentRoot}:${SANDBOX_GUEST_ENVIRONMENT_DIR}`,
        '-w',
        this.workdir,
        ...this.extraRunArgs,
        this.image,
        'bash',
        '-lc',
        installCmd,
      ],
      { progressWatch },
    );
    if (r.exitCode !== 0) {
      throw new Error(formatExecFailure(`docker sandbox build failed (image=${this.image}, cwd=${this.opts.ws.root})`, r));
    }
    await fs.writeFile(cacheAbs, sig, 'utf8');
    await this.opts.audit?.event('sandbox.exec', t().sandboxLog.dockerBuilt(!!reqContent), {
      messageId: 'sandbox.docker_built',
      image: this.image,
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
      return { rebuilt: false, reason: 'no package.json yet' };
    }
    const lockContent = await fs.readFile(this.opts.ws.abs('package-lock.json'), 'utf8').catch(() => '');
    const sig = dockerNodeDependencySignature(this.image, pkgContent, lockContent);
    const cacheAbs = path.join(this.opts.environmentRoot, this.cacheRel);
    const cached = await fs.readFile(cacheAbs, 'utf8').catch(() => '');
    const modulesExist = await fs
      .stat(this.opts.ws.abs('node_modules'))
      .then(() => true)
      .catch(() => false);
    if (modulesExist && cached === sig) {
      return { rebuilt: false, reason: 'cache hit' };
    }

    if (this.pull) {
      const r = await execRaw(this.dockerBin, ['pull', this.image], { timeoutMs: 300_000 });
      if (r.exitCode !== 0) {
        throw new Error(`docker pull ${this.image} failed: ${r.stderr || r.stdout}`);
      }
    }

    const installCommand = lockContent.trim() && !options?.refreshLockfile
      ? 'npm ci --ignore-scripts --no-audit --no-fund'
      : 'npm install --ignore-scripts --no-audit --no-fund';
    const progressWatch = createInstallProgressWatch(
      [this.opts.ws.abs('node_modules')],
      this.opts.limits,
      'docker npm install',
    );
    const r = await execRaw(
      this.dockerBin,
      [
        'run',
        '--rm',
        '-v',
        `${this.opts.ws.root}:${this.workdir}`,
        '-v',
        `${this.opts.environmentRoot}:${SANDBOX_GUEST_ENVIRONMENT_DIR}`,
        '-w',
        this.workdir,
        ...this.extraRunArgs,
        this.image,
        'bash',
        '-lc',
        installCommand,
      ],
      { progressWatch },
    );
    if (r.exitCode !== 0) {
      throw new Error(formatExecFailure(`docker sandbox build failed (image=${this.image}, cwd=${this.opts.ws.root})`, r));
    }
    if (options?.refreshLockfile) {
      const validationCommand = 'npm ci --dry-run --ignore-scripts --no-audit --no-fund';
      await this.opts.audit?.event(
        'sandbox.exec',
        t().sandboxLog.command('docker', validationCommand),
        { messageId: 'sandbox.command', cwd: this.opts.ws.root, image: this.image },
      );
      const validation = await execRaw(
        this.dockerBin,
        [
          'run',
          '--rm',
          '-v',
          `${this.opts.ws.root}:${this.workdir}`,
          '-v',
          `${this.opts.environmentRoot}:${SANDBOX_GUEST_ENVIRONMENT_DIR}`,
          '-w',
          this.workdir,
          ...this.extraRunArgs,
          this.image,
          'bash',
          '-lc',
          validationCommand,
        ],
      );
      if (validation.exitCode !== 0) {
        throw new Error(formatExecFailure(
          `docker npm lockfile validation failed after dependency update (image=${this.image}, cwd=${this.opts.ws.root})`,
          validation,
        ));
      }
    }
    const finalLockContent = await fs.readFile(this.opts.ws.abs('package-lock.json'), 'utf8').catch(() => '');
    const finalSignature = dockerNodeDependencySignature(this.image, pkgContent, finalLockContent);
    await fs.writeFile(cacheAbs, finalSignature, 'utf8');
    await this.opts.audit?.event('sandbox.exec', t().sandboxLog.dockerNodeBuilt, {
      messageId: 'sandbox.docker_node_built', image: this.image,
    });
    return { rebuilt: true, reason: modulesExist ? 'package.json changed' : 'node_modules created' };
  }

  /** 在容器内执行任意命令。cwd 视为 workspace 内相对路径或绝对宿主路径（后者会被映射回容器）。 */
  async exec(cmd: string, argv: string[], extra?: ExecExtra): Promise<ExecResult> {
    const containerCwd = this.toContainerPath(extra?.cwd) ?? this.workdir;
    const timeoutMs = extra?.timeoutMs ?? this.opts.limits.wall_seconds * 1000;

    const dockerArgs: string[] = [
      'run',
      '--rm',
      '-v',
      `${this.opts.ws.root}:${this.workdir}`,
      '-v',
      `${this.opts.environmentRoot}:${SANDBOX_GUEST_ENVIRONMENT_DIR}`,
      '-w',
      containerCwd,
      `--cpus=${this.opts.limits.cpu}`,
      `--memory=${this.opts.limits.memory_mb}m`,
      '--pids-limit',
      '256',
    ];
    if (this.language === 'typescript') {
      dockerArgs.push(
        '-e',
        `PATH=${this.workdir}/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      );
    } else {
      dockerArgs.push(
        '-e',
        `VIRTUAL_ENV=${this.venvInContainer}`,
        '-e',
        `PATH=${this.venvInContainer}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      );
    }
    for (const [k, v] of Object.entries(extra?.env ?? {})) {
      dockerArgs.push('-e', `${k}=${v}`);
    }
    if (this.opts.limits.network === 'off') dockerArgs.push('--network', 'none');
    // bidirectional: publish requested ports on 127.0.0.1 so host-side tests can reach the app.
    if (this.opts.limits.network === 'full' && this.opts.limits.expose_ports?.length) {
      for (const port of this.opts.limits.expose_ports) {
        dockerArgs.push('-p', `127.0.0.1:${port}:${port}`);
      }
    }
    dockerArgs.push(...this.extraRunArgs, this.image, cmd, ...argv);

    await this.opts.audit?.event('sandbox.exec', t().sandboxLog.command('docker', `${cmd} ${argv.join(' ')}`), {
      messageId: 'sandbox.command',
      cwd: containerCwd,
      timeoutMs,
      image: this.image,
      network: this.opts.limits.network,
    });
    return execRaw(this.dockerBin, dockerArgs, { timeoutMs, progressWatch: extra?.progressWatch });
  }

  async runProgram(args: string[], extra?: ExecExtra): Promise<ExecResult> {
    if (this.language === 'typescript') {
      const command = resolveTypeScriptProgramCommand(args);
      return this.exec(command.cmd, command.argv, extra);
    }
    return this.exec(this.pythonInContainer, args, extra);
  }

  async runTests(args: string[] = [], extra?: ExecExtra): Promise<ExecResult> {
    if (this.language === 'typescript') {
      const normalizedArgs = normalizeTypeScriptTestArgs(args);
      const argv = normalizedArgs.length > 0 ? ['test', '--silent', '--', ...normalizedArgs] : ['test', '--silent'];
      return this.exec('npm', argv, extra);
    }
    return this.exec(this.pythonInContainer, ['-m', 'pytest', ...args], extra);
  }

  async installDeps(packages: string[]): Promise<ExecResult> {
    const progressWatch = createInstallProgressWatch(
      [
        this.language === 'typescript'
          ? this.opts.ws.abs('node_modules')
          : path.join(this.opts.environmentRoot, this.venvName),
      ],
      this.opts.limits,
      this.language === 'typescript' ? 'docker npm install' : 'docker pip install',
    );
    if (this.language === 'typescript') {
      return this.exec('npm', ['install', '--no-audit', '--no-fund', ...packages], {
        timeoutMs: 0,
        progressWatch,
      });
    }
    return this.exec(this.pipInContainer, ['install', '--quiet', ...packages], {
      timeoutMs: 0,
      progressWatch,
    });
  }

  /** 将宿主机绝对路径映射回容器路径；相对路径或 undefined 原样返回（相对则拼到 workdir）。 */
  private toContainerPath(p?: string): string | null {
    if (!p) return null;
    if (path.isAbsolute(p)) {
      const root = path.resolve(this.opts.ws.root);
      const norm = path.resolve(p);
      if (norm === root) return this.workdir;
      if (norm.startsWith(root + path.sep)) {
        return this.workdir + '/' + norm.slice(root.length + 1).replaceAll(path.sep, '/');
      }
      // 不在 workspace 内的绝对路径不可见 — fallback 至 workdir
      return this.workdir;
    }
    return `${this.workdir}/${p.replaceAll('\\', '/')}`;
  }
}

function dockerNodeDependencySignature(image: string, packageJson: string, lockfile: string): string {
  return crypto.createHash('sha256').update(image + '\n' + packageJson + '\n' + lockfile).digest('hex');
}
