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

describe('TicketWorkflow', () => {
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
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const coding = graph.steps.find((step) => step.type === 'CODE')!;

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
    const request = await workflow.openChangeRequest({
      sourceTicketId: bug.id,
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      targetStepId: detailed.id,
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
    await registration.routeAndAssign(request.id);
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
        entries: step.id === detailed.id
          ? []
          : [{ path: step.outputs[0]!, operation: 'update' }],
        application: step.id === detailed.id
          ? {
            outcome: 'not-applicable',
            reasonCategory: 'already-aligned',
            rationale: 'The detailed-design contract already contains the required result source.',
              inspectedArtifacts: [step.outputs[0]!],
              evidence: ['The existing output contract explicitly requires source.'],
            }
          : undefined,
        verificationAssessmentId: await passingAssessment(repository, step),
      });
    }

    const appliedRequest = await repository.read(request.id);
    expect(appliedRequest.objectType === 'ticket' && appliedRequest.type === 'change-request'
      ? appliedRequest.applications.find((application) => application.stepId === detailed.id)
      : undefined).toMatchObject({
      outcome: 'not-applicable',
      inspectedArtifacts: [detailed.outputs[0]!],
    });

    const bugBeforeClose = await repository.read(bug.id);
    expect(bugBeforeClose.objectType === 'ticket' && bugBeforeClose.state).not.toBe('closed');
    await workflow.closeVerified(request.id);
    const closedRequest = await repository.read(request.id);
    const closedBug = await repository.read(bug.id);

    expect(closedRequest.objectType === 'ticket' && closedRequest.state).toBe('closed');
    expect(closedBug.objectType === 'ticket' && closedBug.state).toBe('closed');
    expect(closedBug.objectType === 'ticket' && closedBug.solution?.status).toBe('verified');
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
    const request = await workflow.openChangeRequest({
      creatorActorId: graph.actors.find((actor) => actor.role === 'tester')!.id,
      sourceTicketId: enhancement.id,
      triggerStepId: unit.id,
      sourceStepId: coding.id,
      targetStepId: coding.id,
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
      const released: string[] = [];
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
        releaseFrom: async (_t: unknown, id: string) => { released.push(id); },
      };
      return { count: await workflow.releaseCyclicCorrectiveBlockers('p1' as never), released };
    };

    // The hop's Step depends on the parked Story's Step, transitively, and that Step has not
    // delivered: neither side can move.
    expect(await releasedFor('step-code')).toEqual({ count: 1, released: ['cr-1'] });
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
    const released: string[] = [];
    const workflow = new TicketWorkflow({
      list: async () => [
        story,
        {
          objectType: 'ticket', id: 'bug-1', projectId: 'p1', type: 'bug',
          state: 'pending', blockedByTicketIds: [],
        },
        {
          objectType: 'ticket', id: 'cr-1', projectId: 'p1', type: 'change-request',
          state: 'created', targetStepId: 'step-unit', sourceTicketId: 'bug-1', blockedByTicketIds: [],
        },
        { objectType: 'step', id: 'step-design', projectId: 'p1', state: 'reopened', dependencyStepIds: [] },
        { objectType: 'step', id: 'step-unit', projectId: 'p1', state: 'pending', dependencyStepIds: ['step-design'] },
      ],
      read: async () => story,
      commit: async () => {},
    } as never);
    (workflow as unknown as { blockers: { releaseFrom: unknown } }).blockers = {
      releaseFrom: async (_t: unknown, id: string) => { released.push(id); },
    };
    expect(await workflow.releaseCyclicCorrectiveBlockers('p1' as never)).toBe(1);
    expect(released).toEqual(['bug-1']);

    // Resuming takes the role's slot back, so a role with no headroom cannot take one back now. The
    // live run unparked two Tickets that both needed system-engineer, and routing then refused the
    // second at 2/1 and aborted; a later pass releases this one once the slot frees.
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
          state: 'created', targetStepId: 'step-unit', sourceTicketId: 'bug-1', blockedByTicketIds: [],
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
    expect(await bounded.releaseCyclicCorrectiveBlockers('p1' as never)).toBe(0);
    expect(skipped).toEqual([]);
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
    parentTicketId: source.id,
    creatorActorId: creatorActorId ?? source.creatorActorId,
    state: 'created',
    assignmentIds: [],
    activeAssignmentId: undefined,
    sourceTicketId: source.id,
    triggerStepId: affectedStepIds[0],
    sourceStepId: affectedStepIds[0],
    targetStepId: affectedStepIds[0],
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
    work: { ticket: await state.requireTicket(requestId as never), step, mode: 'change-request' } as never,
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
 * `sourceTicketId` and they differ in exactly that field. 41 Change Requests served 8 Bugs.
 *
 * The Bugs are opened one after the other, as they are in a run: the first is handed off through its
 * hop before the second is routed, which is also what frees the single owning actor.
 */
describe('Change Request hop merging', () => {
  const bugOn = async (
    workflow: TicketWorkflow,
    registration: TicketRegistrationService,
    graph: { steps: Step[]; actors: Array<{ id: string; role: string }> },
    message: string,
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
      code: 'integration_contract_mismatch',
      retryable: true,
      switchProvider: false,
      rawEvidenceRef: '.xcompiler/failures/integration.log',
      correlationId: createObjectId(),
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
      implementationPlan: ['Update the detailed design.'],
      verificationGate: ['All affected Step gates pass.'],
    };
  };

  it('folds a second Bug propagating the same hop into the one already carrying it', async () => {
    const { graph, workflow, registration } = await setup();
    const first = await bugOn(workflow, registration, graph, 'Adapter contract mismatch.');
    const a = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'),
      sourceTicketId: first.id,
      contractDelta: {
        summary: 'Align the adapter contract.',
        before: ['adapter may omit source'],
        after: ['adapter always includes source'],
        affectedArtifacts: ['docs/03-detailed-design.md'],
      },
    });
    const second = await bugOn(workflow, registration, graph, 'Result contract mismatch.');
    const b = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'),
      sourceTicketId: second.id,
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
    const first = await bugOn(workflow, registration, graph, 'Adapter contract mismatch.');
    const a = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'), sourceTicketId: first.id, contractDelta: delta,
    });
    const second = await bugOn(workflow, registration, graph, 'Result contract mismatch.');
    await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'), sourceTicketId: second.id, contractDelta: delta,
    });

    const folded = await repository.read(second.id) as Ticket;
    expect(folded.state).toBe('pending');
    expect((folded as Ticket & { changeRequestTicketIds: string[] }).changeRequestTicketIds)
      .toContain(a.id);
  });

  it('keeps a different route as its own hop', async () => {
    const { graph, workflow, registration } = await setup();
    const delta = {
      summary: 'Align the contract.',
      before: [],
      after: ['contract is explicit'],
      affectedArtifacts: ['docs/03-detailed-design.md'],
    };
    const first = await bugOn(workflow, registration, graph, 'Adapter contract mismatch.');
    const a = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'), sourceTicketId: first.id, contractDelta: delta,
    });
    const second = await bugOn(workflow, registration, graph, 'Result contract mismatch.');
    const b = await workflow.openChangeRequest({
      ...hopFor(graph, 'CODE'), sourceTicketId: second.id, contractDelta: delta,
    });
    expect(b.id).not.toBe(a.id);
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
  const supplementCase = (stepId: string) =>
    `FAILED tests/verification/p1/functional-test/${stepId}/test_risk_supplement.py::TestErrorCsv::test_error_csv_content_rows - FileNotFoundError`;
  const baselineCase =
    'FAILED tests/test_functional_acceptance.py::TestNormalParsing::test_single_ecu_filtering - AssertionError';



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
    });
    expect(bug.failure.targetStepId).toBe(functional.pairedStepId);
  });
});
