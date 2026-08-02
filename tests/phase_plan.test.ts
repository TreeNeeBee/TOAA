import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlan } from '../src/agents/planner.js';
import type { Phase, Step } from '../src/core/plan.js';
import {
  advancePhasePlan,
  buildPhasePlanCheckpoint,
  buildPhasePlanFromCurrentPlan,
  defaultPhasePlanPath,
  defaultPhasePlanStepPath,
  phasePlanFileName,
} from '../src/core/phase_plan.js';
import { loadPlanTarget, savePhasePlan, savePlan } from '../src/core/storage.js';

describe('phase plan persistence', () => {
  it('persists a source-bound checkpoint before the current phase is materialized', () => {
    const sourceDigest = 'a'.repeat(64);
    const checkpoint = buildPhasePlanCheckpoint({
      language: 'typescript',
      intent: 'greenfield',
      projectType: 'application',
      requirementDigest: 'Build a news briefing CLI.',
      complexityAssessment: {
        level: 'moderate',
        rationale: 'Core delivery followed by one enhancement phase.',
        splitRecommended: true,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core',
          objective: 'Deliver the briefing CLI.',
          status: 'current',
          scope: ['CLI'],
          deliverables: ['Runnable application'],
          dependsOn: [],
          verificationGate: {
            summary: 'Core works.',
            checks: ['npm test'],
            failurePolicy: 'Repair P1.',
          },
        },
        {
          id: 'P2',
          title: 'Enhancement',
          objective: 'Improve summaries.',
          status: 'planned',
          scope: ['summaries'],
          deliverables: ['Summary extension'],
          dependsOn: ['P1'],
          verificationGate: {
            summary: 'Enhancement works.',
            checks: ['npm test'],
            failurePolicy: 'Repair P2.',
          },
        },
      ],
      sourceDigest,
    });

    expect(checkpoint.sourceDigest).toBe(sourceDigest);
    expect(checkpoint.currentPhaseId).toBe('P1');
    expect(checkpoint.phases.map((phase) => phase.planPath)).toEqual([
      'plan.P1.json',
      'plan.P2.json',
    ]);
  });

  it('preserves completed Phase history when an incremental plan is appended', () => {
    const existing = buildPhasePlanCheckpoint({
      language: 'typescript',
      intent: 'greenfield',
      projectType: 'application',
      requirementDigest: 'Deliver the core application.',
      complexityAssessment: {
        level: 'simple',
        rationale: 'One completed Phase.',
        splitRecommended: false,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [{
        id: 'P1', title: 'Core', objective: 'Deliver core.', status: 'current', scope: ['core'],
        deliverables: ['core'], dependsOn: [],
        verificationGate: { summary: 'Core passes.', checks: ['npm test'], failurePolicy: 'Open a Bug.' },
      }],
      sourceDigest: 'b'.repeat(64),
    });
    existing.phases[0]!.status = 'complete';
    const incremental = buildPlan({
      requirementDigest: 'Add reporting.',
      globalPrompt: 'Preserve core behavior.',
      dependencies: [],
      complexityAssessment: {
        level: 'moderate',
        rationale: 'A new reporting Phase is required.',
        splitRecommended: true,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [{
        id: 'P2', title: 'Reporting', objective: 'Add reporting.', status: 'current', scope: ['reports'],
        deliverables: ['report command'], dependsOn: [],
        verificationGate: { summary: 'Reports pass.', checks: ['npm test'], failurePolicy: 'Open a Bug.' },
      }],
      steps: vModelSteps('P2'),
    }, { language: 'typescript', intent: 'feature' });
    incremental.implementationPhases = incremental.implementationPhases.filter(
      (phase) => phase.status === 'current',
    );

    const merged = buildPhasePlanFromCurrentPlan({
      plan: incremental,
      phasePlanPath: '/workspace/phasePlan.json',
      currentPlanPath: '/workspace/plan.P2.json',
      existing,
    });

    expect(merged.phases.map((phase) => [phase.id, phase.status])).toEqual([
      ['P1', 'complete'],
      ['P2', 'current'],
    ]);
    expect(merged.currentPhaseId).toBe('P2');
    expect(merged.requirementDigest).toContain('Deliver the core application.');
    expect(merged.requirementDigest).toContain('Add reporting.');
    expect(merged.complexityAssessment.level).toBe('moderate');
  });

  it('loads phasePlan.json as the current phase plan target', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-phase-plan-'));
    const plan = buildPlan(
      {
        requirementDigest: 'Build a small CLI utility.',
        globalPrompt: 'Keep the implementation compact.',
        dependencies: [],
        complexityAssessment: {
          level: 'complex',
          rationale: 'Requires a core phase and a follow-up enhancement phase.',
          splitRecommended: true,
          userForcedPhaseSplit: false,
        },
        implementationPhases: [
          {
            id: 'P1',
            title: 'Core CLI',
            objective: 'Deliver the core command workflow.',
            status: 'current',
            scope: ['core command'],
            deliverables: ['working CLI'],
            dependsOn: [],
            verificationGate: {
              summary: 'Core CLI can run.',
              checks: ['npm test'],
              failurePolicy: 'Return to V-model debug for P1.',
            },
          },
          {
            id: 'P2',
            title: 'Enhancements',
            objective: 'Add optional reporting features.',
            status: 'planned',
            scope: ['reports'],
            deliverables: ['report command'],
            dependsOn: ['P1'],
            verificationGate: {
              summary: 'Reporting features pass regression checks.',
              checks: ['npm test'],
              failurePolicy: 'Plan P2 only after P1 passes.',
            },
          },
        ],
        steps: vModelSteps(),
      },
      { language: 'typescript', intent: 'greenfield' },
    );

    const phasePlanPath = defaultPhasePlanPath(workspace);
    const currentPlanPath = defaultPhasePlanStepPath(workspace, plan.phaseId);
    await savePlan(currentPlanPath, plan);
    const phasePlan = buildPhasePlanFromCurrentPlan({ plan, phasePlanPath, currentPlanPath });
    await savePhasePlan(phasePlanPath, phasePlan);

    expect(path.basename(currentPlanPath)).toBe('plan.P1.json');
    expect(phasePlan.currentPhaseId).toBe('P1');
    expect(phasePlan.phases.find((phase) => phase.id === 'P1')?.planPath).toBe(phasePlanFileName('P1'));
    expect(phasePlan.phases.find((phase) => phase.id === 'P2')?.planPath).toBe(phasePlanFileName('P2'));

    const advanced = advancePhasePlan(phasePlan);
    expect(advanced.completedPhaseId).toBe('P1');
    expect(advanced.nextPhase?.id).toBe('P2');
    expect(advanced.phasePlan.currentPhaseId).toBe('P2');
    expect(advanced.phasePlan.phases.find((phase) => phase.id === 'P1')?.status).toBe('complete');
    expect(advanced.phasePlan.phases.find((phase) => phase.id === 'P2')?.status).toBe('current');
    expect(phasePlan.phases.find((phase) => phase.id === 'P1')?.status).toBe('current');

    const loaded = await loadPlanTarget(phasePlanPath);
    expect(loaded.phasePlanPath).toBe(phasePlanPath);
    expect(loaded.planPath).toBe(currentPlanPath);
    expect(loaded.plan.phaseId).toBe('P1');
    expect(loaded.plan.steps).toHaveLength(plan.steps.length);
  });

  it('rejects obsolete V-model source/test-plan mappings instead of rewriting the plan', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-phase-plan-obsolete-'));
    const plan = buildPlan(
      {
        requirementDigest: 'Build a small CLI utility.',
        globalPrompt: 'Keep the implementation compact.',
        dependencies: [],
        complexityAssessment: {
          level: 'simple',
          rationale: 'Single core workflow.',
          splitRecommended: false,
          userForcedPhaseSplit: false,
        },
        implementationPhases: [
          {
            id: 'P1',
            title: 'Core CLI',
            objective: 'Deliver the core command workflow.',
            status: 'current',
            scope: ['core command'],
            deliverables: ['working CLI'],
            dependsOn: [],
            verificationGate: {
              summary: 'Core CLI can run.',
              checks: ['npm test'],
              failurePolicy: 'Return to V-model debug for P1.',
            },
          },
        ],
        steps: vModelSteps(),
      },
      { language: 'typescript', intent: 'greenfield' },
    );
    const hld = plan.steps.find((step) => step.phase === 'HIGH_LEVEL_DESIGN')!;
    const detailed = plan.steps.find((step) => step.phase === 'DETAILED_DESIGN')!;
    hld.outputs = ['docs/02-high-level-design.md', 'docs/tests/integration-test-plan.md', 'package.json'];
    detailed.outputs = ['docs/03-detailed-design.md', 'docs/tests/module-test-plan.md'];
    const planPath = path.join(workspace, 'plan.P1.json');
    await savePlan(planPath, plan);

    await expect(loadPlanTarget(planPath)).rejects.toThrow(/must synchronously output paired/);
  });

  it('accepts a materialized follow-up phase whose current status matches phaseId', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-phase-plan-p2-'));
    const plan = buildPlan(
      {
        requirementDigest: 'Add reporting to the existing CLI.',
        globalPrompt: 'Preserve the completed core workflow.',
        dependencies: [],
        complexityAssessment: {
          level: 'moderate',
          rationale: 'Core and reporting are separate iterations.',
          splitRecommended: true,
          userForcedPhaseSplit: false,
        },
        implementationPhases: [
          {
            id: 'P1',
            title: 'Core CLI',
            objective: 'Deliver the core workflow.',
            status: 'complete',
            scope: ['core'],
            deliverables: ['working CLI'],
            dependsOn: [],
            verificationGate: {
              summary: 'Core passed.',
              checks: ['npm test'],
              failurePolicy: 'Debug P1.',
            },
          },
          {
            id: 'P2',
            title: 'Reporting',
            objective: 'Deliver reporting features.',
            status: 'current',
            scope: ['reports'],
            deliverables: ['report command'],
            dependsOn: ['P1'],
            verificationGate: {
              summary: 'Reporting passes.',
              checks: ['npm test'],
              failurePolicy: 'Debug P2.',
            },
          },
        ],
        steps: vModelSteps('P2'),
      },
      { language: 'typescript', intent: 'feature' },
    );
    const planPath = path.join(workspace, 'plan.P2.json');
    await savePlan(planPath, plan);

    const loaded = await loadPlanTarget(planPath);
    expect(loaded.plan.phaseId).toBe('P2');
    expect(new Set(loaded.plan.steps.map((step) => step.iterationId))).toEqual(new Set(['P2']));
  });
});

