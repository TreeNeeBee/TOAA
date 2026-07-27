import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IssueJournal } from '../src/core/issue_journal.js';
import { Workspace } from '../src/workspace/workspace.js';

describe('IssueJournal', () => {
  it('updates snapshots while appending lifecycle events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-issue-journal-'));
    const journal = new IssueJournal(new Workspace(root));
    const issue = {
      id: 'ISSUE-1',
      status: 'recorded' as const,
      kind: 'phase',
      reason: 'first failure',
    };

    await journal.persist(issue, 'recorded');
    await journal.persist(
      { ...issue, status: 'resolved', issueResolutionPlan: 'repair and verify' },
      'resolved',
    );

    const events = (await fs.readFile(
      path.join(root, '.xcompiler/issues/issues.jsonl'),
      'utf8',
    )).trim().split('\n').map((line) => JSON.parse(line) as { event: string });
    const snapshot = JSON.parse(await fs.readFile(
      path.join(root, '.xcompiler/issues/ISSUE-1.json'),
      'utf8',
    )) as { status: string };

    expect(events.map((event) => event.event)).toEqual(['recorded', 'resolved']);
    expect(snapshot.status).toBe('resolved');
  });
});
