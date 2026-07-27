import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { DockerSandbox } from '../src/sandbox/docker.js';

let tmp: string;
let ws: Workspace;
let scriptDir: string;
let fakeDocker: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-docker-'));
  ws = new Workspace(tmp);
  scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-fakedocker-'));
  // Fake docker bin: just record argv into a file and exit 0
  fakeDocker = path.join(scriptDir, 'docker');
  await fs.writeFile(
    fakeDocker,
    [
      '#!/usr/bin/env bash',
      'echo "$@" >> "$0.calls"',
      '# emulate `docker version` -> 0',
      'if [ "$1" = "version" ]; then echo "fake-25.0"; exit 0; fi',
      '# emulate `docker run ... bash -lc "..."` for build by creating venv marker on host',
      'if [ "$1" = "run" ]; then',
      '  # extract -v <hostpath>:<containerpath>',
      '  HOSTPATH=""',
      '  while [ "$#" -gt 0 ]; do',
      '    if [ "$1" = "-v" ]; then HOSTPATH="${2%%:*}"; fi',
      '    if [ "$1" = "bash" ]; then break; fi',
      '    shift',
      '  done',
      '  if [ -n "$HOSTPATH" ]; then',
      '    # 解析 bash -lc "python -m venv /workspace/.sandbox/<name> && ..." 中的 venv 路径',
      '    BASH_CMD="$@"',
      '    VENV_REL=$(echo "$BASH_CMD" | sed -n "s/.*python -m venv \\/workspace\\/\\(\\.sandbox\\/[A-Za-z0-9._-]*\\).*/\\1/p")',
      '    if [ -z "$VENV_REL" ]; then VENV_REL=".sandbox/venv"; fi',
      '    mkdir -p "$HOSTPATH/$VENV_REL/bin"',
      '    : > "$HOSTPATH/$VENV_REL/bin/python"',
      '    chmod +x "$HOSTPATH/$VENV_REL/bin/python"',
      '  fi',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(fakeDocker, 0o755);
});

describe('DockerSandbox', () => {
  it('build creates .sandbox/<project>/bin/python on first call (cache miss) and short-circuits on second (cache hit)', async () => {
    await ws.writeFile('requirements.txt', 'pytest==8.*\n');
    const sb = new DockerSandbox({
      ws,
      limits: { cpu: 1, memory_mb: 256, wall_seconds: 30, network: 'download-only' },
      dockerBin: fakeDocker,
    });
    const venvName = path.basename(tmp);

    const r1 = await sb.build();
    expect(r1.rebuilt).toBe(true);
    expect(await ws.exists(`.sandbox/${venvName}/bin/python`)).toBe(true);
    expect(await ws.exists('.sandbox/requirements.sha256')).toBe(true);

    const r2 = await sb.build();
    expect(r2.rebuilt).toBe(false);
    expect(r2.reason).toBe('cache hit');
  }, 15_000);

  it('exec issues docker run with -v <ws>:<workdir> and --memory/--cpus flags', async () => {
    const sb = new DockerSandbox({
      ws,
      limits: { cpu: 2, memory_mb: 512, wall_seconds: 10, network: 'off' },
      dockerBin: fakeDocker,
    });
    await sb.exec('echo', ['hello']);
    const calls = await fs.readFile(`${fakeDocker}.calls`, 'utf8');
    expect(calls).toContain(`-v ${ws.root}:/workspace`);
    expect(calls).toContain('--cpus=2');
    expect(calls).toContain('--memory=512m');
    expect(calls).toContain('--network none');
    expect(calls).toContain('echo hello');
  }, 15_000);

  it('publishes expose_ports to 127.0.0.1 when network=full', async () => {
    const sb = new DockerSandbox({
      ws,
      limits: { cpu: 1, memory_mb: 256, wall_seconds: 10, network: 'full', expose_ports: [8000, 5173] },
      dockerBin: fakeDocker,
    });
    await sb.exec('echo', ['serving']);
    const calls = await fs.readFile(`${fakeDocker}.calls`, 'utf8');
    expect(calls).toContain('-p 127.0.0.1:8000:8000');
    expect(calls).toContain('-p 127.0.0.1:5173:5173');
    // sanity: --network none must NOT be set in full mode
    expect(calls).not.toMatch(/--network none/);
  }, 15_000);

  it('does not publish ports when network=download-only (default)', async () => {
    const sb = new DockerSandbox({
      ws,
      limits: { cpu: 1, memory_mb: 256, wall_seconds: 10, network: 'download-only', expose_ports: [9000] },
      dockerBin: fakeDocker,
    });
    await sb.exec('echo', ['hi']);
    const calls = await fs.readFile(`${fakeDocker}.calls`, 'utf8');
    expect(calls).not.toContain('-p 127.0.0.1:9000:9000');
    expect(calls).not.toMatch(/--network none/);
  }, 15_000);

});
