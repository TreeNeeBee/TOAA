import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SubprocessSandbox,
  execRaw,
  formatExecFailure,
  resolveExecutableOnPath,
} from '../src/sandbox/subprocess.js';
import { Workspace } from '../src/workspace/workspace.js';

async function tempDir(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `xcompiler-${name}-`));
}

describe('execRaw install progress watch', () => {
  it('resolves bare commands to absolute host paths before spawning', async () => {
    if (process.platform === 'win32') return;
    const dir = await tempDir('host-command');
    const executable = path.join(dir, 'xc-host-probe');
    await fs.writeFile(executable, '#!/bin/sh\nprintf "host-ok"\n', 'utf8');
    await fs.chmod(executable, 0o755);

    expect(await resolveExecutableOnPath('xc-host-probe', { PATH: dir })).toBe(executable);
    const result = await execRaw('xc-host-probe', [], { env: { PATH: dir } });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'host-ok' });
  });

  it('fails only after the watched install path stops growing', async () => {
    const dir = await tempDir('install-idle');
    const result = await execRaw(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], {
      progressWatch: {
        paths: [dir],
        idleTimeoutMs: 80,
        checkIntervalMs: 20,
        label: 'test install',
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.timeoutReason).toContain('test install progress idle');
  });

  it('refreshes the idle timer when the watched install path grows', async () => {
    const dir = await tempDir('install-growth');
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const dir = process.argv[1];
      [40, 110, 180].forEach((ms, idx) => {
        setTimeout(() => {
          fs.writeFileSync(path.join(dir, 'pkg-' + idx), 'x'.repeat(1024 * (idx + 1)));
        }, ms);
      });
      setTimeout(() => process.exit(0), 230);
    `;
    const result = await execRaw(process.execPath, ['-e', script, dir], {
      progressWatch: {
        paths: [dir],
        idleTimeoutMs: 90,
        checkIntervalMs: 20,
        label: 'test install',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('includes timeout metadata in install failure diagnostics', () => {
    const message = formatExecFailure('npm dependency install failed (cwd=/tmp/project)', {
      exitCode: -1,
      stdout: 'real stdout error',
      stderr: 'npm warn deprecated package',
      timedOut: true,
      timeoutReason: 'npm install progress idle for 900000ms',
      durationMs: 900001,
    });

    expect(message).toContain('exit=-1');
    expect(message).toContain('timedOut=true');
    expect(message).toContain('reason=npm install progress idle');
    expect(message).toContain('stdout:\nreal stdout error');
    expect(message).toContain('stderr:\nnpm warn deprecated package');
  });
});

describe('SubprocessSandbox environment isolation', () => {
  it('does not expose host secrets unless inheritance is explicitly enabled', async () => {
    const dir = await tempDir('env-isolation');
    const secretName = 'XCOMPILER_TEST_HOST_SECRET';
    const previous = process.env[secretName];
    process.env[secretName] = 'must-not-leak';
    try {
      const isolated = new SubprocessSandbox({
        ws: new Workspace(dir),
        language: 'typescript',
        limits: { cpu: 1, memory_mb: 128, wall_seconds: 5, network: 'download-only' },
      });
      const hidden = await isolated.exec(process.execPath, ['-e', `process.stdout.write(process.env.${secretName} ?? '')`]);
      expect(hidden.stdout).toBe('');

      const inherited = new SubprocessSandbox({
        ws: new Workspace(dir),
        language: 'typescript',
        inheritEnv: true,
        limits: { cpu: 1, memory_mb: 128, wall_seconds: 5, network: 'download-only' },
      });
      const visible = await inherited.exec(process.execPath, ['-e', `process.stdout.write(process.env.${secretName} ?? '')`]);
      expect(visible.stdout).toBe('must-not-leak');
    } finally {
      if (previous === undefined) delete process.env[secretName];
      else process.env[secretName] = previous;
    }
  });
});

describe('SubprocessSandbox TypeScript dependency cache', () => {
  it('stores the post-install lockfile signature after a controlled refresh', async () => {
    const dir = await tempDir('node-lock-refresh');
    const ws = new Workspace(dir);
    await ws.writeFile('fixture-dep/package.json', JSON.stringify({
      name: 'fixture-dep',
      version: '1.0.0',
    }, null, 2) + '\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'lock-refresh-fixture',
      version: '1.0.0',
      private: true,
      dependencies: { 'fixture-dep': 'file:./fixture-dep' },
    }, null, 2) + '\n');
    const sandbox = new SubprocessSandbox({
      ws,
      language: 'typescript',
      limits: { cpu: 1, memory_mb: 128, wall_seconds: 10, network: 'download-only' },
    });

    const refreshed = await sandbox.build('package.json', { refreshLockfile: true });
    const cached = await sandbox.build('package.json');

    expect(refreshed.rebuilt).toBe(true);
    expect(await ws.exists('package-lock.json')).toBe(true);
    expect(cached).toEqual({ rebuilt: false, reason: 'cache hit' });
  });
});
