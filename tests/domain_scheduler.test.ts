import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Plan } from '../src/core/plan.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { QualityAssessmentService } from '../src/domain/quality/assessment_service.js';
import { DomainScheduler } from '../src/domain/workflow/scheduler.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { Workspace } from '../src/workspace/workspace.js';

describe('DomainScheduler', () => {
  it('keeps development Steps delivered until their paired verification Step passes', async () => {
    const { graph, repository, scheduler } = await setup();
    const phase = graph.phases[0]!;
    for (let index = 0; index < 5; index += 1) {
      const work = await scheduler.next(phase.id);
      expect(work?.step.name).toBe(`P1-S${String(index + 1).padStart(3, '0')}`);
      const started = await scheduler.start(work!);
      await deliverPassing(repository, scheduler, started);
    }

    const coding = graph.steps.find((step) => step.type === 'CODING')!;
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const persistedCoding = await repository.read(coding.id);
    const persistedUnit = await repository.read(unit.id);
    expect(persistedCoding.objectType === 'step' && persistedCoding.state).toBe('closed');
    expect(persistedUnit.objectType === 'step' && persistedUnit.state).toBe('closed');

    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const persistedDetailed = await repository.read(detailed.id);
    expect(persistedDetailed.objectType === 'step' && persistedDetailed.state).toBe('delivered');
  });

  it('routes a failed test back to its paired source and resumes the same Bug after restart', async () => {
    const { graph, repository, scheduler } = await setup();
    const phase = graph.phases[0]!;
    for (let index = 0; index < 4; index += 1) {
      const started = await scheduler.start((await scheduler.next(phase.id))!);
      await deliverPassing(repository, scheduler, started);
    }
    const unitWork = await scheduler.start((await scheduler.next(phase.id))!);
    const bug = await scheduler.routeFailure({
      failedStepId: unitWork.step.id,
      message: 'expected source, received undefined',
      summary: 'Unit result contract failed.',
      rawEvidenceRef: '.xcompiler/failures/unit.log',
      correlationId: createObjectId(),
    });

    const coding = graph.steps.find((step) => step.type === 'CODING')!;
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const persistedCoding = await repository.read(coding.id);
    const persistedUnit = await repository.read(unit.id);
    expect(persistedCoding.objectType === 'step' && persistedCoding.state).toBe('reopened');
    expect(persistedUnit.objectType === 'step' && persistedUnit.state).toBe('pending');

    const resumedRepository = new DomainObjectRepository(new Workspace(repositoryRoot(repository)));
    await resumedRepository.load();
    const resumed = await new DomainScheduler(resumedRepository).resume(phase.id);
    expect(resumed).toMatchObject({ mode: 'debug', step: { id: coding.id }, ticket: { id: bug.id } });
  });

  it('recovers an LLM infrastructure failure that was previously misrouted as a Bug', async () => {
    const { graph, repository, scheduler } = await setup();
    const phase = graph.phases[0]!;
    for (let index = 0; index < 4; index += 1) {
      const started = await scheduler.start((await scheduler.next(phase.id))!);
      await deliverPassing(repository, scheduler, started);
    }
    const unitWork = await scheduler.start((await scheduler.next(phase.id))!);
    const bug = await scheduler.routeFailure({
      failedStepId: unitWork.step.id,
      message: 'all LLM providers failed for role Tester: status=429',
      summary: 'OpenAI-compatible provider request failed status=429',
      correlationId: createObjectId(),
    });
    const debugWork = await scheduler.start((await scheduler.resume(phase.id))!);

    await scheduler.recoverMisroutedInfrastructureBug(bug.id);

    const coding = await repository.read(debugWork.step.id);
    const unit = await repository.read(unitWork.step.id);
    const cancelledBug = await repository.read(bug.id);
    const resumed = await scheduler.resume(phase.id);
    expect(coding.objectType === 'step' && coding.state).toBe('delivered');
    expect(coding.objectType === 'step' && coding.attempts).toBe(1);
    expect(unit.objectType === 'step' && unit.state).toBe('in_progress');
    expect(unit.objectType === 'step' && unit.attempts).toBe(0);
    expect(cancelledBug.objectType === 'ticket' && cancelledBug.state).toBe('cancelled');
    expect(resumed).toMatchObject({ mode: 'normal', step: { id: unitWork.step.id }, ticket: { id: unitWork.ticket.id } });
  });

  it('closes a Phase only after all eight Step gates and delivery Tickets close', async () => {
    const { graph, repository, scheduler } = await setup();
    const phase = graph.phases[0]!;
    for (let index = 0; index < 8; index += 1) {
      const work = await scheduler.next(phase.id);
      expect(work?.step.type).toBe(graph.steps[index]!.type);
      await deliverPassing(repository, scheduler, await scheduler.start(work!));
    }
    await scheduler.completePhase(phase.id);

    const persistedPhase = await repository.read(phase.id);
    const epic = await repository.read(phase.epicTicketId);
    const delivery = (await Promise.all(
      repository.registry.byType('ticket').map((entry) => repository.read(entry.id)),
    )).find((object) => object.objectType === 'ticket' && object.type === 'story' && object.workKind === 'delivery');
    expect(persistedPhase.objectType === 'phase' && persistedPhase.state).toBe('closed');
    expect(epic.objectType === 'ticket' && epic.state).toBe('closed');
    expect(delivery?.objectType === 'ticket' && delivery.state).toBe('closed');
  });

  it('never updates immutable Checkpoints', async () => {
    const { graph, repository, scheduler } = await setup();
    const work = await scheduler.start((await scheduler.next(graph.phases[0]!.id))!);
    const step = await repository.read(work.step.id);
    expect(step.objectType).toBe('step');
    if (step.objectType !== 'step') throw new Error('expected Step');
    const checkpoint = await repository.read(step.checkpointIds[0]!);
    await expect(repository.update(checkpoint)).rejects.toThrow(/immutable/u);
  });

  it('advances Project and ProjectPlan to the same dependency-ready Phase', async () => {
    const plan = samplePlan();
    plan.implementationPhases.push({
      id: 'P2',
      title: 'Enhancement',
      objective: 'Deliver the enhancement.',
      status: 'planned',
      scope: ['enhancement'],
      deliverables: ['src/enhancement.ts'],
      dependsOn: ['P1'],
      verificationGate: {
        summary: 'Enhancement gates pass.',
        checks: ['Acceptance passes.'],
        failurePolicy: 'Open a Bug.',
      },
    });
    const { graph, repository, scheduler } = await setup(plan);
    for (let index = 0; index < 8; index += 1) {
      await deliverPassing(repository, scheduler, await scheduler.start((await scheduler.next(graph.phases[0]!.id))!));
    }
    const completion = await scheduler.completePhase(graph.phases[0]!.id);
    const project = await repository.read(graph.project.id);
    const projectPlan = await repository.read(graph.projectPlan.id);

    expect(completion.nextPhaseId).toBe(graph.phases[1]!.id);
    expect(project.objectType === 'project' && project.currentPhaseId).toBe(graph.phases[1]!.id);
    expect(projectPlan.objectType === 'plan' && projectPlan.planKind === 'project' && projectPlan.activePhaseId)
      .toBe(graph.phases[1]!.id);
  });
});

const roots = new WeakMap<DomainObjectRepository, string>();

async function setup(plan = samplePlan()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-domain-scheduler-'));
  const repository = new DomainObjectRepository(new Workspace(root));
  roots.set(repository, root);
  await repository.load();
  const graph = compileProjectGraph({
    draft: plan,
    topic: 'Build a TypeScript service.',
    projectName: 'service',
  });
  await repository.persistCompiledGraph(graph);
  return { graph, repository, scheduler: new DomainScheduler(repository) };
}

function repositoryRoot(repository: DomainObjectRepository): string {
  const root = roots.get(repository);
  if (!root) throw new Error('repository root not found');
  return root;
}

async function deliverPassing(
  repository: DomainObjectRepository,
  scheduler: DomainScheduler,
  work: Awaited<ReturnType<DomainScheduler['start']>>,
): Promise<void> {
  const kpis = await Promise.all(work.step.kpiIds.map((id) => repository.read(id)));
  const assessment = await new QualityAssessmentService(repository).assessStep({
    step: work.step,
    metrics: kpis.flatMap((object) => object.objectType === 'kpi'
      ? [{ metric: object.metric, value: 1 }]
      : []),
  });
  await scheduler.deliverNormal(work, assessment.id);
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
