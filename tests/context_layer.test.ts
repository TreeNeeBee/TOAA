import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import { ContextService } from '../src/application/context/context_service.js';
import {
  ContextAssembler,
  MAX_TICKET_CHAIN_DEPTH,
  TicketHierarchyCycleError,
} from '../src/application/context/context_assembler.js';
import {
  ContextAuthorityError,
  ContextRevisionConflictError,
} from '../src/domain/context/context_record.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { ProjectContainer } from '../src/workspace/project_container.js';
import { PLAN_VERSION, type Plan } from '../src/core/plan.js';
import { STEP_TYPES } from '../src/domain/steps/step.js';
import { bindTicketWorkspace, type Ticket } from '../src/domain/tickets/ticket.js';
import { TicketWorkflow } from '../src/application/project_management/ticket_workflow.js';
import { bugContracts } from './helpers/ticket_fixtures.js';
import { createObjectId } from '../src/domain/identity/object_id.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-context-'));
  const container = new ProjectContainer(root);
  const repository = new DomainObjectRepository(container.state);
  await repository.load();
  const graph = compileProjectGraph({
    draft: samplePlan(),
    topic: 'Build a TypeScript application.',
    projectName: 'fixture',
  });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  const story = graph.tickets.find(
    (t): t is Ticket => t.type === 'story' && t.workKind === 'v-model-step',
  )!;
  return {
    repository,
    graph,
    story,
    context: new ContextService(repository),
    assembler: new ContextAssembler(repository),
    actorId: graph.actors[0]!.id,
  };
}

describe('context updates', () => {
  it('refuses a stale write instead of overwriting another role', async () => {
    const { context, graph, actorId } = await fixture();
    const projectId = graph.project.id;
    const record = await context.ensure(projectId, 'project', projectId);

    await context.apply(projectId, {
      scope: 'project', ownerId: projectId, expectedRevision: record.revision,
      operation: 'append-finding', actorId, text: 'first writer',
    });

    // Second writer still holds the revision it read before the first write landed.
    await expect(context.apply(projectId, {
      scope: 'project', ownerId: projectId, expectedRevision: record.revision,
      operation: 'append-finding', actorId, text: 'second writer',
    })).rejects.toBeInstanceOf(ContextRevisionConflictError);
  });

  it('lets an executing role record what it learned but not rewrite its acceptance', async () => {
    const { context, graph, story, actorId } = await fixture();
    const projectId = graph.project.id;
    let record = await context.ensure(projectId, 'ticket', story.id);

    record = await context.apply(projectId, {
      scope: 'ticket', ownerId: story.id, expectedRevision: record.revision,
      operation: 'append-finding', actorId, text: 'the parser rejects empty input',
    });
    expect(record.findings[0]!.text).toBe('the parser rejects empty input');
    expect(record.findings[0]!.actorId).toBe(actorId);

    await expect(context.apply(projectId, {
      scope: 'ticket', ownerId: story.id, expectedRevision: record.revision,
      operation: 'set-acceptance', actorId, values: ['whatever I managed'],
    })).rejects.toBeInstanceOf(ContextAuthorityError);
  });

  it('keeps a proposed decision non-binding until the authority accepts it', async () => {
    const { context, graph, story, actorId } = await fixture();
    const projectId = graph.project.id;
    let record = await context.ensure(projectId, 'ticket', story.id);
    record = await context.apply(projectId, {
      scope: 'ticket', ownerId: story.id, expectedRevision: record.revision,
      operation: 'propose-decision', actorId, text: 'use streaming parse', rationale: 'memory',
    });
    expect(record.decisions[0]!.status).toBe('proposed');

    record = await context.apply(projectId, {
      scope: 'ticket', ownerId: story.id, expectedRevision: record.revision,
      operation: 'accept-decision', actorId, hasAuthority: true, targetId: record.decisions[0]!.id,
    });
    expect(record.decisions[0]!.status).toBe('accepted');
  });
});

