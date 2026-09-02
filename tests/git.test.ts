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

  it('keeps worktree-local runtime evidence across source rollback', async () => {
    await git.ensureRepo();
    await ws.writeFile('src/main.ts', 'export const value = 1;\n');
    await ws.writeFile('.xcw/audit/audit.jsonl', '{"event":"before"}\n');
    await ws.writeFile('.xcw/objects/ticket/BUG-1.json', '{"state":"created"}\n');
    await ws.writeFile('.xcw/debug-wiki/external/entry.md', '# before\n');
    const sha = await git.snapshot('S001', 0, 'before failed attempt');

    await ws.writeFile('src/main.ts', 'export const value = 2;\n');
    await ws.writeFile('.xcw/audit/audit.jsonl', '{"event":"after"}\n');
    await ws.writeFile('.xcw/objects/ticket/BUG-1.json', '{"state":"resolved"}\n');
    await ws.writeFile('.xcw/debug-wiki/external/entry.md', '# after\n');

    await git.revertTo(sha);

    expect(await ws.readFile('src/main.ts')).toContain('value = 1');
    expect(await ws.readFile('.xcw/audit/audit.jsonl')).toContain('"after"');
    expect(await ws.readFile('.xcw/objects/ticket/BUG-1.json')).toContain('resolved');
    expect(await ws.readFile('.xcw/debug-wiki/external/entry.md')).toContain('# after');

    const tracked = await git.raw().raw(['ls-files']);
    // Project state is never versioned, with no placeholder exception.
    expect(tracked).not.toContain('.xcw/');
    expect(tracked).not.toContain('.xcw/audit/audit.jsonl');
    expect(tracked).not.toContain('.xcw/objects/ticket/BUG-1.json');
  });

  it('untracks previously committed runtime metadata without deleting it', async () => {
    await git.ensureRepo();
    await ws.writeFile('.xcw/audit/audit.jsonl', '{"event":"tracked"}\n');
    await ws.writeFile('.sandbox/run.log', 'tracked\n');
    await git.raw().raw(['add', '-f', '.xcw/audit/audit.jsonl', '.sandbox/run.log']);
    await git.raw().commit('track runtime metadata');

    await git.snapshot('S002', 0, 'detach runtime metadata');

    const tracked = await git.raw().raw(['ls-files']);
    expect(tracked).not.toContain('.xcw/audit/audit.jsonl');
    expect(tracked).not.toContain('.sandbox/run.log');
    await expect(ws.exists('.xcw/audit/audit.jsonl')).resolves.toBe(true);
    await expect(ws.exists('.sandbox/run.log')).resolves.toBe(true);
  });
});

describe('runtime artifacts stay out of the repository', () => {
  it('gives the generated project a .gitignore covering what it produces by running', async () => {
    // The repository exclude file is local and invisible, so the delivered project shipped without
    // the one file every project has, and anyone cloning it saw runtime output as source.
    await git.ensureRepo();
    const ignore = await fs.readFile(path.join(tmp, '.gitignore'), 'utf8');
    for (const pattern of ['output/', 'node_modules/', '*.log', '*.pyc', '.venv/', '*.tsbuildinfo']) {
      expect(ignore, pattern).toContain(pattern);
    }
  });

  it('keeps ignore rules the project already wrote', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'secrets.env\noutput/\n', 'utf8');
    await git.ensureRepo();
    const ignore = await fs.readFile(path.join(tmp, '.gitignore'), 'utf8');
    expect(ignore).toContain('secrets.env');
    // Present entries are not repeated.
    expect(ignore.split('\n').filter((line) => line === 'output/')).toHaveLength(1);
  });

  it('untracks output a previous build had already committed', async () => {
    // A product that rewrites its own output on every delivery gate makes its next merge impossible
    // once that file is tracked, and the artifact then reaches the corrective flow as a Change
    // Request against a file no Step owns. A workspace that predates the rule repairs itself.
    await git.ensureRepo();
    await fs.mkdir(path.join(tmp, 'output'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'output', 'daily-briefing.md'), '# first\n', 'utf8');
    await fs.writeFile(path.join(tmp, 'src.ts'), 'export const a = 1;\n', 'utf8');
    const { simpleGit } = await import('simple-git');
    const raw = simpleGit({ baseDir: tmp });
    await raw.raw(['add', '-f', '--', 'output/daily-briefing.md', 'src.ts']);
    await raw.commit('tracked by an older build');
    expect(await raw.raw(['ls-files', '--', 'output/'])).toContain('daily-briefing.md');

    await git.snapshot('S006', 1);

    expect(await raw.raw(['ls-files', '--', 'output/'])).toBe('');
    expect(await raw.raw(['ls-files', '--', 'src.ts'])).toContain('src.ts');
  });
});
