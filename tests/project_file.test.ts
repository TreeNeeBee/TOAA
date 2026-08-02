import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Plan } from '../src/core/plan.js';
import {
  XCOMPILER_PROJECT_MANIFEST_KIND,
  buildProjectProgress,
  defaultProjectFilePath,
  findProjectFile,
  loadXCompilerProject,
  updateProjectFile,
} from '../src/core/project_file.js';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { StepSchema } from '../src/domain/steps/step.js';
import { reviseObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { Workspace } from '../src/workspace/workspace.js';

describe('XCompiler project file', () => {
  it('creates a workspace-local manifest that points to the canonical Project', async () => {
    const { workspace, graph } = await canonicalWorkspace();
    const projectFile = await updateProjectFile({
      workspace,
      projectId: graph.project.id,
      planPath: path.join(workspace, 'phasePlan.json'),
      configPath: path.join(workspace, 'config.yaml'),
      command: 'build',
      intent: 'feature',
      requirementFile: path.join(workspace, 'feature.md'),
      recordHistory: true,
    });

    expect(projectFile).toBe(defaultProjectFilePath(workspace));
    const loaded = await loadXCompilerProject(projectFile);
    expect(loaded.data.kind).toBe(XCOMPILER_PROJECT_MANIFEST_KIND);
    expect(loaded.data.projectId).toBe(graph.project.id);
    expect(loaded.project.id).toBe(graph.project.id);
    expect(loaded.workspace).toBe(path.resolve(workspace));
    expect(loaded.planPath).toBe(path.join(workspace, 'phasePlan.json'));
    expect(loaded.configPath).toBe(path.join(workspace, 'config.yaml'));
    expect(loaded.data.progress?.status).toBe('planned');
    expect(loaded.data.progress?.steps[0]?.name).toBe('P1-S001');
    expect(loaded.data.history[0]?.command).toBe('build');
  });

  it('does not auto-discover legacy .toaa project files', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-'));
    await fs.writeFile(path.join(workspace, 'legacy.toaa'), '{}');
    expect(await findProjectFile(workspace)).toBeUndefined();
    await expect(loadXCompilerProject(path.join(workspace, 'legacy.toaa'))).rejects.toThrow(/\.xc/u);
  });

  it.each(['toaa.project', 'xcompiler.project'])(
    'rejects obsolete %s project payloads',
    async (kind) => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-'));
      const legacy = path.join(workspace, 'legacy.xc');
      await fs.writeFile(legacy, JSON.stringify({ kind, version: '1', workspace, planPath: 'plan.json' }));
      await expect(loadXCompilerProject(legacy)).rejects.toThrow();
      await expect(updateProjectFile({ workspace, projectFilePath: legacy, planPath: 'plan.json' }))
        .rejects.toThrow();
    },
  );

  it('derives progress only from domain Step state', async () => {
    const { graph } = await canonicalWorkspace();
    const states = ['closed', 'pending', 'created'] as const;
    const steps = graph.steps.slice(0, 3).map((step, index) => StepSchema.parse({
      ...step,
      ...reviseObjectEnvelope(step),
      state: states[index],
      pendingReason: states[index] === 'pending' ? 'defect' : undefined,
    }));
    const progress = buildProjectProgress(graph.project, steps);
    expect(progress.status).toBe('failed');
    expect(progress.failedStepId).toBe(steps[1]!.id);
    expect(progress.percent).toBe(33);
  });

  it('stores the workspace as an absolute path', async () => {
    const { workspace, graph } = await canonicalWorkspace();
    const projectFile = await updateProjectFile({
      workspace,
      projectId: graph.project.id,
      planPath: path.join(workspace, 'phasePlan.json'),
      command: 'build',
    });
    const raw = JSON.parse(await fs.readFile(projectFile, 'utf8')) as { workspace: string };
    expect(raw.workspace).toBe(path.resolve(workspace));
  });

  it('rejects a manifest pointing to an unknown Project', async () => {
    const { workspace, graph } = await canonicalWorkspace();
    const projectFile = await updateProjectFile({
      workspace,
      projectId: graph.project.id,
      planPath: path.join(workspace, 'phasePlan.json'),
    });
    const data = JSON.parse(await fs.readFile(projectFile, 'utf8')) as Record<string, unknown>;
    data.projectId = '018f22ce-7e2a-7d51-8d89-abcdef123456';
    await fs.writeFile(projectFile, JSON.stringify(data));
    await expect(loadXCompilerProject(projectFile)).rejects.toThrow(/entry not found/u);
  });

  it('rejects a stale workspace path before loading domain state', async () => {
    const { workspace, graph } = await canonicalWorkspace();
    const projectFile = await updateProjectFile({
      workspace,
      projectId: graph.project.id,
      planPath: path.join(workspace, 'phasePlan.json'),
    });
    const data = JSON.parse(await fs.readFile(projectFile, 'utf8')) as Record<string, unknown>;
    data.workspace = path.join(workspace, 'moved-away');
    await fs.writeFile(projectFile, JSON.stringify(data));
    await expect(loadXCompilerProject(projectFile)).rejects.toThrow(/does not exist/u);
  });

  it('rejects a workspace that does not contain the manifest', async () => {
    const { workspace, graph } = await canonicalWorkspace();
    const projectFile = await updateProjectFile({
      workspace,
      projectId: graph.project.id,
      planPath: path.join(workspace, 'phasePlan.json'),
    });
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-other-'));
    const data = JSON.parse(await fs.readFile(projectFile, 'utf8')) as Record<string, unknown>;
    data.workspace = other;
    await fs.writeFile(projectFile, JSON.stringify(data));
    await expect(loadXCompilerProject(projectFile)).rejects.toThrow(/outside its declared workspace/u);
  });

  it('rejects a workspace without write permission', async () => {
    const { workspace, graph } = await canonicalWorkspace();
    const projectFile = await updateProjectFile({
      workspace,
      projectId: graph.project.id,
      planPath: path.join(workspace, 'phasePlan.json'),
    });
    await fs.chmod(workspace, 0o555);
    try {
      await expect(loadXCompilerProject(projectFile)).rejects.toThrow(/not writable/u);
    } finally {
      await fs.chmod(workspace, 0o755);
    }
  });
});

