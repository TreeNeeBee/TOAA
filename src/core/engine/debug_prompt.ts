import type { AuditLogger } from '../../audit/audit.js';
import {
  calibrateDebugSuggestions,
  renderDebugSuggestions,
} from '../../agents/calibration.js';
import {
  buildDebugBrief,
  compactFailureEvidence,
  renderDebugBriefForPrompt,
} from '../debug_brief.js';
import { renderDebugWikiMatchesForPrompt } from '../debug_wiki.js';
import type { Step } from '../plan.js';
import { TicketStore } from '../ticket.js';
import { DebugWikiFeedbackService } from './debug_wiki_feedback.js';
import {
  isSupersededNetworkBrief,
  testRollbackTriageGuidance,
} from './v_model_policy.js';

export interface DebugPromptContext {
  reason: string;
  bugTicketId?: string;
  contextMode?: 'audit-repair' | 'iteration-gate' | 'test-rollback';
  debugWikiEntryIds?: string[];
}

export interface DebugPromptPayload {
  debugBrief: string;
  failureLog: string;
  suggestions: string;
  debugWikiEntryIds: string[];
}

export async function buildDebugPromptPayload(input: {
  step: Step;
  debug: DebugPromptContext;
  failureLog: string;
  tickets: TicketStore;
  debugWiki: DebugWikiFeedbackService;
  audit: AuditLogger;
  language: string;
}): Promise<DebugPromptPayload> {
  const bug = input.debug.bugTicketId
    ? input.tickets.findBug(input.debug.bugTicketId)
    : undefined;
  const currentBrief = buildDebugBrief({
    reason: input.debug.reason,
    failureLog: input.failureLog,
    phase: bug?.source.phase ?? input.step.phase,
    targetPhase: bug?.targetPhase ?? input.step.phase,
  });
  const rootBrief = bug?.debugBrief &&
    !isSupersededNetworkBrief(bug.debugBrief, currentBrief)
    ? bug.debugBrief
    : undefined;
  const enhancement = bug?.enhanceTicketId
    ? input.tickets.findEnhance(bug.enhanceTicketId)
    : undefined;
  const enhancementBlock = enhancement
    ? [
        '## enhancement finding',
        `id: ${enhancement.id}`,
        `kind: ${enhancement.kind}`,
        `finding: ${enhancement.finding}`,
        'This identifies the quality gap; it is not a downstream change request.',
        '',
      ]
    : [];
  const briefBlocks = [
    ...enhancementBlock,
    ...(rootBrief && rootBrief.summary !== currentBrief.summary
      ? [
          '## root bug ticket brief',
          renderDebugBriefForPrompt(rootBrief),
          '',
          '## current retry brief',
          renderDebugBriefForPrompt(currentBrief),
        ]
      : [renderDebugBriefForPrompt(currentBrief)]),
  ];
  const evidence = compactFailureEvidence({
    reason: input.debug.reason,
    failureLog: input.failureLog,
    phase: bug?.source.phase ?? input.step.phase,
    targetPhase: bug?.targetPhase ?? input.step.phase,
    maxChars: 2600,
    maxLines: 50,
  });
  const suggestions = [
    input.debug.contextMode === 'test-rollback'
      ? testRollbackTriageGuidance(currentBrief)
      : '',
    renderDebugSuggestions(
      calibrateDebugSuggestions(input.failureLog, input.debug.reason),
    ),
  ].filter(Boolean).join('\n\n');
  const wikiMatches = await input.debugWiki.search(currentBrief, 3);
  const debugWikiEntryIds = wikiMatches.map((match) => match.entry.id);
  if (debugWikiEntryIds.length > 0) {
    input.debug.debugWikiEntryIds = dedup([
      ...(input.debug.debugWikiEntryIds ?? []),
      ...debugWikiEntryIds,
    ]);
    if (bug) {
      bug.debugWikiEntryIds = dedup([
        ...(bug.debugWikiEntryIds ?? []),
        ...debugWikiEntryIds,
      ]);
    }
    await input.debugWiki.recordUse(debugWikiEntryIds, {
      brief: currentBrief,
      ticketId: bug?.id,
      stepId: input.step.id,
      phase: input.step.phase,
      targetPhase: bug?.targetPhase,
      language: input.language,
      solution: 'retrieved for Debugger prompt',
    });
    await input.audit.event(
      'note',
      `debug wiki matched ${debugWikiEntryIds.join(', ')}`,
      {
        messageId: 'engine.debug_wiki_matched',
        entryIds: debugWikiEntryIds,
        stepId: input.step.id,
        phase: input.step.phase,
      },
    );
  }
  const wikiPrompt = renderDebugWikiMatchesForPrompt(wikiMatches);
  return {
    debugBrief: [briefBlocks.join('\n'), wikiPrompt].filter(Boolean).join('\n\n'),
    failureLog: evidence,
    suggestions,
    debugWikiEntryIds,
  };
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
