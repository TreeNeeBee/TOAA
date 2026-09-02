import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { TicketWorkflow } from '../src/application/project_management/ticket_workflow.js';
import { CorrectiveWorkflowService } from '../src/application/project_management/corrective_workflow_service.js';
import { ProjectStateService } from '../src/application/project_management/project_state_service.js';
import { createObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { TicketSchema, bindTicketWorkspace, type Ticket } from '../src/domain/tickets/ticket.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import { TicketRegistrationService } from '../src/application/project_management/ticket_registration_service.js';
import { QualityAssessmentService } from '../src/application/execution/quality_assessment_service.js';
import type { Step } from '../src/domain/steps/step.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { Workspace } from '../src/workspace/workspace.js';
import type { Plan } from '../src/core/plan.js';
import { bugContracts, failedTestOutcome, passedTestOutcome } from './helpers/ticket_fixtures.js';
import { buildBugFailureContracts } from '../src/application/project_management/bug_verification.js';

describe('TicketWorkflow', () => {
  it('preserves duplicate Bug reports while PM parks and reconciles the later Ticket', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const tester = graph.actors.find((actor) => actor.role === 'tester')!;
    const open = (summary: string) => workflow.openBug({
      creatorActorId: tester.id,
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: summary,
      summary,
      category: 'test',
      code: 'adapter_contract_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test',
        code: 'adapter_contract_failed',
        testSelectors: ['tests/integration/adapter.test.ts::returns source'],
      }),
    });

    const original = await open('The adapter omitted source in the first captured run.');
    await registration.register(original.id);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await open('A later run rendered different prose for the same adapter failure.');
    const duplicate = await registration.register(second.id);

    expect(second.id).not.toBe(original.id);
    expect(duplicate).toMatchObject({
      state: 'pending',
      pendingReason: 'duplicate',
      duplicateOfTicketId: original.id,
    });
    const linkedOriginal = await repository.read(original.id);
    expect(linkedOriginal.objectType === 'ticket' && linkedOriginal.duplicateTicketIds)
      .toContain(duplicate.id);
    const decisions = await repository.list({ objectType: 'decision-record' });
    expect(decisions.some((decision) =>
      decision.objectType === 'decision-record' &&
      decision.selected === 'park-as-duplicate' &&
      decision.evidenceRefs.includes(original.id) &&
      decision.evidenceRefs.includes(duplicate.id))).toBe(true);
    await expect(registration.routeAndAssign(duplicate.id)).rejects.toThrow(/must not be assigned/u);

    await registration.routeAndAssign(original.id);
    await workflow.setSolution(original.id, {
      status: 'verified',
      approach: 'Restore the adapter result contract.',
      rationale: 'The structural failure was reproduced at the original verification gate.',
      changes: ['docs/03-detailed-design.md'],
      verification: ['adapter integration test passed'],
      updatedAt: new Date().toISOString(),
    });
    // Without the replay the Bug simply does not close. Refusing is the invariant; throwing would
    // end the run over work that is merely unfinished.
    expect((await workflow.closeVerified(original.id)).state).not.toBe('closed');
    await workflow.closeVerified(original.id, {
      verificationStep: integration,
      testOutcomes: [passedTestOutcome(integration, ['tests/integration/adapter.test.ts'])],
    });
    await workflow.reconcileClosedCorrectiveTickets(graph.project.id);

    const reconciled = await repository.read(duplicate.id);
    expect(reconciled.objectType === 'ticket' && reconciled.state).toBe('cancelled');
  });

  it('inherits the discovering Ticket worktree when opening a corrective Ticket', async () => {
    const { graph, repository, workflow } = await setup();
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const codeStory = await workflow.storyForStep(coding.id);
    const boundStory = bindTicketWorkspace(codeStory, {
      kind: 'ticket',
      relativePath: `worktrees/tickets/${codeStory.id}`,
      branch: `xcompiler/ticket/${codeStory.id}`,
      revision: 'a'.repeat(40),
      workspaceId: createObjectId(),
      changeSetId: createObjectId(),
      reason: 'change-set',
      boundAt: new Date().toISOString(),
    });
    await repository.update(boundStory, boundStory.state);

    const bug = await workflow.openBug({
      creatorActorId: graph.actors.find((actor) => actor.role === 'developer')!.id,
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'candidate-only failure',
      summary: 'candidate-only failure',
      category: 'test',
      code: 'candidate_failure',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      causationId: boundStory.id,
      ...bugContracts(integration, detailed, integration, {
        category: 'test', code: 'candidate_failure',
      }),
    });

    expect(bug.workspaceBinding).toMatchObject({
      kind: 'ticket',
      relativePath: `worktrees/tickets/${codeStory.id}`,
      reason: 'inherited',
    });
    expect(bug.workspaceBindingHistory).toEqual([bug.workspaceBinding]);
  });

  it('keeps a Bug open until its linked Change Request is implemented and verified', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;

    const bug = await workflow.openBug({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'The service and adapter contracts disagree.',
      summary: 'Integration contract mismatch.',
      category: 'test',
      code: 'integration_contract_mismatch',
      retryable: true,
      switchProvider: false,
      rawEvidenceRef: '.xcompiler/failures/integration.log',
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test',
        code: 'integration_contract_mismatch',
        testSelectors: ['tests/integration.test.ts::service adapter contract'],
      }),
    });
    await registration.routeAndAssign(bug.id);
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Correct the detailed contract and propagate its delta.',
      rationale: 'The implementation followed an ambiguous contract.',
      changes: ['docs/03-detailed-design.md'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, detailed);
    const request = await workflow.openChangeRequest({
      sourceTicketIds: [bug.id],
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      targetStepId: integration.id,
      propagationStepIds: [integration.id],
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
    const handedOffBug = await repository.read(bug.id);
    expect(handedOffBug.objectType === 'ticket' && handedOffBug.state).toBe('resolved');
    await registration.routeAndAssign(request.id);
    await workflow.setSolution(request.id, {
      status: 'verified',
      approach: 'Apply the contract delta through each affected Step.',
      rationale: 'Incremental propagation preserves unaffected work.',
      changes: ['docs/03-detailed-design.md', 'src/service.ts'],
      verification: ['unit and integration gates passed'],
      updatedAt: new Date().toISOString(),
    });

    await workflow.recordChange({
      ticketId: request.id,
      stepId: integration.id,
      summary: `Verified the accepted correction at ${integration.name}.`,
      entries: [{ path: integration.outputs[0]!, operation: 'update' }],
      verificationAssessmentId: await passingAssessment(repository, integration),
    });

    const appliedRequest = await repository.read(request.id);
    expect(appliedRequest.objectType === 'ticket' && appliedRequest.type === 'change-request'
      ? appliedRequest.applications.find((application) => application.stepId === integration.id)
      : undefined).toMatchObject({
      outcome: 'applied',
    });

    const bugBeforeClose = await repository.read(bug.id);
    expect(bugBeforeClose.objectType === 'ticket' && bugBeforeClose.state).not.toBe('closed');
    await workflow.closeVerified(request.id, {
      verificationStep: integration,
      testOutcomes: [passedTestOutcome(integration, ['tests/integration.test.ts'])],
    });
    const closedRequest = await repository.read(request.id);
    const closedBug = await repository.read(bug.id);

    expect(closedRequest.objectType === 'ticket' && closedRequest.state).toBe('closed');
    expect(closedBug.objectType === 'ticket' && closedBug.state).toBe('closed');
    expect(closedBug.objectType === 'ticket' && closedBug.solution?.status).toBe('verified');
    const traces = (await repository.list({ objectType: 'ticket-trace-event' }))
      .filter((event) => event.objectType === 'ticket-trace-event' && event.ticketId === bug.id)
      .sort((left, right) => left.sequence - right.sequence);
    const resolvedIndex = traces.findIndex((event) => event.toTicketState === 'resolved');
    expect(resolvedIndex).toBeGreaterThanOrEqual(0);
    expect(traces.slice(resolvedIndex + 1).some((event) => event.toTicketState === 'in_progress'))
      .toBe(false);
  });

  it('closes an applied parent CR after its child hand-off was persisted before interruption', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const tester = graph.actors.find((actor) => actor.role === 'tester')!;
    const bug = await workflow.openBug({
      creatorActorId: tester.id,
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'The integration contract failed.',
      summary: 'The integration contract failed.',
      category: 'test',
      code: 'integration_contract_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test',
        code: 'integration_contract_failed',
        testSelectors: ['tests/integration/pipeline.test.ts'],
      }),
    });
    await registration.routeAndAssign(bug.id, { forStepId: detailed.id });
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Restore the integration contract in detailed design.',
      rationale: 'The downstream test exposed an omitted source contract.',
      changes: ['docs/03-detailed-design.md'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, detailed);
    const parent = await workflow.openChangeRequest({
      sourceTicketIds: [bug.id],
      creatorActorId: tester.id,
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      targetStepId: functional.id,
      propagationStepIds: [functional.id],
      contractDelta: {
        summary: 'Carry the corrected integration contract downstream.',
        before: ['pipeline omitted source'],
        after: ['pipeline includes source'],
        affectedArtifacts: ['tests/functional/pipeline.test.ts'],
      },
      implementationPlan: ['Verify functional impact.'],
      verificationGate: ['Functional gate passes.'],
    });
    await registration.routeAndAssign(parent.id, { forStepId: functional.id });
    await workflow.setSolution(parent.id, {
      status: 'verified',
      approach: 'Verify the existing functional contract.',
      rationale: 'No local delta is required.',
      changes: [],
      verification: ['Functional gate passed.'],
      updatedAt: new Date().toISOString(),
    });
    await workflow.recordChange({
      ticketId: parent.id,
      stepId: functional.id,
      summary: 'Verified functional impact.',
      entries: [],
      verificationAssessmentId: await passingAssessment(repository, functional),
      application: {
        outcome: 'not-applicable',
        reasonCategory: 'already-aligned',
        rationale: 'The functional contract already consumes the accepted shape.',
        inspectedArtifacts: ['tests/functional/pipeline.test.ts'],
        evidence: ['The functional contract was inspected and passed.'],
      },
    });
    const child = await workflow.openChangeRequest({
      sourceTicketIds: [bug.id],
      creatorActorId: tester.id,
      triggerStepId: integration.id,
      sourceStepId: functional.id,
      targetStepId: integration.id,
      propagationStepIds: [integration.id],
      parentChangeRequestId: parent.id,
      contractDelta: {
        summary: 'Replay the original integration contract.',
        before: ['pipeline omitted source'],
        after: ['pipeline includes source'],
        affectedArtifacts: ['tests/integration/pipeline.test.ts'],
      },
      implementationPlan: ['Replay the original integration failure.'],
      verificationGate: ['Original integration selector passes.'],
    });
    await registration.register(child.id);

    await workflow.reconcileClosedCorrectiveTickets(graph.project.id);

    const recoveredParent = await repository.read(parent.id);
    const openChild = await repository.read(child.id);
    const openBug = await repository.read(bug.id);
    expect(recoveredParent.objectType === 'ticket' && recoveredParent.state).toBe('closed');
    expect(openChild.objectType === 'ticket' && openChild.state).toBe('created');
    expect(openBug.objectType === 'ticket' && openBug.state).not.toBe('closed');
  });

  it('rejects a corrective handoff atomically when the repairing Step has no passing assessment', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const bug = await workflow.openBug({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'The adapter contract failed.',
      summary: 'The adapter contract failed.',
      category: 'test',
      code: 'adapter_contract_failed',
      retryable: false,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test', code: 'adapter_contract_failed',
      }),
    });
    await registration.routeAndAssign(bug.id);
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Repair the adapter contract.',
      rationale: 'The failing contract is localized.',
      changes: ['src/adapter.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });

    await expect(workflow.openChangeRequest({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      sourceTicketIds: [bug.id],
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      targetStepId: integration.id,
      propagationStepIds: [integration.id],
      contractDelta: {
        summary: 'Propagate the repaired adapter contract.',
        before: ['adapter may omit source'],
        after: ['adapter includes source'],
        affectedArtifacts: ['src/adapter.ts'],
      },
      implementationPlan: ['Apply the accepted adapter delta.'],
      verificationGate: ['The integration contract passes.'],
    })).rejects.toThrow(/no attached Quality Assessment/u);

    const unchangedBug = await repository.read(bug.id);
    expect(unchangedBug.objectType === 'ticket' && unchangedBug.state).toBe('in_progress');
    const requests = await repository.list({ objectType: 'ticket', projectId: graph.project.id });
    expect(requests.some((ticket) => ticket.objectType === 'ticket' && ticket.type === 'change-request'))
      .toBe(false);
  });

  it('reopens the waiting Bug when its gate reports the same failure again', async () => {
    // The gate that was going to confirm the repair failed the same way instead. That is the verdict
    // the resolved Ticket was waiting for, and it is negative — so the Ticket comes back rather than
    // a second one being opened beside it, which would leave the first waiting forever.
    const { graph, repository, workflow, registration } = await setup();
    const controller = new CorrectiveWorkflowService(repository);
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const failure = {
      kind: 'execution' as const,
      category: 'test' as const,
      code: 'adapter_contract_mismatch',
      message: 'adapter returned undefined',
      retryable: false,
      switchProvider: false,
    };
    const routeArgs = {
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStepId: integration.id,
      message: 'adapter returned undefined',
      summary: 'adapter returned undefined',
      failure,
      correlationId: createObjectId(),
      bugKind: 'test-failure' as const,
    };
    const bug = await controller.routeFailure(routeArgs);
    await registration.routeAndAssign(bug.id);
    await workflow.setSolution(bug.id, {
      status: 'proposed',
      approach: 'Restore the adapter result contract.',
      rationale: 'Reproduced at the integration gate.',
      changes: ['src/adapter.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await workflow.awaitVerification(bug.id, {
      stepId: detailed.id,
      qualityAssessmentId: await passingAssessment(repository, detailed),
    });
    expect((await repository.read(bug.id)).state).toBe('resolved');

    const state = new ProjectStateService(repository);
    let failedStep = await state.requireStep(integration.id);
    failedStep = await state.transitionStep(failedStep, 'in_progress');
    failedStep = await state.transitionStep(failedStep, 'delivered');
    await state.transitionStep(failedStep, 'closed');
    let targetStep = await state.requireStep(detailed.id);
    targetStep = await state.transitionStep(targetStep, 'in_progress');
    targetStep = await state.transitionStep(targetStep, 'delivered');
    await state.transitionStep(targetStep, 'closed');
    const parent = await openChangeRequestFor(
      repository,
      graph,
      [integration.id],
      graph.actors.find((actor) => actor.role === 'tester')!.id,
    );
    const routedParent = await registration.routeAndAssign(parent.id);
    await state.transitionTicketPath(routedParent.ticket, ['in_progress']);

    const again = await controller.routeFailure({
      ...routeArgs,
      correlationId: createObjectId(),
      parentChangeRequestId: parent.id,
    });

    expect(again.id).toBe(bug.id);
    expect((await repository.read(bug.id)).state).toBe('reopened');
    expect((await repository.read(integration.id)).state).toBe('pending');
    expect((await repository.read(detailed.id)).state).toBe('reopened');
    const blockedParent = await repository.read(parent.id);
    expect(blockedParent.objectType === 'ticket' && blockedParent.state).toBe('pending');
    expect(blockedParent.objectType === 'ticket' && blockedParent.blockedByTicketIds).toContain(bug.id);
  });

  it('parks a repaired Bug out of the scheduler while it waits for its gate', async () => {
    // The repair has landed and only the verdict is outstanding. Parking it under a reason that
    // reads as "blocked on something that will clear" left it schedulable at the Step that had just
    // finished it: a live run cycled one Bug through pending → in_progress three times, re-running
    // a repair that was already done, and the Ticket never propagated.
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const bug = await workflow.openBug({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'adapter contract mismatch',
      summary: 'adapter contract mismatch',
      category: 'test',
      code: 'adapter_contract_mismatch',
      retryable: false,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test',
        code: 'adapter_contract_mismatch',
      }),
    });
    await registration.routeAndAssign(bug.id);
    await workflow.setSolution(bug.id, {
      status: 'proposed',
      approach: 'Restore the adapter result contract.',
      rationale: 'Reproduced at the integration gate.',
      changes: ['src/adapter.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });

    // Resolution asserts this Step already checked the repair, so it must show that check: an
    // assessment of a different Step does not evidence it, and neither does a failing one.
    await expect(workflow.awaitVerification(bug.id, {
      stepId: detailed.id,
      qualityAssessmentId: await passingAssessment(repository, integration),
    })).rejects.toThrow(/passing assessment of its own Step/u);
    const failing = await new QualityAssessmentService(repository).assessStep({
      step: detailed,
      metrics: (await Promise.all(detailed.kpiIds.map((id) => repository.read(id))))
        .flatMap((object) => object.objectType === 'kpi'
          ? [{ metric: object.metric, value: 0 }]
          : []),
    });
    await expect(workflow.awaitVerification(bug.id, {
      stepId: detailed.id,
      qualityAssessmentId: failing.id,
    })).rejects.toThrow(/passing assessment of its own Step/u);

    const parked = await workflow.awaitVerification(bug.id, {
      stepId: detailed.id,
      qualityAssessmentId: await passingAssessment(repository, detailed),
    });

    expect(parked.state).toBe('resolved');
  });

  it('reports only Bugs as verified resolutions, never an Enhancement raised inside the CR', async () => {
    // Both types close in this sweep, but the caller feeds the returned ids to the verified-Bug
    // knowledge base, which refuses anything else. A live run raised an Enhancement inside a Change
    // Request, closed it here, handed its id on, and the throw ended the run after S005 had already
    // delivered its work.
    const { graph, repository, workflow, registration } = await setup();
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const tester = graph.actors.find((actor) => actor.role === 'tester')!.id;
    const enhancement = await workflow.openEnhancement({
      creatorActorId: tester,
      sourceStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-incomplete',
      finding: 'Boundary branches are not covered.',
      correlationId: createObjectId(),
    });
    await registration.routeAndAssign(enhancement.id);
    await workflow.setSolution(enhancement.id, {
      status: 'applied',
      approach: 'Add the missing boundary implementation and tests.',
      rationale: 'Coverage is below the approved KPI.',
      changes: ['src/service.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, unit);
    const request = await workflow.openChangeRequest({
      creatorActorId: tester,
      sourceTicketIds: [enhancement.id],
      triggerStepId: unit.id,
      sourceStepId: unit.id,
      targetStepId: coding.id,
      propagationStepIds: [coding.id],
      contractDelta: {
        summary: 'Cover the boundary branches.',
        before: ['uncovered'], after: ['covered'], affectedArtifacts: ['src/service.ts'],
      },
      implementationPlan: ['Add the branch tests.'],
      verificationGate: ['coverage meets the KPI'],
    });
    // The Enhancement is raised inside the CR and carries a solution, so the sweep reaches it.
    const raised = await workflow.openEnhancement({
      creatorActorId: tester,
      sourceStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-incomplete',
      finding: 'The renderer branch is still uncovered.',
      correlationId: createObjectId(),
      parentChangeRequestId: request.id,
    });
    await registration.routeAndAssign(raised.id);
    await workflow.setSolution(raised.id, {
      status: 'applied',
      approach: 'Cover the renderer branch.',
      rationale: 'Reported by the unit gate.',
      changes: ['tests/renderer.test.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });

    const verified = await workflow.verifyCorrectionsRaisedBy(
      request.id, unit, [passedTestOutcome(unit, ['tests/renderer.test.ts'])], ['coverage restored'],
    );
    expect(verified).not.toContain(raised.id);
    const closed = await repository.read(raised.id);
    expect(closed.objectType === 'ticket' && closed.state).toBe('closed');
  });

  it('refuses to close a CR until its own Step has verified evidence', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const enhancement = await workflow.openEnhancement({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      sourceStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-incomplete',
      finding: 'Boundary branches are not covered.',
      correlationId: createObjectId(),
    });
    await registration.routeAndAssign(enhancement.id);
    await workflow.setSolution(enhancement.id, {
      status: 'applied',
      approach: 'Add the missing boundary implementation and tests.',
      rationale: 'Coverage is below the approved KPI.',
      changes: ['src/service.ts', 'tests/service.test.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, coding);
    const request = await workflow.openChangeRequest({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      sourceTicketIds: [enhancement.id],
      triggerStepId: unit.id,
      sourceStepId: coding.id,
      targetStepId: coding.id,
      propagationStepIds: [coding.id],
      contractDelta: {
        summary: 'Cover boundary behavior.',
        before: [],
        after: ['Boundary behavior is explicit and tested.'],
        affectedArtifacts: ['src/service.ts', 'tests/service.test.ts'],
      },
      implementationPlan: ['Update code and unit tests.'],
      verificationGate: ['Coverage KPI passes.'],
    });
    await registration.routeAndAssign(request.id);
    await workflow.setSolution(request.id, {
      status: 'verified',
      approach: 'Apply the boundary delta.',
      rationale: 'The missing behavior is localized.',
      changes: ['src/service.ts'],
      verification: ['coding gate passed'],
      updatedAt: new Date().toISOString(),
    });
    // Applied, but with no verification assessment: the change was made and never proven.
    await workflow.recordChange({
      ticketId: request.id,
      stepId: coding.id,
      summary: 'Updated code.',
      entries: [{ path: 'src/service.ts', operation: 'update' }],
    });

    // Only this CR's own Step matters now; a downstream Step's evidence belongs to the child CR
    // opened for it, which closes on its own.
    await expect(workflow.closeVerified(request.id))
      .rejects.toThrow(/missing a verified application/u);
  });
  it('opens one Step at a time as a Change Request advances, in V-model order', async () => {
    // Reopening the whole downstream chain up front put every affected Step into `reopened` before
    // anyone knew the delta would reach them, and replaced the V-model's ordering with a scheduler
    // picking from a pool. The state machine advances one Step at a time, so activation does too.
    const { graph, repository } = await setup();
    const [detailed, coding, unit] = ['DETAILED_DESIGN', 'CODE', 'UNIT_TEST']
      .map((type) => graph.steps.find((step) => step.type === type)!);
    const state = new ProjectStateService(repository);
    for (const step of [unit, coding, detailed]) {
      let current = await state.requireStep(step.id);
      current = await state.transitionStep(current, 'in_progress');
      await state.transitionStep(current, 'delivered');
    }

    const request = await openChangeRequestFor(repository, graph, [detailed.id, coding.id, unit.id]);
    await new CorrectiveWorkflowService(repository).activateChangeRequest(request.id);

    const stateOf = async (id: string) => {
      const object = await repository.read(id as never);
      return object.objectType === 'step' ? object.state : 'missing';
    };
    // Earliest in V-model order opens; the rest wait until the delta actually reaches them.
    expect(await stateOf(detailed.id)).toBe('reopened');
    expect(await stateOf(coding.id)).toBe('delivered');
    expect(await stateOf(unit.id)).toBe('delivered');
  });

  it('sends a downstream dependency need back to the design that owns the manifest', async () => {
    // The same shape as a defect rolling back to the Step that caused it: work discovered that an
    // accepted upstream artifact is wrong for it. HIGH_LEVEL_DESIGN decides the whole dependency
    // set, so the requesting Step parks and PM drives the return.
    const { graph, repository } = await setup();
    const state = new ProjectStateService(repository);
    const design = graph.steps.find((step) => step.type === 'HIGH_LEVEL_DESIGN')!;
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    for (const step of [design, coding]) {
      let current = await state.requireStep(step.id);
      current = await state.transitionStep(current, 'in_progress');
      await state.transitionStep(current, 'delivered');
    }

    const corrective = new CorrectiveWorkflowService(repository);
    const request = await corrective.routeDependencyChange({
      requestingStepId: coding.id,
      packages: ['zod', 'nanoid'],
      reason: 'The parser needs schema validation.',
      creatorActorId: graph.actors.find((actor) => actor.role === 'developer')!.id,
      correlationId: createObjectId(),
    });

    expect(request.type).toBe('change-request');
    expect(request.targetStepId).toBe(design.id);
    expect(request.description).toContain('zod, nanoid');

    const stateOf = async (id: string) => {
      const object = await repository.read(id as never);
      return object.objectType === 'step' ? object.state : 'missing';
    };
    // The design reopens to answer; the requester waits rather than proceeding without the packages.
    expect(await stateOf(design.id)).toBe('reopened');
    expect(await stateOf(coding.id)).toBe('pending');

    // Asking twice for the same packages joins the open request instead of opening a second one.
    const again = await corrective.routeDependencyChange({
      requestingStepId: coding.id,
      packages: ['nanoid', 'zod'],
      reason: 'still needed',
      creatorActorId: graph.actors.find((actor) => actor.role === 'developer')!.id,
      correlationId: createObjectId(),
    });
    expect(again.id).toBe(request.id);
  });

  // From a live run, which aborted here: CODE failed, a Bug was opened and assigned to the only
  // developer, and while repairing it the Step asked for a package. The Step parked — but the Bug
  // stayed `in_progress` holding the developer's one capacity slot. The answer arrives as a re-check
  // Change Request targeting that same Step, so nothing could take it and the run stopped with
  // "No registered actor can process DEP-P1-003".
  // A run killed mid-attempt left three tasks `in_progress` under a Story that had since been
  // blocked. The scheduler will not restart work it believes is running, and will not descend into a
  // parent it cannot work, so every later pass saw active work it could not advance and the phase
  // stopped for lack of progress with every actor idle. Work in progress under a *workable* parent
  // is untouched — a deferred infrastructure failure resumes exactly that way.
  it('hands back in-progress work whose parent the scheduler can no longer reach', async () => {
    const reclaimedFor = async (parent: Record<string, unknown>) => {
      const child = {
        objectType: 'ticket', id: 'task-1', projectId: 'p1', type: 'task',
        state: 'in_progress', parentTicketId: 'story-1', blockedByTicketIds: [],
      };
      const committed: unknown[][] = [];
      const workflow = new TicketWorkflow({
        list: async () => [child, { objectType: 'ticket', id: 'story-1', projectId: 'p1', ...parent }],
        read: async () => undefined,
        commit: async (objects: unknown[]) => { committed.push(objects); },
      } as never);
      const internals = workflow as unknown as {
        lifecycle: { prepareTransition: (t: unknown, s: string, o: unknown) => Promise<{ objects: unknown[] }> };
      };
      internals.lifecycle.prepareTransition = async () => ({ objects: [] });
      return workflow.reclaimUnreachableWork('p1' as never);
    };

    // Parent parked, or holding a blocker: the child can never be reached again.
    expect(await reclaimedFor({ type: 'story', state: 'pending', blockedByTicketIds: [] })).toBe(1);
    expect(await reclaimedFor({ type: 'story', state: 'created', blockedByTicketIds: ['bug-1'] })).toBe(1);
    // Parent workable: the child is legitimately in flight and must be left alone.
    expect(await reclaimedFor({ type: 'story', state: 'in_progress', blockedByTicketIds: [] })).toBe(0);
  });

  // A repair chain that propagates a change forward opens hops on downstream Steps. Those Steps
  // cannot become ready until the Step whose Story discovered the defect delivers — so parking that
  // Story leaves each side waiting on the other. A live run deadlocked exactly there: a Bug found at
  // DETAILED_DESIGN hopped to CODE and then to UNIT_TEST, and UNIT_TEST could not be scheduled while
  // DETAILED_DESIGN stayed parked behind it. A hop aimed *upstream* is the ordinary case and must
  // still hold its Story, or a verification Step would re-run and re-declare success mid-repair.
  it('unparks a Story held by a repair hop that is itself waiting on that Story', async () => {
    const releasedFor = async (targetDependsOn: string, discoveringState = 'reopened') => {
      const step = (id: string, dependencyStepIds: string[], state = 'pending') =>
        ({ objectType: 'step', id, projectId: 'p1', dependencyStepIds, state });
      const story = {
        objectType: 'ticket', id: 'story-1', projectId: 'p1', type: 'story',
        state: 'pending', stepId: 'step-design', blockedByTicketIds: ['cr-1'],
      };
      const released: Array<{ id: string; resume: boolean | undefined }> = [];
      const workflow = new TicketWorkflow({
        list: async () => [
          story,
          {
            objectType: 'ticket', id: 'cr-1', projectId: 'p1', type: 'change-request',
            state: 'created', targetStepId: 'step-unit', blockedByTicketIds: [],
          },
          step('step-design', [], discoveringState),
          step('step-unit', [targetDependsOn]),
          step('step-code', ['step-design']),
        ],
        read: async () => story,
        commit: async () => {},
      } as never);
      (workflow as unknown as { blockers: { releaseFrom: unknown } }).blockers = {
        releaseFrom: async (_t: unknown, id: string, options?: { resume?: boolean }) => {
          released.push({ id, resume: options?.resume });
        },
      };
      return { count: await workflow.releaseCyclicCorrectiveBlockers('p1' as never), released };
    };

    // The hop's Step depends on the parked Story's Step, transitively, and that Step has not
    // delivered: neither side can move.
    expect(await releasedFor('step-code')).toEqual({
      count: 1,
      released: [{ id: 'cr-1', resume: false }],
    });
    // The hop's Step is independent of it: the Story is legitimately waiting and stays parked.
    expect(await releasedFor('step-other')).toEqual({ count: 0, released: [] });
    // Downstream, but the discovering Step already delivered, so the hop is reachable. This is the
    // ordinary mid-repair hold — a verification Story must not re-run and re-declare success.
    expect(await releasedFor('step-code', 'delivered')).toEqual({ count: 0, released: [] });

    // A Bug holds its Story directly and advances through hops, so the unreachable hop is one edge
    // further out. Releasing only the direct Story-to-hop edge left this Phase idle for the same
    // reason: the Story was parked behind the Bug, and the Bug waited on the hop needing the Story.
    const story = {
      objectType: 'ticket', id: 'story-1', projectId: 'p1', type: 'story',
      state: 'pending', stepId: 'step-design', blockedByTicketIds: ['bug-1'],
    };
    const released: Array<{ id: string; resume: boolean | undefined }> = [];
    const workflow = new TicketWorkflow({
      list: async () => [
        story,
        {
          objectType: 'ticket', id: 'bug-1', projectId: 'p1', type: 'bug',
          state: 'pending', blockedByTicketIds: [],
        },
        {
          objectType: 'ticket', id: 'cr-1', projectId: 'p1', type: 'change-request',
          state: 'created', targetStepId: 'step-unit', sourceTicketIds: ['bug-1'], blockedByTicketIds: [],
        },
        { objectType: 'step', id: 'step-design', projectId: 'p1', state: 'reopened', dependencyStepIds: [] },
        { objectType: 'step', id: 'step-unit', projectId: 'p1', state: 'pending', dependencyStepIds: ['step-design'] },
      ],
      read: async () => story,
      commit: async () => {},
    } as never);
    (workflow as unknown as { blockers: { releaseFrom: unknown } }).blockers = {
      releaseFrom: async (_t: unknown, id: string, options?: { resume?: boolean }) => {
        released.push({ id, resume: options?.resume });
      },
    };
    expect(await workflow.releaseCyclicCorrectiveBlockers('p1' as never)).toBe(1);
    expect(released).toEqual([{ id: 'bug-1', resume: false }]);

    // Edge recovery itself consumes no actor capacity. Even with no current headroom, the Ticket
    // stays pending and the scheduler can choose the prerequisite work before resuming this one.
    const parked = { ...story, activeAssignmentId: 'asg-1' };
    const skipped: string[] = [];
    const bounded = new TicketWorkflow({
      list: async () => [
        parked,
        {
          objectType: 'ticket', id: 'bug-1', projectId: 'p1', type: 'bug',
          state: 'pending', blockedByTicketIds: [],
        },
        {
          objectType: 'ticket', id: 'cr-1', projectId: 'p1', type: 'change-request',
          state: 'created', targetStepId: 'step-unit', sourceTicketIds: ['bug-1'], blockedByTicketIds: [],
        },
        { objectType: 'step', id: 'step-design', projectId: 'p1', state: 'reopened', dependencyStepIds: [] },
        { objectType: 'step', id: 'step-unit', projectId: 'p1', state: 'pending', dependencyStepIds: ['step-design'] },
        {
          objectType: 'ticket-assignment', id: 'asg-1', projectId: 'p1',
          assigneeActorId: 'actor-1', capacityConsumed: true,
        },
        {
          objectType: 'actor-registration', id: 'actor-1', projectId: 'p1',
          capacity: 1, activeAssignmentIds: ['asg-other'],
        },
      ],
      read: async () => parked,
      commit: async () => {},
    } as never);
    (bounded as unknown as { blockers: { releaseFrom: unknown } }).blockers = {
      releaseFrom: async (_t: unknown, id: string) => { skipped.push(id); },
    };
    expect(await bounded.releaseCyclicCorrectiveBlockers('p1' as never)).toBe(1);
    expect(skipped).toEqual(['bug-1']);
  });

  it('frees the requesting role, so the answer can be assigned back to it', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const state = new ProjectStateService(repository);
    const design = graph.steps.find((step) => step.type === 'HIGH_LEVEL_DESIGN')!;
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const developer = graph.actors.find((actor) => actor.role === 'developer')!;
    for (const step of [design, coding]) {
      let current = await state.requireStep(step.id);
      current = await state.transitionStep(current, 'in_progress');
      await state.transitionStep(current, 'delivered');
    }

    // A Bug on the CODE Step, assigned and started: this is what holds the developer's slot.
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const bug = await workflow.openBug({
      creatorActorId: developer.id,
      failedStep: await state.requireStep(unit.id),
      targetStep: await state.requireStep(coding.id),
      verificationStep: await state.requireStep(unit.id),
      kind: 'test-failure',
      severity: 'high',
      message: 'the parser drops the source field',
      summary: 'parser defect',
      category: 'test',
      code: 'parser_drops_source',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(unit, coding, unit, {
        category: 'test', code: 'parser_drops_source',
      }),
    });
    await registration.routeAndAssign(bug.id);
    // Recording a solution is what moves an assigned Ticket into `in_progress`, which is the state
    // that holds capacity — and the state the live Bug was in when the request was raised.
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Return the source field from parse().',
      rationale: 'Two call sites depend on it.',
      changes: ['src/parser.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    const inProgress = await repository.read(bug.id);
    expect(inProgress.objectType === 'ticket' && inProgress.state).toBe('in_progress');
    const capacityBefore = await activeAssignments(repository, developer.id);
    expect(capacityBefore, 'the Bug must hold the slot for this to mean anything').toBe(1);

    await new CorrectiveWorkflowService(repository).routeDependencyChange({
      requestingStepId: coding.id,
      requestingTicket: (await repository.read(bug.id)) as Ticket,
      packages: ['zod'],
      reason: 'schema validation',
      creatorActorId: developer.id,
      correlationId: createObjectId(),
    });

    expect(await activeAssignments(repository, developer.id)).toBe(0);
    const parked = await repository.read(bug.id);
    expect(parked.objectType === 'ticket' && parked.state).toBe('pending');
    expect(parked.objectType === 'ticket' && parked.pendingReason).toBe('dependency');
  });

  it('makes every downstream Step re-check after the dependency set changes', async () => {
    // A corrective chain stops where the delta stops, because it carries a change. This chain
    // carries the fact that the environment moved, and only each Step can say whether that breaks
    // it — so it runs to the end regardless of what any hop produced.
    const { graph, repository } = await setup();
    const state = new ProjectStateService(repository);
    const corrective = new CorrectiveWorkflowService(repository);
    const byType = (type: string) => graph.steps.find((step) => step.type === type)!;
    const design = byType('HIGH_LEVEL_DESIGN');
    const coding = byType('CODE');
    for (const step of [design, coding]) {
      let current = await state.requireStep(step.id);
      current = await state.transitionStep(current, 'in_progress');
      await state.transitionStep(current, 'delivered');
    }

    const request = await corrective.routeDependencyChange({
      requestingStepId: coding.id,
      packages: ['zod'],
      reason: 'schema validation',
      creatorActorId: graph.actors.find((actor) => actor.role === 'developer')!.id,
      correlationId: createObjectId(),
    });

    // The design answers; the next Step downstream of it is asked to confirm, not the requester.
    await completeDependencyHop(repository, request.id, design.id);
    const openRequests = async () => (await repository.list({ objectType: 'ticket' }))
      .filter((t): t is Ticket => t.objectType === 'ticket'
        && t.type === 'change-request' && t.state !== 'closed' && t.state !== 'cancelled');
    const afterDesign = await openRequests();
    expect(afterDesign).toHaveLength(1);
    // A re-check hop owns no part of the manifest and cannot call add_dependency. Handed the
    // request's own plan it was told to "add cron after a compatibility check" when cron was
    // already installed — nothing to do, no stated way to conclude, and it probed until the
    // no-progress guard stopped it.
    const recheck = afterDesign[0]!;
    expect(recheck.type === 'change-request' && recheck.implementationPlan.join(' '))
      .toContain('Check this Step');
    expect(recheck.type === 'change-request' && recheck.implementationPlan.join(' '))
      .not.toContain('Add zod after');
    expect(afterDesign[0]!.type === 'change-request' && afterDesign[0]!.targetStepId)
      .toBe(byType('DETAILED_DESIGN').id);
    expect(recheck.type === 'change-request' && recheck.parentChangeRequestId).toBe(request.id);
    expect(recheck.parentTicketId).toBe(request.parentTicketId);
    expect(recheck.rootTicketId).toBe(request.rootTicketId);
  });

  it('frees the capacity a blocked Ticket reserved before it ever started', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const tickets = await repository.list({ objectType: 'ticket', projectId: graph.project.id });
    const story = tickets.find(
      (object) => object.objectType === 'ticket' && object.stepId === coding.id,
    )!;

    // Routing reserves capacity while the Story is still `created`.
    const routed = await registration.routeAndAssign(story.id, { forStepId: coding.id });
    const owner = await registration.actorById(routed.assignment.assigneeActorId);
    expect(owner.activeAssignmentIds).toContain(routed.assignment.id);

    await workflow.openBug({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-failure',
      severity: 'high',
      message: 'unit gate failed',
      summary: 'unit gate failed',
      category: 'test',
      code: 'unit_failure',
      retryable: true,
      switchProvider: false,
      rawEvidenceRef: '.xcompiler/failures/unit.log',
      correlationId: createObjectId(),
      ...bugContracts(unit, coding, unit, {
        category: 'test', code: 'unit_failure',
      }),
    });

    const blocked = await repository.read(story.id);
    expect(blocked.objectType === 'ticket' && blocked.state).toBe('created');
    expect(blocked.objectType === 'ticket' && blocked.blockedByTicketIds).toHaveLength(1);
    // The Story is parked with no state change, so only an explicit release can return the seat —
    // and without it a single-capacity developer could never take the Bug that unblocks this Story.
    const after = await registration.actorById(routed.assignment.assigneeActorId);
    expect(after.activeAssignmentIds).not.toContain(routed.assignment.id);
  });

  it('does not reopen resolved Story work when a corrective Ticket owns the repair', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const story = await workflow.storyForStep(detailed.id);
    await registration.routeAndAssign(story.id, { forStepId: detailed.id });
    await new ProjectStateService(repository).transitionTicketPath(story, ['in_progress', 'resolved']);

    const bug = await workflow.openBug({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'integration contract failed',
      summary: 'integration contract failed',
      category: 'test',
      code: 'integration_contract_failure',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test', code: 'integration_contract_failure',
      }),
    });

    const blocked = await repository.read(story.id);
    expect(blocked.objectType === 'ticket' && blocked.state).toBe('resolved');
    expect(blocked.objectType === 'ticket' && blocked.blockedByTicketIds).toEqual([bug.id]);
  });

  it('parks the active parent CR instead of blocking a closed Story for a quality gap', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const story = await workflow.storyForStep(coding.id);
    const state = new ProjectStateService(repository);
    const routedStory = await registration.routeAndAssign(story.id, { forStepId: coding.id });
    await state.transitionTicketPath(routedStory.ticket, ['in_progress', 'resolved', 'closed']);
    const tester = graph.actors.find((actor) => actor.role === 'tester')!;
    const parent = await openChangeRequestFor(repository, graph, [unit.id], tester.id);
    await registration.register(parent.id);
    const routedParent = await registration.routeAndAssign(parent.id, { forStepId: unit.id });
    await state.transitionTicketPath(routedParent.ticket, ['in_progress']);

    const enhancement = await workflow.openEnhancement({
      creatorActorId: tester.id,
      sourceStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'quality-shortfall',
      finding: 'Line coverage is below the approved KPI.',
      parentChangeRequestId: parent.id,
      correlationId: createObjectId(),
    });

    const unchangedStory = await repository.read(story.id);
    const blockedParent = await repository.read(parent.id);
    expect(unchangedStory.objectType === 'ticket' && unchangedStory.state).toBe('closed');
    expect(unchangedStory.objectType === 'ticket' && unchangedStory.blockedByTicketIds).toEqual([]);
    expect(blockedParent.objectType === 'ticket' && blockedParent.state).toBe('pending');
    expect(blockedParent.objectType === 'ticket' && blockedParent.blockedByTicketIds).toEqual([
      enhancement.id,
    ]);
    expect(enhancement.creatorActorId).toBe(tester.id);
  });

  it('parks a Bug while an independently discovered upstream Enhancement is repaired', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const requirement = graph.steps.find((step) => step.type === 'REQUIREMENT_ANALYSIS')!;
    const design = graph.steps.find((step) => step.type === 'HIGH_LEVEL_DESIGN')!;
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const moduleTest = graph.steps.find((step) => step.type === 'MODULE_TEST')!;
    const tester = graph.actors.find((actor) => actor.role === 'tester')!;
    const bug = await workflow.openBug({
      creatorActorId: tester.id,
      failedStep: functional,
      targetStep: requirement,
      verificationStep: functional,
      kind: 'test-failure',
      severity: 'high',
      message: 'The acceptance baseline failed.',
      summary: 'The acceptance baseline failed.',
      category: 'test',
      code: 'acceptance_baseline_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(functional, requirement, functional, {
        category: 'test', code: 'acceptance_baseline_failed',
      }),
    });
    await registration.register(bug.id);
    const assigned = await registration.routeAndAssign(bug.id);
    await new ProjectStateService(repository).transitionTicketPath(assigned.ticket, ['in_progress']);

    const enhancement = await workflow.openEnhancement({
      creatorActorId: tester.id,
      sourceStep: requirement,
      targetStep: design,
      verificationStep: moduleTest,
      kind: 'functional-gap',
      finding: 'package.json excludes a declared baseline test.',
      affectedArtifacts: ['package.json'],
      sourceBugTicketId: bug.id,
      correlationId: bug.source.correlationId,
      causationId: bug.id,
    });

    const parked = await repository.read(bug.id);
    expect(parked.objectType === 'ticket' && parked.state).toBe('pending');
    expect(parked.objectType === 'ticket' && parked.blockedByTicketIds).toEqual([enhancement.id]);
    expect(enhancement.sourceBugTicketId).toBe(bug.id);
    expect(enhancement.relatedTicketIds).toContain(bug.id);
  });

  it('parks the active parent CR while preserving closed Stories for a discovered Bug', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const state = new ProjectStateService(repository);
    const codingStory = await workflow.storyForStep(coding.id);
    const unitStory = await workflow.storyForStep(unit.id);
    const routedCoding = await registration.routeAndAssign(codingStory.id, { forStepId: coding.id });
    await state.transitionTicketPath(routedCoding.ticket, ['in_progress', 'resolved', 'closed']);
    const routedUnit = await registration.routeAndAssign(unitStory.id, { forStepId: unit.id });
    await state.transitionTicketPath(routedUnit.ticket, ['in_progress', 'resolved', 'closed']);
    const tester = graph.actors.find((actor) => actor.role === 'tester')!;
    const parent = await openChangeRequestFor(repository, graph, [unit.id], tester.id);
    await registration.register(parent.id);
    const routedParent = await registration.routeAndAssign(parent.id, { forStepId: unit.id });
    await state.transitionTicketPath(routedParent.ticket, ['in_progress']);

    const bug = await workflow.openBug({
      creatorActorId: tester.id,
      failedStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-failure',
      severity: 'high',
      message: 'A unit assertion failed while verifying the change.',
      summary: 'The changed behavior violates its unit contract.',
      category: 'test',
      code: 'unit_assertion_failed',
      retryable: true,
      switchProvider: false,
      parentChangeRequestId: parent.id,
      correlationId: createObjectId(),
      ...bugContracts(unit, coding, unit, {
        category: 'test', code: 'unit_assertion_failed',
      }),
    });

    const unchangedCodingStory = await repository.read(codingStory.id);
    const unchangedUnitStory = await repository.read(unitStory.id);
    const blockedParent = await repository.read(parent.id);
    expect(unchangedCodingStory.objectType === 'ticket' && unchangedCodingStory.state).toBe('closed');
    expect(unchangedUnitStory.objectType === 'ticket' && unchangedUnitStory.state).toBe('closed');
    expect(blockedParent.objectType === 'ticket' && blockedParent.state).toBe('pending');
    expect(blockedParent.objectType === 'ticket' && blockedParent.blockedByTicketIds).toEqual([bug.id]);
    expect(bug.creatorActorId).toBe(tester.id);
  });

  it('treats a passing Vitest file invocation as replay of its failed cases', async () => {
    const { graph, repository, workflow } = await setup();
    const moduleTest = graph.steps.find((step) => step.type === 'MODULE_TEST')!;
    const design = graph.steps.find((step) => step.type === 'HIGH_LEVEL_DESIGN')!;
    const bug = await workflow.openBug({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStep: moduleTest,
      targetStep: design,
      verificationStep: moduleTest,
      kind: 'test-failure',
      severity: 'high',
      message: 'The configuration contract failed.',
      summary: 'The configuration contract failed.',
      category: 'test',
      code: 'config_contract_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(moduleTest, design, moduleTest, {
        category: 'test',
        code: 'config_contract_failed',
        testSelectors: [
          'Config Module > should load a valid file 3ms',
          'tests/modules/config.test.ts > Config Module > should load a valid file',
          'tests/modules/config.test.ts > Config Module > should apply defaults',
        ],
      }),
    });

    const recorded = await workflow.recordBugVerification(
      bug.id,
      moduleTest,
      [passedTestOutcome(moduleTest, ['tests/modules/config.test.ts'])],
      await passingAssessment(repository, moduleTest),
    );

    expect(recorded.verificationRecords).toHaveLength(1);
    expect(recorded.verificationRecords[0]?.executedTestSelectors)
      .toEqual(['tests/modules/config.test.ts']);
  });

  it('drops Vitest suite labels that cannot be replayed from a Bug verification contract', async () => {
    const { graph, repository, workflow } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const contracts = buildBugFailureContracts({
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      failure: {
        kind: 'execution',
        category: 'test',
        code: 'pipeline_integration_failed',
        message: 'The full pipeline integration failed.',
        retryable: true,
        switchProvider: false,
      },
      testOutcomes: [{
        status: 'failed',
        stepType: integration.type,
        tool: 'run_tests',
        args: ['tests/integration/full-pipeline.test.ts'],
        exitCode: 1,
        timedOut: false,
        failedTests: [
          'Full Pipeline Integration > should execute complete pipeline 3ms',
          'tests/integration/full-pipeline.test.ts > Full Pipeline Integration > should execute complete pipeline',
        ],
        recordedAt: new Date().toISOString(),
      }],
    });
    expect(contracts.verificationContract.testSelectors).toEqual([
      'tests/integration/full-pipeline.test.ts > Full Pipeline Integration > should execute complete pipeline',
    ]);

    const bug = await workflow.openBug({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'The full pipeline integration failed.',
      summary: 'The full pipeline integration failed.',
      category: 'test',
      code: 'pipeline_integration_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...contracts,
    });
    const recorded = await workflow.recordBugVerification(
      bug.id,
      integration,
      [passedTestOutcome(integration, ['tests/integration/full-pipeline.test.ts'])],
      await passingAssessment(repository, integration),
    );
    expect(recorded.verificationRecords).toHaveLength(1);
  });

  it('does not report a correction as closed when the original selector was not replayed', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const tester = graph.actors.find((actor) => actor.role === 'tester')!;
    const parent = await openChangeRequestFor(repository, graph, [unit.id], tester.id);
    const bug = await workflow.openBug({
      creatorActorId: tester.id,
      failedStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-failure',
      severity: 'high',
      message: 'The service result was incomplete.',
      summary: 'The service result was incomplete.',
      category: 'test',
      code: 'service_result_incomplete',
      retryable: true,
      switchProvider: false,
      parentChangeRequestId: parent.id,
      correlationId: createObjectId(),
      ...bugContracts(unit, coding, unit, {
        category: 'test',
        code: 'service_result_incomplete',
        testSelectors: ['tests/unit/service.test.ts > service > returns source'],
      }),
    });
    await registration.routeAndAssign(bug.id, { forStepId: coding.id });
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Restore the service result.',
      rationale: 'The implementation omitted a required field.',
      changes: ['src/service.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, coding);
    const currentCoding = await new ProjectStateService(repository).requireStep(coding.id);
    await workflow.awaitVerification(bug.id, {
      stepId: currentCoding.id,
      qualityAssessmentId: currentCoding.qualityAssessmentId!,
    });
    await attachPassingAssessment(repository, unit);
    const currentUnit = await new ProjectStateService(repository).requireStep(unit.id);

    const closed = await workflow.verifyCorrectionsRaisedBy(
      parent.id,
      currentUnit,
      [passedTestOutcome(currentUnit, ['tests/unit/unrelated.test.ts'])],
      ['An unrelated unit test passed.'],
    );
    const current = await repository.read(bug.id);

    expect(closed).toEqual([]);
    expect(current.objectType === 'ticket' && current.state).toBe('resolved');
    expect(current.objectType === 'ticket' && current.solution?.status).toBe('applied');
  });

  it('restores interrupted CR sources to resolved without fabricating closure proof', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const tester = graph.actors.find((actor) => actor.role === 'tester')!;
    const bug = await workflow.openBug({
      creatorActorId: tester.id,
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'The adapter contract failed.',
      summary: 'The adapter contract failed.',
      category: 'test',
      code: 'adapter_contract_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test',
        code: 'adapter_contract_failed',
        testSelectors: ['tests/integration/adapter.test.ts > adapter > returns source'],
      }),
    });
    const routedBug = await registration.routeAndAssign(bug.id, { forStepId: detailed.id });
    await workflow.setSolution(routedBug.ticket.id, {
      status: 'applied',
      approach: 'Restore the adapter result contract.',
      rationale: 'The contract omitted source provenance.',
      changes: ['docs/03-detailed-design.md'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, detailed);
    const request = await workflow.openChangeRequest({
      sourceTicketIds: [bug.id],
      creatorActorId: tester.id,
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      targetStepId: integration.id,
      propagationStepIds: [integration.id, functional.id],
      contractDelta: {
        summary: 'Carry the corrected adapter contract forward.',
        before: ['source may be absent'],
        after: ['source is required'],
        affectedArtifacts: ['docs/03-detailed-design.md'],
      },
      implementationPlan: ['Verify downstream impact.'],
      verificationGate: ['Affected integration checks pass.'],
    });
    await registration.routeAndAssign(request.id, { forStepId: integration.id });
    await workflow.setSolution(request.id, {
      status: 'verified',
      approach: 'Apply the contract delta.',
      rationale: 'The integration boundary consumes the corrected contract.',
      changes: ['tests/integration/adapter.test.ts'],
      verification: ['Integration gate passed.'],
      updatedAt: new Date().toISOString(),
    });
    await workflow.recordChange({
      ticketId: request.id,
      stepId: integration.id,
      summary: 'Applied the corrected adapter contract.',
      entries: [{ path: 'tests/integration/adapter.test.ts', operation: 'update' }],
      verificationAssessmentId: await passingAssessment(repository, integration),
    });
    await workflow.closeVerified(request.id);

    const state = new ProjectStateService(repository);
    const resolved = await state.requireTicket(bug.id);
    const interrupted = await state.transitionTicketPath(resolved, ['reopened', 'in_progress']);
    const assignment = await repository.read(interrupted.activeAssignmentId!);
    expect(assignment.objectType).toBe('ticket-assignment');
    expect(await activeAssignments(repository, assignment.objectType === 'ticket-assignment'
      ? assignment.assigneeActorId
      : bug.creatorActorId)).toBe(1);

    await workflow.reconcileClosedCorrectiveTickets(graph.project.id);
    const recovered = await repository.read(bug.id);
    expect(recovered.objectType === 'ticket' && recovered.state).toBe('resolved');
    expect(recovered.objectType === 'ticket' && recovered.verificationRecords).toEqual([]);
    expect(await activeAssignments(repository, assignment.objectType === 'ticket-assignment'
      ? assignment.assigneeActorId
      : bug.creatorActorId)).toBe(0);
  });
});