function vModelSteps(iterationId = 'P1'): Step[] {
  const phases: Phase[] = [
    'REQUIREMENT_ANALYSIS',
    'HIGH_LEVEL_DESIGN',
    'DETAILED_DESIGN',
    'CODE',
    'UNIT_TEST',
    'INTEGRATION_TEST',
    'MODULE_TEST',
    'FUNCTIONAL_TEST',
  ];
  return phases.map((phase, index) => {
    const id = `S${String(index + 1).padStart(3, '0')}`;
    return {
      id,
      iterationId,
      phase,
      title: `${phase} step`,
      description: `Complete ${phase}.`,
      systemPrompt: `Implement ${phase} deliverables.`,
      role: phase.endsWith('TEST') ? 'Tester' : phase === 'CODE' ? 'Coder' : 'Planner',
      tools: ['write_file'],
      inputs: index === 0 ? [] : [`docs/${String(index).padStart(2, '0')}.md`],
      outputs: stepOutputs(phase, index),
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: `${phase} output exists.`,
      maxAttempts: 3,
    };
  });
}

function stepOutputs(phase: Phase, index: number): string[] {
  if (phase === 'HIGH_LEVEL_DESIGN') return ['docs/02.md', 'package.json'];
  if (phase === 'CODE') return ['src/main.ts'];
  if (phase === 'UNIT_TEST') return ['tests/main.test.ts'];
  return [`docs/${String(index + 1).padStart(2, '0')}.md`];
}
