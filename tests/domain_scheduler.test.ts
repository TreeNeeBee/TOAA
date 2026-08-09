import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Plan } from '../src/core/plan.js';
import { QualityAssessmentService } from '../src/application/execution/quality_assessment_service.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import { ProjectController, type ScheduledWork } from '../src/application/project_management/project_controller.js';
import { TicketRegistrationService } from '../src/application/project_management/ticket_registration_service.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { createObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { TicketSchema } from '../src/domain/tickets/ticket.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { Workspace } from '../src/workspace/workspace.js';
import { ProjectStateService } from '../src/application/project_management/project_state_service.js';

describe('PM WorkScheduler', () => {
  it('keeps a source Step delivered until its paired verification closes it', async () => {
    const fixture = await setup();
    for (let index = 0; index < 5; index += 1) {
      const work = await startNext(fixture);
      expect(work.step.name).toBe(`P1-S${String(index + 1).padStart(3, '0')}`);
      await deliverPassing(fixture, work);
    }
    const code = fixture.graph.steps.find((step) => step.type === 'CODE')!;
    const unit = fixture.graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const detailed = fixture.graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    expect((await fixture.repository.read(code.id)).state).toBe('closed');
    expect((await fixture.repository.read(unit.id)).state).toBe('closed');
    expect((await fixture.repository.read(detailed.id)).state).toBe('delivered');
  });

  it('routes a failed verification to its paired source and resumes the Bug after reload', async () => {
    const fixture = await setup();
    for (let index = 0; index < 4; index += 1) await deliverPassing(fixture, await startNext(fixture));
    const unitWork = await startNext(fixture);
    const creatorActorId = await fixture.registration.discovererActorIdForStep(unitWork.step.id);
    const bug = await fixture.controller.routeFailure({
      creatorActorId,
      failedStepId: unitWork.step.id,
      message: 'expected source, received undefined',
      summary: 'Unit result contract failed.',
      failure: {
        kind: 'execution',
        category: 'test',
        code: 'unit_contract_failed',
        message: 'expected source, received undefined',
        retryable: true,
        switchProvider: false,
      },
      rawEvidenceRef: '.xcompiler/failures/unit.log',
      correlationId: createObjectId(),
    });
    const code = fixture.graph.steps.find((step) => step.type === 'CODE')!;
    expect((await fixture.repository.read(code.id)).state).toBe('reopened');
    expect((await fixture.repository.read(unitWork.step.id)).state).toBe('pending');

    const repository = new DomainObjectRepository(new Workspace(fixture.root));
    await repository.load();
    const resumed = await new ProjectController(repository).resume(fixture.graph.phases[0]!.id);
    expect(resumed).toMatchObject({ mode: 'debug', step: { id: code.id }, ticket: { id: bug.id } });
  });

  it('resumes an owned Ticket whose Step is pending before dispatching an earlier created CR', async () => {
    const fixture = await setup();
    for (let index = 0; index < 7; index += 1) {
      await deliverPassing(fixture, await startNext(fixture));
    }
    const functionalWork = await startNext(fixture);
    const activeAssignmentId = functionalWork.ticket.activeAssignmentId;
    expect(activeAssignmentId).toBeDefined();

    const unitStep = fixture.graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const unitStory = fixture.graph.tickets.find((ticket) =>
      ticket.type === 'story' && ticket.stepId === unitStep.id)!;
    const tester = fixture.graph.actors.find((actor) => actor.role === 'tester')!;
    const {
      workKind: _workKind,
      verificationTicketId: _verificationTicketId,
      pairedSourceTicketId: _pairedSourceTicketId,
      ...ticketBase
    } = unitStory;
    const earlierRequest = TicketSchema.parse({
      ...ticketBase,
      ...createObjectEnvelope({
        name: 'CR-P1-S005-RECOVERY',
        objectType: 'ticket',
        projectId: unitStory.projectId,
      }),
      type: 'change-request',
      creatorActorId: tester.id,
      state: 'created',
      assignmentIds: [],
      activeAssignmentId: undefined,
      attempts: 0,
      solution: undefined,
      resolvedAt: undefined,
      closedAt: undefined,
      sourceTicketId: unitStory.id,
      triggerStepId: unitStep.id,
      sourceStepId: unitStep.id,
      targetStepId: unitStep.id,
      contractDelta: {
        summary: 'Re-check the earlier unit contract.',
        before: ['previous contract'],
        after: ['corrected contract'],
        affectedArtifacts: ['tests/unit.test.ts'],
      },
      implementationPlan: ['Apply the corrected unit contract.'],
      verificationGate: ['Unit verification passes.'],
    });
    await fixture.repository.insert(earlierRequest, earlierRequest.state);
    await fixture.registration.register(earlierRequest.id);

    const state = new ProjectStateService(fixture.repository);
    await state.transitionStep(await state.requireStep(unitStep.id), 'reopened');
    await state.moveStepPending(await state.requireStep(functionalWork.step.id), 'defect');

    const resumed = await fixture.controller.resume(fixture.graph.phases[0]!.id);
    expect(resumed).toMatchObject({
      mode: 'normal',
      step: { id: functionalWork.step.id },
      ticket: { id: functionalWork.ticket.id },
    });
    const routed = await fixture.registration.routeAndAssign(resumed!.ticket.id, {
      forStepId: resumed!.step.id,
    });
    expect(routed.assignment.id).toBe(activeAssignmentId);
  });

  it('closes a Phase only after all Step and delivery Tickets close', async () => {
    const fixture = await setup();
    for (let index = 0; index < 8; index += 1) await deliverPassing(fixture, await startNext(fixture));
    const result = await fixture.controller.completePhase(fixture.graph.phases[0]!.id);
    expect(result.projectDelivered).toBe(true);
    expect((await fixture.repository.read(fixture.graph.phases[0]!.id)).state).toBe('closed');
    expect((await fixture.repository.read(fixture.graph.phases[0]!.epicTicketId)).state).toBe('closed');
  });

  it('never updates immutable Checkpoints', async () => {
    const fixture = await setup();
    const work = await startNext(fixture);
    const step = await fixture.repository.read(work.step.id);
    if (step.objectType !== 'step') throw new Error('expected Step');
    const checkpoint = await fixture.repository.read(step.checkpointIds[0]!);
    await expect(fixture.repository.update(checkpoint)).rejects.toThrow(/immutable/u);
  });
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-pm-scheduler-'));
  const repository = new DomainObjectRepository(new Workspace(root));
  await repository.load();
  const graph = compileProjectGraph({
    draft: samplePlan(),
    topic: 'Build a TypeScript service.',
    projectName: 'service',
  });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  const registration = new TicketRegistrationService(repository);
  await registration.registerProjectTickets(graph.project.id);
  return {
    root,
    graph,
    repository,
    registration,
    controller: new ProjectController(repository),
  };
}

async function startNext(fixture: Awaited<ReturnType<typeof setup>>): Promise<ScheduledWork> {
  const work = await fixture.controller.next(fixture.graph.phases[0]!.id);
  if (!work) throw new Error('expected scheduled work');
  const routed = await fixture.registration.routeAndAssign(work.ticket.id);
  return fixture.controller.start({ ...work, ticket: routed.ticket });
}

async function deliverPassing(
  fixture: Awaited<ReturnType<typeof setup>>,
  work: ScheduledWork,
): Promise<void> {
  const kpis = await Promise.all(work.step.kpiIds.map((id) => fixture.repository.read(id)));
  const assessment = await new QualityAssessmentService(fixture.repository).assessStep({
    step: work.step,
    metrics: kpis.flatMap((object) => object.objectType === 'kpi'
      ? [{ metric: object.metric, value: 1 }]
      : []),
  });
  await fixture.controller.deliverNormal(work, assessment.id);
}

function samplePlan(): Plan {
  const phases = [
    ['REQUIREMENT_ANALYSIS', 'Planner'], ['HIGH_LEVEL_DESIGN', 'Architect'],
    ['DETAILED_DESIGN', 'Architect'], ['CODE', 'Coder'], ['UNIT_TEST', 'Tester'],
    ['INTEGRATION_TEST', 'Tester'], ['MODULE_TEST', 'Tester'], ['FUNCTIONAL_TEST', 'Tester'],
  ] as const;
  return {
    version: '1', language: 'typescript', intent: 'greenfield', phaseId: 'P1', projectType: 'application',
    requirementDigest: 'Build a service.',
    complexityAssessment: { level: 'simple', rationale: 'One phase.', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Deliver core.', status: 'current', scope: ['core'],
      deliverables: ['src/main.ts'], dependsOn: [],
      verificationGate: { summary: 'All gates pass.', checks: ['Acceptance passes.'], failurePolicy: 'Open a Bug.' },
    }],
    globalPrompt: 'Implement.', baselineSummary: '', dependencies: [], userAddenda: '', createdAt: new Date().toISOString(),
    steps: phases.map(([phase, role], index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase, title: phase,
      description: `Execute ${phase}.`, systemPrompt: `Execute ${phase}.`, role, tools: ['read_file'],
      inputs: index ? [`artifact-${index}`] : [], outputs: [`artifact-${index + 1}`], subTasks: [],
      dependsOn: index ? [`S${String(index).padStart(3, '0')}`] : [], acceptance: `${phase} passes.`,
      maxAttempts: 3,
    })),
  };
}
