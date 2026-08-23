import { createHash } from 'node:crypto';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { Ticket, TicketWorkspaceBinding } from '../../domain/tickets/ticket.js';
import type { ContextRecord } from '../../domain/context/context_record.js';
import type { DebugBrief } from '../../core/debug_brief.js';
import type { DebugWikiMatch } from '../../core/debug_wiki.js';
import { isCorrectiveTicket } from '../../domain/tickets/ticket.js';
import { ContextService } from './context_service.js';

/** Guards against a malformed parent chain turning assembly into an unbounded walk. */
export const MAX_TICKET_CHAIN_DEPTH = 16;

export class TicketHierarchyCycleError extends Error {
  constructor(ticketId: string) {
    super(`Ticket ${ticketId} appears twice in its own parent chain`);
    this.name = 'TicketHierarchyCycleError';
  }
}

export interface ContextAssemblyRequest {
  projectId: ObjectId;
  phaseId?: ObjectId;
  stepId?: ObjectId;
  ticketId?: ObjectId;
  /** Total characters the assembled context may occupy. */
  budgetChars?: number;
  /**
   * The failure to search the Debug Wiki with. Supplied only when a Bug is in scope; retrieval is
   * skipped for every other Ticket type, so an ordinary Ticket never inherits another Ticket's
   * defect history.
   */
  debugBrief?: DebugBrief;
}

/** The retrieval half of the Debug Wiki. Narrow on purpose: assembly reads, it never writes. */
export interface DebugWikiRetrievalPort {
  search(
    brief: DebugBrief,
    options: { limit?: number; language?: string },
  ): Promise<DebugWikiMatch[]>;
}

export interface ContextAssemblerOptions {
  /** Omitted where no wiki is available; assembly then records no entries rather than failing. */
  wiki?: DebugWikiRetrievalPort;
  /** Top-K. The relevance floor is the wiki's own, so retrieval has one definition. */
  wikiLimit?: number;
  language?: string;
}

/**
 * What a parent Ticket contributes to its child's execution.
 *
 * Bounded on purpose: a parent's full history is mostly failed attempts and tool output, which
 * crowds out the current task without telling the child anything it can act on. What survives is
 * what constrains the child — objective, constraints, acceptance, and accepted decisions.
 */
export interface TicketContextView {
  ticketId: ObjectId;
  name: string;
  objective: string;
  constraints: string[];
  acceptance: string[];
  acceptedDecisions: string[];
  workspace?: TicketWorkspaceBinding;
}

export interface ContextSnapshot {
  projectContextRevision?: number;
  phaseContextRevision?: number;
  stepContextRevision?: number;
  ticketContextRevisions: Record<string, number>;
  debugWikiEntryIds: string[];
  assembledContextHash: string;
  createdAt: string;
}

export interface AssembledContext {
  project?: ContextRecord;
  phase?: ContextRecord;
  step?: ContextRecord;
  /** Root first, current last, so a reader meets constraints before the task they apply to. */
  ticketChain: TicketContextView[];
  /** Empty unless a Bug was in scope and a wiki was available. */
  debugWikiMatches: DebugWikiMatch[];
  snapshot: ContextSnapshot;
  text: string;
}

/**
 * Builds the context one role execution sees.
 *
 * Assembly is scoped by what is actually being worked on: with no Ticket in scope there is no
 * Ticket context and no Debug Wiki lookup, because neither describes the work. Loading them anyway
 * is how a prompt fills with a previous task's details.
 */
export class ContextAssembler {
  private readonly context: ContextService;

  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    private readonly options: ContextAssemblerOptions = {},
  ) {
    this.context = new ContextService(repository);
  }

  async assemble(request: ContextAssemblyRequest): Promise<AssembledContext> {
    const project = await this.context.find(request.projectId, 'project', request.projectId);
    const phase = request.phaseId
      ? await this.context.find(request.projectId, 'phase', request.phaseId)
      : undefined;
    const step = request.stepId
      ? await this.context.find(request.projectId, 'step', request.stepId)
      : undefined;

    const chain = request.ticketId ? await this.ticketChain(request.ticketId) : [];
    const ticketRevisions: Record<string, number> = {};
    const ticketChain: TicketContextView[] = [];
    for (const ticket of chain) {
      const record = await this.context.find(request.projectId, 'ticket', ticket.id);
      if (record) ticketRevisions[ticket.id] = record.revision;
      ticketChain.push(viewOf(ticket, record));
    }

    const debugWikiMatches = await this.retrieveDebugWiki(chain.at(-1), request);
    const text = renderContext(
      { project, phase, step, ticketChain, debugWikiMatches },
      request.budgetChars,
    );
    return {
      project,
      phase,
      step,
      ticketChain,
      debugWikiMatches,
      text,
      snapshot: {
        projectContextRevision: project?.revision,
        phaseContextRevision: phase?.revision,
        stepContextRevision: step?.revision,
        ticketContextRevisions: ticketRevisions,
        debugWikiEntryIds: debugWikiMatches.map((match) => match.entry.id),
        assembledContextHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        createdAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Debug Wiki retrieval, restricted to a Bug in scope.
   *
   * The current Ticket decides, not its ancestry: a Task whose parent Story once had a Bug is not
   * debugging anything, and loading that Bug's history would push the actual task out of the
   * prompt.
   */
  private async retrieveDebugWiki(
    current: Ticket | undefined,
    request: ContextAssemblyRequest,
  ): Promise<DebugWikiMatch[]> {
    // Every corrective type, not only Bug. A Change Request repairing a contract and an Enhancement
    // closing a quality shortfall are both debugging something, and the wiki holds what previous
    // runs learned about exactly those failures.
    if (!current || !isCorrectiveTicket(current.type)) return [];
    if (!this.options.wiki || !request.debugBrief) return [];
    return this.options.wiki.search(request.debugBrief, {
      limit: this.options.wikiLimit ?? 3,
      language: this.options.language,
    });
  }

  /**
   * Resolves a Ticket's ancestry, root first.
   *
   * Rejects a cycle rather than looping, refuses a parent from another Project, and stops at a
   * depth cap: a malformed chain must fail visibly, because silently truncating it would hand the
   * role a context that omits the constraints it is supposed to honour.
   */
  async ticketChain(ticketId: ObjectId): Promise<Ticket[]> {
    const seen = new Set<string>();
    const chain: Ticket[] = [];
    let current: Ticket | undefined = await this.requireTicket(ticketId);
    const projectId = current.projectId;
    while (current) {
      if (seen.has(current.id)) throw new TicketHierarchyCycleError(current.id);
      if (current.projectId !== projectId) {
        throw new Error(`Ticket ${current.id} belongs to another Project and cannot be a parent`);
      }
      seen.add(current.id);
      chain.push(current);
      if (chain.length > MAX_TICKET_CHAIN_DEPTH) {
        throw new Error(`Ticket ${ticketId} parent chain exceeds ${MAX_TICKET_CHAIN_DEPTH} levels`);
      }
      current = current.parentTicketId ? await this.requireTicket(current.parentTicketId) : undefined;
    }
    return chain.reverse();
  }

  private async requireTicket(id: ObjectId): Promise<Ticket> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'ticket') throw new Error(`Object ${id} is not a Ticket`);
    return object;
  }
}

