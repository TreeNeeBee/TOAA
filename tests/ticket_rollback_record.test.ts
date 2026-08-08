import { describe, expect, it } from 'vitest';
import {
  appendTicketCommit,
  attemptBaselineRevision,
  lastVerifiedRevision,
  type Ticket,
  type TicketCommit,
} from '../src/domain/tickets/ticket.js';

const stepId = '019fd0e5-5210-7e41-8d33-fd207dc4de96';

function commit(overrides: Partial<TicketCommit>): TicketCommit {
  return {
    revision: 'a'.repeat(40),
    kind: 'baseline',
    attempt: 0,
    stepId,
    summary: 'fixture',
    recordedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function ticket(): Ticket {
  return {
    id: '019fd0e5-5210-7e03-9b5e-4876a0541efd',
    name: 'P1-S004-STORY',
    objectType: 'ticket',
    type: 'task',
    workKind: 'planned-work',
    projectId: '019fd0e5-5210-7e03-9b5e-4876a0541eff',
    phaseId: '019fd0e5-5210-7e03-9b5e-4876a0541efa',
    role: 'developer',
    agent: 'Coder',
    creatorActorId: '019fd0e5-5210-7e03-9b5e-4876a0541efb',
    rootTicketId: '019fd0e5-5210-7e03-9b5e-4876a0541efd',
    priority: 128,
    description: 'fixture',
    acceptance: ['done'],
    state: 'in_progress',
    source: { kind: 'runtime', correlationId: '019fd0e5-5210-7e03-9b5e-4876a0541efc' },
    submittedAt: new Date(0).toISOString(),
    schemaVersion: 1,
    revision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    commits: [],
  } as unknown as Ticket;
}

describe('ticket rollback record', () => {
  it('fixes the ticket baseline at the first recorded baseline commit', () => {
    const first = appendTicketCommit(ticket(), commit({ revision: 'b'.repeat(40) }));
    const later = appendTicketCommit(first, commit({ revision: 'c'.repeat(40), attempt: 1 }));
    expect(later.baselineRevision).toBe('b'.repeat(40));
  });

  it('rolls an attempt back to its own baseline, not the ticket baseline', () => {
    let subject = appendTicketCommit(ticket(), commit({ revision: 'b'.repeat(40), attempt: 0 }));
    subject = appendTicketCommit(subject, commit({ revision: 'c'.repeat(40), kind: 'verified', attempt: 0 }));
    subject = appendTicketCommit(subject, commit({ revision: 'd'.repeat(40), attempt: 1 }));

    // This is the boundary that matters when a corrective Ticket reuses a worktree: unwinding
    // attempt 1 must not discard the work attempt 0 already got through its gate.
    expect(attemptBaselineRevision(subject, 1)).toBe('d'.repeat(40));
    expect(attemptBaselineRevision(subject, 0)).toBe('b'.repeat(40));
    expect(lastVerifiedRevision(subject)).toBe('c'.repeat(40));
  });

  it('keeps rolled-back attempts in the record rather than erasing them', () => {
    let subject = appendTicketCommit(ticket(), commit({ revision: 'b'.repeat(40) }));
    subject = appendTicketCommit(subject, commit({ revision: 'e'.repeat(40), kind: 'attempt' }));
    expect(subject.commits.map((entry) => entry.kind)).toEqual(['baseline', 'attempt']);
  });

  it('reports no baseline for an attempt that never started', () => {
    expect(attemptBaselineRevision(ticket(), 3)).toBeUndefined();
  });
});
