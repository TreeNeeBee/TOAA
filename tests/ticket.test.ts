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
    }],
    dependsOn: ['S003'],
    acceptance: 'The design delta is implemented and verified.',
    status: 'PENDING',
    retries: 0,
    maxRetries: 3,
  };
}

function plan(step = codeStep()): Plan {
  return {
    version: 2,
    intent: 'feature',
    projectType: 'application',
    language: 'typescript',
    requirementDigest: 'Implement a ticket-driven service change.',
    globalPrompt: 'Implement the approved plan.',
    steps: [step],
  };
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-'));
  const workspace = new Workspace(root);
  const store = new TicketStore(workspace);
  const workTickets = new WorkTicketLifecycle(store);
  const step = codeStep();
  await workTickets.registerPlan(plan(step));
  return { root, workspace, store, workTickets, step };
}

async function createBug(store: TicketStore, step: Step): Promise<BugTicket> {
  const work = store.workForStep(step.id)!;
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
      feature: 'work',
      task: 'work',
      'sub-task': 'work',
      bug: 'bug',
      enhance: 'enhancement',
      'change-request': 'change-request',
    });
  });

  it('materializes feature, task, and sub-task tickets from the plan hierarchy', async () => {
    const { root, store, step } = await setup();
    const tickets = store.all();
    const feature = tickets.find((ticket) => ticket.type === 'feature');
    const task = store.workForStep(step.id);
    const subTask = tickets.find((ticket) => ticket.type === 'sub-task');

    expect(feature).toMatchObject({ status: 'open', iterationId: 'P1' });
    expect(task).toMatchObject({
      type: 'task',
      parentTicketId: feature?.id,
      rootTicketId: feature?.id,
      source: { stepId: 'S004', phase: 'CODE' },
    });
    expect(subTask).toMatchObject({
      parentTicketId: task?.id,
      rootTicketId: feature?.id,
      source: { stepId: 'S004' },
    });

    const events = (await fs.readFile(
      path.join(root, '.xcompiler/tickets/events.jsonl'),
      'utf8',
    )).trim().split('\n').map((line) => JSON.parse(line) as { ticketType: string });
    expect(events.map((event) => event.ticketType)).toEqual(
      expect.arrayContaining(['feature', 'task', 'sub-task']),
    );
  });

  it('reserves enhance tickets for quality findings instead of iteration roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-refactor-'));
    const workspace = new Workspace(root);
    const store = new TicketStore(workspace);
    const workTickets = new WorkTicketLifecycle(store);
    const refactorPlan = plan();
    refactorPlan.intent = 'refactor';

    await workTickets.registerPlan(refactorPlan);

    expect(store.all().filter((ticket) => ticket.type === 'feature')).toHaveLength(1);
    expect(store.all().filter((ticket) => ticket.type === 'enhance')).toHaveLength(0);
  });

  it('rejects pre-v2 Ticket stores instead of running a compatibility path', async () => {
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
    const work = store.workForStep(step.id)!;
    const root = store.find(work.rootTicketId!)!;

    await workTickets.startStep(step);
    await workTickets.completeStep(step);
    expect(work.status).toBe('closed');
    expect(root.status).toBe('closed');

    await workTickets.startStep(step);
    expect(work.status).toBe('in_progress');
    expect(root.status).toBe('in_progress');
  });

  it('persists a change-request ticket linked to its triggering bug and affected tasks', async () => {
    const { root, store, step } = await setup();
    const bug = await createBug(store, step);
    const work = store.workForStep(step.id)!;
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
      affectedTaskTicketIds: [work.id],
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
