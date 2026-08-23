import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectOrchestrator } from '../src/application/project_management/orchestrator.js';
import { resetFileTreeServices } from '../src/application/workspace/file_tree_resolver.js';
import { Workspace } from '../src/workspace/workspace.js';

/**
 * The delivered manifest asserts that it describes the released commit. These cover what happens
 * when it does not: bytes reached the canonical copy without being committed, so the file list
 * describes a state no commit holds, and anyone checking out the release gets something else.
 */
describe('delivery manifest provenance', () => {
  it('passes silently when the indexed revision is HEAD and nothing is outstanding', async () => {
    const probe = harness({ head: 'rev1', pending: [] });
    await probe.verify('rev1');

    expect(probe.commits).toBe(0);
    expect(probe.dirty).toBe(false);
    expect(probe.notes).toEqual([]);
  });

  // Repair before report: the outstanding paths are committed and the tree re-indexed, so delivery
  // carries a manifest whose provenance is true rather than one flagged as doubtful.
  it('commits the outstanding paths and re-indexes, then reports the repair', async () => {
    const probe = harness({ head: 'rev1', pending: ['src/late.ts'] }, { head: 'rev2', pending: [] });
    await probe.verify('rev1');

    expect(probe.commits).toBe(1);
    expect(probe.rescans).toContain('rev2');
    expect(probe.dirty).toBe(false);
    expect(probe.notes.join(' ')).toContain('provenance repaired');
  });

  // Delivery still completes: a manifest whose provenance is flagged is more use than a Phase that
  // cannot deliver. What must not happen is delivering it while claiming it was verified.
  it('marks the tree unverified and names the paths when the repair does not settle it', async () => {
    const probe = harness(
      { head: 'rev1', pending: ['src/late.ts'] },
      { head: 'rev2', pending: ['src/late.ts'] },
    );
    await probe.verify('rev1');

    expect(probe.dirty).toBe(true);
    expect(probe.notes.join(' ')).toContain('provenance unverified');
    expect(probe.recorded.pendingChanges).toEqual(['src/late.ts']);
  });

  // A commit that never happened leaves nothing to stand on, and that is a different cause from a
  // revision that moved — the recorded reason has to say which.
  it('names an uncommitted artifact as the cause', async () => {
    const probe = harness({ head: 'rev1', pending: [] }, { head: 'rev1', pending: [] });
    await probe.verify(undefined);

    expect(probe.notes.join(' ')).toContain('never committed');
  });

  // Covering the check without covering its call site leaves the check able to pass while never
  // running: deleting the call from the delivery path failed nothing until this existed.
  it('runs as part of publishing the manifest, not only when called directly', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-provenance-'));
    resetFileTreeServices();
    try {
      const notes: string[] = [];
      const store = new Map<string, unknown>();
      const projectId = '019fd0e5-5210-7e03-9b5e-4876a0541efd';
      const phase = { id: '019fd0e5-5210-7e41-8d33-fd207dc4de96', objectType: 'phase', projectId };
      const orchestrator = new ProjectOrchestrator({
        workspace: new Workspace(root),
        repository: {
          read: async (id: string) => (id === phase.id ? phase : store.get(id)),
          list: async (query: { objectType?: string }) =>
            [...store.values()].filter((object) =>
              (object as { objectType?: string }).objectType === query.objectType),
          commit: async (batch: { id: string }[]) => {
            for (const object of batch) store.set(object.id, object);
          },
        },
        plugins: { size: 0 },
        audit: { event: async (_k: string, message: string) => { notes.push(message); } },
        // Uncommitted paths at delivery, and no artifact commit available to repair them.
        canonicalRevisionState: async () => ({ head: 'rev1', pending: ['src/uncommitted.ts'] }),
      } as never, { language: 'typescript' } as never);

      await (orchestrator as unknown as {
        publishFileManifest(phaseId: string): Promise<void>;
      }).publishFileManifest(phase.id);

      expect(notes.join(' ')).toContain('provenance unverified');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function harness(...states: { head: string; pending: string[] }[]) {
  const notes: string[] = [];
  const rescans: (string | undefined)[] = [];
  let dirty = false;
  let commits = 0;
  let call = 0;
  let recorded: Record<string, unknown> = {};

  const tree = {
    rescan: async (revision?: string) => { rescans.push(revision); return 0; },
    markDirty: async () => { dirty = true; },
  };
  const orchestrator = new ProjectOrchestrator({
    repository: {}, plugins: { size: 0 },
    audit: {
      event: async (_kind: string, message: string, data?: Record<string, unknown>) => {
        notes.push(message);
        recorded = data ?? {};
      },
    },
    canonicalRevisionState: async () => states[Math.min(call++, states.length - 1)]!,
    commitCanonicalArtifact: async () => { commits += 1; return states[states.length - 1]!.head; },
  } as never, { language: 'typescript' } as never);

  return {
    notes, rescans,
    get commits() { return commits; },
    get dirty() { return dirty; },
    get recorded() { return recorded; },
    verify: (indexed: string | undefined) =>
      (orchestrator as unknown as {
        verifyManifestProvenance(
          projectId: string, phaseId: string, tree: unknown, indexed?: string,
        ): Promise<void>;
      }).verifyManifestProvenance('proj', 'phase', tree, indexed),
  };
}
