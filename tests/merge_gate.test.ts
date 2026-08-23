import { describe, expect, it, vi } from 'vitest';
import {
  gateOutcome,
  isGateCurrent,
  transitionMergeRequest,
  type GateCheckResult,
  type MergeGateRun,
  type MergeRequest,
  MergeRequestSchema,
} from '../src/domain/workspace/merge_request.js';
import { createObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { MergeGateService } from '../src/application/workspace/merge_gate_service.js';
import { ProjectContainer } from '../src/workspace/project_container.js';
import { MergeConflictError } from '../src/application/workspace/git_port.js';
import { TicketChangeSetSchema } from '../src/domain/workspace/change_set.js';

function run(overrides: Partial<MergeGateRun> = {}): MergeGateRun {
  return {
    sourceRevision: 'a'.repeat(40),
    targetRevision: 'b'.repeat(40),
    status: 'passed',
    checkResults: [],
    ...overrides,
  } as unknown as MergeGateRun;
}

function check(overrides: Partial<GateCheckResult> = {}): GateCheckResult {
  return { name: 'build', ok: true, summary: 'ok', kind: 'execution', ...overrides };
}

describe('merge gate verdicts', () => {
  it('holds only while both the source and the target are unchanged', () => {
    const gate = run();
    expect(isGateCurrent(gate, { source: 'a'.repeat(40), target: 'b'.repeat(40) })).toBe(true);
    // A new commit on the Ticket branch changes what is being merged...
    expect(isGateCurrent(gate, { source: 'c'.repeat(40), target: 'b'.repeat(40) })).toBe(false);
    // ...and a new commit on the mainline changes what it is merged into.
    expect(isGateCurrent(gate, { source: 'a'.repeat(40), target: 'd'.repeat(40) })).toBe(false);
  });

  it('separates an infrastructure failure from a product failure', () => {
    expect(gateOutcome([check(), check({ name: 'test' })])).toBe('passed');
    expect(gateOutcome([check({ name: 'test', ok: false })])).toBe('failed');
    // An unreachable provider must block the merge, not open a Bug against the project.
    expect(gateOutcome([check({ name: 'test', ok: false, kind: 'infrastructure' })]))
      .toBe('infrastructure-failed');
  });

  it('treats a gate with no checks as failed rather than vacuously passing', () => {
    expect(gateOutcome([])).toBe('failed');
  });

  it('refuses to move a merged request back into review', () => {
    const merged = { id: 'mr', state: 'merged', revision: 1 } as unknown as MergeRequest;
    // Merged is terminal: re-opening it would suggest the mainline commit could be re-judged.
    expect(() => transitionMergeRequest(merged, 'ready')).toThrow(/merged -> ready/);
  });

  it('treats a repeated transition as a no-op rather than an error', () => {
    const ready = { id: 'mr', state: 'ready', revision: 1 } as unknown as MergeRequest;
    expect(transitionMergeRequest(ready, 'ready')).toBe(ready);
  });
});

describe('merge gate lifecycle', () => {
  it('retargets the existing merge request after a failed candidate takes over the ChangeSet', async () => {
    const projectId = createObjectId();
    const changeSetId = createObjectId();
    const request = MergeRequestSchema.parse({
      ...createObjectEnvelope({ name: 'mr-retarget', objectType: 'merge-request', projectId }),
      changeSetId,
      rootTicketId: createObjectId(),
      sourceBranch: 'xcompiler/ticket/T0',
      targetBranch: 'master',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'b'.repeat(40),
      gateRunIds: [],
      state: 'changes-requested',
    });
    const changeSet = TicketChangeSetSchema.parse({
      ...createObjectEnvelope({ name: 'changeset-retarget', objectType: 'ticket-change-set', projectId }),
      id: changeSetId,
      rootTicketId: request.rootTicketId,
      generation: 1,
      sourceBranch: 'xcompiler/gate/repaired',
      workspaceId: createObjectId(),
      baseRevision: 'a'.repeat(40),
      currentRevision: 'c'.repeat(40),
      state: 'reviewing',
    });
    let updated: unknown;
    const service = new MergeGateService(
      {
        list: async () => [request],
        read: async () => changeSet,
        update: async (object: unknown) => { updated = object; },
      } as never,
      new ProjectContainer('/tmp/xcompiler-gate-retarget'),
      {} as never,
      'master',
    );

    const refreshed = await service.open(changeSet);

    expect(refreshed.sourceBranch).toBe('xcompiler/gate/repaired');
    expect(refreshed.sourceRevision).toBe('c'.repeat(40));
    expect(updated).toEqual(refreshed);
  });

  it('retains a failed candidate so the routed Bug can debug the exact tree', async () => {
    const projectId = createObjectId();
    const request = MergeRequestSchema.parse({
      ...createObjectEnvelope({ name: 'mr-failed', objectType: 'merge-request', projectId }),
      changeSetId: createObjectId(),
      rootTicketId: createObjectId(),
      sourceBranch: 'xcompiler/ticket/T0',
      targetBranch: 'master',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'b'.repeat(40),
      gateRunIds: [],
      state: 'validating',
    });
    const running = {
      ...createObjectEnvelope({ name: 'gate-failed', objectType: 'merge-gate-run', projectId }),
      mergeRequestId: request.id,
      sourceRevision: 'b'.repeat(40),
      targetRevision: 'a'.repeat(40),
      candidateRevision: 'c'.repeat(40),
      worktreePath: `worktrees/gates/${request.id}/run`,
      status: 'running',
      checkResults: [],
      startedAt: new Date().toISOString(),
    } as MergeGateRun;
    const removeWorktree = vi.fn(async () => undefined);
    const deleteBranch = vi.fn(async () => undefined);
    const committed: unknown[][] = [];
    const service = new MergeGateService(
      {
        read: async (id: string) => id === running.id ? running : request,
        commit: async (objects: unknown[]) => { committed.push(objects); },
      } as never,
      new ProjectContainer('/tmp/xcompiler-gate-failed'),
      { removeWorktree, deleteBranch } as never,
      'master',
    );

    const finished = await service.complete(running.id, [check({ ok: false, summary: 'tests broke' })]);

    expect(finished.status).toBe('failed');
    expect(committed).toHaveLength(1);
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it('removes the disposable worktree and branch when candidate creation conflicts', async () => {
    const projectId = createObjectId();
    const request = MergeRequestSchema.parse({
      ...createObjectEnvelope({ name: 'mr-fixture', objectType: 'merge-request', projectId }),
      changeSetId: createObjectId(),
      rootTicketId: createObjectId(),
      sourceBranch: 'xcompiler/ticket/T1',
      targetBranch: 'master',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'b'.repeat(40),
      gateRunIds: [],
      state: 'ready',
    });
    const removeWorktree = vi.fn(async () => undefined);
    const deleteBranch = vi.fn(async () => undefined);
    const service = new MergeGateService(
      { read: async () => request } as never,
      new ProjectContainer('/tmp/xcompiler-gate-lifecycle'),
      {
        revision: async (ref: string) => ref === 'master' ? 'a'.repeat(40) : 'b'.repeat(40),
        addWorktree: async () => undefined,
        mergeInto: async () => {
          throw new MergeConflictError('xcompiler/ticket/T1', ['src/a.ts']);
        },
        removeWorktree,
        deleteBranch,
      } as never,
      'master',
    );

    await expect(service.start(request.id)).rejects.toThrow('Merge conflict');
    expect(removeWorktree).toHaveBeenCalledOnce();
    expect(deleteBranch).toHaveBeenCalledOnce();
  });

  it('cleans the candidate when persisting its running GateRun fails', async () => {
    const projectId = createObjectId();
    const request = MergeRequestSchema.parse({
      ...createObjectEnvelope({ name: 'mr-persistence', objectType: 'merge-request', projectId }),
      changeSetId: createObjectId(),
      rootTicketId: createObjectId(),
      sourceBranch: 'xcompiler/ticket/T2',
      targetBranch: 'master',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'b'.repeat(40),
      gateRunIds: [],
      state: 'ready',
    });
    const removeWorktree = vi.fn(async () => undefined);
    const deleteBranch = vi.fn(async () => undefined);
    const service = new MergeGateService(
      {
        read: async () => request,
        commit: async () => { throw new Error('registry unavailable'); },
      } as never,
      new ProjectContainer('/tmp/xcompiler-gate-persistence'),
      {
        revision: async (ref: string) => ref === 'master' ? 'a'.repeat(40) : 'b'.repeat(40),
        addWorktree: async () => undefined,
        mergeInto: async () => 'c'.repeat(40),
        removeWorktree,
        deleteBranch,
      } as never,
      'master',
    );

    await expect(service.start(request.id)).rejects.toThrow('registry unavailable');
    expect(removeWorktree).toHaveBeenCalledOnce();
    expect(deleteBranch).toHaveBeenCalledOnce();
  });
});
