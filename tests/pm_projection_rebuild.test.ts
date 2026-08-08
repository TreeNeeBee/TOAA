import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import { ProjectStatusProjectionService } from '../src/application/project_management/project_projection.js';
import {
  FileProjectProjectionWriter,
  PROJECT_STATUS_PROJECTION_PATH,
} from '../src/infrastructure/projections/file_project_projection.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { Workspace } from '../src/workspace/workspace.js';
import { PLAN_VERSION, type Plan } from '../src/core/plan.js';
import { STEP_TYPES } from '../src/domain/steps/step.js';

/**
 * The 0.3 acceptance gate for the PM cache: "PM cache can be deleted and rebuilt without changing
 * behavior." The invalidation machinery existed but nothing exercised the gate itself.
 */
describe('PM status projection', () => {
  it('rebuilds an identical projection after its cache file is deleted', async () => {
    const { workspace, repository, projectId } = await fixture();
    const writer = new FileProjectProjectionWriter(workspace);
    const service = new ProjectStatusProjectionService(repository, writer);

    const first = await service.refresh(projectId);
    await writer.write(first);
    expect(await workspace.exists(PROJECT_STATUS_PROJECTION_PATH)).toBe(true);

    // Cache loss must cost performance only, never correctness.
    await workspace.remove(PROJECT_STATUS_PROJECTION_PATH);
    expect(await workspace.exists(PROJECT_STATUS_PROJECTION_PATH)).toBe(false);

    const rebuilt = await service.current(projectId);
    // Everything except the generation timestamp must be reproduced exactly.
    expect(withoutTimestamp(rebuilt)).toEqual(withoutTimestamp(first));
  });

  it('reuses the cache only while the registry sequence and source revisions still match', async () => {
    const { workspace, repository, projectId } = await fixture();
    const writer = new FileProjectProjectionWriter(workspace);
    const service = new ProjectStatusProjectionService(repository, writer);

    const projection = await service.refresh(projectId);
    await writer.write(projection);
    // An intact cache is reused verbatim, timestamp included.
    expect(await service.current(projectId)).toEqual(projection);

    // A tampered checksum must be rejected rather than trusted as canonical state.
    const raw = JSON.parse(await workspace.readFile(PROJECT_STATUS_PROJECTION_PATH));
    raw.projection.sourceChecksum = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    await workspace.writeFile(PROJECT_STATUS_PROJECTION_PATH, JSON.stringify(raw));

    const recovered = await service.current(projectId);
    expect(withoutTimestamp(recovered)).toEqual(withoutTimestamp(projection));
    expect(recovered.generatedAt).not.toBe(projection.generatedAt);
  });
});

function withoutTimestamp(
  projection: Awaited<ReturnType<ProjectStatusProjectionService['refresh']>>,
): Record<string, unknown> {
  const { generatedAt: _generatedAt, ...rest } = projection;
  return rest;
}

async function fixture(): Promise<{
  workspace: Workspace;
  repository: DomainObjectRepository;
  projectId: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-pm-projection-'));
  const workspace = new Workspace(root);
  const graph = compileProjectGraph({
    draft: samplePlan(),
    topic: 'Build a TypeScript news application.',
    projectName: 'news',
  });
  const repository = new DomainObjectRepository(workspace);
  await repository.load();
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  return { workspace, repository, projectId: graph.project.id };
}

function samplePlan(): Plan {
  return {
    version: PLAN_VERSION,
    language: 'typescript',
    intent: 'greenfield',
    phaseId: 'P1',
    projectType: 'application',
    requirementDigest: 'news reader',
    complexityAssessment: {
      level: 'simple', rationale: 'fixture', splitRecommended: false, userForcedPhaseSplit: false,
    },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Deliver the reader', status: 'current',
      scope: ['reader'], deliverables: ['src/index.ts'], dependsOn: [],
    }],
    architectureModules: [],
    globalPrompt: '',
    baselineSummary: '',
    dependencies: [],
    userAddenda: '',
    createdAt: new Date(0).toISOString(),
    steps: STEP_TYPES.map((type, index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`,
      iterationId: 'P1',
      phase: type,
      title: `${type} step`,
      description: `${type} work`,
      systemPrompt: `Do the ${type} work.`,
      role: 'Coder' as const,
      tools: ['write_file'],
      inputs: [],
      outputs: [`docs/${type.toLowerCase()}.md`],
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: `${type} accepted`,
      maxAttempts: 3,
    })),
  };
}
