export const ISSUE_STATUSES = [
  'recorded',
  'routed',
  'change_pending',
  'resolved',
  'unresolved',
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

const ISSUE_TRANSITIONS: StateTransitions<IssueStatus> = {
  recorded: ['routed', 'resolved', 'unresolved'],
  routed: ['change_pending', 'resolved', 'unresolved'],
  change_pending: ['routed', 'resolved', 'unresolved'],
  unresolved: ['routed', 'change_pending', 'resolved'],
  resolved: [],
};

export function transitionIssue<T extends { id?: string; status: IssueStatus; updatedAt: string }>(
  issue: T,
  next: IssueStatus,
  at = new Date().toISOString(),
): boolean {
  const changed = assertStateTransition(
    'issue',
    issue.id ?? 'issue',
    issue.status,
    next,
    ISSUE_TRANSITIONS,
  );
  if (!changed) return false;
  issue.status = next;
  issue.updatedAt = at;
  return true;
}
import { assertStateTransition, type StateTransitions } from '../util/state_machine.js';
