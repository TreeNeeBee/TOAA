import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DebugWiki } from '../src/core/debug_wiki.js';
import { buildDebugBrief } from '../src/core/debug_brief.js';

async function roots() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-wiki-tiers-'));
  return {
    installation: path.join(base, 'install', '.xcompiler', 'debug-wiki'),
    project: path.join(base, 'container', '.xcompiler', 'debug-wiki'),
    otherProject: path.join(base, 'other', '.xcompiler', 'debug-wiki'),
  };
}

function resolution(summary: string) {
  const brief = buildDebugBrief({
    reason: summary,
    failureLog: `${summary}\nstack trace here`,
    phase: 'CODE',
    targetPhase: 'CODE',
  });
  return {
    brief,
    ticketId: 'TKT-1',
    stepId: 'S004',
    phase: 'CODE' as const,
    targetPhase: 'CODE' as const,
    language: 'typescript',
    resolutionPlan: `fix ${summary}`,
    solution: `fix ${summary}`,
    evidence: ['tests pass'],
    repairFiles: ['src/a.ts'],
  };
}

describe('debug wiki tiers', () => {
  it('writes a run-time finding to the project tier, not the shared one', async () => {
    const { installation, project } = await roots();
    const wiki = new DebugWiki(installation, { projectPath: project });
    await wiki.load();
    const persisted = await wiki.recordResolution(resolution('parser rejects empty input'));

    expect(persisted.created).toMatch(/^project\./u);
    // The shared installation tier must not gain project-specific knowledge.
    const shared = await fs.readdir(path.join(installation, 'wiki', 'external')).catch(() => []);
    expect(shared).toEqual([]);
    const owned = await fs.readdir(path.join(project, 'wiki', 'project'));
    expect(owned.length).toBe(1);
  });

  it('keeps one project findings invisible to another project', async () => {
    const { installation, project, otherProject } = await roots();
    const first = new DebugWiki(installation, { projectPath: project });
    await first.load();
    await first.recordResolution(resolution('parser rejects empty input'));

    const second = new DebugWiki(installation, { projectPath: otherProject });
    await second.load();
    const matches = await second.search(
      buildDebugBrief({
        reason: 'parser rejects empty input',
        failureLog: 'parser rejects empty input',
        phase: 'CODE',
        targetPhase: 'CODE',
      }),
      { language: 'typescript' },
    );
    expect(matches.map((match) => match.entry.layer)).not.toContain('project');
  });

  it('still finds its own project findings on a later run', async () => {
    const { installation, project } = await roots();
    const first = new DebugWiki(installation, { projectPath: project });
    await first.load();
    await first.recordResolution(resolution('parser rejects empty input'));

    const reopened = new DebugWiki(installation, { projectPath: project });
    await reopened.load();
    const matches = await reopened.search(
      buildDebugBrief({
        reason: 'parser rejects empty input',
        failureLog: 'parser rejects empty input',
        phase: 'CODE',
        targetPhase: 'CODE',
      }),
      { language: 'typescript' },
    );
    expect(matches.some((match) => match.entry.layer === 'project')).toBe(true);
  });

  it('falls back to the shared writable tier when no project root is configured', async () => {
    const { installation } = await roots();
    const wiki = new DebugWiki(installation);
    await wiki.load();
    const persisted = await wiki.recordResolution(resolution('generic ecosystem issue'));
    expect(persisted.created).toMatch(/^external\./u);
  });
});
