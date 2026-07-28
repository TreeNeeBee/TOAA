import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChangeRequestTicketSchema,
  TicketStore,
  transitionTicket,
  type BugTicket,
} from '../src/core/ticket.js';
import type { Plan, Step } from '../src/core/plan.js';
import { ChangeRequestLifecycle } from '../src/core/engine/change_request_lifecycle.js';
import { TICKET_LIFECYCLE_OWNERS } from '../src/core/engine/lifecycle_registry.js';
import { WorkTicketLifecycle } from '../src/core/engine/work_ticket_lifecycle.js';
import { Workspace } from '../src/workspace/workspace.js';

function codeStep(): Step {
  return {
    id: 'S004',
    iterationId: 'P1',
    phase: 'CODE',
    title: 'Apply design delta',
    description: 'Apply only the approved contract delta.',
    systemPrompt: 'Apply only the approved contract delta and preserve unrelated behavior.',
    role: 'Coder',
    tools: ['write_file'],
    inputs: ['docs/03-detailed-design.md'],
    outputs: ['src/main.ts'],
    subTasks: [{
      id: 'M001',
      title: 'Update service',
      description: 'Apply the service contract.',
      acceptance: 'The service follows the new contract.',
      outputs: ['src/service.ts'],
      subTasks: [{
        id: 'M001.1',
        title: 'Update result type',
        description: 'Apply the result type contract.',
        acceptance: 'The result type follows the detailed design.',
        outputs: ['src/result.ts'],
      }],
    }],
    dependsOn: [],
    acceptance: 'The design delta is implemented and verified.',
    status: 'PENDING',
    retries: 0,
    maxRetries: 3,
  };
}

function plan(step = codeStep()): Plan {
  return {
    version: '1',
    intent: 'feature',
    phaseId: 'P1',
    projectType: 'application',
    language: 'typescript',
    requirementDigest: 'Implement a ticket-driven service change.',
    complexityAssessment: {
      level: 'simple',
      rationale: 'One isolated change.',
      splitRecommended: false,
      userForcedPhaseSplit: false,
    },
    implementationPhases: [{
      id: 'P1',
      title: 'Core delivery',
      objective: 'Implement the ticket-driven service change.',
      status: 'current',
      scope: ['service'],
      deliverables: ['src/main.ts'],
      dependsOn: [],
      verificationGate: {
        summary: 'The service change is verified.',
        checks: ['The stage acceptance passes.'],
        failurePolicy: 'Open a Bug and route it to the paired source Feature.',
      },
    }],
    globalPrompt: 'Implement the approved plan.',
    baselineSummary: '',
    userAddenda: '',
    createdAt: new Date().toISOString(),
    steps: [step],
  };
}

function vModelPlan(): Plan {
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
  const base = plan();
  base.steps = phases.map(([phase, role], index): Step => ({
    ...codeStep(),
    id: `S${String(index + 1).padStart(3, '0')}`,
    phase,
    role,
    title: phase,
    description: `Execute ${phase}.`,
    systemPrompt: `Complete only ${phase}.`,
    inputs: index === 0 ? [] : [`artifact-${index}`],
    outputs: [`artifact-${index + 1}`],
    subTasks: [],
    dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
    acceptance: `${phase} passes.`,
  }));
  return base;
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-'));
  const workspace = new Workspace(root);
  const store = new TicketStore(workspace);
  const workTickets = new WorkTicketLifecycle(store);
  const step = codeStep();
  await workTickets.registerExecutionGraph(plan(step));
  return { root, workspace, store, workTickets, step };
}

