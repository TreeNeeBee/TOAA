import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { TicketWorkflow } from '../src/domain/tickets/workflow.js';
import { QualityAssessmentService } from '../src/domain/quality/assessment_service.js';
import type { Step } from '../src/domain/steps/step.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { Workspace } from '../src/workspace/workspace.js';
import type { Plan } from '../src/core/plan.js';

describe('TicketWorkflow', () => {
  it('keeps a Bug open until its linked Change Request is implemented and verified', async () => {
    const { graph, repository, workflow } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const coding = graph.steps.find((step) => step.type === 'CODING')!;

    const bug = await workflow.openBug({
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'The service and adapter contracts disagree.',
      summary: 'Integration contract mismatch.',
      rawEvidenceRef: '.xcompiler/failures/integration.log',
      correlationId: createObjectId(),
    });
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Correct the detailed contract and propagate its delta.',
      rationale: 'The implementation followed an ambiguous contract.',
      changes: ['docs/03-detailed-design.md'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    const request = await workflow.openChangeRequest({
      sourceTicketId: bug.id,
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      affectedStepIds: [detailed.id, coding.id, unit.id, integration.id],
      contractDelta: {
        summary: 'Align the service result contract.',
        before: ['result may omit source'],
        after: ['result always includes source'],
        affectedArtifacts: ['docs/03-detailed-design.md', 'src/service.ts'],
      },
      implementationPlan: [
        'Update detailed design.',
        'Apply the implementation delta.',
        'Rerun unit and integration tests.',
      ],
      verificationGate: ['All affected Step gates pass.'],
    });
    await workflow.setSolution(request.id, {
      status: 'verified',
      approach: 'Apply the contract delta through each affected Step.',
      rationale: 'Incremental propagation preserves unaffected work.',
      changes: ['docs/03-detailed-design.md', 'src/service.ts'],
      verification: ['unit and integration gates passed'],
      updatedAt: new Date().toISOString(),
    });

    for (const step of [detailed, coding, unit, integration]) {
      await workflow.recordChange({
        ticketId: request.id,
        stepId: step.id,
        summary: `Applied CR to ${step.name}.`,
        entries: [{ path: step.outputs[0]!, operation: 'update' }],
        verificationAssessmentId: await passingAssessment(repository, step),
      });
    }

    const bugBeforeClose = await repository.read(bug.id);
    expect(bugBeforeClose.objectType === 'ticket' && bugBeforeClose.state).not.toBe('closed');
    await workflow.closeVerified(request.id);
    const closedRequest = await repository.read(request.id);
    const closedBug = await repository.read(bug.id);

    expect(closedRequest.objectType === 'ticket' && closedRequest.state).toBe('closed');
    expect(closedBug.objectType === 'ticket' && closedBug.state).toBe('closed');
    expect(closedBug.objectType === 'ticket' && closedBug.solution?.status).toBe('verified');
  });

  it('refuses to close a CR when any affected Step lacks change and verification evidence', async () => {
    const { graph, repository, workflow } = await setup();
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const coding = graph.steps.find((step) => step.type === 'CODING')!;
    const enhancement = await workflow.openEnhancement({
      sourceStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-incomplete',
      finding: 'Boundary branches are not covered.',
      correlationId: createObjectId(),
    });
    await workflow.setSolution(enhancement.id, {
      status: 'applied',
      approach: 'Add the missing boundary implementation and tests.',
      rationale: 'Coverage is below the approved KPI.',
      changes: ['src/service.ts', 'tests/service.test.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    const request = await workflow.openChangeRequest({
      sourceTicketId: enhancement.id,
      triggerStepId: unit.id,
      sourceStepId: coding.id,
      affectedStepIds: [coding.id, unit.id],
      contractDelta: {
        summary: 'Cover boundary behavior.',
        before: [],
        after: ['Boundary behavior is explicit and tested.'],
        affectedArtifacts: ['src/service.ts', 'tests/service.test.ts'],
      },
      implementationPlan: ['Update code and unit tests.'],
      verificationGate: ['Coverage KPI passes.'],
    });
    await workflow.setSolution(request.id, {
      status: 'verified',
      approach: 'Apply the boundary delta.',
      rationale: 'The missing behavior is localized.',
      changes: ['src/service.ts'],
      verification: ['coding gate passed'],
      updatedAt: new Date().toISOString(),
    });
    await workflow.recordChange({
      ticketId: request.id,
      stepId: coding.id,
      summary: 'Updated code.',
      entries: [{ path: 'src/service.ts', operation: 'update' }],
      verificationAssessmentId: await passingAssessment(repository, coding),
    });

    await expect(workflow.closeVerified(request.id)).rejects.toThrow(/missing verified applications/u);
  });
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-workflow-'));
  const repository = new DomainObjectRepository(new Workspace(root));
  await repository.load();
  const graph = compileProjectGraph({
    draft: samplePlan(),
    topic: 'Build a TypeScript service.',
    projectName: 'service',
  });
  await repository.persistCompiledGraph(graph);
  return { graph, repository, workflow: new TicketWorkflow(repository) };
}

async function passingAssessment(repository: DomainObjectRepository, step: Step) {
  const kpis = await Promise.all(step.kpiIds.map((id) => repository.read(id)));
  const assessment = await new QualityAssessmentService(repository).assessStep({
    step,
    metrics: kpis.flatMap((object) => object.objectType === 'kpi'
      ? [{ metric: object.metric, value: 1 }]
      : []),
  });
  return assessment.id;
}

function samplePlan(): Plan {
  const phases = [
    ['REQUIREMENT_ANALYSIS', 'Planner'],
    ['HIGH_LEVEL_DESIGN', 'Architect'],
    ['DETAILED_DESIGN', 'Architect'],
    ['CODE', 'Coder'],
    ['UNIT_TEST', 'Tester'],
    ['INTEGRATION_TEST', 'Tester'],
    ['MODULE_TEST', 'Tester'],
    ['FUNCTIONAL_TEST', 'Tester'],
  ] as const;
  return {
    version: '1', language: 'typescript', intent: 'greenfield', phaseId: 'P1',
    projectType: 'application', requirementDigest: 'Build a service.',
    complexityAssessment: { level: 'simple', rationale: 'One phase.', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Deliver core.', status: 'current', scope: ['core'],
      deliverables: ['src/main.ts'], dependsOn: [],
      verificationGate: { summary: 'All gates pass.', checks: ['Acceptance passes.'], failurePolicy: 'Open a Ticket.' },
    }],
    globalPrompt: 'Implement the plan.', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date().toISOString(),
    steps: phases.map(([phase, role], index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase,
      title: phase, description: `Execute ${phase}.`, systemPrompt: `Execute ${phase}.`, role,
      tools: ['read_file'], inputs: index ? [`artifact-${index}`] : [], outputs: [`artifact-${index + 1}`],
      subTasks: [], dependsOn: index ? [`S${String(index).padStart(3, '0')}`] : [],
      acceptance: `${phase} passes.`, maxAttempts: 3,
    })),
  };
}