async function activeAssignments(
  repository: DomainObjectRepository,
  actorId: string,
): Promise<number> {
  const actor = await repository.read(actorId as never);
  return actor.objectType === 'actor-registration' ? actor.activeAssignmentIds.length : -1;
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-workflow-'));
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
  return { graph, repository, registration, workflow: new TicketWorkflow(repository) };
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

async function attachPassingAssessment(
  repository: DomainObjectRepository,
  step: Step,
): Promise<void> {
  const state = new ProjectStateService(repository);
  const current = await state.requireStep(step.id);
  const assessmentId = await passingAssessment(repository, current);
  await state.attachQuality(current, assessmentId);
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

/** A Change Request spanning several downstream Steps, as CR propagation produces. */
async function openChangeRequestFor(
  repository: DomainObjectRepository,
  graph: Awaited<ReturnType<typeof setup>>['graph'],
  affectedStepIds: string[],
  creatorActorId?: string,
): Promise<Ticket> {
  const source = graph.tickets.find((ticket) => ticket.stepId === affectedStepIds[0])!;
  const { workKind: _w, verificationTicketId: _v, pairedSourceTicketId: _p, ...base } =
    source as Ticket & Record<string, unknown>;
  const request = TicketSchema.parse({
    ...base,
    ...createObjectEnvelope({
      name: 'CR-ORDER-1',
      objectType: 'ticket',
      projectId: source.projectId,
      now: new Date().toISOString(),
    }),
    type: 'change-request',
    changeKind: 'corrective',
    parentTicketId: source.id,
    creatorActorId: creatorActorId ?? source.creatorActorId,
    state: 'created',
    assignmentIds: [],
    activeAssignmentId: undefined,
    sourceTicketIds: [source.id],
    triggerStepId: affectedStepIds[0],
    sourceStepId: affectedStepIds[0],
    targetStepId: affectedStepIds[0],
    propagationStepIds: affectedStepIds,
    contractDelta: {
      summary: 'align the contract', before: ['before'], after: ['after'],
      affectedArtifacts: ['src/x.ts'],
    },
    implementationPlan: ['apply the delta'],
    verificationGate: ['downstream gates pass'],
  });
  await repository.insert(request, request.state);
  return request;
}

/** Applies a dependency Change Request at its target Step, as the handler would. */
async function completeDependencyHop(
  repository: DomainObjectRepository,
  requestId: string,
  stepId: string,
): Promise<void> {
  const state = new ProjectStateService(repository);
  const corrective = new CorrectiveWorkflowService(repository);
  const registration = new TicketRegistrationService(repository);
  let step = await state.requireStep(stepId as never);
  if (step.state === 'reopened' || step.state === 'created') {
    step = await state.transitionStep(step, 'in_progress');
  }
  const routed = await registration.routeAndAssign(requestId as never, { forStepId: step.id });
  await state.transitionTicketPath(routed.ticket, ['in_progress']);
  await corrective.completeChangeRequestStep({
    work: { ticket: await state.requireTicket(requestId as never), step } as never,
    qualityAssessmentId: await passingAssessment(repository, step),
    summary: 'dependency accepted',
    entries: [{ path: 'package.json', operation: 'update' }],
    verification: ['sandbox rebuilt'],
  });
}

/**
 * Two Bugs on one Step each open their own propagation along the identical route. A live run
 * produced four such pairs — `S004→S005`, `S005→S006`, `S006→S007`, `S007→S008` — created one to two
 * minutes apart, carrying the same delta to the same owner, because the guard keyed on
 * source Ticket ids and they differ in exactly that relation. 41 Change Requests served 8 Bugs.
 *
 * The Bugs are opened one after the other, as they are in a run: the first is handed off through its
 * hop before the second is routed, which is also what frees the single owning actor.
 */
describe('Change Request hop merging', () => {
  const bugOn = async (
    repository: DomainObjectRepository,
    workflow: TicketWorkflow,
    registration: TicketRegistrationService,
    graph: { steps: Step[]; actors: Array<{ id: string; role: string }> },
    message: string,
    code: string,
    testSelectors: string[] = [],
  ) => {
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const bug = await workflow.openBug({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message,
      summary: message,
      category: 'test',
      code,
      retryable: true,
      switchProvider: false,
      rawEvidenceRef: '.xcompiler/failures/integration.log',
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, { category: 'test', code, testSelectors }),
    });
    await registration.routeAndAssign(bug.id);
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Correct the contract.',
      rationale: 'The implementation followed an ambiguous contract.',
      changes: ['docs/03-detailed-design.md'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, detailed);
    return bug;
  };

  const hopFor = (graph: { steps: Step[]; actors: Array<{ id: string; role: string }> }, targetType: string) => {
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    return {
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      targetStepId: graph.steps.find((step) => step.type === targetType)!.id,
      propagationStepIds: [graph.steps.find((step) => step.type === targetType)!.id],
      implementationPlan: ['Update the detailed design.'],
      verificationGate: ['All affected Step gates pass.'],
    };
  };

  it('folds a second Bug propagating the same hop into the one already carrying it', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const first = await bugOn(repository, workflow, registration, graph, 'Adapter contract mismatch.', 'adapter_contract_mismatch');
    const a = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'),
      sourceTicketIds: [first.id],
      contractDelta: {
        summary: 'Align the adapter contract.',
        before: ['adapter may omit source'],
        after: ['adapter always includes source'],
        affectedArtifacts: ['docs/03-detailed-design.md'],
      },
    });
    const second = await bugOn(repository, workflow, registration, graph, 'Result contract mismatch.', 'result_contract_mismatch');
    const b = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'),
      sourceTicketIds: [second.id],
      contractDelta: {
        summary: 'Align the result contract.',
        before: ['result may omit source'],
        after: ['result always includes source'],
        affectedArtifacts: ['src/service.ts'],
      },
    });

    expect(b.id).toBe(a.id);
    expect(b.relatedTicketIds).toContain(first.id);
    expect(b.relatedTicketIds).toContain(second.id);
    // Both reasons survive, because two Bugs can reach one Step for reasons that are not the same.
    expect(b.contractDelta.summary).toContain('Align the adapter contract.');
    expect(b.contractDelta.summary).toContain('Align the result contract.');
    expect(b.contractDelta.affectedArtifacts).toEqual(
      expect.arrayContaining(['docs/03-detailed-design.md', 'src/service.ts']),
    );
    expect(b.contractDelta.after).toEqual(
      expect.arrayContaining(['adapter always includes source', 'result always includes source']),
    );
  });

  it('hands off the folded Bug too, so it does not stay schedulable forever', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const delta = {
      summary: 'Align the contract.',
      before: [],
      after: ['contract is explicit'],
      affectedArtifacts: ['docs/03-detailed-design.md'],
    };
    const first = await bugOn(repository, workflow, registration, graph, 'Adapter contract mismatch.', 'adapter_contract_mismatch');
    const a = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'), sourceTicketIds: [first.id], contractDelta: delta,
    });
    const second = await bugOn(repository, workflow, registration, graph, 'Result contract mismatch.', 'result_contract_mismatch');
    await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'), sourceTicketIds: [second.id], contractDelta: delta,
    });

    const folded = await repository.read(second.id) as Ticket;
    expect(folded.state).toBe('resolved');
    expect((folded as Ticket & { changeRequestTicketIds: string[] }).changeRequestTicketIds)
      .toContain(a.id);
  });

  it('keeps a different route as its own hop', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const delta = {
      summary: 'Align the contract.',
      before: [],
      after: ['contract is explicit'],
      affectedArtifacts: ['docs/03-detailed-design.md'],
    };
    const first = await bugOn(repository, workflow, registration, graph, 'Adapter contract mismatch.', 'adapter_contract_mismatch');
    const a = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'), sourceTicketIds: [first.id], contractDelta: delta,
    });
    const second = await bugOn(repository, workflow, registration, graph, 'Result contract mismatch.', 'result_contract_mismatch');
    const b = await workflow.openChangeRequest({
      ...hopFor(graph, 'CODE'), sourceTicketIds: [second.id], contractDelta: delta,
    });
    expect(b.id).not.toBe(a.id);
  });

  it('rejects duplicate or out-of-order Steps before creating a propagation hop', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const bug = await bugOn(
      repository,
      workflow,
      registration,
      graph,
      'Adapter contract mismatch.',
      'adapter_contract_mismatch',
    );
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const requirement = graph.steps.find((step) => step.type === 'REQUIREMENT_ANALYSIS')!;
    const base = {
      ...hopFor(graph, 'DETAILED_DESIGN'),
      sourceTicketIds: [bug.id],
      contractDelta: {
        summary: 'Align the contract.',
        before: [],
        after: ['contract is explicit'],
        affectedArtifacts: ['docs/03-detailed-design.md'],
      },
    };

    await expect(workflow.openChangeRequest({
      ...base,
      propagationStepIds: [detailed.id, detailed.id],
    })).rejects.toThrow(/must be unique/u);
    await expect(workflow.openChangeRequest({
      ...base,
      propagationStepIds: [detailed.id, requirement.id],
    })).rejects.toThrow(/must follow V-model order/u);
  });

  it('closes a folded final hop only after every source Bug contract is replayed', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const first = await bugOn(
      repository,
      workflow,
      registration,
      graph,
      'Adapter A contract mismatch.',
      'adapter_a_contract_mismatch',
      ['tests/integration/adapter-a.test.ts::returns source'],
    );
    const request = await workflow.openChangeRequest({
      ...hopFor(graph, 'INTEGRATION_TEST'),
      sourceTicketIds: [first.id],
      contractDelta: {
        summary: 'Align adapter A.',
        before: ['source may be absent'],
        after: ['source is required'],
        affectedArtifacts: ['src/adapter-a.ts'],
      },
    });
    const second = await bugOn(
      repository,
      workflow,
      registration,
      graph,
      'Adapter B contract mismatch.',
      'adapter_b_contract_mismatch',
      ['tests/integration/adapter-b.test.ts::returns timestamp'],
    );
    const folded = await workflow.openChangeRequest({
      ...hopFor(graph, 'INTEGRATION_TEST'),
      sourceTicketIds: [second.id],
      contractDelta: {
        summary: 'Align adapter B.',
        before: ['timestamp may be absent'],
        after: ['timestamp is required'],
        affectedArtifacts: ['src/adapter-b.ts'],
      },
    });
    expect(folded.id).toBe(request.id);
    expect(folded.sourceTicketIds).toEqual(expect.arrayContaining([first.id, second.id]));

    await registration.routeAndAssign(folded.id);
    await workflow.setSolution(folded.id, {
      status: 'verified',
      approach: 'Apply both accepted adapter deltas.',
      rationale: 'The folded hop owns both source contracts.',
      changes: ['src/adapter-a.ts', 'src/adapter-b.ts'],
      verification: ['integration gate passed'],
      updatedAt: new Date().toISOString(),
    });
    await workflow.recordChange({
      ticketId: folded.id,
      stepId: integration.id,
      summary: 'Applied and verified both adapter deltas.',
      entries: [
        { path: 'src/adapter-a.ts', operation: 'update' },
        { path: 'src/adapter-b.ts', operation: 'update' },
      ],
      verificationAssessmentId: await passingAssessment(repository, integration),
    });

    // One source replayed, one not: the folded hop refuses to close rather than throwing, because
    // the chain is unfinished rather than broken.
    await workflow.closeVerified(folded.id, {
      verificationStep: integration,
      testOutcomes: [passedTestOutcome(integration, ['tests/integration/adapter-a.test.ts'])],
    });
    const stillOpen = await repository.read(folded.id);
    expect(stillOpen.objectType === 'ticket' && stillOpen.state).not.toBe('closed');

    await workflow.closeVerified(folded.id, {
      verificationStep: integration,
      testOutcomes: [passedTestOutcome(integration, [
        'tests/integration/adapter-a.test.ts',
        'tests/integration/adapter-b.test.ts',
      ])],
    });
    const closedSources = await Promise.all([repository.read(first.id), repository.read(second.id)]);
    expect(closedSources.map((ticket) => ticket.objectType === 'ticket' ? ticket.state : 'invalid'))
      .toEqual(['closed', 'closed']);
  });

  it('retains exact Bug verification from an earlier hop until downstream impact work finishes', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const bug = await bugOn(
      repository,
      workflow,
      registration,
      graph,
      'The adapter source contract failed.',
      'adapter_source_contract_failed',
      ['tests/integration/adapter.test.ts::returns source'],
    );
    await workflow.recordBugVerification(
      bug.id,
      integration,
      [passedTestOutcome(integration, ['tests/integration/adapter.test.ts'])],
      await passingAssessment(repository, integration),
    );
    const request = await workflow.openChangeRequest({
      ...hopFor(graph, 'FUNCTIONAL_TEST'),
      sourceTicketIds: [bug.id],
      contractDelta: {
        summary: 'Confirm the repaired adapter contract at functional acceptance.',
        before: ['source may be absent'],
        after: ['source is required'],
        affectedArtifacts: ['src/adapter.ts'],
      },
    });
    await registration.routeAndAssign(request.id);
    await workflow.setSolution(request.id, {
      status: 'verified',
      approach: 'Apply the accepted adapter delta to functional acceptance.',
      rationale: 'Downstream impact remains after the original integration failure is disproved.',
      changes: ['tests/functional/acceptance.test.ts'],
      verification: ['functional gate passed'],
      updatedAt: new Date().toISOString(),
    });
    await workflow.recordChange({
      ticketId: request.id,
      stepId: functional.id,
      summary: 'Verified downstream functional impact.',
      entries: [{ path: 'tests/functional/acceptance.test.ts', operation: 'update' }],
      verificationAssessmentId: await passingAssessment(repository, functional),
    });

    await workflow.closeVerified(request.id, { verificationStep: functional, testOutcomes: [] });
    const closedBug = await repository.read(bug.id);
    expect(closedBug.objectType === 'ticket' && closedBug.state).toBe('closed');
    expect(closedBug.objectType === 'ticket' && closedBug.verificationRecords).toHaveLength(1);
  });
});