async function createBug(store: TicketStore, step: Step): Promise<BugTicket> {
  const work = store.featureForStep(step.id, step.iterationId ?? 'P1')!;
  return store.createBug({
    priority: 'high',
    title: 'Unit test failed',
    description: 'The service result contract is incorrect.',
    iterationId: 'P1',
    rootTicketId: work.rootTicketId,
    relatedTicketIds: [work.id],
    blockedByTicketIds: [],
    source: {
      kind: 'runtime',
      externalId: step.id,
      stepId: step.id,
      phase: step.phase,
      role: step.role,
    },
    acceptance: ['The corrected unit test passes.', 'The resolution is written to debug-wiki.'],
    artifacts: ['.xcompiler/tickets/BUG-P1-001/failure.raw.log'],
    kind: 'test-gate',
    severity: 'error',
    language: 'typescript',
    intent: 'feature',
    requirementDigest: 'Implement a ticket-driven service change.',
    reason: 'Unit test failed.',
    failureLog: 'AssertionError: expected structured result',
    changeRequestTicketIds: [],
  });
}

describe('ticket workflow', () => {
  it('assigns every Ticket type to an explicit lifecycle owner', () => {
    expect(TICKET_LIFECYCLE_OWNERS).toEqual({
      epic: 'work',
      feature: 'work',
      task: 'work',
      'sub-task': 'work',
      bug: 'bug',
      enhance: 'enhancement',
      'change-request': 'change-request',
    });
  });

  it('materializes an Epic, stage and delivery Features, and two task levels', async () => {
    const { root, store, step } = await setup();
    const tickets = store.all();
    const epic = tickets.find((ticket) => ticket.type === 'epic');
    const feature = store.featureForStep(step.id, step.iterationId ?? 'P1');
    const delivery = tickets.find(
      (ticket) => ticket.type === 'feature' && ticket.workKind === 'delivery',
    );
    const task = tickets.find((ticket) => ticket.type === 'task');
    const subTask = tickets.find((ticket) => ticket.type === 'sub-task');

    expect(epic).toMatchObject({
      type: 'epic',
      workKind: 'iteration',
      status: 'open',
      iterationId: 'P1',
    });
    expect(feature).toMatchObject({
      type: 'feature',
      workKind: 'v-model-stage',
      parentTicketId: epic?.id,
      rootTicketId: epic?.id,
      source: { stepId: 'S004', phase: 'CODE' },
    });
    expect(delivery).toMatchObject({
      workKind: 'delivery',
      parentTicketId: epic?.id,
      rootTicketId: epic?.id,
      dependsOnTicketIds: [feature?.id],
    });
    expect(task).toMatchObject({
      parentTicketId: feature?.id,
      rootTicketId: epic?.id,
      source: { stepId: 'S004' },
    });
    expect(subTask).toMatchObject({
      parentTicketId: task?.id,
      rootTicketId: epic?.id,
      source: { stepId: 'S004' },
    });

    const events = (await fs.readFile(
      path.join(root, '.xcompiler/tickets/events.jsonl'),
      'utf8',
    )).trim().split('\n').map((line) => JSON.parse(line) as { ticketType: string });
    expect(events.map((event) => event.ticketType)).toEqual(
      expect.arrayContaining(['epic', 'feature', 'task', 'sub-task']),
    );
  });

  it('reserves enhance tickets for quality findings instead of iteration roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-refactor-'));
    const workspace = new Workspace(root);
    const store = new TicketStore(workspace);
    const workTickets = new WorkTicketLifecycle(store);
    const refactorPlan = plan();
    refactorPlan.intent = 'refactor';

    await workTickets.registerExecutionGraph(refactorPlan);

    expect(store.all().filter((ticket) => ticket.type === 'epic')).toHaveLength(1);
    expect(store.all().filter((ticket) => ticket.type === 'feature')).toHaveLength(2);
    expect(store.all().filter((ticket) => ticket.type === 'enhance')).toHaveLength(0);
  });

  it('builds the V-model dependency graph and blocks delivery on active defects', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-v-model-'));
    const store = new TicketStore(new Workspace(root));
    const workTickets = new WorkTicketLifecycle(store);
    const currentPlan = vModelPlan();

    await workTickets.registerExecutionGraph(currentPlan);
    const epic = store.epicForIteration('P1')!;
    const delivery = store.deliveryForIteration('P1')!;
    const features = currentPlan.steps.map((step) =>
      store.featureForStep(step.id, step.iterationId ?? 'P1')!
    );

    expect(store.all().filter((ticket) => ticket.type === 'epic')).toHaveLength(1);
    expect(store.all().filter((ticket) => ticket.type === 'feature')).toHaveLength(9);
    expect(features[0]?.verificationTicketId).toBe(features[7]?.id);
    expect(features[1]?.verificationTicketId).toBe(features[6]?.id);
    expect(features[2]?.verificationTicketId).toBe(features[5]?.id);
    expect(features[3]?.verificationTicketId).toBe(features[4]?.id);
    expect(features[4]?.pairedSourceTicketId).toBe(features[3]?.id);
    expect(features[1]?.dependsOnTicketIds).toEqual([features[0]?.id]);
    expect(delivery.dependsOnTicketIds).toEqual(features.map((feature) => feature.id));
    expect(workTickets.readiness(currentPlan.steps[0]!).ready).toBe(true);
    expect(workTickets.readiness(currentPlan.steps[1]!).ready).toBe(false);

    for (const step of currentPlan.steps) await workTickets.completeStep(step);
    const bug = await createBug(store, currentPlan.steps[3]!);
    await expect(workTickets.completeDelivery('P1')).rejects.toThrow(bug.id);

    await store.transition(bug, 'cancelled', 'test-defect-cancelled');
    await workTickets.completeDelivery('P1', ['docs/project-development-report.md']);
    expect(delivery).toMatchObject({
      status: 'closed',
      execution: { state: 'passed' },
    });
    expect(epic).toMatchObject({
      status: 'closed',
      execution: { state: 'passed' },
    });
  });

  it('gates a later iteration through its upstream Epic instead of Plan order', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-iterations-'));
    const store = new TicketStore(new Workspace(root));
    const workTickets = new WorkTicketLifecycle(store);
    const currentPlan = plan();
    const first = {
      ...codeStep(),
      id: 'S001',
      iterationId: 'P1',
      dependsOn: [],
      subTasks: [],
    };
    const second = {
      ...codeStep(),
      id: 'S001',
      iterationId: 'P2',
      dependsOn: [],
      subTasks: [],
    };
    currentPlan.steps = [second, first];
    currentPlan.implementationPhases = [
      currentPlan.implementationPhases[0]!,
      {
        ...currentPlan.implementationPhases[0]!,
        id: 'P2',
        title: 'Enhancement delivery',
        status: 'planned',
        dependsOn: ['P1'],
      },
    ];

    await workTickets.registerExecutionGraph(currentPlan);
    const firstEpic = store.epicForIteration('P1')!;
    const secondEpic = store.epicForIteration('P2')!;
    const firstFeature = store.featureForStep(first.id, first.iterationId)!;
    const secondFeature = store.featureForStep(second.id, second.iterationId)!;

    expect(firstFeature.id).not.toBe(secondFeature.id);
    expect(firstFeature.iterationId).toBe('P1');
    expect(secondFeature.iterationId).toBe('P2');
    expect(secondEpic.dependsOnTicketIds).toEqual([firstEpic.id]);
    expect(secondFeature.dependsOnTicketIds).toEqual([firstEpic.id]);
    expect(workTickets.readiness(second).ready).toBe(false);

    await workTickets.completeStep(first);
    await workTickets.completeDelivery('P1');
    expect(workTickets.readiness(second).ready).toBe(true);

    await workTickets.completeStep(second);
    await workTickets.completeDelivery('P2');
    expect(workTickets.isIterationDelivered('P2')).toBe(true);
  });

  it('rejects missing Step and prerequisite Epic dependencies during graph compilation', async () => {
    const missingStepRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'xcompiler-ticket-missing-step-'),
    );
    const missingStepLifecycle = new WorkTicketLifecycle(
      new TicketStore(new Workspace(missingStepRoot)),
    );
    const missingStepPlan = plan({
      ...codeStep(),
      dependsOn: ['S999'],
    });
    await expect(missingStepLifecycle.registerExecutionGraph(missingStepPlan))
      .rejects.toThrow('dependency Step(s) missing for S999');

    const missingEpicRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'xcompiler-ticket-missing-epic-'),
    );
    const missingEpicLifecycle = new WorkTicketLifecycle(
      new TicketStore(new Workspace(missingEpicRoot)),
    );
    const missingEpicPlan = plan({
      ...codeStep(),
      iterationId: 'P2',
    });
    missingEpicPlan.implementationPhases = [{
      ...missingEpicPlan.implementationPhases[0]!,
      id: 'P2',
      dependsOn: ['P1'],
    }];
    await expect(missingEpicLifecycle.registerExecutionGraph(missingEpicPlan))
      .rejects.toThrow('prerequisite Epic(s) missing for P1');
  });

  it('rejects pre-v3 Ticket stores instead of running a compatibility path', async () => {
    const { root, workspace } = await setup();
    const indexPath = path.join(root, '.xcompiler/tickets/index.json');
    const legacy = (JSON.parse(await fs.readFile(indexPath, 'utf8')) as Array<Record<string, unknown>>)
      .map((ticket) => ({ ...ticket, version: 1 }));
    await fs.writeFile(indexPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    await expect(new TicketStore(workspace).load()).rejects.toThrow();
  });

  it('routes only bug tickets through debug, verification, and final closure', async () => {
    const { store, step } = await setup();
    const bug = await createBug(store, step);

    await store.transition(bug, 'triaged', 'routed');
    await store.transition(bug, 'in_progress', 'debug-started');
    bug.bugResolutionPlan = 'Correct the result contract and rerun the unit test.';
    await store.transition(bug, 'verification', 'repair-ready');
    await store.transition(bug, 'resolved', 'verification-passed');
    await store.transition(bug, 'closed', 'closed-after-wiki');

    expect(bug).toMatchObject({
      type: 'bug',
      status: 'closed',
      bugResolutionPlan: expect.stringContaining('rerun the unit test'),
    });
    expect(() => transitionTicket(bug, 'triaged')).toThrow(
      `Invalid ticket transition ${bug.id}: closed -> triaged`,
    );
  });

  it('reopens closed ancestor tickets when completed work starts again', async () => {
    const { store, workTickets, step } = await setup();
    const work = store.featureForStep(step.id, step.iterationId ?? 'P1')!;
    const root = store.find(work.rootTicketId!)!;

    await workTickets.startStep(step);
    await workTickets.completeStep(step);
    expect(work.status).toBe('closed');
    expect(root.status).toBe('in_progress');
    await workTickets.completeDelivery('P1');
    expect(root.status).toBe('closed');

    await workTickets.startStep(step);
    expect(work.status).toBe('in_progress');
    expect(root.status).toBe('in_progress');
  });

  it('persists a change-request ticket linked to its triggering bug and affected tasks', async () => {
    const { root, store, step } = await setup();
    const bug = await createBug(store, step);
    const work = store.featureForStep(step.id, step.iterationId ?? 'P1')!;
    const enhancement = await store.createEnhance({
      priority: 'high',
      iterationId: 'P1',
      title: 'Correct the incomplete service contract',
      description: 'The structured result contract is incomplete.',
      parentTicketId: work.rootTicketId,
      rootTicketId: work.rootTicketId,
      relatedTicketIds: [bug.id, work.id],
      blockedByTicketIds: [],
      source: {
        kind: 'runtime',
        externalId: bug.id,
        stepId: step.id,
        phase: step.phase,
        role: step.role,
      },
      acceptance: ['The corrected contract passes integration verification.'],
      artifacts: [],
      kind: 'functional-gap',
      finding: 'The service does not expose the required structured result.',
      sourceBugTicketId: bug.id,
      affectedWorkTicketIds: [work.id],
      changeRequestTicketIds: [],
      disposition: 'change-request',
    });
    await store.recordModelAttribution(enhancement, {
      providers: ['author-provider'],
      role: step.role,
      contribution: 'author',
      outcome: 'attributed-gap',
      stepId: step.id,
      phase: step.phase,
    });
    const request = await store.createChangeRequest({
      priority: 'high',
      iterationId: 'P1',
      title: 'Correct detailed design contract',
      description: 'Propagate only the corrected contract delta.',
      objective: 'Correct the rejected contract and propagate only its delta.',
      rootTicketId: work.rootTicketId,
      relatedTicketIds: [enhancement.id, bug.id, work.id],
      blockedByTicketIds: [],
      source: {
        kind: 'runtime',
        externalId: `${bug.id}:${step.id}`,
        stepId: step.id,
        phase: step.phase,
        role: step.role,
      },
      acceptance: ['Integration tests pass.'],
      artifacts: ['docs/03-detailed-design.md', 'src/main.ts'],
      sourceEnhanceTicketId: enhancement.id,
      originBugTicketId: bug.id,
      triggerTicketId: enhancement.id,
      scope: {
        in: ['S003 design correction', 'S004 implementation'],
        out: ['Unrelated behavior'],
      },
      trigger: {
        failedStepId: 'S006',
        failedPhase: 'INTEGRATION_TEST',
        failedAcceptance: 'Integration tests pass.',
        reason: 'Integration contract mismatch.',
        failureSummary: 'Expected the corrected interface.',
        failureEvidencePath: `.xcompiler/tickets/${bug.id}/failure.raw.log`,
      },
      designSource: {
        stepId: 'S003',
        phase: 'DETAILED_DESIGN',
        baselineCommit: 'before-sha',
        repairCommit: 'repair-sha',
        changedArtifacts: ['docs/03-detailed-design.md'],
      },
      contractChange: {
        summary: 'Change the service result contract.',
        before: ['Service returned a scalar.'],
        after: ['Service returns a structured result.'],
        interfaces: ['ServiceResult'],
        dependencies: [],
        constraints: ['Preserve the CLI contract.'],
      },
      implementationPlan: 'Update S004, then run downstream verification gates.',
      affectedSteps: [{
        stepId: step.id,
        phase: step.phase,
        role: step.role,
        title: step.title,
        inputs: step.inputs,
        outputs: step.outputs,
        acceptance: step.acceptance,
      }],
      affectedArtifacts: ['docs/03-detailed-design.md', 'src/main.ts'],
      verification: {
        targetStepId: 'S006',
        targetPhase: 'INTEGRATION_TEST',
        testArgs: ['tests/integration.test.ts'],
        checks: ['Integration tests pass.'],
        failurePolicy: 'Create a linked Bug Ticket and return this CR to rework.',
        rollbackTargetStepId: 'S003',
        rollbackTargetPhase: 'DETAILED_DESIGN',
      },
      execution: {
        completedStepIds: [],
      },
    });

    const changes = new ChangeRequestLifecycle(
      store,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    await changes.recordApplication(request, {
      stepId: step.id,
      phase: step.phase,
      kind: 'implementation-change',
      commit: 'code-sha',
      changedFiles: ['src/main.ts'],
      summary: 'Applied the service result delta.',
    });
    await changes.requestRework(request, 'BUG-P1-002', 'unit verification failed');

    const persisted = ChangeRequestTicketSchema.parse(JSON.parse(await fs.readFile(
      path.join(root, '.xcompiler/tickets', `${request.id}.json`),
      'utf8',
    )));
    expect(persisted).toMatchObject({
      type: 'change-request',
      status: 'in_progress',
      revision: 2,
      triggerTicketId: enhancement.id,
      sourceEnhanceTicketId: enhancement.id,
      originBugTicketId: bug.id,
      relatedTicketIds: expect.arrayContaining([enhancement.id, bug.id, work.id, 'BUG-P1-002']),
      execution: { completedStepIds: [step.id] },
    });
    const summary = JSON.parse(await fs.readFile(
      path.join(root, '.xcompiler/tickets/summary.json'),
      'utf8',
    )) as {
      enhancementsByKind: Record<string, number>;
      modelImpact: Record<string, Record<string, number>>;
    };
    expect(summary.enhancementsByKind['functional-gap']).toBe(1);
    expect(summary.modelImpact['author-provider']?.['attributed-gap']).toBe(1);
  });
});
