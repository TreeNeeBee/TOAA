import type { Workspace } from '../workspace/workspace.js';
import type { IssueStatus } from './issue_state.js';

export interface IssueJournalEntry {
  id: string;
  status: IssueStatus;
  kind: string;
  stepId?: string;
  phase?: string;
  targetStepId?: string;
  targetPhase?: string;
  reason: string;
  debugBrief?: {
    summary: string;
    debugDemand: string;
  };
  debugWikiEntryIds?: string[];
  issueResolutionPlan?: string;
  activeChangeRequestId?: string;
  changeRequestIds?: string[];
  causedByChangeRequestId?: string;
}

/**
 * Persists the current issue snapshot and an append-only lifecycle journal.
 * The journal never reads historical JSONL back into memory.
 */
export class IssueJournal {
  constructor(private readonly workspace: Workspace) {}

  async persist(
    issue: IssueJournalEntry,
    event: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.workspace.writeFile(
      `.xcompiler/issues/${issue.id}.json`,
      `${JSON.stringify(issue, null, 2)}\n`,
    );
    await this.workspace.appendFile(
      '.xcompiler/issues/issues.jsonl',
      `${JSON.stringify({
        event,
        at: new Date().toISOString(),
        issueId: issue.id,
        status: issue.status,
        kind: issue.kind,
        stepId: issue.stepId,
        phase: issue.phase,
        targetStepId: issue.targetStepId,
        targetPhase: issue.targetPhase,
        reason: issue.reason,
        debugSummary: issue.debugBrief?.summary,
        debugDemand: issue.debugBrief?.debugDemand,
        debugWikiEntryIds: issue.debugWikiEntryIds,
        issueResolutionPlan: issue.issueResolutionPlan,
        activeChangeRequestId: issue.activeChangeRequestId,
        changeRequestIds: issue.changeRequestIds,
        causedByChangeRequestId: issue.causedByChangeRequestId,
        ...extra,
      })}\n`,
    );
  }
}