function viewOf(ticket: Ticket, record?: ContextRecord): TicketContextView {
  return {
    ticketId: ticket.id,
    name: ticket.name,
    objective: record?.objective || ticket.description,
    constraints: record?.constraints ?? [],
    acceptance: record?.acceptance.length ? record.acceptance : [...ticket.acceptance],
    acceptedDecisions: (record?.decisions ?? [])
      .filter((decision) => decision.status === 'accepted')
      .map((decision) => decision.decision),
    workspace: ticket.workspaceBinding,
  };
}

function renderContext(
  parts: {
    project?: ContextRecord;
    phase?: ContextRecord;
    step?: ContextRecord;
    ticketChain: TicketContextView[];
    debugWikiMatches: DebugWikiMatch[];
  },
  budgetChars?: number,
): string {
  const sections: string[] = [];
  for (const [heading, record] of [
    ['Project Context', parts.project],
    ['Phase Context', parts.phase],
    ['Step Context', parts.step],
  ] as const) {
    if (!record) continue;
    sections.push([
      `## ${heading}`,
      record.objective && `objective: ${record.objective}`,
      record.progress && `progress: ${record.progress}`,
      ...record.constraints.map((item) => `constraint: ${item}`),
      ...record.acceptance.map((item) => `acceptance: ${item}`),
      ...record.findings.map((item) => `finding: ${item.text}`),
      ...record.decisions
        .filter((item) => item.status === 'accepted')
        .map((item) => `decision: ${item.decision}`),
      ...record.openQuestions
        .filter((item) => item.status === 'open')
        .map((item) => `open question: ${item.question}`),
    ].filter(Boolean).join('\n'));
  }
  if (parts.ticketChain.length > 0) {
    sections.push(['## Ticket Hierarchy', ...parts.ticketChain.map((view, index) => [
      `### ${index === parts.ticketChain.length - 1 ? 'Current' : 'Parent'} ${view.name}`,
      `objective: ${view.objective}`,
      ...(view.workspace
        ? [
            `workspace: ${view.workspace.kind} ${view.workspace.relativePath}`,
            `branch: ${view.workspace.branch}`,
            `workspace revision: ${view.workspace.revision}`,
            'tool path rule: every file-tool path is relative to this workspace root; never include the workspace prefix',
          ]
        : []),
      ...view.constraints.map((item) => `constraint: ${item}`),
      ...view.acceptance.map((item) => `acceptance: ${item}`),
      ...view.acceptedDecisions.map((item) => `decision: ${item}`),
    ].join('\n'))].join('\n\n'));
  }
  if (parts.debugWikiMatches.length > 0) {
    sections.push([
      '## Debug Wiki (validate before applying)',
      'These are hypotheses. Current files and executable failure evidence always take precedence.',
      ...parts.debugWikiMatches.map((match) =>
        match.entry.status === 'needs_review'
          ? `- ${match.entry.id} status=needs_review: prior solution intentionally hidden; derive a fresh solution from current evidence`
          : `- ${match.entry.id} status=${match.entry.status} confidence=${match.confidence?.toFixed(2) ?? 'unknown'}: ${match.entry.solution}`),
    ].join('\n'));
  }
  const text = sections.join('\n\n');
  if (budgetChars === undefined || text.length <= budgetChars) return text;
  // Trimming keeps the head: Project and Phase constraints bound everything below them, so losing
  // the tail costs detail while losing the head would drop the rules the work must satisfy.
  return `${text.slice(0, Math.max(0, budgetChars - 20))}\n... context trimmed`;
}