/**
 * A verification Step's gate runs two ownership domains: the paired baseline its source Step wrote,
 * and the risk supplement it wrote itself. Routing the whole gate failure to the source is right for
 * the first and wrong for the second — the source owns neither the file nor the write scope for it.
 *
 * A live FUNCTIONAL_TEST failure did exactly that. `test_error_csv_content_rows`, a supplement case
 * calling `write_error_csv` with a path the implementation appends its own suffix to, was routed to
 * REQUIREMENT_ANALYSIS, whose allowlist held neither the supplement nor `src/excel_writer.py`. It
 * delivered nine times without touching either file and the run had to be stopped by hand.
 */
describe('verification supplement routing', () => {
  const supplementSelector = (stepId: string) =>
    `tests/verification/p1/functional-test/${stepId}/test_risk_supplement.py::TestErrorCsv::test_error_csv_content_rows`;
  const supplementCase = (stepId: string) => `FAILED ${supplementSelector(stepId)} - FileNotFoundError`;
  const baselineSelector =
    'tests/test_functional_acceptance.py::TestNormalParsing::test_single_ecu_filtering';
  const baselineCase =
    `FAILED ${baselineSelector} - AssertionError`;



  it('keeps a failure confined to the Step own supplement in that Step', async () => {
    const { graph, repository } = await setup();
    const controller = new CorrectiveWorkflowService(repository);
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const evidence = [
      'pytest exit=1 args=tests/test_functional_acceptance.py',
      supplementCase(functional.id),
      '1 failed, 36 passed',
    ].join('\n');
    const bug = await controller.routeFailure({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStepId: functional.id,
      message: evidence,
      summary: 'FUNCTIONAL_TEST executable test gate failed',
      failure: {
        kind: 'execution', category: 'test', code: 'test_command_failed',
        message: evidence, retryable: true, switchProvider: false,
      },
      correlationId: createObjectId(),
      bugKind: 'test-failure',
      testOutcomes: [failedTestOutcome(functional, [supplementSelector(functional.id)])],
    });
    expect(bug.failure.targetStepId).toBe(functional.id);
  });

  it('returns a baseline failure to the paired source', async () => {
    const { graph, repository } = await setup();
    const controller = new CorrectiveWorkflowService(repository);
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const evidence = [
      'pytest exit=1 args=tests/test_functional_acceptance.py',
      baselineCase,
      '1 failed, 36 passed',
    ].join('\n');
    const bug = await controller.routeFailure({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStepId: functional.id,
      message: evidence,
      summary: 'FUNCTIONAL_TEST executable test gate failed',
      failure: {
        kind: 'execution', category: 'test', code: 'test_command_failed',
        message: evidence, retryable: true, switchProvider: false,
      },
      correlationId: createObjectId(),
      bugKind: 'test-failure',
      testOutcomes: [failedTestOutcome(functional, [baselineSelector])],
    });
    expect(bug.failure.targetStepId).toBe(functional.pairedStepId);
  });

  // A supplement that exposes a real product defect fails alongside the baseline; the source answers
  // for the contract it defined, whatever else failed next to it.
  it('returns to the paired source when the baseline fails too', async () => {
    const { graph, repository } = await setup();
    const controller = new CorrectiveWorkflowService(repository);
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const evidence = [
      'pytest exit=1 args=tests/test_functional_acceptance.py',
      baselineCase,
      supplementCase(functional.id),
      '2 failed, 35 passed',
    ].join('\n');
    const bug = await controller.routeFailure({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      failedStepId: functional.id,
      message: evidence,
      summary: 'FUNCTIONAL_TEST executable test gate failed',
      failure: {
        kind: 'execution', category: 'test', code: 'test_command_failed',
        message: evidence, retryable: true, switchProvider: false,
      },
      correlationId: createObjectId(),
      bugKind: 'test-failure',
      testOutcomes: [failedTestOutcome(functional, [baselineSelector, supplementSelector(functional.id)])],
    });
    expect(bug.failure.targetStepId).toBe(functional.pairedStepId);
  });
});

