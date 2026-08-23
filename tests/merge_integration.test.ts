import { describe, expect, it, vi } from 'vitest';
import {
  MergeIntegrationService,
  mergeGateScopeForStep,
} from '../src/application/workspace/merge_integration_service.js';
import type { GateCheckResult, MergeGateRun } from '../src/domain/workspace/merge_request.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { MergeConflictError } from '../src/application/workspace/git_port.js';

const projectId = createObjectId();
const rootTicketId = createObjectId();
const changeSetId = createObjectId();
const correctiveTicketId = createObjectId();
const mergeRequestId = createObjectId();
const workspaceId = createObjectId();
const phaseId = createObjectId();
const stepId = createObjectId();

const now = new Date(0).toISOString();

const mergeRequest = {
  id: mergeRequestId, name: 'mr-T1', objectType: 'merge-request', projectId,
  schemaVersion: 1, revision: 1, createdAt: now, updatedAt: now,
  changeSetId, rootTicketId,
  sourceBranch: 'xcompiler/ticket/T1', targetBranch: 'master',
  baseRevision: 'a'.repeat(40), sourceRevision: 'b'.repeat(40),
  gateRunIds: [], state: 'approved',
};

const changeSet = {
  id: changeSetId, objectType: 'ticket-change-set', projectId, rootTicketId,
  name: 'changeset-T1', sourceBranch: 'xcompiler/ticket/T1', workspaceId,
  generation: 1,
  baseRevision: 'a'.repeat(40), currentRevision: 'b'.repeat(40),
  correctiveTicketIds: [correctiveTicketId], changelistIds: [], state: 'reviewing', revision: 1,
  schemaVersion: 1, createdAt: now, updatedAt: now,
};

function harness(options: {
  checks: GateCheckResult[];
  mayMerge?: boolean;
  authorizeMerge?: () => Promise<{ approved: boolean; reason?: string }>;
  startError?: Error;
  verdictOk?: boolean;
  verdictReason?: string;
  failMergedStateCommitOnce?: boolean;
}) {
  const checkScopes: string[] = [];
  let mergeMessage = '';
  let mergedHead = false;
  const squashMerge = vi.fn(async (input: { message: string }) => {
    mergeMessage = input.message;
    mergedHead = true;
    return 'c'.repeat(40);
  });
  const releaseChangeSet = vi.fn(async () => undefined);
  const committed: unknown[][] = [];
  const gateRun = (status: MergeGateRun['status']) => ({
    id: createObjectId(), objectType: 'merge-gate-run', status,
    targetRevision: 'd'.repeat(40), candidateRevision: 'e'.repeat(40),
    worktreePath: `worktrees/gates/${mergeRequestId}/candidate`,
  } as unknown as MergeGateRun);
  const status = options.checks.some((c) => !c.ok && c.kind === 'infrastructure')
    ? 'infrastructure-failed'
    : options.checks.every((c) => c.ok) ? 'passed' : 'failed';

  // Stateful, like the real repository: reads see prior writes. A static stub that answered the
  // Merge Request for every id and dropped every update is why this suite never noticed the service
  // writing through a ChangeSet copy it had been holding across two intervening writes.
  const stored = new Map<string, Record<string, unknown>>([
    [changeSetId, { ...changeSet }],
    [mergeRequestId, { ...mergeRequest }],
  ]);
  const put = (object: unknown) => {
    const record = object as Record<string, unknown>;
    if (typeof record?.id === 'string') stored.set(record.id, record);
  };
  let rejectMergedState = options.failMergedStateCommitOnce ?? false;

  const service = new MergeIntegrationService({
    repository: {
      list: async () => [stored.get(changeSetId)],
      read: async (id: string) => id === rootTicketId
        ? { objectType: 'ticket', id: rootTicketId, phaseId, stepId }
        : id === stepId
          ? { objectType: 'step', id: stepId, type: 'CODE' }
        : stored.get(id) ?? mergeRequest,
      commit: async (objects: unknown[]) => {
        if (rejectMergedState && objects.some((object) =>
          (object as { objectType?: string; state?: string }).objectType === 'merge-request' &&
          (object as { state?: string }).state === 'merged')) {
          rejectMergedState = false;
          throw new Error('registry unavailable');
        }
        committed.push(objects);
        objects.forEach(put);
      },
      update: async (object: unknown) => { put(object); },
    } as never,
    gates: {
      open: async () => {
        const current = stored.get(changeSetId) ?? changeSet;
        if (!current.mergeRequestId) {
          put({ ...current, revision: Number(current.revision ?? 0) + 1, mergeRequestId });
        }
        return stored.get(mergeRequestId) ?? mergeRequest;
      },
      start: async () => {
        if (options.startError) throw options.startError;
        return { run: gateRun('running'), root: '/gate' };
      },
      complete: async () => {
        const run = gateRun(status as MergeGateRun['status']);
        put(run);
        const current = stored.get(mergeRequestId) ?? mergeRequest;
        put({
          ...current,
          revision: Number(current.revision ?? 0) + 1,
          state: status === 'passed' ? 'approved' : 'changes-requested',
          gateRunIds: [...((current.gateRunIds as string[] | undefined) ?? []), run.id],
        });
        return run;
      },
      currentVerdict: async () => {
        const request = stored.get(mergeRequestId) ?? mergeRequest;
        const runId = (request.gateRunIds as string[] | undefined)?.at(-1);
        return {
          ok: options.verdictOk ?? true,
          reason: options.verdictReason,
          run: runId ? stored.get(runId) : gateRun('passed'),
        };
      },
    } as never,
    git: {
      squashMerge,
      readCommit: async () => ({
        revision: mergedHead ? 'c'.repeat(40) : 'd'.repeat(40),
        parents: mergedHead ? ['d'.repeat(40)] : ['a'.repeat(40)],
        message: mergeMessage,
      }),
    } as never,
    runChecks: async (_root, scope) => {
      checkScopes.push(scope);
      return options.checks;
    },
    targetBranch: 'master',
    mayMerge: options.mayMerge ?? true,
    authorizeMerge: options.authorizeMerge,
    releaseChangeSet,
  });
  return { service, squashMerge, releaseChangeSet, committed, checkScopes };
}