describe('context assembly', () => {
  it('loads no ticket context when no ticket is in scope', async () => {
    const { assembler, context, graph, story, actorId } = await fixture();
    const projectId = graph.project.id;
    const record = await context.ensure(projectId, 'ticket', story.id);
    await context.apply(projectId, {
      scope: 'ticket', ownerId: story.id, expectedRevision: record.revision,
      operation: 'append-finding', actorId, text: 'ticket-only detail',
    });

    const assembled = await assembler.assemble({ projectId });
    expect(assembled.ticketChain).toEqual([]);
    expect(assembled.text).not.toContain('ticket-only detail');
    expect(assembled.snapshot.ticketContextRevisions).toEqual({});
  });

  it('orders the parent chain root first and records each source revision', async () => {
    const { assembler, context, graph, story } = await fixture();
    const projectId = graph.project.id;
    await context.ensure(projectId, 'ticket', story.id);

    const assembled = await assembler.assemble({ projectId, ticketId: story.id });
    const names = assembled.ticketChain.map((view) => view.name);
    expect(names.at(-1)).toBe(story.name);
    expect(names.length).toBeGreaterThan(1);
    expect(assembled.snapshot.ticketContextRevisions[story.id]).toBeGreaterThan(0);
    expect(assembled.snapshot.assembledContextHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('tells the active role which Ticket worktree owns relative tool paths', async () => {
    const { assembler, repository, graph, story } = await fixture();
    const bound = bindTicketWorkspace(story, {
      kind: 'ticket',
      relativePath: `worktrees/tickets/${story.id}`,
      branch: `xcompiler/ticket/${story.id}`,
      revision: 'a'.repeat(40),
      workspaceId: createObjectId(),
      changeSetId: createObjectId(),
      reason: 'change-set',
      boundAt: new Date().toISOString(),
    });
    await repository.update(bound, bound.state);

    const assembled = await assembler.assemble({
      projectId: graph.project.id,
      ticketId: story.id,
    });

    expect(assembled.text).toContain(`workspace: ticket worktrees/tickets/${story.id}`);
    expect(assembled.text).toContain('every file-tool path is relative to this workspace root');
  });

  it('retrieves Debug Wiki entries only when a corrective Ticket is in scope', async () => {
    const { repository, graph, story } = await fixture();
    const projectId = graph.project.id;
    const wiki = new RecordingWiki();
    const assembler = new ContextAssembler(repository, { wiki, language: 'typescript' });
    const brief = { reason: 'assertion failed', failureLog: 'boom' } as never;

    // A Story is not debugging anything: loading another Ticket's defect history would push the
    // actual task out of the prompt.
    const forStory = await assembler.assemble({ projectId, ticketId: story.id, debugBrief: brief });
    expect(wiki.searches).toBe(0);
    expect(forStory.debugWikiMatches).toEqual([]);
    expect(forStory.snapshot.debugWikiEntryIds).toEqual([]);
    expect(forStory.text).not.toContain('Debug Wiki');

    const bug = await openBugTicket(repository, graph);
    const forBug = await assembler.assemble({ projectId, ticketId: bug.id, debugBrief: brief });
    expect(wiki.searches).toBe(1);
    expect(forBug.snapshot.debugWikiEntryIds).toEqual(['WIKI-1']);
    expect(forBug.text).toContain('restart the fixture between cases');
  });

  // An Enhancement is repairing something too, and the wiki holds what earlier runs learned about
  // the failures that raise them. Restricting retrieval to Bug withheld it from exactly the Tickets
  // two live runs died on. Driven through `assemble` rather than through the predicate, because the
  // predicate can be right while the call site still asks the old question.
  it('retrieves for a corrective Ticket that is not a Bug', async () => {
    const { repository, graph } = await fixture();
    const projectId = graph.project.id;
    const wiki = new RecordingWiki();
    const assembler = new ContextAssembler(repository, { wiki, language: 'typescript' });
    const brief = { reason: 'coverage shortfall', failureLog: 'boom' } as never;

    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const enhancement = await new TicketWorkflow(repository).openEnhancement({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      sourceStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'quality-shortfall',
      finding: 'unit coverage below the declared gate',
      correlationId: createObjectId(),
    });

    const assembled = await assembler.assemble({
      projectId,
      ticketId: enhancement.id,
      debugBrief: brief,
    });
    expect(wiki.searches).toBe(1);
    expect(assembled.snapshot.debugWikiEntryIds).toEqual(['WIKI-1']);
  });

  it('records no wiki entries when a Bug is in scope but no wiki is available', async () => {
    const { repository, graph, story } = await fixture();
    const bug = await openBugTicket(repository, graph);
    const assembler = new ContextAssembler(repository);
    const assembled = await assembler.assemble({
      projectId: graph.project.id,
      ticketId: bug.id,
      debugBrief: { reason: 'x', failureLog: 'y' } as never,
    });
    expect(assembled.debugWikiMatches).toEqual([]);
    expect(assembled.snapshot.debugWikiEntryIds).toEqual([]);
  });

  it('rejects a parent cycle instead of looping', async () => {
    // The registry already refuses to persist a cycle, so this guard exists for a graph read from
    // corrupt or hand-edited state. It is tested against a repository that can produce one.
    const assembler = new ContextAssembler(cyclicRepository());
    await expect(assembler.ticketChain('A' as never))
      .rejects.toBeInstanceOf(TicketHierarchyCycleError);
  });

  it('fails visibly rather than silently truncating an over-deep chain', async () => {
    // Silently cutting the chain would drop exactly the levels whose constraints the role must
    // honour, so an over-deep chain has to be an error.
    const assembler = new ContextAssembler(deepRepository(MAX_TICKET_CHAIN_DEPTH + 3));
    await expect(assembler.ticketChain('T0' as never)).rejects.toThrow(/exceeds \d+ levels/);
  });

  it('trims to the budget from the tail, keeping the constraints at the head', async () => {
    const { assembler, context, graph, actorId } = await fixture();
    const projectId = graph.project.id;
    const record = await context.ensure(projectId, 'project', projectId);
    await context.apply(projectId, {
      scope: 'project', ownerId: projectId, expectedRevision: record.revision,
      operation: 'set-objective', actorId, hasAuthority: true, text: 'HEAD-MARKER objective',
    });

    const assembled = await assembler.assemble({ projectId, budgetChars: 60 });
    expect(assembled.text.length).toBeLessThanOrEqual(60);
    expect(assembled.text).toContain('HEAD-MARKER');
  });
});

function samplePlan(): Plan {
  return {
    version: PLAN_VERSION, language: 'typescript', intent: 'greenfield', phaseId: 'P1',
    projectType: 'application', requirementDigest: 'context fixture',
    complexityAssessment: {
      level: 'simple', rationale: 'fixture', splitRecommended: false, userForcedPhaseSplit: false,
    },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Deliver', status: 'current',
      scope: ['core'], deliverables: ['src/index.ts'], dependsOn: [],
    }],
    architectureModules: [], globalPrompt: '', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date(0).toISOString(),
    steps: STEP_TYPES.map((type, index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase: type,
      title: `${type} step`, description: `${type} work`, systemPrompt: `Do the ${type} work.`,
      role: 'Coder' as const, tools: ['write_file'], inputs: [],
      outputs: [`docs/${type.toLowerCase()}.md`],
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: `${type} accepted`, maxAttempts: 3,
    })),
  };
}

