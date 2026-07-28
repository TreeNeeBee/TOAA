import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkTicketLifecycle } from '../src/core/engine/work_ticket_lifecycle.js';
import type { Plan, Step } from '../src/core/plan.js';
import { TicketStore } from '../src/core/ticket.js';
import { Workspace } from '../src/workspace/workspace.js';

function step(id: string, status: Step['status']): Step {
  return {
    id,
    iterationId: 'P1',
    phase: 'CODE',
    title: id,
    description: id,
    systemPrompt: id,
    role: 'Coder',
    tools: [],
    inputs: [],
    outputs: [`src/${id}.ts`],
    subTasks: [],
    dependsOn: [],
    acceptance: id,
    status,
    retries: 4,
    maxRetries: 3,
  };
}

describe('runtime interrupted-step recovery', () => {
  it('projects persisted Feature state over stale Plan Step state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-recovery-'));
    const workspace = new Workspace(root);
    const store = new TicketStore(workspace);
    const lifecycle = new WorkTicketLifecycle(store);
    const running = step('S004', 'RUNNING');
    const plan = {
      version: '1',
      intent: 'feature',
      phaseId: 'P1',
      projectType: 'application',
      language: 'typescript',
      requirementDigest: 'Recover from interrupted execution.',
      complexityAssessment: {
        level: 'simple',
        rationale: 'One isolated stage.',
        splitRecommended: false,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [{
        id: 'P1',
        title: 'Recovery',
        objective: 'Recover the interrupted stage.',
        status: 'current',
        scope: ['runtime'],
        deliverables: ['src/S004.ts'],
        dependsOn: [],
        verificationGate: {
          summary: 'The stage is verified.',
          checks: ['The feature closes.'],
          failurePolicy: 'Open a Bug.',
        },
      }],
      globalPrompt: '',
      baselineSummary: '',
      userAddenda: '',
      createdAt: new Date().toISOString(),
      steps: [running],
    } as Plan;

    await lifecycle.registerExecutionGraph(plan);
    expect(running.status).toBe('PENDING');

    await lifecycle.startStep(running);
    expect(store.featureForStep('S004', 'P1')?.status).toBe('in_progress');

    running.status = 'DONE';
    const reloaded = new WorkTicketLifecycle(new TicketStore(workspace));
    await reloaded.registerExecutionGraph(plan);
    expect(running.status).toBe('RUNNING');
  });
});
