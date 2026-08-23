import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildDebugBrief } from '../src/core/debug_brief.js';
import {
  DEFAULT_DEBUG_WIKI_REL_PATH,
  DebugWiki,
  defaultDebugWikiPath,
  renderDebugWikiMatchesForPrompt,
} from '../src/core/debug_wiki.js';

async function tmpRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-debug-wiki-'));
  return path.join(dir, 'debug-wiki');
}

describe('DebugWiki', () => {
  it('defaults to the configured XCompiler path instead of a generated project workspace', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-debug-wiki-root-'));
    const previous = process.env.XC_PATH;
    process.env.XC_PATH = dir;
    try {
      expect(defaultDebugWikiPath()).toBe(path.join(dir, DEFAULT_DEBUG_WIKI_REL_PATH));
    } finally {
      if (previous === undefined) delete process.env.XC_PATH;
      else process.env.XC_PATH = previous;
    }
  });

  it('falls back to the workspace when the configured XCompiler path is the filesystem root', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-debug-wiki-fallback-'));
    const previous = process.env.XC_PATH;
    process.env.XC_PATH = path.parse(dir).root;
    try {
      expect(defaultDebugWikiPath(dir)).toBe(path.join(dir, DEFAULT_DEBUG_WIKI_REL_PATH));
    } finally {
      if (previous === undefined) delete process.env.XC_PATH;
      else process.env.XC_PATH = previous;
    }
  });

  it('records a resolved Bug Ticket and retrieves it by debug brief', async () => {
    const root = await tmpRoot();
    const wiki = new DebugWiki(root);
    const brief = buildDebugBrief({
      reason: 'Test gate: tests exit=1',
      failureLog: 'FAILED tests/test_parser.py::test_signal_scale\nAssertionError: expected scale 0.1',
      phase: 'UNIT_TEST',
      targetPhase: 'CODE',
    });

    const result = await wiki.recordResolution({
      brief,
      ticketId: 'BUG-1',
      stepId: 'S004',
      phase: 'CODE',
      targetPhase: 'CODE',
      language: 'python',
      resolutionPlan: 'Root cause is wrong scale conversion; patch parser and verify the focused unit test.',
      solution: 'Patch the parser scale conversion and rerun the unit test.',
      repairFiles: ['src/parser.py', 'tests/test_parser.py'],
    });

    expect(result.created).toMatch(/^external\./u);
    const matches = await wiki.search(brief, { language: 'python' });
    const index = JSON.parse(await fs.readFile(path.join(root, 'index.json'), 'utf8')) as {
      layers: { system: { entries: number }; agent: { entries: number }; external: { entries: number } };
    };
    expect(index.layers.system.entries).toBeGreaterThan(0);
    expect(index.layers.agent.entries).toBeGreaterThan(0);
    expect(index.layers.external.entries).toBe(1);
    await expect(fs.readFile(path.join(root, 'README.md'), 'utf8')).resolves.toContain('LLM-wiki');
    await expect(fs.readFile(path.join(root, 'index.md'), 'utf8')).resolves.toContain('wiki/external');
    await expect(fs.readFile(path.join(root, 'log.md'), 'utf8')).resolves.toContain('resolution_created');
    expect(matches.some((match) => match.entry.layer === 'external')).toBe(true);
    expect(matches[0]?.entry.resolutionPlan).toContain('wrong scale conversion');
    expect(matches[0]?.entry.solution).toContain('scale conversion');
    expect(renderDebugWikiMatchesForPrompt(matches)).toContain('debug wiki matches');
    expect(renderDebugWikiMatchesForPrompt(matches)).toContain('priorPlan');
    expect(renderDebugWikiMatchesForPrompt(matches)).toContain('candidateSolution');
    expect(renderDebugWikiMatchesForPrompt(matches)).not.toContain('confirmedSolution');
  });

  it('marks a used entry for review when the solution fails', async () => {
    const root = await tmpRoot();
    const wiki = new DebugWiki(root);
    const brief = buildDebugBrief({
      reason: 'run_tests failed',
      failureLog: 'SyntaxError: unterminated string literal in src/main.py',
      phase: 'CODE',
    });
    const created = await wiki.recordResolution({
      brief,
      ticketId: 'BUG-1',
      stepId: 'S004',
      phase: 'CODE',
      language: 'python',
      solution: 'Fix the string literal.',
    });
    const id = created.created!;

    await wiki.recordUse([id], {
      brief,
      ticketId: 'BUG-2',
      stepId: 'S004',
      phase: 'CODE',
      language: 'python',
      solution: 'retrieved for prompt',
    });
    await wiki.recordFailure([id], {
      brief,
      ticketId: 'BUG-2',
      stepId: 'S004',
      phase: 'CODE',
      language: 'python',
      solution: 'retrieved solution failed',
      reason: 'Debugger repeated the same broken patch',
    });

    const reloaded = new DebugWiki(root);
    await reloaded.load();
    const storedPage = await fs.readFile(path.join(root, 'wiki', 'external', `${id}.md`), 'utf8');
    expect(storedPage).toContain('status: needs_review');
    expect(storedPage).toContain('uses: 1');
    expect(storedPage).toContain('failures: 1');
    expect(storedPage).toContain('kind: failure');
  });

  it('stores bundled agent feedback as an overlay and corrects it after a successful repair', async () => {
    const root = await tmpRoot();
    const wiki = new DebugWiki(root);
    const brief = buildDebugBrief({
      reason: 'Network API failure detected',
      failureLog: 'http_fetch GET https://old.example/api -> HTTP 403 Forbidden',
      phase: 'FUNCTIONAL_TEST',
      targetPhase: 'HIGH_LEVEL_DESIGN',
    });

    const matches = await wiki.search(brief, { language: 'python' });
    const builtin = matches.find((match) => match.entry.id === 'agent.calibration.network-api');
    expect(builtin?.entry.layer).toBe('agent');

    await wiki.recordUse([builtin!.entry.id], {
      brief,
      ticketId: 'BUG-2',
      stepId: 'S002',
      phase: 'HIGH_LEVEL_DESIGN',
      language: 'python',
      solution: 'retrieved for prompt',
    });
    await wiki.recordFailure([builtin!.entry.id], {
      brief,
      ticketId: 'BUG-2',
      stepId: 'S002',
      phase: 'HIGH_LEVEL_DESIGN',
      language: 'python',
      solution: 'old API failed',
      reason: 'HTTP 403 remained',
    });

    await expect(fs.readFile(path.join(root, 'wiki', 'external', 'feedback.jsonl'), 'utf8'))
      .resolves.toContain('agent.calibration.network-api');
    const reloaded = new DebugWiki(root);
    await reloaded.load();
    const index = JSON.parse(await fs.readFile(path.join(root, 'index.json'), 'utf8')) as {
      entries: Array<{ id: string; status: string }>;
    };
    expect(index.entries.find((entry) => entry.id === 'agent.calibration.network-api')?.status).toBe('needs_review');

    const corrected = await wiki.recordResolution({
      brief,
      ticketId: 'BUG-2',
      stepId: 'S002',
      phase: 'HIGH_LEVEL_DESIGN',
      language: 'python',
      solution: 'Switch to a maintained no-key public API and verify the response shape.',
      usedEntryIds: [builtin!.entry.id],
    });

    expect(corrected.created).toMatch(/^external\./u);
    const correctedIndex = JSON.parse(await fs.readFile(path.join(root, 'index.json'), 'utf8')) as {
      entries: Array<{ id: string; status: string }>;
    };
    expect(correctedIndex.entries.find((entry) => entry.id === 'agent.calibration.network-api')?.status).toBe('active');
    const externalPage = await fs.readFile(path.join(root, 'wiki', 'external', `${corrected.created}.md`), 'utf8');
    expect(externalPage).toContain('agent.calibration.network-api');
    expect(externalPage).toContain('Switch to a maintained no-key public API');
  });

  it('creates a replacement instead of reactivating another Bug\'s reviewed entry', async () => {
    const root = await tmpRoot();
    const wiki = new DebugWiki(root);
    const brief = buildDebugBrief({
      reason: 'Network API failure detected',
      failureLog: 'http_fetch GET https://old.example/api -> HTTP 403 Forbidden',
      phase: 'FUNCTIONAL_TEST',
      targetPhase: 'HIGH_LEVEL_DESIGN',
    });
    const created = await wiki.recordResolution({
      brief,
      ticketId: 'BUG-1',
      stepId: 'S002',
      phase: 'HIGH_LEVEL_DESIGN',
      language: 'python',
      solution: 'Retry the same old API.',
    });
    const id = created.created!;
    await wiki.recordFailure([id], {
      brief,
      ticketId: 'BUG-2',
      stepId: 'S002',
      phase: 'HIGH_LEVEL_DESIGN',
      language: 'python',
      solution: 'old API failed',
      reason: 'HTTP 403 remained',
    });

    const replacement = await wiki.recordResolution({
      brief,
      ticketId: 'BUG-2',
      stepId: 'S002',
      phase: 'HIGH_LEVEL_DESIGN',
      language: 'python',
      solution: 'Switch to a maintained no-key public API and verify the response shape.',
      usedEntryIds: [id],
    });

    const reloaded = new DebugWiki(root);
    await reloaded.load();
    const index = JSON.parse(await fs.readFile(path.join(root, 'index.json'), 'utf8')) as {
      entries: Array<{ id: string; status: string }>;
    };
    expect(replacement.created).toMatch(/^external\./u);
    expect(index.entries.find((entry) => entry.id === id)?.status).toBe('needs_review');
    const oldPage = await fs.readFile(path.join(root, 'wiki', 'external', `${id}.md`), 'utf8');
    const replacementPage = await fs.readFile(
      path.join(root, 'wiki', 'external', `${replacement.created}.md`),
      'utf8',
    );
    expect(oldPage).toContain('Retry the same old API.');
    expect(oldPage).not.toContain('Switch to a maintained no-key public API');
    expect(replacementPage).toContain('Switch to a maintained no-key public API');
    expect(replacementPage).toContain(id);
  });

  it('does not merge a different Bug into an active retrieved entry', async () => {
    const root = await tmpRoot();
    const wiki = new DebugWiki(root);
    const firstBrief = buildDebugBrief({
      reason: 'functional test failed',
      failureLog: 'tests/functional/cli.test.ts: CLI exited with status 1',
      phase: 'FUNCTIONAL_TEST',
      targetPhase: 'REQUIREMENT_ANALYSIS',
    });
    const first = await wiki.recordResolution({
      brief: firstBrief,
      ticketId: 'BUG-1',
      stepId: 'S001',
      phase: 'REQUIREMENT_ANALYSIS',
      language: 'typescript',
      solution: 'Correct the CLI acceptance contract.',
    });
    const firstId = first.created!;
    const secondBrief = buildDebugBrief({
      reason: 'another functional test failed',
      failureLog: 'tests/functional/network.test.ts: live HTTP request timed out',
      phase: 'FUNCTIONAL_TEST',
      targetPhase: 'REQUIREMENT_ANALYSIS',
    });

    await wiki.recordUse([firstId], {
      brief: secondBrief,
      ticketId: 'BUG-2',
      stepId: 'S001',
      phase: 'REQUIREMENT_ANALYSIS',
      language: 'typescript',
      solution: 'retrieved as a hypothesis',
    });
    const second = await wiki.recordResolution({
      brief: secondBrief,
      ticketId: 'BUG-2',
      stepId: 'S001',
      phase: 'REQUIREMENT_ANALYSIS',
      language: 'typescript',
      solution: 'Replace live HTTP calls in tests with deterministic recorded fixtures.',
      usedEntryIds: [firstId],
    });

    expect(second.created).toMatch(/^external\./u);
    expect(second.updated).toEqual([]);
    const firstPage = await fs.readFile(path.join(root, 'wiki', 'external', `${firstId}.md`), 'utf8');
    const secondPage = await fs.readFile(path.join(root, 'wiki', 'external', `${second.created}.md`), 'utf8');
    expect(firstPage).toContain('Correct the CLI acceptance contract.');
    expect(firstPage).not.toContain('deterministic recorded fixtures');
    expect(secondPage).toContain('deterministic recorded fixtures');
    expect(secondPage).not.toContain('supersedes:');
  });

  it('quarantines legacy pages that merged several unrelated solutions', async () => {
    const root = await tmpRoot();
    const wiki = new DebugWiki(root);
    const brief = buildDebugBrief({
      reason: 'functional test failed',
      failureLog: 'tests/functional/cli.test.ts exited with status 1',
      phase: 'FUNCTIONAL_TEST',
      targetPhase: 'REQUIREMENT_ANALYSIS',
    });
    const first = await wiki.recordResolution({
      brief,
      ticketId: 'BUG-LEGACY',
      stepId: 'S001',
      phase: 'REQUIREMENT_ANALYSIS',
      solution: 'First unrelated guess.',
    });
    await wiki.recordResolution({
      brief,
      ticketId: 'BUG-LEGACY',
      stepId: 'S001',
      phase: 'REQUIREMENT_ANALYSIS',
      solution: 'Second unrelated guess.',
    });
    await wiki.recordResolution({
      brief,
      ticketId: 'BUG-LEGACY',
      stepId: 'S001',
      phase: 'REQUIREMENT_ANALYSIS',
      solution: 'Third unrelated guess.',
    });

    const reloaded = new DebugWiki(root);
    const match = (await reloaded.search(brief)).find((item) => item.entry.id === first.created)!;
    expect(match.entry.status).toBe('needs_review');
    const rendered = renderDebugWikiMatchesForPrompt([match]);
    expect(rendered).toContain('disputedSolution: hidden');
    expect(rendered).not.toContain('First unrelated guess.');
    await expect(fs.readFile(path.join(root, 'wiki', 'external', `${first.created}.md`), 'utf8'))
      .resolves.toContain('status: needs_review');
  });
});