/** A repository whose ticket graph contains a cycle the registry would never have accepted. */
function cyclicRepository() {
  const tickets: Record<string, unknown> = {
    A: stubTicket('A', 'B'),
    B: stubTicket('B', 'A'),
  };
  return stubRepository(tickets);
}

/** A parent chain longer than the assembler's cap. */
function deepRepository(depth: number) {
  const tickets: Record<string, unknown> = {};
  for (let index = 0; index < depth; index += 1) {
    tickets[`T${index}`] = stubTicket(`T${index}`, index + 1 < depth ? `T${index + 1}` : undefined);
  }
  return stubRepository(tickets);
}

function stubTicket(id: string, parentTicketId?: string) {
  return {
    id, name: id, objectType: 'ticket', projectId: 'P', parentTicketId,
    description: id, acceptance: [id], revision: 1,
  };
}

function stubRepository(tickets: Record<string, unknown>) {
  return {
    read: async (id: string) => {
      const found = tickets[id];
      if (!found) throw new Error(`no ticket ${id}`);
      return found;
    },
    list: async () => [],
  } as never;
}

class RecordingWiki {
  public searches = 0;
  async search(): Promise<Array<{ entry: { id: string; solution: string } }>> {
    this.searches += 1;
    return [{ entry: { id: 'WIKI-1', solution: 'restart the fixture between cases' } }];
  }
}

async function openBugTicket(
  repository: DomainObjectRepository,
  graph: Awaited<ReturnType<typeof fixture>>['graph'],
): Promise<Ticket> {
  // Opened through the real workflow rather than hand-built, so the Ticket under test is shaped the
  // way execution actually produces one.
  const coding = graph.steps.find((step) => step.type === 'CODE')!;
  const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
  return new TicketWorkflow(repository).openBug({
    creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
    failedStep: unit,
    targetStep: coding,
    verificationStep: unit,
    kind: 'test-failure',
    severity: 'high',
    message: 'boom',
    summary: 'assertion failed',
    category: 'test',
    code: 'assert',
    retryable: true,
    switchProvider: false,
    rawEvidenceRef: '.xcompiler/failures/unit.log',
    correlationId: createObjectId(),
    ...bugContracts(unit, coding, unit, { category: 'test', code: 'assert' }),
  });
}
