import { existsSync, readFileSync } from 'node:fs';
import type { Workspace } from '../workspace/workspace.js';
import type { AuditLogger } from '../audit/audit.js';
import type { XCompilerConfig } from '../config/config.js';
import type { Language } from '../core/plan.js';
import { getLanguageProfile } from '../core/language.js';
import type { Sandbox } from './types.js';
import { SubprocessSandbox } from './subprocess.js';
import { DockerSandbox } from './docker.js';
import { t } from '../i18n/index.js';
import { xcEnv } from '../config/env.js';

/**
 * 检测当前进程是否跑在容器里。依据（任一命中即认为在容器内）：
 *  - 环境变量 XC_IN_CONTAINER=1（显式覆盖 / Dockerfile 中设置）
 *  - /.dockerenv 文件存在（docker 默认创建）
 *  - /run/.containerenv 存在（podman 默认创建）
 *  - /proc/1/cgroup 包含 'docker' / 'kubepods' / 'containerd'
 *
 * 显式设 XC_IN_CONTAINER=0 强制按"宿主"对待（仅在你确认 DooD 路径语义无误时使用）。
 */
export function isRunningInContainer(): boolean {
  const env = xcEnv('IN_CONTAINER');
  if (env === '1') return true;
  if (env === '0') return false;
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return true;
  try {
    const cg = readFileSync('/proc/1/cgroup', 'utf8');
    if (/\b(docker|kubepods|containerd|podman)\b/.test(cg)) return true;
  } catch {
    /* not linux or unreadable */
  }
  return false;
}

/**
 * 工厂：按 plan.language 选择 config.agent.sandboxes.<language> 的实现。
 *
 * 约束：当 XCompiler 本身运行在容器内时，**不支持** sandbox=docker（DooD 在多数
 * 部署中会造成 bind-mount 路径语义不一致、docker.sock GID 错位等问题）。给
 * 出明确错误信息，引导用户改用 sandbox=subprocess 或在宿主上运行 XCompiler。
 */
export function createSandbox(
  cfg: XCompilerConfig,
  ws: Workspace,
  /** Environment root under container state; identifies which environment this work owns. */
  environmentRoot: string,
  audit?: AuditLogger,
  language: Language = 'python',
  /**
   * Shared per-project package download cache; each environment keeps its own installed state.
   *
   * Honoured by the subprocess sandbox only. The Docker sandbox bind-mounts the environment root as
   * a whole, so sharing a cache there needs a second mount rather than a second path, and it keeps
   * a cache per environment until that exists.
   */
  downloadCacheRoot?: string,
): Sandbox {
  const languageSandbox = cfg.agent.sandboxes[language];
  const kind = languageSandbox.mode;
  const activeLimits = kind === 'docker' ? languageSandbox.docker.limits : languageSandbox.local.limits;
  if (kind === 'subprocess' && activeLimits.network === 'off') {
    throw new Error(t().system.unsupportedSubprocessNetworkOff);
  }
  if (kind === 'docker') {
    if (isRunningInContainer()) {
      throw new Error(t().system.dockerInsideContainerUnsupported);
    }
    return new DockerSandbox({
      ws,
      limits: languageSandbox.docker.limits,
      audit,
      language,
      image: languageSandbox.docker.image ?? getLanguageProfile(language).defaultDockerImage,
      workdir: languageSandbox.docker.workdir,
      pull: languageSandbox.docker.pull,
      dockerBin: languageSandbox.docker.docker_bin,
      extraRunArgs: languageSandbox.docker.extra_run_args,
      environmentRoot,
    });
  }
  if (kind === 'firejail') {
    throw new Error(t().system.firejailUnsupported);
  }
  // 在容器内默认提示（但不抦截）：subprocess 是唯一推荐选项
  return new SubprocessSandbox({
    ws,
    limits: languageSandbox.local.limits,
    audit,
    language,
    environmentRoot,
    downloadCacheRoot,
    pythonBin: languageSandbox.local.python_bin,
    registry: languageSandbox.local.registry,
    inheritEnv: languageSandbox.local.inherit_env,
  });
}
