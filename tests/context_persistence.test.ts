import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import { ContextService } from '../src/application/context/context_service.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { ProjectContainer } from '../src/workspace/project_container.js';
import { PLAN_VERSION, type Plan } from '../src/core/plan.js';
import { STEP_TYPES } from '../src/domain/steps/step.js';

/**
 * Context is a registered object, so it must survive a process restart. Reading it back through a
 * second repository instance is what proves that, rather than reading a value still in memory.
 */
describe('context record survives a repository round trip', () => {
  it('reads back what was written, from a fresh repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-rt-'));
    const container = new ProjectContainer(root);
    const repo = new DomainObjectRepository(container.state);
    await repo.load();
    const graph = compileProjectGraph({ draft: plan(), topic: 't', projectName: 'p' });
    await new ProjectGraphPersistenceService(repo).persistGraph(graph);
    const svc = new ContextService(repo);
    const rec = await svc.ensure(graph.project.id, 'project', graph.project.id);
    await svc.apply(graph.project.id, {
      scope: 'project', ownerId: graph.project.id, expectedRevision: rec.revision,
      operation: 'set-objective', actorId: graph.actors[0]!.id, hasAuthority: true,
      text: 'ROUNDTRIP',
    });
    const fresh = new DomainObjectRepository(container.state);
    await fresh.load();
    const reread = await new ContextService(fresh).find(graph.project.id, 'project', graph.project.id);
    expect(reread?.objective).toBe('ROUNDTRIP');
    expect(reread?.revision).toBe(rec.revision + 1);
  });
});

function plan(): Plan {
  return {
    version: PLAN_VERSION, language: 'typescript', intent: 'greenfield', phaseId: 'P1',
    projectType: 'application', requirementDigest: 'rt',
    complexityAssessment: { level: 'simple', rationale: 'x', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{ id: 'P1', title: 'C', objective: 'D', status: 'current', scope: ['c'], deliverables: ['a'], dependsOn: [] }],
    architectureModules: [], globalPrompt: '', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date(0).toISOString(),
    steps: STEP_TYPES.map((t, i) => ({
      id: `S${String(i+1).padStart(3,'0')}`, iterationId: 'P1', phase: t, title: t, description: t,
      systemPrompt: t, role: 'Coder' as const, tools: ['write_file'], inputs: [], outputs: [`docs/${i}.md`],
      dependsOn: i === 0 ? [] : [`S${String(i).padStart(3,'0')}`], acceptance: 'a', maxAttempts: 3,
    })),
  };
}
