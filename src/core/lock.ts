import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

/**
 * 容器级文件锁，防止多个 XCompiler 进程并发改同一个项目。
 * 锁文件：<stateRoot>/.lock，内容为 JSON：{pid, host, command, startedAt}。
 *
 * 锁在容器状态根而非工作副本上：一个项目可以有多个 worktree，它们共享同一份状态，
 * 因此争用点是状态而不是某个工作副本。
 *
 * 语义：
 *   - 优先 O_EXCL 创建，成功即获锁；
 *   - 若已存在但记录的 PID 在本机不存活（`process.kill(pid, 0)` 抛 ESRCH），视为陈旧锁，强制接管；
 *   - 跨主机的锁一律拒绝（无法证伪）。
 */

export interface LockInfo {
  ownerId?: string;
  pid: number;
  host: string;
  command: string;
  startedAt: string;
}

export class LockError extends Error {
  constructor(message: string, public readonly info?: LockInfo) {
    super(message);
    this.name = 'LockError';
  }
}

const LOCK_REL = '.lock';

function lockPath(stateRoot: string): string {
  return path.join(stateRoot, LOCK_REL);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM 表示进程存在但无权限发信号 → 视为存活
    return true;
  }
}

async function readLock(file: string): Promise<LockInfo | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

export interface AcquiredLock {
  release(): Promise<void>;
}

export async function acquireLock(
  stateRoot: string,
  command: string,
  options: { force?: boolean } = {},
): Promise<AcquiredLock> {
  const file = lockPath(stateRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const info: LockInfo = {
    ownerId: randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    command,
    startedAt: new Date().toISOString(),
  };
  const payload = JSON.stringify(info, null, 2);

  const tryCreate = async (): Promise<boolean> => {
    try {
      const fh = await fs.open(file, 'wx');
      await fh.writeFile(payload, 'utf8');
      await fh.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  if (await tryCreate()) {
    return makeReleaser(file, info.ownerId!);
  }

  if (options.force) {
    // 强制接管：覆写现有锁文件。仅在用户明确传入 --force 时生效。
    await fs.writeFile(file, payload, 'utf8');
    return makeReleaser(file, info.ownerId!);
  }

  const existing = await readLock(file);
  if (existing) {
    const sameHost = existing.host === info.host;
    if (sameHost && !isAlive(existing.pid)) {
      // 陈旧锁：直接覆写
      await fs.writeFile(file, payload, 'utf8');
      return makeReleaser(file, info.ownerId!);
    }
    throw new LockError(
      `workspace 已被其它 XCompiler 进程占用 (pid=${existing.pid}, host=${existing.host}, cmd=${existing.command}, since=${existing.startedAt}).\n` +
        `如确信该进程已退出，请删除 ${file} 后重试。`,
      existing,
    );
  }
  // 文件存在但读不出（损坏） → 接管
  await fs.writeFile(file, payload, 'utf8');
  return makeReleaser(file, info.ownerId!);
}

function makeReleaser(file: string, ownerId: string): AcquiredLock {
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      const current = await readLock(file);
      if (current?.ownerId !== ownerId) return;
      await fs.unlink(file);
    } catch {
      /* ignore */
    }
  };
  return { release };
}
