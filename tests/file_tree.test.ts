import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReadWriteLock } from '../src/core/rwlock.js';
import {
  applyFileTreeChange,
  isIgnoredTreePath,
  readTreeDir,
  statTreePath,
  type FileTreeEntry,
} from '../src/domain/workspace/file_tree.js';
import { FileTreeService } from '../src/application/workspace/file_tree_service.js';
import {
  resolveFileTreeService,
  resetFileTreeServices,
} from '../src/application/workspace/file_tree_resolver.js';
import {
  renderFileManifest,
  upsertFileManifest,
} from '../src/application/workspace/file_manifest.js';
import type { PersistedDomainObject } from '../src/domain/objects/persisted.js';
import { PLAN_VERSION } from '../src/core/plan.js';
import { STEP_TYPES } from '../src/domain/steps/step.js';

const entry = (over: Partial<FileTreeEntry> & { path: string }): FileTreeEntry => ({
  type: 'file', size: 1, mtimeMs: 1, ctimeMs: 1, ...over,
});

describe('ReadWriteLock', () => {
  it('lets readers share and keeps a writer exclusive', async () => {
    const lock = new ReadWriteLock();
    const order: string[] = [];
    let peakReaders = 0;

    const reader = async (id: string) => lock.read(async () => {
      peakReaders = Math.max(peakReaders, lock.readers);
      order.push(`r${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    await Promise.all([
      reader('1'),
      reader('2'),
      lock.write(async () => {
        // Nothing else may be inside while a writer holds the lock.
        expect(lock.readers).toBe(0);
        order.push('w');
      }),
    ]);

    expect(peakReaders).toBe(2);
    expect(order.filter((step) => step === 'w')).toHaveLength(1);
  });

  // A lock that admits every arriving reader is a suggestion: with readers arriving faster than
  // they finish, `activeReaders` never reaches zero and the writer waits forever.
  it('does not let a steady stream of readers starve a waiting writer', async () => {
    const lock = new ReadWriteLock();
    let wrote = false;
    let readsAfterWrite = 0;

    const first = lock.read(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const writer = lock.write(async () => { wrote = true; });
    // These arrive while the writer is queued behind the first reader.
    const latecomers = [0, 1, 2].map(() => lock.read(async () => {
      if (wrote) readsAfterWrite += 1;
    }));

    await Promise.all([first, writer, ...latecomers]);

    expect(wrote).toBe(true);
    expect(readsAfterWrite).toBe(3);
  });

  it('releases the lock when the critical section throws', async () => {
    const lock = new ReadWriteLock();
    await expect(lock.write(async () => { throw new Error('mutation failed'); }))
      .rejects.toThrow('mutation failed');
    expect(lock.writeHeld).toBe(false);
    await expect(lock.write(async () => 'recovered')).resolves.toBe('recovered');
  });
});

describe('file tree', () => {
  it('applies create, modify, and delete without disagreeing with the filesystem', () => {
    let entries = applyFileTreeChange([], { kind: 'created', entry: entry({ path: 'src/a.ts' }) });
    entries = applyFileTreeChange(entries, {
      kind: 'modified',
      entry: entry({ path: 'src/a.ts', size: 20, mtimeMs: 99, ctimeMs: 99 }),
    });
    expect(statTreePath(entries, 'src/a.ts')).toMatchObject({ size: 20, mtimeMs: 99 });
    expect(entries).toHaveLength(1);

    // Deleting something absent settles on the state the filesystem is in rather than throwing.
    entries = applyFileTreeChange(entries, { kind: 'deleted', entry: entry({ path: 'src/never.ts' }) });
    entries = applyFileTreeChange(entries, { kind: 'deleted', entry: entry({ path: 'src/a.ts' }) });
    expect(entries).toEqual([]);
  });

  // Removing only the exact path left every descendant behind as an entry for a file that no
  // longer exists — in the manifest that gets delivered as the record of what the project is.
  it('takes the subtree with a deleted directory, the way rm -r does', () => {
    const entries = [
      entry({ path: 'src', type: 'directory' }),
      entry({ path: 'src/a.ts' }),
      entry({ path: 'src/deep/b.ts' }),
      entry({ path: 'src-tools/keep.ts' }),
    ];
    const after = applyFileTreeChange(entries, {
      kind: 'deleted',
      entry: entry({ path: 'src', type: 'directory' }),
    });
    // A sibling whose name merely starts with the same letters is not under it.
    expect(after.map((e) => e.path)).toEqual(['src-tools/keep.ts']);
  });

  it('reads one directory level, the way readdir does', () => {
    const entries = [
      entry({ path: 'src/a.ts' }),
      entry({ path: 'src/nested/b.ts' }),
      entry({ path: 'src/nested', type: 'directory' }),
      entry({ path: 'README.md' }),
    ];
    expect(readTreeDir(entries, 'src').map((e) => e.path)).toEqual(['src/a.ts', 'src/nested']);
    expect(readTreeDir(entries).map((e) => e.path)).toEqual(['README.md']);
  });

  it('excludes a configured prefix and its subtree, not paths that merely start with the letters', () => {
    expect(isIgnoredTreePath('node_modules/x/index.js', ['node_modules'])).toBe(true);
    expect(isIgnoredTreePath('node_modules', ['node_modules'])).toBe(true);
    expect(isIgnoredTreePath('node_modules_local/keep.ts', ['node_modules'])).toBe(false);
  });
});

describe('FileTreeService', () => {
  let root = '';
  let objects = new Map<string, PersistedDomainObject>();
  let service: FileTreeService;

  const repository = {
    read: async (id: string) => objects.get(id)!,
    commit: async (batch: PersistedDomainObject[]) => {
      for (const object of batch) objects.set(object.id, object);
    },
    list: async () => [...objects.values()],
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-file-tree-'));
    objects = new Map();
    const tree = FileTreeService.create({
      projectId: '019fd0e5-5210-7e03-9b5e-4876a0541efd' as never,
      workspaceRoot: root,
    });
    objects.set(tree.id, tree);
    service = new FileTreeService(repository as never, root, tree.id);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // The timestamps come from lstat, never from the caller: a tree assembled from what a tool
  // claimed to write could contain a file that was never created.
  it('records what landed on disk, with the timestamps stat reports', async () => {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    await service.record('src/a.ts', 'created');

    const stat = await service.stat('src/a.ts');
    expect(stat?.type).toBe('file');
    expect(stat?.size).toBeGreaterThan(0);
    expect(stat?.mtimeMs).toBeGreaterThan(0);
    expect(stat?.ctimeMs).toBeGreaterThan(0);

    await fs.rm(path.join(root, 'src/a.ts'));
    await service.record('src/a.ts', 'deleted');
    expect(await service.stat('src/a.ts')).toBeUndefined();
  });

  // A create whose file is already gone is a delete. Recording the caller's intent instead would
  // leave an entry for a path that does not exist, in a record that gets delivered.
  it('does not invent an entry for a path that is not there', async () => {
    await service.record('src/vanished.ts', 'created');
    expect(await service.stat('src/vanished.ts')).toBeUndefined();
  });

  it('reconciles the whole tree for changes that never passed through it', async () => {
    // A Git checkout or a merge lands files without calling record.
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/merged.ts'), 'export const merged = true;\n');
    await fs.mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules/pkg/index.js'), 'module.exports = {};\n');

    const counted = await service.rescan();

    expect(counted).toBeGreaterThan(0);
    expect(await service.stat('src/merged.ts')).toBeDefined();
    // Dependency output is not part of the project's tree.
    expect(await service.stat('node_modules/pkg/index.js')).toBeUndefined();
  });

  // Without the directories a write brought into being, the tree holds a file whose parents it has
  // never heard of, and `list` — the `readdir` answer — reports an empty directory that
  // demonstrably has contents. It would only agree with the filesystem again at the next rescan.
  it('records the directories an incremental write created', async () => {
    await fs.mkdir(path.join(root, 'src/deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/deep/a.ts'), 'export const a = 1;\n');
    await service.record('src/deep/a.ts', 'created');

    expect((await service.stat('src'))?.type).toBe('directory');
    expect((await service.stat('src/deep'))?.type).toBe('directory');
    expect((await service.list('src')).map((entry) => entry.path)).toEqual(['src/deep']);
    expect((await service.list('src/deep')).map((entry) => entry.path)).toEqual(['src/deep/a.ts']);

    // A second file in a directory the tree already holds adds nothing further.
    await fs.writeFile(path.join(root, 'src/deep/b.ts'), 'export const b = 2;\n');
    await service.record('src/deep/b.ts', 'created');
    expect((await service.entries()).filter((entry) => entry.type === 'directory')).toHaveLength(2);
  });

  // `reconciledRevision` asserts "these entries are what git revision X holds". A rescan that cannot
  // name a revision has no such assertion to make, and carrying the previous one forward left the
  // tree claiming a correspondence its freshly scanned entries no longer had — the value a delivery
  // HEAD check would be validated against.
  it('drops the reconciled revision when the entries move off it', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    await service.rescan('abc123');
    const tree = () => [...objects.values()][0] as { reconciledRevision?: string };
    expect(tree().reconciledRevision).toBe('abc123');

    // An incremental write moves the tree off that commit.
    await fs.writeFile(path.join(root, 'b.txt'), 'b\n');
    await service.record('b.txt', 'created');
    expect(tree().reconciledRevision).toBeUndefined();

    // A rescan that names no revision cannot restore the claim either.
    await service.rescan('def456');
    await service.rescan();
    expect(tree().reconciledRevision).toBeUndefined();
  });

  // Marking the index dirty does not touch the entries, so the revision that described them still
  // does; `dirty` is what says a write may have been missed.
  it('keeps the reconciled revision when only the dirty flag changes', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    await service.rescan('abc123');
    await service.markDirty();
    const tree = [...objects.values()][0] as { reconciledRevision?: string; dirty?: boolean };
    expect(tree.dirty).toBe(true);
    expect(tree.reconciledRevision).toBe('abc123');
  });

  // Every write is one revision step, which is why the tree is its own object and not a field on
  // the management plan the orchestrator is also writing.
  it('advances exactly one revision per mutation', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    const before = [...objects.values()][0]!.revision;
    await service.record('a.txt', 'created');
    const after = [...objects.values()][0]!.revision;
    expect(after).toBe(before + 1);
  });
});

describe('delivered file manifest', () => {
  const entries: FileTreeEntry[] = [
    entry({ path: 'src/a.ts', size: 2048, mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_500_000 }),
    entry({ path: 'docs', type: 'directory', size: 0 }),
  ];

  // This section is written into a file it lists, so any size or timestamp it printed would be
  // wrong for that file the instant the write lands. The manifest scopes itself to the facts the
  // write cannot invalidate, and says where the rest is kept.
  it('carries path and type only, and says where the stat data lives', () => {
    const section = renderFileManifest(entries);
    expect(section).toContain('`src/a.ts`');
    expect(section).toMatch(/\| `docs` \| directory \|/u);
    // Directories are not counted as delivered files.
    expect(section).toContain('1 files');

    // Nothing the manifest write would falsify.
    expect(section).not.toContain('KiB');
    expect(section).not.toContain('mtime)');
    expect(section).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
    // And the reader is told where it did go.
    expect(section).toContain('recorded on the project file tree');
  });

  // Appending on every delivery would grow one duplicate per run, each disagreeing with the others.
  // A delivered document that contradicts itself is worse than one that omits the manifest.
  it('replaces an earlier manifest instead of appending a second one', () => {
    const authored = '# Delivery\n\nHand-written acceptance notes.\n';
    const first = upsertFileManifest(authored, renderFileManifest(entries));
    const second = upsertFileManifest(first, renderFileManifest([entries[0]!]));

    expect(second.match(/xcompiler:file-manifest:begin/gu)).toHaveLength(1);
    expect(second).toContain('Hand-written acceptance notes.');
    expect(second).not.toContain('`docs`');
  });

  it('leaves authored prose either side of the region untouched', () => {
    const authored = '# Delivery\n\nBefore.\n\n<!-- xcompiler:file-manifest:begin -->\nold\n<!-- xcompiler:file-manifest:end -->\n\nAfter.\n';
    const updated = upsertFileManifest(authored, renderFileManifest(entries));
    expect(updated).toContain('Before.');
    expect(updated).toContain('After.');
    expect(updated).not.toContain('\nold\n');
  });
});

describe('file tree resolution', () => {
  const projectId = '019fd0e5-5210-7e03-9b5e-4876a0541efd' as never;
  const planId = '019fd0e5-5210-7e41-8d33-fd207dc4de96';
  let store = new Map<string, PersistedDomainObject>();

  const repository = {
    read: async (id: string) => store.get(id)!,
    commit: async (batch: PersistedDomainObject[]) => {
      for (const object of batch) store.set(object.id, object);
    },
    list: async (options?: { objectType?: string; projectId?: string }) =>
      [...store.values()].filter((object) =>
        (!options?.objectType || object.objectType === options.objectType) &&
        (!options?.projectId || object.projectId === options.projectId)),
  };

  beforeEach(() => {
    store = new Map();
    resetFileTreeServices();
  });

  // The canonical tree belongs to the Project. Candidate worktrees are transient and must never
  // replace or fork the PM-owned mainline index.
  it('returns one service per Project, so the canonical lock and index are shared', async () => {
    const first = await resolveFileTreeService(repository as never, projectId, '/tmp/ws-a');
    const second = await resolveFileTreeService(repository as never, projectId, '/tmp/ws-a');
    expect(second).toBe(first);

    // A caller presenting a candidate path still resolves to the Project's canonical service.
    const other = await resolveFileTreeService(repository as never, projectId, '/tmp/ws-b');
    expect(other).toBe(first);
  });

  it('records ownership on the management plan exactly once', async () => {
    const plan = {
      id: planId, objectType: 'project-management-plan', projectId, revision: 1,
      name: 'pm', schemaVersion: 1, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), pmActorId: projectId, objective: 'o',
      scopeBaseline: ['s'], successCriteria: ['c'], constraints: [], stakeholderRefs: [],
      milestonePhaseIds: [projectId], actorRegistrationIds: [projectId], riskRecordIds: [],
      decisionRecordIds: [], interactionRequestIds: [], scheduleToleranceMs: 0, status: 'draft',
    } as unknown as PersistedDomainObject;
    store.set(planId, plan);

    await resolveFileTreeService(repository as never, projectId, '/tmp/ws-a');
    const afterFirst = store.get(planId) as { fileTree?: { fileTreeId: string }; revision: number };
    expect(afterFirst.fileTree?.fileTreeId).toBeDefined();

    // A second workspace must not repoint the plan at whichever one wrote last.
    resetFileTreeServices();
    await resolveFileTreeService(repository as never, projectId, '/tmp/ws-b');
    const afterSecond = store.get(planId) as { fileTree?: { fileTreeId: string }; revision: number };
    expect(afterSecond.fileTree?.fileTreeId).toBe(afterFirst.fileTree?.fileTreeId);
    expect(afterSecond.revision).toBe(afterFirst.revision);
  });
});

// The master tree belongs to the Project. Registered without a parent it hangs outside the object
// graph that integrity checks and `childrenOf` traversals walk — seventeen such entries were
// sitting parentless in a live workspace registry.
describe('file tree registration', () => {
  it('registers under the Project, like the other project-owned objects', async () => {
    const { DomainObjectRepository } = await import(
      '../src/infrastructure/repository/domain_object_repository.js');
    const { ProjectContainer } = await import('../src/workspace/project_container.js');
    const { compileProjectGraph } = await import('../src/domain/planning/compiler.js');
    const { ProjectGraphPersistenceService } = await import(
      '../src/application/planning/project_graph_persistence_service.js');

    const containerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-file-tree-parent-'));
    try {
      const container = new ProjectContainer(containerRoot);
      const repository = new DomainObjectRepository(container.state);
      await repository.load();
      const graph = compileProjectGraph({ draft: minimalPlan(), topic: 't', projectName: 'p' });
      await new ProjectGraphPersistenceService(repository).persistGraph(graph);

      const tree = FileTreeService.create({ projectId: graph.project.id });
      await repository.commit([tree]);

      const registry = (repository as unknown as {
        registry: { childrenOf(id: string): { id: string }[] };
      }).registry;
      expect(registry.childrenOf(graph.project.id).map((entry) => entry.id)).toContain(tree.id);
    } finally {
      await fs.rm(containerRoot, { recursive: true, force: true });
    }
  });
});

function minimalPlan() {
  return {
    version: PLAN_VERSION, language: 'typescript', intent: 'greenfield', phaseId: 'P1',
    projectType: 'application', requirementDigest: 'ft',
    complexityAssessment: { level: 'simple', rationale: 'x', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{ id: 'P1', title: 'C', objective: 'D', status: 'current', scope: ['c'], deliverables: ['a'], dependsOn: [] }],
    architectureModules: [], globalPrompt: '', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date(0).toISOString(),
    steps: STEP_TYPES.map((type, index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase: type, title: type,
      description: type, systemPrompt: type, role: 'Coder' as const, tools: ['write_file'],
      inputs: [], outputs: [`docs/${index}.md`],
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: 'a', maxAttempts: 3,
    })),
  } as never;
}
