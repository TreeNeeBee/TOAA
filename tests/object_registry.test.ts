import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createObjectEnvelope,
  reviseObjectEnvelope,
} from '../src/domain/objects/object_envelope.js';
import {
  OBJECT_REGISTRY_EVENTS_PATH,
  OBJECT_REGISTRY_INDEX_PATH,
  ObjectRegistry,
  sha256Content,
} from '../src/infrastructure/registry/object_registry.js';
import { Workspace } from '../src/workspace/workspace.js';

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-registry-'));
  const workspace = new Workspace(root);
  const registry = new ObjectRegistry(workspace);
  await registry.load();
  return { root, workspace, registry };
}

async function storeObject(
  workspace: Workspace,
  objectType: string,
  id: string,
  value: unknown,
): Promise<{ objectRef: string; contentHash: string }> {
  const objectRef = `.xcompiler/objects/${objectType}/${id}.json`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await workspace.writeFileAtomic(objectRef, content);
  return { objectRef, contentHash: sha256Content(content) };
}

describe('ObjectRegistry', () => {
  it('maps global ids to type, name and object content without treating name as identity', async () => {
    const { workspace, registry } = await setup();
    const project = createObjectEnvelope({
      name: 'news',
      objectType: 'project',
      now: '2026-08-01T00:00:00.000Z',
    });
    const projectStorage = await storeObject(workspace, project.objectType, project.id, project);
    await registry.register({ envelope: project, ...projectStorage, state: 'created' });

    const step = createObjectEnvelope({
      name: 'P1-S004',
      objectType: 'step',
      projectId: project.id,
      now: '2026-08-01T00:01:00.000Z',
    });
    const stepStorage = await storeObject(workspace, step.objectType, step.id, step);
    await registry.register({
      envelope: step,
      ...stepStorage,
      parentId: project.id,
      state: 'created',
    });

    expect(step.id).not.toBe(step.name);
    expect(registry.require(step.id, 'step')).toMatchObject({
      id: step.id,
      name: 'P1-S004',
      objectType: 'step',
      projectId: project.id,
      parentId: project.id,
    });
    expect(registry.childrenOf(project.id).map((entry) => entry.id)).toEqual([step.id]);
    expect(await registry.verifyIntegrity({ verifyContent: true })).toEqual([]);
  });

  it('enforces revision checks, id non-reuse and active project ownership', async () => {
    const { workspace, registry } = await setup();
    const project = createObjectEnvelope({ name: 'project', objectType: 'project' });
    const projectStorage = await storeObject(workspace, project.objectType, project.id, project);
    await registry.register({ envelope: project, ...projectStorage });

    await expect(registry.register({ envelope: project, ...projectStorage }))
      .rejects.toThrow(/cannot be reused/u);

    const phase = createObjectEnvelope({ name: 'P1', objectType: 'phase', projectId: project.id });
    const phaseStorage = await storeObject(workspace, phase.objectType, phase.id, phase);
    await registry.register({ envelope: phase, ...phaseStorage, parentId: project.id });

    const revised = reviseObjectEnvelope(phase, { name: 'P1 Core' });
    const revisedStorage = await storeObject(workspace, revised.objectType, revised.id, revised);
    await registry.update({ envelope: revised, ...revisedStorage, parentId: project.id });
    expect(registry.require(phase.id).name).toBe('P1 Core');

    await expect(registry.update({ envelope: revised, ...revisedStorage, parentId: project.id }))
      .rejects.toThrow(/revision must advance/u);
    await expect(registry.tombstone(project.id, project.revision))
      .rejects.toThrow(/active child/u);
  });

  it('rejects parent cycles during reparenting', async () => {
    const { workspace, registry } = await setup();
    const project = createObjectEnvelope({ name: 'project', objectType: 'project' });
    const projectStorage = await storeObject(workspace, project.objectType, project.id, project);
    await registry.register({ envelope: project, ...projectStorage });

    const phase = createObjectEnvelope({ name: 'P1', objectType: 'phase', projectId: project.id });
    const phaseStorage = await storeObject(workspace, phase.objectType, phase.id, phase);
    await registry.register({ envelope: phase, ...phaseStorage, parentId: project.id });

    const step = createObjectEnvelope({ name: 'P1-S001', objectType: 'step', projectId: project.id });
    const stepStorage = await storeObject(workspace, step.objectType, step.id, step);
    await registry.register({ envelope: step, ...stepStorage, parentId: phase.id });

    const revisedPhase = reviseObjectEnvelope(phase);
    const revisedStorage = await storeObject(
      workspace,
      revisedPhase.objectType,
      revisedPhase.id,
      revisedPhase,
    );
    await expect(registry.update({
      envelope: revisedPhase,
      ...revisedStorage,
      parentId: step.id,
    })).rejects.toThrow(/create a cycle/u);
  });

  it('replays the append-only event log and rebuilds a missing snapshot', async () => {
    const { workspace, registry } = await setup();
    const project = createObjectEnvelope({ name: 'project', objectType: 'project' });
    const storage = await storeObject(workspace, project.objectType, project.id, project);
    await registry.register({ envelope: project, ...storage });

    await workspace.remove(OBJECT_REGISTRY_INDEX_PATH);
    const restored = new ObjectRegistry(workspace);
    await restored.load();

    expect(restored.require(project.id)).toMatchObject({ name: 'project', objectType: 'project' });
    await restored.rebuild();
    expect(await workspace.exists(OBJECT_REGISTRY_INDEX_PATH)).toBe(true);
    expect((await workspace.readFile(OBJECT_REGISTRY_EVENTS_PATH)).trim().split('\n')).toHaveLength(1);
  });

  it('detects missing and modified object content', async () => {
    const { workspace, registry } = await setup();
    const project = createObjectEnvelope({ name: 'project', objectType: 'project' });
    const storage = await storeObject(workspace, project.objectType, project.id, project);
    await registry.register({ envelope: project, ...storage });

    await workspace.writeFile(storage.objectRef, '{"corrupted":true}\n');
    expect(await registry.verifyIntegrity({ verifyContent: true })).toEqual([
      expect.objectContaining({ objectId: project.id, code: 'hash-mismatch' }),
    ]);

    await workspace.remove(storage.objectRef);
    expect(await registry.verifyIntegrity({ verifyContent: true })).toEqual([
      expect.objectContaining({ objectId: project.id, code: 'missing-object' }),
    ]);
  });

  it('rejects a rewritten registry event even when its sequence is unchanged', async () => {
    const { workspace, registry } = await setup();
    const project = createObjectEnvelope({ name: 'project', objectType: 'project' });
    const storage = await storeObject(workspace, project.objectType, project.id, project);
    await registry.register({ envelope: project, ...storage });

    const events = (await workspace.readFile(OBJECT_REGISTRY_EVENTS_PATH)).trim().split('\n');
    const first = JSON.parse(events[0]!) as { entry: { name: string } };
    first.entry.name = 'rewritten';
    await workspace.writeFile(OBJECT_REGISTRY_EVENTS_PATH, `${JSON.stringify(first)}\n`);

    await expect(new ObjectRegistry(workspace).load()).rejects.toThrow(/event hash is invalid/u);
  });

  it('rejects object references outside the project workspace', async () => {
    const { registry } = await setup();
    const project = createObjectEnvelope({ name: 'project', objectType: 'project' });
    await expect(registry.register({
      envelope: project,
      objectRef: '../outside.json',
      contentHash: sha256Content('{}'),
    })).rejects.toThrow(/escape the workspace/u);
  });
});
