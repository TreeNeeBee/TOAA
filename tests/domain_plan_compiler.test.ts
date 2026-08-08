import { describe, expect, it } from 'vitest';
import type { Phase as DraftStepType, Plan as DraftPlan, Role as DraftRole } from '../src/core/plan.js';
import { isObjectId } from '../src/domain/identity/object_id.js';
import {
  compileProjectExtension,
  compileProjectGraph,
  rebaseDraftPlanPhases,
} from '../src/domain/planning/compiler.js';
import { ProjectSchema } from '../src/domain/projects/project.js';
import { STEP_TYPES } from '../src/domain/steps/step.js';
import { validateDomainGraph } from '../src/domain/workflow/domain_graph.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import { DomainAuditTrail } from '../src/application/observability/domain_audit_trail.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { generateProjectDevelopmentReport } from '../src/core/project_report.js';
import { reviseObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { PhaseSchema } from '../src/domain/phases/phase.js';
import { TicketSchema, type WorkTicket } from '../src/domain/tickets/ticket.js';

describe('domain plan compiler', () => {
  it('compiles readable Planner names into a globally identified Project graph', () => {
    const graph = compileProjectGraph({
      draft: samplePlan(),
      topic: 'Build a TypeScript news application.',
      topicSourceRef: 'examples/news/news_ts.md',
      projectName: 'news',
    });

    const allObjects = [
      graph.project,
      graph.projectPlan,
      ...graph.phasePlans,
      ...graph.phases,
      ...graph.steps,
      ...graph.tickets,
      ...graph.kpis,
      ...graph.deliverables,
    ];
    expect(allObjects.every((object) => isObjectId(object.id))).toBe(true);
    expect(new Set(allObjects.map((object) => object.id))).toHaveLength(allObjects.length);
    expect(allObjects.every((object) => object.id !== object.name)).toBe(true);
    expect(graph.project.name).toBe('news');
    expect(graph.steps.map((step) => step.name)).toEqual(
      STEP_TYPES.map((_, index) => `P1-S${String(index + 1).padStart(3, '0')}`),
    );
    expect(graph.steps.map((step) => step.type)).toEqual(STEP_TYPES);
    expect(new Set(graph.steps.map((step) => step.maxAttempts))).toEqual(new Set([9]));
    expect(validateDomainGraph(graph)).toEqual([]);
  });

  it('creates Epic, Story and two Task levels while leaving future Phases skeletal', () => {
    const graph = compileProjectGraph({
      draft: samplePlan(),
      topic: 'Build a TypeScript news application.',
      projectName: 'news',
    });
    const p1 = graph.phases.find((phase) => phase.name === 'P1')!;
    const p2 = graph.phases.find((phase) => phase.name === 'P2')!;
    const p1Plan = graph.phasePlans.find((plan) => plan.phaseId === p1.id)!;
    const p2Plan = graph.phasePlans.find((plan) => plan.phaseId === p2.id)!;

    expect(p1.stepIds).toHaveLength(8);
    expect(p1Plan.materialized).toBe(true);
    expect(p2.stepIds).toEqual([]);
    expect(p2Plan.materialized).toBe(false);
    expect(p2.dependencyPhaseIds).toEqual([p1.id]);
    expect(graph.tickets.filter((ticket) => ticket.type === 'epic')).toHaveLength(2);
    expect(graph.tickets.filter((ticket) => ticket.type === 'story')).toHaveLength(9);
    expect(graph.tickets.filter((ticket) => ticket.type === 'task')).toHaveLength(2);
    expect(graph.tickets.some((ticket) => ['feature', 'sub-task'].includes(ticket.type))).toBe(false);
  });

  // From a live run: three Tickets in one Phase were all named `P1-S004-T01S`, because a subtask was
  // numbered within its own parent but named after the Step. Names are the identity every log line,
  // audit entry, and evidence bundle shows.
  it('gives every Ticket in the graph a unique name, including sibling subtasks', () => {
    const draft = samplePlan();
    const code = draft.steps.find((step) => step.phase === 'CODE')!;
    // Two parent tasks, each with its own first subtask — the collision needs siblings to appear.
    code.subTasks = [
      {
        id: 'M001',
        title: 'Implement scraping',
        description: 'Implement the scrapers.',
        acceptance: 'Scrapers are implemented.',
        outputs: ['src/scrape.ts'],
        subTasks: [{
          id: 'M001.1',
          title: 'Implement the parser',
          description: 'Implement the parser.',
          acceptance: 'The parser is covered.',
          outputs: ['src/parse.ts'],
        }],
      },
      {
        id: 'M002',
        title: 'Implement rendering',
        description: 'Implement the renderer.',
        acceptance: 'The renderer is implemented.',
        outputs: ['src/render.ts'],
        subTasks: [{
          id: 'M002.1',
          title: 'Implement the template',
          description: 'Implement the template.',
          acceptance: 'The template is covered.',
          outputs: ['src/template.ts'],
        }],
      },
    ];
    const graph = compileProjectGraph({
      draft,
      topic: 'Build a TypeScript news application.',
      projectName: 'news',
    });

    const names = graph.tickets.map((ticket) => ticket.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
    // Each subtask still reads as belonging to its parent.
    expect(names).toContain('P1-S004-T01S01');
    expect(names).toContain('P1-S004-T02S01');
  });

  it('pairs each development Step and Story with its verification side', () => {
    const graph = compileProjectGraph({
      draft: samplePlan(),
      topic: 'Build a TypeScript news application.',
      projectName: 'news',
    });
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const codingStory = graph.tickets.find((ticket) => ticket.type === 'story' && ticket.stepId === coding.id)!;
    const unitStory = graph.tickets.find((ticket) => ticket.type === 'story' && ticket.stepId === unit.id)!;

    expect(coding.pairedStepId).toBe(unit.id);
    expect(unit.pairedStepId).toBe(coding.id);
    expect(codingStory.type === 'story' && codingStory.verificationTicketId).toBe(unitStory.id);
    expect(unitStory.type === 'story' && unitStory.pairedSourceTicketId).toBe(codingStory.id);
  });

  it('persists the complete graph through the global object registry', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-domain-graph-'));
    const workspace = new Workspace(root);
    const graph = compileProjectGraph({
      draft: samplePlan(),
      topic: 'Build a TypeScript news application.',
      projectName: 'news',
    });
    const repository = new DomainObjectRepository(workspace);
    await repository.load();
    await new ProjectGraphPersistenceService(repository).persistGraph(graph);

    // Project + ProjectPlan + the PM management plan, plus every Role Definition, every registered
    // actor, and the graph.
    const expectedCount = 1 + 1 + 1 + graph.roleDefinitions.length + graph.actors.length +
      graph.phasePlans.length + graph.phases.length +
      graph.steps.length + graph.tickets.length + graph.kpis.length + graph.deliverables.length;
    expect(repository.registry.all()).toHaveLength(expectedCount);
    expect(await repository.registry.verifyIntegrity({ verifyContent: true })).toEqual([]);
    expect(await repository.read(graph.steps[3]!.id)).toMatchObject({
      id: graph.steps[3]!.id,
      name: 'P1-S004',
      objectType: 'step',
    });

    await new DomainAuditTrail(repository).recordEvent({
      projectId: graph.project.id,
      subject: { id: graph.phases[0]!.id, objectType: 'phase' },
      kind: 'workflow.phase_started',
      actor: 'test-runtime',
      correlationId: createObjectId(),
      payload: { phaseName: graph.phases[0]!.name },
    });
    const projectWithAudit = await repository.read(graph.project.id);
    expect(projectWithAudit.objectType === 'project' && projectWithAudit.auditEventIds).toHaveLength(1);

    const story = graph.tickets.find((ticket) => ticket.type === 'story')!;
    const log = await new DomainAuditTrail(repository).recordLog({
      projectId: graph.project.id,
      subject: { id: story.id, objectType: 'ticket' },
      level: 'error',
      message: 'The verification gate failed.',
      correlationId: createObjectId(),
      data: { gate: 'unit-test' },
    });
    const ticketWithLog = await repository.read(story.id);
    expect(ticketWithLog.objectType === 'ticket' && ticketWithLog.logIds).toEqual([log.id]);
    expect(await repository.read(log.id)).toMatchObject({
      objectType: 'log',
      message: 'The verification gate failed.',
    });

    await generateProjectDevelopmentReport({
      workspace,
      plan: samplePlan(),
      finalDelivery: false,
      repository,
    });
    const reports = await repository.list({ objectType: 'report', projectId: graph.project.id });
    expect(reports).toHaveLength(1);
    const phaseWithReport = await repository.read(graph.phases[0]!.id);
    expect(phaseWithReport.objectType === 'phase' && phaseWithReport.reportIds).toEqual([reports[0]!.id]);
  });

  it('appends rebased Phases without replacing the canonical Project identity', async () => {
    const originalDraft = samplePlan();
    originalDraft.implementationPhases = [originalDraft.implementationPhases[0]!];
    const original = compileProjectGraph({
      draft: originalDraft,
      topic: 'Build a TypeScript news application.',
      projectName: 'news',
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-domain-extension-'));
    const repository = new DomainObjectRepository(new Workspace(root));
    await repository.load();
    await new ProjectGraphPersistenceService(repository).persistGraph(original);
    const predecessorPhase = PhaseSchema.parse({
      ...original.phases[0]!,
      ...reviseObjectEnvelope(original.phases[0]!),
      state: 'closed',
    });
    await repository.update(predecessorPhase, predecessorPhase.state);
    const predecessorEpicObject = original.tickets.find(
      (ticket) => ticket.type === 'epic' && ticket.phaseId === predecessorPhase.id,
    )!;
    const predecessorEpic = TicketSchema.parse({
      ...predecessorEpicObject,
      ...reviseObjectEnvelope(predecessorEpicObject),
      state: 'closed',
    }) as WorkTicket;
    await repository.update(predecessorEpic, predecessorEpic.state);
    const closedProject = ProjectSchema.parse({
      ...original.project,
      ...reviseObjectEnvelope(original.project),
      state: 'closed',
    });
    await repository.update(closedProject, closedProject.state);
    const extensionDraft = rebaseDraftPlanPhases(
      { ...samplePlan(), intent: 'feature' },
      original.phases.map((phase) => phase.name),
    );
    const extension = compileProjectExtension({
      draft: extensionDraft,
      topic: 'Add personalized categories.',
      projectName: original.project.name,
      project: closedProject,
      projectPlan: original.projectPlan,
      predecessorPhase,
      predecessorEpic,
      // An incremental Phase reuses the Project's existing PM registrations rather than
      // registering a second set of actors.
      actors: original.actors,
      managementPlan: original.managementPlan,
    });

    expect(extension.project.id).toBe(original.project.id);
    expect(extension.project.projectPlanId).toBe(original.projectPlan.id);
    expect(extension.phases.map((phase) => phase.name)).toEqual(['P2', 'P3']);
    expect(extension.phases[0]!.dependencyPhaseIds).toContain(predecessorPhase.id);
    const firstEpic = extension.tickets.find(
      (ticket) => ticket.type === 'epic' && ticket.phaseId === extension.phases[0]!.id,
    );
    expect(firstEpic?.dependencyTicketIds).toContain(predecessorEpic.id);
    expect(extension.project.phaseIds).toEqual([
      ...original.project.phaseIds,
      ...extension.phases.map((phase) => phase.id),
    ]);
    await new ProjectGraphPersistenceService(repository).persistExtension(extension);
    expect((await repository.findProject())?.id).toBe(original.project.id);
    expect(await repository.registry.verifyIntegrity({ verifyContent: true })).toEqual([]);
  });
});

function samplePlan(): DraftPlan {
  const phases: Array<[DraftStepType, DraftRole]> = [
    ['REQUIREMENT_ANALYSIS', 'Planner'],
    ['HIGH_LEVEL_DESIGN', 'Architect'],
    ['DETAILED_DESIGN', 'Architect'],
    ['CODE', 'Coder'],
    ['UNIT_TEST', 'Tester'],
    ['INTEGRATION_TEST', 'Tester'],
    ['MODULE_TEST', 'Tester'],
    ['FUNCTIONAL_TEST', 'Tester'],
  ];
  return {
    version: '1',
    language: 'typescript',
    intent: 'greenfield',
    phaseId: 'P1',
    projectType: 'application',
    requirementDigest: 'Build a news application.',
    complexityAssessment: {
      level: 'complex',
      rationale: 'The application has external integration and multiple modules.',
      splitRecommended: true,
      userForcedPhaseSplit: false,
    },
    implementationPhases: [
      {
        id: 'P1',
        title: 'Core delivery',
        objective: 'Deliver the core news workflow.',
        status: 'current',
        scope: ['core'],
        deliverables: ['src/main.ts'],
        dependsOn: [],
        verificationGate: {
          summary: 'Core workflow passes.',
          checks: ['All acceptance tests pass.'],
          failurePolicy: 'Open a Bug and route it to the paired source Step.',
        },
      },
      {
        id: 'P2',
        title: 'Enhancements',
        objective: 'Add caching and resilience.',
        status: 'planned',
        scope: ['cache'],
        deliverables: ['src/cache.ts'],
        dependsOn: ['P1'],
        verificationGate: {
          summary: 'Enhancements pass.',
          checks: ['Resilience scenarios pass.'],
          failurePolicy: 'Open a Bug and route it to the paired source Step.',
        },
      },
    ],
    globalPrompt: 'Follow the approved architecture.',
    baselineSummary: '',
    dependencies: ['vitest'],
    userAddenda: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    steps: phases.map(([phase, role], index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`,
      iterationId: 'P1',
      phase,
      title: phase,
      description: `Execute ${phase}.`,
      systemPrompt: `Complete only ${phase}.`,
      role,
      tools: index === 3 ? ['write_file'] : ['read_file'],
      inputs: index === 0 ? [] : [`artifact-${index}`],
      outputs: [`artifact-${index + 1}`],
      subTasks: index === 3 ? [{
        id: 'M001',
        title: 'Implement service',
        description: 'Implement the news service.',
        acceptance: 'The service contract is implemented.',
        outputs: ['src/service.ts'],
        subTasks: [{
          id: 'M001.1',
          title: 'Implement result mapping',
          description: 'Implement the result mapping.',
          acceptance: 'The result mapping is covered.',
          outputs: ['src/result.ts'],
        }],
      }] : [],
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: `${phase} passes.`,
      maxAttempts: 3,
    })),
  };
}
