import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChangeRequestStore,
  EngineeringChangeRequestSchema,
  transitionChangeRequest,
} from '../src/core/change_request.js';
import type { Step } from '../src/core/plan.js';
import { Workspace } from '../src/workspace/workspace.js';

function affectedStep(): Step {
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
    dependsOn: ['S003'],
    acceptance: 'The design delta is implemented and verified.',
    status: 'PENDING',
    retries: 0,
    maxRetries: 3,
  };
}

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-cr-'));
  const workspace = new Workspace(root);
  const store = new ChangeRequestStore(workspace);
  const step = affectedStep();
  const request = await store.create({
    iterationId: 'P1',
    issueId: 'ISSUE-1',
    relatedIssueIds: ['ISSUE-1'],
    title: 'Correct detailed design contract',
    objective: 'Correct the rejected contract and propagate only its delta.',
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
      failureEvidencePath: '.xcompiler/issues/ISSUE-1/failure.raw.log',
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
    implementationPlan: 'Update S004, then run its downstream verification gates.',
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
      failurePolicy: 'Record a linked issue and return this CR to rework.',
      rollbackTargetStepId: 'S003',
      rollbackTargetPhase: 'DETAILED_DESIGN',
    },
    execution: {
      completedStepIds: [],
      blockedBy: [],
    },
  });
  return { root, store, request };
}

describe('engineering change requests', () => {
  it('persists a bidirectionally traceable CR contract and application history', async () => {
    const { root, store, request } = await createStore();

    await store.recordApplication(request, {
      stepId: 'S004',
      phase: 'CODE',
      kind: 'implementation-change',
      commit: 'code-sha',
      changedFiles: ['src/main.ts'],
      summary: 'Applied the service result delta.',
    });

    const persisted = EngineeringChangeRequestSchema.parse(JSON.parse(await fs.readFile(
      path.join(root, '.xcompiler/change-requests', `${request.id}.json`),
      'utf8',
    )));
    expect(persisted.status).toBe('implementing');
    expect(persisted.relatedIssueIds).toEqual(['ISSUE-1']);
    expect(persisted.execution.completedStepIds).toEqual(['S004']);
    expect(persisted.applications[0]).toMatchObject({
      revision: 1,
      commit: 'code-sha',
      changedFiles: ['src/main.ts'],
    });
  });

  it('reuses the same CR revision chain for ordinary downstream failures', async () => {
    const { store, request } = await createStore();

    await store.requestRework(request, 'ISSUE-2', 'unit verification failed');
    expect(request).toMatchObject({
      status: 'rework',
      revision: 2,
      relatedIssueIds: ['ISSUE-1', 'ISSUE-2'],
    });

    await store.recordApplication(request, {
      stepId: 'S004',
      phase: 'CODE',
      kind: 'implementation-change',
      commit: 'rework-sha',
      changedFiles: ['src/main.ts'],
      summary: 'Corrected the failed implementation.',
    });
    expect(request.status).toBe('implementing');
    expect(request.applications.at(-1)?.revision).toBe(2);
  });

  it('keeps closed CRs terminal', async () => {
    const { store, request } = await createStore();
    await store.close(request);
    expect(() => transitionChangeRequest(request, 'rework')).toThrow(
      `Invalid change request transition ${request.id}: closed -> rework`,
    );
  });

  it('blocks a parent CR only when a correction expands into a child CR', async () => {
    const { store, request } = await createStore();
    await store.blockOnChild(
      request,
      'CR-P1-002',
      'ISSUE-2',
      'The correction expands from detailed design into system architecture.',
    );

    expect(request).toMatchObject({
      status: 'rework',
      revision: 2,
      relatedIssueIds: ['ISSUE-1', 'ISSUE-2'],
      execution: { blockedBy: ['CR-P1-002'] },
    });
  });
});
