import type { AuditLogger } from '../../audit/audit.js';
import {
  buildDebugBrief,
  type DebugBrief,
} from '../debug_brief.js';
import {
  DebugWiki,
  type DebugWikiMatch,
  type DebugWikiResolutionInput,
} from '../debug_wiki.js';
import type { BugTicket } from '../ticket.js';
import type { Step } from '../plan.js';
import { cleanFailureLogForDebugContext } from '../debug_policy.js';

export class DebugWikiFeedbackService {
  constructor(
    private readonly wiki: DebugWiki,
    private readonly audit: AuditLogger,
    private readonly strict: boolean,
    private readonly language: () => string,
  ) {}

  get path(): string {
    return this.wiki.filePath;
  }

  async load(): Promise<void> {
    await this.safe('load', () => this.wiki.load(), undefined);
  }

  async search(brief: DebugBrief, limit = 3): Promise<DebugWikiMatch[]> {
    return this.safe(
      'search',
      () => this.wiki.search(brief, { language: this.language(), limit }),
      [],
    );
  }

  async recordUse(
    entryIds: string[],
    input: DebugWikiResolutionInput,
  ): Promise<void> {
    await this.safe(
      'record-use',
      () => this.wiki.recordUse(entryIds, input),
      undefined,
    );
  }

  async recordFailure(input: {
    step: Step;
    bug?: BugTicket;
    entryIds: string[];
    reason: string;
    failureLog: string;
  }): Promise<void> {
    if (input.entryIds.length === 0) return;
    const brief = buildDebugBrief({
      reason: input.reason,
      failureLog: cleanFailureLogForDebugContext(input.failureLog),
      phase: input.bug?.source.phase ?? input.step.phase,
      targetPhase: input.bug?.targetPhase ?? input.step.phase,
    });
    await this.safe(
      'record-failure',
      () => this.wiki.recordFailure(input.entryIds, {
        brief,
        ticketId: input.bug?.id,
        stepId: input.step.id,
        phase: input.step.phase,
        targetPhase: input.bug?.targetPhase,
        language: this.language(),
        solution: 'retrieved wiki solution did not resolve this attempt',
        reason: input.reason,
      }),
      undefined,
    );
    await this.audit.event(
      'note',
      `debug wiki marked ${input.entryIds.join(', ')} for review`,
      {
        messageId: 'engine.debug_wiki_feedback',
        kind: 'failure',
        entryIds: input.entryIds,
        ticketId: input.bug?.id,
        stepId: input.step.id,
        reason: input.reason,
      },
    );
  }

  async recordResolution(
    bug: BugTicket,
    step: Step,
    repair?: BugTicket['repair'],
  ): Promise<void> {
    const brief = bug.debugBrief ?? buildDebugBrief({
      reason: bug.reason,
      failureLog: bug.failureLog,
      phase: bug.source.phase,
      targetPhase: bug.targetPhase,
    });
    const repairFiles = repair?.changedFiles?.length ? repair.changedFiles : step.outputs;
    const repairedStepId = repair?.repairedStepId ?? step.id;
    const repairedPhase = repair?.repairedPhase ?? step.phase;
    const evidenceSummary = [
      `Resolved ${bug.kind} by Debugger in ${repairedStepId}/${repairedPhase}.`,
      `Mode: ${repair?.mode ?? 'verification'}.`,
      repairFiles.length > 0 ? `Changed/verified files: ${repairFiles.join(', ')}.` : '',
      repair?.patchPath ? `Patch: ${repair.patchPath}.` : '',
      `Demand: ${brief.debugDemand}`,
    ].filter(Boolean).join(' ');
    const solution = bug.bugResolutionPlan
      ? `${bug.bugResolutionPlan}\nResolution evidence: ${evidenceSummary}`
      : evidenceSummary;
    const result = await this.safe(
      'record-resolution',
      () => this.wiki.recordResolution({
        brief,
        ticketId: bug.id,
        stepId: step.id,
        phase: step.phase,
        targetPhase: bug.targetPhase,
        language: this.language(),
        resolutionPlan: bug.bugResolutionPlan,
        solution,
        evidence: brief.evidence,
        repairFiles,
        usedEntryIds: bug.debugWikiEntryIds,
      }),
      { updated: [] },
    );
    if (result.created || result.updated.length > 0) {
      await this.audit.event('note', `debug wiki updated after ${bug.id}`, {
        messageId: 'engine.debug_wiki_updated',
        ticketId: bug.id,
        created: result.created,
        updated: result.updated,
      });
    }
  }

  private async safe<T>(
    operation: string,
    action: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      const message = (error as Error).message;
      await this.audit.event('note', `debug wiki ${operation} failed: ${message}`, {
        messageId: 'engine.debug_wiki_failed',
        operation,
        path: this.wiki.filePath,
        error: message,
      });
      if (this.strict) throw error;
      return fallback;
    }
  }
}
