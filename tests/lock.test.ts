import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireLock, LockError } from '../src/core/lock.js';
import { runExecute } from '../src/runtime/run.js';
import { silentRuntimeIO } from '../src/runtime/io.js';

const root = path.resolve(__dirname, '..');

async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-lock-'));
}

describe('workspace lock', () => {
  it('acquires + releases', async () => {
    const dir = await tmpdir();
    const l = await acquireLock(dir, 'xcompiler_build');
    expect(await fs.stat(path.join(dir, '.lock'))).toBeTruthy();
    await l.release();
    await expect(fs.stat(path.join(dir, '.lock'))).rejects.toThrow();
  });

  it('rejects a second acquire on same workspace (live pid)', async () => {
    const dir = await tmpdir();
    const l = await acquireLock(dir, 'xcompiler_build');
    await expect(acquireLock(dir, 'xcompiler_run')).rejects.toBeInstanceOf(LockError);
    await l.release();
  });

  it('takes over a stale lock (dead pid)', async () => {
    const dir = await tmpdir();
    await fs.mkdir(path.join(dir, '.xcompiler'), { recursive: true });
    // PID 999999 极不可能存活
    await fs.writeFile(
      path.join(dir, '.lock'),
      JSON.stringify({ pid: 999999, host: os.hostname(), command: 'ghost', startedAt: new Date().toISOString() }),
    );
    const l = await acquireLock(dir, 'xcompiler_build');
    await l.release();
  });

  it('does not let a replaced owner release the current lock', async () => {
    const dir = await tmpdir();
    const first = await acquireLock(dir, 'first');
    const second = await acquireLock(dir, 'second', { force: true });

    await first.release();
    expect(await fs.stat(path.join(dir, '.lock'))).toBeTruthy();

    await second.release();
    await expect(fs.stat(path.join(dir, '.lock'))).rejects.toThrow();
  });

  it('does not install process signal listeners', async () => {
    const dir = await tmpdir();
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };

    const lock = await acquireLock(dir, 'listener-check');
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    await lock.release();
  });

  it('releases the runtime lock when plan loading fails before engine startup', async () => {
    const dir = await tmpdir();
    await expect(runExecute({
      workspace: dir,
      planPath: path.join(dir, 'missing-phasePlan.json'),
      configPath: path.join(root, 'config.example.yaml'),
      io: silentRuntimeIO,
    })).rejects.toThrow();

    const lock = await acquireLock(dir, 'after-runtime-error');
    await lock.release();
  });
});
