import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import { ContextService } from '../src/application/context/context_service.js';
import { TicketDistillationService } from '../src/application/context/ticket_distillation_service.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { ProjectContainer } from '../src/workspace/project_container.js';
import { TicketSchema, type Ticket } from '../src/domain/tickets/ticket.js';
import { TicketWorkflow } from '../src/application/project_management/ticket_workflow.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { PLAN_VERSION, type Plan } from '../src/core/plan.js';
import { STEP_TYPES } from '../src/domain/steps/step.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-distil-'));
  const repository = new DomainObjectRepository(new ProjectContainer(root).state);
  await repository.load();
  const graph = compileProjectGraph({ draft: plan(), topic: 't', projectName: 'p' });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  const coding = graph.steps.find((step) => step.type === 'CODE')!;
  const story = graph.tickets.find((ticket) => ticket.stepId === coding.id)!;
  return {
    root,
    repository,
    graph,
    coding,
    story,
    context: new ContextService(repository),
    distillation: new TicketDistillationService(repository),
  };
}

function closed(story: Ticket, over: Partial<Ticket> = {}): Ticket {
  return TicketSchema.parse({
    ...story,
    state: 'closed',
    solution: {
      status: 'verified',
      approach: 'Extracted the parser behind an interface.',
      rationale: 'The two call sites needed different error handling.',
      changes: ['src/parser.ts'],
      verification: ['unit gate passed'],
      updatedAt: new Date().toISOString(),
    },
    ...over,
  });
}

describe('ticket distillation', () => {
  it('carries a closed Ticket into the Context of its Step', async () => {
    const { distillation, context, graph, coding, story } = await fixture();
    expect(await distillation.distil(closed(story))).toBe(true);

    const record = await context.find(graph.project.id, 'step', coding.id);
    expect(record?.findings.map((finding) => finding.text)).toEqual([
      `[${story.name}] Extracted the parser behind an interface. — The two call sites needed different error handling.`,
      `[${story.name}] verified by: unit gate passed`,
    ]);
    expect(record?.artifacts.map((artifact) => artifact.path)).toEqual(['src/parser.ts']);
    // Attribution matters: context records who learned what, so it is auditable.
    expect(record?.findings[0]!.actorId).toBe(story.creatorActorId);
  });

  it('does not distil twice when a closure is retried', async () => {
    const { distillation, context, graph, coding, story } = await fixture();
    const ticket = closed(story);
    expect(await distillation.distil(ticket)).toBe(true);
    expect(await distillation.distil(ticket)).toBe(false);

    const record = await context.find(graph.project.id, 'step', coding.id);
    expect(record?.findings).toHaveLength(2);
    expect(record?.artifacts).toHaveLength(1);
  });

  it('sends a Bug to the Debug Wiki instead, and distils nothing that did not close', async () => {
    const { distillation, context, repository, graph, coding, story } = await fixture();
    // A Bug's history belongs to the wiki: putting defect transcripts in Step Context would load
    // them for every role that later touches this Step.
    const bug = await new TicketWorkflow(repository).openBug({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStep: graph.steps.find((step) => step.type === 'UNIT_TEST')!,
      targetStep: coding,
      verificationStep: graph.steps.find((step) => step.type === 'UNIT_TEST')!,
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
    });
    expect(await distillation.distil(TicketSchema.parse({ ...bug, state: 'closed' }))).toBe(false);
    // Failed and cancelled work records that an approach did not hold, which is a trace fact rather
    // than knowledge the next attempt should be handed as established.
    for (const state of ['cancelled', 'in_progress', 'resolved'] as const) {
      expect(await distillation.distil(closed(story, { state })), state).toBe(false);
    }
    expect(await context.find(graph.project.id, 'step', coding.id)).toBeUndefined();
  });

  it('records that the scope is covered when a Ticket closed without a solution', async () => {
    const { distillation, context, graph, coding, story } = await fixture();
    const ticket = TicketSchema.parse({ ...story, state: 'closed', description: 'Wire the CLI flag.' });
    expect(await distillation.distil(ticket)).toBe(true);

    const record = await context.find(graph.project.id, 'step', coding.id);
    expect(record?.findings.map((finding) => finding.text))
      .toEqual([`[${story.name}] delivered: Wire the CLI flag.`]);
    expect(record?.artifacts).toEqual([]);
  });
});

function plan(): Plan {
  return {
    version: PLAN_VERSION, language: 'typescript', intent: 'greenfield', phaseId: 'P1',
    projectType: 'application', requirementDigest: 'distillation fixture',
    complexityAssessment: { level: 'simple', rationale: 'x', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{ id: 'P1', title: 'C', objective: 'D', status: 'current', scope: ['c'], deliverables: ['a'], dependsOn: [] }],
    architectureModules: [], globalPrompt: '', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date(0).toISOString(),
    steps: STEP_TYPES.map((t, i) => ({
      id: `S${String(i + 1).padStart(3, '0')}`, iterationId: 'P1', phase: t, title: t, description: t,
      systemPrompt: t, role: 'Coder' as const, tools: ['write_file'], inputs: [], outputs: [`docs/${i}.md`],
      dependsOn: i === 0 ? [] : [`S${String(i).padStart(3, '0')}`], acceptance: 'a', maxAttempts: 3,
    })),
  };
}