async function canonicalWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-'));
  const repository = new DomainObjectRepository(new Workspace(workspace));
  await repository.load();
  const graph = compileProjectGraph({
    draft: samplePlan(),
    topic: 'Build a Python application.',
    projectName: 'sample',
  });
  await repository.persistCompiledGraph(graph);
  return { workspace, repository, graph };
}

function samplePlan(): Plan {
  const phases = [
    ['REQUIREMENT_ANALYSIS', 'Planner'], ['HIGH_LEVEL_DESIGN', 'Architect'],
    ['DETAILED_DESIGN', 'Architect'], ['CODE', 'Coder'], ['UNIT_TEST', 'Tester'],
    ['INTEGRATION_TEST', 'Tester'], ['MODULE_TEST', 'Tester'], ['FUNCTIONAL_TEST', 'Tester'],
  ] as const;
  return {
    version: '1', language: 'python', intent: 'feature', phaseId: 'P1', projectType: 'application',
    requirementDigest: 'sample',
    complexityAssessment: { level: 'simple', rationale: 'one phase', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Deliver core.', status: 'current', scope: ['core'],
      deliverables: ['src/main.py'], dependsOn: [],
      verificationGate: { summary: 'Pass all gates.', checks: ['acceptance'], failurePolicy: 'Open Bug.' },
    }],
    globalPrompt: '', baselineSummary: '', dependencies: [], userAddenda: '', createdAt: new Date().toISOString(),
    steps: phases.map(([phase, role], index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase,
      title: phase, description: `Execute ${phase}.`, systemPrompt: `Execute ${phase}.`, role,
      tools: [], inputs: [], outputs: [`docs/${index + 1}.md`], subTasks: [],
      dependsOn: index ? [`S${String(index).padStart(3, '0')}`] : [], acceptance: `${phase} passes.`,
      maxAttempts: 3,
    })),
  };
}