describe('Change Request verification preflight', () => {
  it('rejects an incomplete source Bug replay before mutating the Step', async () => {
    const step = {
      id: createObjectId(),
      name: 'P1-S006',
      type: 'INTEGRATION_TEST',
      projectId: 'project-id',
      phaseId: 'phase-id',
    } as Step;
    const contracts = bugContracts(step, step, step, {
      category: 'test',
      code: 'adapter_contract_mismatch',
      testSelectors: ['tests/integration/adapter.test.ts::returns source'],
    });
    const sourceBug = {
      id: 'bug-id',
      name: 'BUG-P1-001',
      objectType: 'ticket',
      type: 'bug',
      state: 'pending',
      failure: { identity: contracts.identity },
      verificationContract: contracts.verificationContract,
      verificationRecords: [],
    };
    const request = {
      id: 'request-id',
      name: 'CR-P1-001',
      objectType: 'ticket',
      type: 'change-request',
      changeKind: 'corrective',
      sourceTicketIds: [sourceBug.id],
      targetStepId: step.id,
      // A downstream scope must not let this hop pass through its own immutable replay gate.
      propagationStepIds: [step.id, 'downstream-step-id'],
    };
    let mutated = false;
    const service = new CorrectiveWorkflowService({} as never);
    (service as unknown as { state: unknown }).state = {
      requireStep: async () => step,
      requirePassingQualityAssessment: async () => {},
      requireTicket: async (id: string) => id === request.id ? request : sourceBug,
      attachQuality: async () => { mutated = true; return step; },
    };

    // The hop refuses to finish without mutating the Step, so the Change Request stays schedulable


    // for the attempt that can supply the replay. Throwing would have ended the run instead.


    expect(await service.completeChangeRequestStep({
      work: { step, ticket: request } as never,
      qualityAssessmentId: 'assessment-id' as never,
      summary: 'Applied the adapter delta.',
      entries: [],
      testOutcomes: [passedTestOutcome(step, ['tests/integration/unrelated.test.ts'])],
    })).toEqual({
      status: 'awaiting-verification',
      closed: false,
      unprovenBugTicketIds: [sourceBug.id],
    });
    expect(mutated).toBe(false);
  });
});