const ok = (name: string): GateCheckResult => ({ name, ok: true, summary: 'ok', kind: 'execution' });
const failed = (name: string, kind: GateCheckResult['kind'] = 'execution'): GateCheckResult =>
  ({ name, ok: false, summary: `${name} broke`, kind });

describe('merge integration', () => {
  it('squashes a passing ChangeSet onto the mainline', async () => {
    const { service, squashMerge, checkScopes } = harness({ checks: [ok('dependencies'), ok('tests')] });
    const outcome = await service.integratePhase(projectId, phaseId);

    expect(outcome.status).toBe('merged');
    expect(outcome.mergedRevisions).toEqual(['c'.repeat(40)]);
    // The gate's target revision is what the merge is pinned to, not a freshly read head.
    expect(squashMerge.mock.calls[0]![0]).toMatchObject({
      targetBranch: 'master',
      sourceBranch: 'xcompiler/ticket/T1',
      expectedTargetRevision: 'd'.repeat(40),
    });
    expect(checkScopes).toEqual(['phase']);
  });

  it('reports a failed gate with the failing checks, which become a Bug at the caller', async () => {
    const { service, squashMerge } = harness({ checks: [ok('dependencies'), failed('tests')] });
    const outcome = await service.integratePhase(projectId, phaseId);

    expect(outcome.status).toBe('failed');
    expect(outcome.failureLog).toContain('tests broke');
    expect(outcome.workspaceBinding).toMatchObject({
      kind: 'gate',
      changeSetId,
      revision: 'e'.repeat(40),
    });
    expect(squashMerge).not.toHaveBeenCalled();
  });

  it('blocks on an infrastructure failure instead of blaming the project', async () => {
    const { service, squashMerge } = harness({ checks: [failed('dependencies', 'infrastructure')] });
    const outcome = await service.integratePhase(projectId, phaseId);

    // Nothing about the change was shown to be wrong, so this must not become a defect.
    expect(outcome.status).toBe('blocked');
    expect(squashMerge).not.toHaveBeenCalled();
  });

  it('reports a merge candidate conflict as a repairable project failure', async () => {
    const { service, squashMerge } = harness({
      checks: [],
      startError: new MergeConflictError('xcompiler/ticket/T1', ['src/parser.ts']),
    });
    const outcome = await service.integratePhase(projectId, phaseId);

    expect(outcome.status).toBe('failed');
    expect(outcome.failureLog).toContain('src/parser.ts');
    expect(squashMerge).not.toHaveBeenCalled();
  });

  it('will not write to a mainline XCompiler did not create', async () => {
    const { service, squashMerge } = harness({
      checks: [ok('dependencies'), ok('tests')],
      mayMerge: false,
    });
    const outcome = await service.integratePhase(projectId, phaseId);

    expect(outcome.status).toBe('awaiting-authorization');
    expect(squashMerge).not.toHaveBeenCalled();
  });

  it('requests authorization before writing to a pre-existing repository', async () => {
    const authorizeMerge = vi.fn(async () => ({ approved: true }));
    const { service, squashMerge } = harness({
      checks: [ok('dependencies'), ok('tests')],
      mayMerge: false,
      authorizeMerge,
    });

    const outcome = await service.integratePhase(projectId, phaseId);

    expect(outcome.status).toBe('merged');
    expect(authorizeMerge).toHaveBeenCalledOnce();
    expect(squashMerge).toHaveBeenCalledOnce();
  });

  it('can resume a gate-passed ChangeSet after authorization was denied', async () => {
    const authorizeMerge = vi.fn()
      .mockResolvedValueOnce({ approved: false, reason: 'not yet' })
      .mockResolvedValueOnce({ approved: true });
    const { service, squashMerge } = harness({
      checks: [ok('dependencies'), ok('tests')],
      mayMerge: false,
      authorizeMerge,
    });

    expect((await service.integratePhase(projectId, phaseId)).status)
      .toBe('awaiting-authorization');
    expect((await service.integratePhase(projectId, phaseId)).status).toBe('merged');
    expect(authorizeMerge).toHaveBeenCalledTimes(2);
    expect(squashMerge).toHaveBeenCalledOnce();
  });

  // The gate had passed and the Merge Request was already recorded as mergeable when a live run died
  // on an unhandled `Cannot merge into master: the working copy has uncommitted changes`. Every
  // other verdict here returns an outcome the orchestrator handles; this one escaped and killed the
  // process at the most expensive point in the run.
  it('reports a merge that cannot be applied instead of throwing', async () => {
    const { service, squashMerge } = harness({ checks: [ok('dependencies'), ok('tests')] });
    squashMerge.mockRejectedValueOnce(
      new Error('Cannot merge into master: the working copy has uncommitted changes: cache/pm/project-status.json'),
    );

    const outcome = await service.integratePhase(projectId, phaseId);

    // Nothing about the project was shown to be wrong, so it blocks rather than opening a defect.
    expect(outcome.status).toBe('blocked');
    expect(outcome.reason).toContain('cache/pm/project-status.json');
    expect(outcome.mergedRevisions).toEqual([]);
  });

  it('reconciles a squash that landed before domain-state persistence failed', async () => {
    const { service, squashMerge, releaseChangeSet } = harness({
      checks: [ok('dependencies'), ok('tests')],
      failMergedStateCommitOnce: true,
    });

    const interrupted = await service.integratePhase(projectId, phaseId);
    expect(interrupted.status).toBe('blocked');
    expect(interrupted.reason).toContain('next run will reconcile');

    const recovered = await service.integratePendingAuthorization(projectId, phaseId);
    expect(recovered.status, recovered.reason).toBe('merged');
    expect(recovered.mergedRevisions).toEqual(['c'.repeat(40)]);
    expect(squashMerge).toHaveBeenCalledOnce();
    expect(releaseChangeSet).toHaveBeenCalledWith(changeSetId);
  });

  it('refuses to merge when the mainline moved after the gate passed', async () => {
    const { service, squashMerge } = harness({
      checks: [ok('dependencies'), ok('tests')],
      verdictOk: false,
      verdictReason: 'source or target moved since the gate passed',
    });
    const outcome = await service.integratePhase(projectId, phaseId);

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('moved');
    expect(squashMerge).not.toHaveBeenCalled();
  });

  it('does nothing when the Phase has no unmerged ChangeSet', async () => {
    const { service } = harness({ checks: [] });
    const outcome = await service.integratePhase(projectId, createObjectId());
    expect(outcome.status).toBe('nothing-to-merge');
  });
});

