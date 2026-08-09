import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { GitService } from '../src/workspace/git.js';

let tmp: string;
let ws: Workspace;
let git: GitService;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-git-'));
  ws = new Workspace(tmp);
  git = new GitService(ws);
});

describe('GitService', () => {
  it('init -> snapshot -> revert restores file content', async () => {
    await git.ensureRepo();
    await ws.writeFile('a.txt', 'v1');
    const sha1 = await git.snapshot('S001', 0, 'after v1');
    expect(typeof sha1).toBe('string');

    await ws.writeFile('a.txt', 'v2');
    await git.snapshot('S001', 1, 'after v2');
    expect(await ws.readFile('a.txt')).toBe('v2');
    await ws.writeFile('created-by-failed-attempt.txt', 'temporary');

    await git.revertTo(sha1);
    expect(await ws.readFile('a.txt')).toBe('v1');
    expect(await ws.exists('created-by-failed-attempt.txt')).toBe(false);
  });

  it('ensureRepo is idempotent', async () => {
    await git.ensureRepo();
    await git.ensureRepo();
    const recent = await git.recentXCompilerCommits();
    expect(recent.some((c) => c.message.includes('init workspace'))).toBe(true);
  });

  it('does not track sandbox runtime artifacts in snapshots', async () => {
    await git.ensureRepo();
    await ws.writeFile('.sandbox/test/bin/python', 'runtime shim\n');

    await git.snapshot('S001', 0, 'runtime artifact');

    const tracked = await git.raw().raw(['ls-files']);
    expect(tracked).not.toContain('.sandbox/test/bin/python');
    await expect(ws.exists('.sandbox/test/bin/python')).resolves.toBe(true);
  });

  it('removes already tracked sandbox artifacts from the index without deleting files', async () => {
    await git.ensureRepo();
    await ws.writeFile('.sandbox/test/bin/python', 'runtime shim\n');
    await git.raw().raw(['add', '-f', '.sandbox/test/bin/python']);
    await git.raw().commit('track sandbox runtime artifact');
    expect(await git.raw().raw(['ls-files'])).toContain('.sandbox/test/bin/python');

    await git.snapshot('S002', 0, 'clean runtime artifact');

    const tracked = await git.raw().raw(['ls-files']);
    expect(tracked).not.toContain('.sandbox/test/bin/python');
    await expect(ws.exists('.sandbox/test/bin/python')).resolves.toBe(true);
  });

  it('keeps runtime audit and debug evidence across source rollback', async () => {
    await git.ensureRepo();
    await ws.writeFile('src/main.ts', 'export const value = 1;\n');
    await ws.writeFile('.xcompiler/audit.jsonl', '{"event":"before"}\n');
    await ws.writeFile('.xcompiler/objects/ticket/BUG-1.json', '{"state":"created"}\n');
    await ws.writeFile('.xcompiler/debug-wiki/external/entry.md', '# before\n');
    await ws.writeFile('logs/run.log', 'before\n');
    await ws.writeFile('docs/process_log.md', '# before\n');
    await ws.writeFile('sample.xc', '{"status":"RUNNING"}\n');
    const sha = await git.snapshot('S001', 0, 'before failed attempt');

    await ws.writeFile('src/main.ts', 'export const value = 2;\n');
    await ws.writeFile('.xcompiler/audit.jsonl', '{"event":"after"}\n');
    await ws.writeFile('.xcompiler/objects/ticket/BUG-1.json', '{"state":"resolved"}\n');
    await ws.writeFile('.xcompiler/debug-wiki/external/entry.md', '# after\n');
    await ws.writeFile('logs/run.log', 'after\n');
    await ws.writeFile('docs/process_log.md', '# after\n');
    await ws.writeFile('sample.xc', '{"status":"FAILED"}\n');

    await git.revertTo(sha);

    expect(await ws.readFile('src/main.ts')).toContain('value = 1');
    expect(await ws.readFile('.xcompiler/audit.jsonl')).toContain('"after"');
    expect(await ws.readFile('.xcompiler/objects/ticket/BUG-1.json')).toContain('resolved');
    expect(await ws.readFile('.xcompiler/debug-wiki/external/entry.md')).toContain('# after');
    expect(await ws.readFile('logs/run.log')).toBe('after\n');
    expect(await ws.readFile('docs/process_log.md')).toBe('# after\n');
    expect(await ws.readFile('sample.xc')).toContain('FAILED');

    const tracked = await git.raw().raw(['ls-files']);
    // Project state is never versioned, with no placeholder exception.
    expect(tracked).not.toContain('.xcompiler/');
    expect(tracked).not.toContain('.xcompiler/audit.jsonl');
    expect(tracked).not.toContain('.xcompiler/objects/ticket/BUG-1.json');
    expect(tracked).not.toContain('logs/run.log');
    expect(tracked).not.toContain('docs/process_log.md');
    expect(tracked).not.toContain('sample.xc');
  });

  it('untracks previously committed runtime metadata without deleting it', async () => {
    await git.ensureRepo();
    await ws.writeFile('.xcompiler/audit.jsonl', '{"event":"tracked"}\n');
    await ws.writeFile('logs/run.log', 'tracked\n');
    await git.raw().raw(['add', '-f', '.xcompiler/audit.jsonl', 'logs/run.log']);
    await git.raw().commit('track runtime metadata');

    await git.snapshot('S002', 0, 'detach runtime metadata');

    const tracked = await git.raw().raw(['ls-files']);
    expect(tracked).not.toContain('.xcompiler/audit.jsonl');
    expect(tracked).not.toContain('logs/run.log');
    await expect(ws.exists('.xcompiler/audit.jsonl')).resolves.toBe(true);
    await expect(ws.exists('logs/run.log')).resolves.toBe(true);
  });
});
