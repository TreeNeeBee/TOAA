/**
 * 沙盒抽象。subprocess 与 docker 实现共用。
 *
 * 设计要点（与用户约定一致）：
 *  - "开发工程时使用挂载的方式将工程目录挂载到 docker 中运行" —— Docker 实现使用 bind mount，
 *    工程目录在宿主机即可见。
 *  - "debug 时直接修改工程代码" —— 因为是 bind mount，XCompiler 通过 Workspace 在宿主机上写入的
 *    任何文件都会立刻反映到容器内，无需复制 / 拷贝。
 */

export interface SandboxLimits {
  cpu: number;
  memory_mb: number;
  wall_seconds: number;
  /**
   * - `off`            disable network completely (`docker --network none`).
   * - `download-only`  outbound only (default), no inbound port publishing.
   * - `full`           outbound + publish `expose_ports` to 127.0.0.1.
   */
  network: 'off' | 'download-only' | 'full';
  /** Container ports to publish on 127.0.0.1 when `network=full`. */
  expose_ports?: number[];
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  timeoutReason?: string;
}

export interface ExecProgressWatch {
  /** Host-side paths whose recursive size indicates install progress. */
  paths: string[];
  /** Kill the child only after this much time without size growth. */
  idleTimeoutMs: number;
  /** Poll interval for recursive size checks. */
  checkIntervalMs?: number;
  /** Human-readable label used in timeout diagnostics. */
  label?: string;
}

export interface ExecExtra {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  progressWatch?: ExecProgressWatch;
}

export interface SandboxBuildOptions {
  /** Regenerate the TypeScript lockfile after a controlled manifest change. */
  refreshLockfile?: boolean;
}

/** 沙盒统一接口。任意 phase / tool 都通过此接口与运行时交互。 */
export interface Sandbox {
  /** 实现标识，便于审计与日志区分。 */
  readonly kind: 'subprocess' | 'docker';

  /**
   * 构建/复用环境。
   *  - Python：`pip install -r requirements.txt` + venv。
   *  - TypeScript：`npm install`（依据 package.json）。
   * manifestFile 为依赖清单在 workspace 内的相对路径；不存在则跳过安装。
   * 返回是否真正重建。
   */
  build(
    manifestFile?: string,
    options?: SandboxBuildOptions,
  ): Promise<{ rebuilt: boolean; reason: string }>;

  /** 执行任意命令；cmd 视实现可能是宿主路径或容器内路径。 */
  exec(cmd: string, argv: string[], extra?: ExecExtra): Promise<ExecResult>;

  /**
   * 运行工程入口程序。
   *  - Python：`python <args>`（自动选用 venv 内解释器）。
   *  - TypeScript：默认 `npx tsx <entry>`；当 args 以 `npm`/`npx`/`node`/`tsx`/`tsc` 开头时执行对应项目命令。
   */
  runProgram(args: string[], extra?: ExecExtra): Promise<ExecResult>;

  /**
   * 运行测试套件。
   *  - Python：`python -m pytest <args>`。
   *  - TypeScript：`npm test`（Vitest）。
   */
  runTests(args?: string[], extra?: ExecExtra): Promise<ExecResult>;

  /**
   * 安装额外依赖（不写入依赖清单）。
   *  - Python：`pip install <packages>`。
   *  - TypeScript：`npm install <packages>`。
   */
  installDeps(packages: string[]): Promise<ExecResult>;
}