describe('merge at Ticket delivery', () => {
  it('lands the delivering Ticket, so the next Step can read its work', async () => {
    // V-model Steps are sequentially dependent. A change still sitting on its own branch when the
    // Step delivers is invisible to everything that follows it in the Phase.
    const { service, squashMerge, releaseChangeSet, checkScopes } = harness({ checks: [ok('tests')] });
    const outcome = await service.integrateTicket(projectId, rootTicketId);

    expect(outcome.status).toBe('merged');
    expect(outcome.mergedRevisions).toEqual(['c'.repeat(40)]);
    expect(squashMerge).toHaveBeenCalledOnce();
    expect(releaseChangeSet).toHaveBeenCalledWith(changeSetId);
    expect(checkScopes).toEqual(['ticket-code']);
  });

  it('lands the branch for a corrective Ticket recorded against it', async () => {
    // A Bug or CR repairing CODE delivers the same ChangeSet its Story opened, so the delivering
    // Ticket is not the one the branch is keyed on. Looking only at the owner would leave every
    // repair unmerged.
    const { service, squashMerge } = harness({ checks: [ok('tests')] });
    const outcome = await service.integrateTicket(projectId, correctiveTicketId);

    expect(outcome.status).toBe('merged');
    expect(squashMerge).toHaveBeenCalledOnce();
  });

  it('has nothing to merge for a Step that worked in the canonical copy', async () => {
    // Only CODE develops in isolation, so most deliveries have no ChangeSet at all — their commits
    // are already on the mainline and merging is not merely unnecessary but meaningless.
    const { service, squashMerge } = harness({ checks: [ok('tests')] });
    const outcome = await service.integrateTicket(projectId, createObjectId());

    expect(outcome.status).toBe('nothing-to-merge');
    expect(outcome.mergedRevisions).toEqual([]);
    expect(squashMerge).not.toHaveBeenCalled();
  });
});

describe('ticket merge gate scope', () => {
  it('uses artifact assembly before CODE and executable gates from CODE onward', () => {
    expect(mergeGateScopeForStep('REQUIREMENT_ANALYSIS')).toBe('ticket-artifact');
    expect(mergeGateScopeForStep('HIGH_LEVEL_DESIGN')).toBe('ticket-artifact');
    expect(mergeGateScopeForStep('DETAILED_DESIGN')).toBe('ticket-artifact');
    expect(mergeGateScopeForStep('CODE')).toBe('ticket-code');
    expect(mergeGateScopeForStep('UNIT_TEST')).toBe('ticket-verification');
    expect(mergeGateScopeForStep('FUNCTIONAL_TEST')).toBe('ticket-verification');
  });
});
