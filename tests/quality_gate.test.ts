import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import {
  QualityAssessmentStore,
  defaultQualityGateForPhase,
  evaluateQualityGate,
} from '../src/core/quality_gate.js';
import {
  generateProjectDevelopmentReport,
  PROJECT_DEVELOPMENT_REPORT_PATH,
} from '../src/core/project_report.js';
import type { Plan, Step } from '../src/core/plan.js';
import { TicketStore } from '../src/core/ticket.js';
import { WorkTicketLifecycle } from '../src/core/engine/work_ticket_lifecycle.js';

describe('stage quality gates', () => {
  let root = '';
  let workspace: Workspace;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-quality-'));
    workspace = new Workspace(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('defines source completion/alignment and stage-specific test metrics', () => {
    expect(defaultQualityGateForPhase('CODE')).toMatchObject({
      completionMin: 0.95,
      upstreamAlignmentMin: 0.9,
    });
    expect(defaultQualityGateForPhase('UNIT_TEST').metrics).toEqual({
      lineCoverage: 0.8,
      branchCoverage: 0.7,
      testCasePassRate: 1,
    });
    expect(defaultQualityGateForPhase('INTEGRATION_TEST').metrics).toHaveProperty(
      'interfaceCoverage',
      0.85,
    );
    expect(defaultQualityGateForPhase('MODULE_TEST').metrics).toHaveProperty(
      'moduleCoverage',
      0.9,
    );
    expect(defaultQualityGateForPhase('FUNCTIONAL_TEST').metrics).toHaveProperty(
      'requirementCoverage',
      0.95,
    );
  });

  it('routes metric shortfalls to Enhance and failed tests to Bug', () => {
    const step = testStep('UNIT_TEST');
    const coverageGap = evaluateQualityGate(step, {
      metrics: {
        lineCoverage: 0.72,
        branchCoverage: 0.62,
        testCasePassRate: 1,
      },
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['coverage/coverage-summary.json'],
      gaps: [],
    });
    expect(coverageGap.enhancementFailures).not.toEqual([]);
    expect(coverageGap.bugFailures).toEqual([]);

    const failedTests = evaluateQualityGate(step, {
      metrics: {
        lineCoverage: 0.9,
        branchCoverage: 0.8,
        testCasePassRate: 0.95,
      },
      tolerance: { failedTests: 1, skippedTests: 0, warnings: 0 },
      evidence: ['pytest output'],
      gaps: [],
    });
    expect(failedTests.bugFailures).toContain(
      'failedTests=1 exceeds tolerance 0',
    );
  });

  it('honors configured metric shortfall tolerance', () => {
    const step = {
      ...testStep('UNIT_TEST'),
      qualityGate: {
        metrics: { lineCoverage: 0.8 },
        tolerance: {
          metricShortfall: 0.05,
          maxFailedTests: 0,
          maxSkippedTests: 0,
          maxWarnings: 0,
        },
      },
    };
    const result = evaluateQualityGate(step, {
      metrics: { lineCoverage: 0.76 },
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['coverage report'],
      gaps: [],
    });
    expect(result.passed).toBe(true);
  });

  it('persists assessments and renders the project development report', async () => {
    const step = {
      ...testStep('CODE'),
      status: 'DONE' as const,
    };
    const store = new QualityAssessmentStore(workspace);
    const assessment = {
      completion: 1,
      upstreamAlignment: 1,
      metrics: {},
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['src/main.py'],
      gaps: [],
    };
    await store.record(step, 0, assessment, evaluateQualityGate(step, assessment));
    const historicalStep = {
      ...testStep('UNIT_TEST'),
      id: 'S005',
      iterationId: 'P0',
      status: 'DONE' as const,
    };
    const historicalAssessment = {
      metrics: {
        lineCoverage: 0.9,
        branchCoverage: 0.8,
        testCasePassRate: 1,
      },
      tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
      evidence: ['coverage/coverage-summary.json'],
      gaps: [],
    };
    await store.record(
      historicalStep,
      0,
      historicalAssessment,
      evaluateQualityGate(historicalStep, historicalAssessment),
    );
    const plan = planWith(step);
    const workTickets = new WorkTicketLifecycle(new TicketStore(workspace));
    await workTickets.registerExecutionGraph(plan);
    await workTickets.completeDelivery('P1');
    const reportPath = await generateProjectDevelopmentReport({
      workspace,
      plan,
      projectAudit: {
        ok: true,
        warnings: 0,
        errors: 0,
        checks: [{
          name: 'tests',
          severity: 'info',
          ok: true,
          summary: 'tests passed',
        }],
      },
      finalDelivery: true,
    });

    expect(reportPath).toBe(PROJECT_DEVELOPMENT_REPORT_PATH);
    const report = await workspace.readFile(reportPath);
    expect(report).toContain('Verdict: **DELIVERED**');
    expect(report).toContain('Project stage quality gates passed: 2/2');
    expect(report).toContain('| P0/S005 | UNIT_TEST | PASS |');
    expect(report).toContain('completion 100.0%/95.0%');
    expect(report).toContain('- Tasks: 0');
    expect(report).toContain('- Sub-tasks: 0');
    expect(report).toContain('PASS: tests - tests passed');
  });
});

function testStep(phase: Step['phase']): Step {
  return {
    id: 'S001',
    iterationId: 'P1',
    phase,
    title: phase,
    description: `Execute ${phase}`,
    systemPrompt: `Complete ${phase} and provide evidence.`,
    role: phase === 'REQUIREMENT_ANALYSIS'
      ? 'Planner'
      : phase === 'HIGH_LEVEL_DESIGN' || phase === 'DETAILED_DESIGN'
        ? 'Architect'
        : phase === 'CODE'
          ? 'Coder'
          : 'Tester',
    tools: [],
    inputs: [],
    outputs: [],
    dependsOn: [],
    acceptance: `${phase} passes`,
    status: 'PENDING',
    retries: 0,
    maxRetries: 3,
  };
}

function planWith(step: Step): Plan {
  return {
    version: '1',
    language: 'python',
    intent: 'greenfield',
    phaseId: 'P1',
    projectType: 'application',
    requirementDigest: 'quality report fixture',
    complexityAssessment: {
      level: 'simple',
      rationale: 'test fixture',
      splitRecommended: false,
      userForcedPhaseSplit: false,
    },
    implementationPhases: [{
      id: 'P1',
      title: 'Core',
      objective: 'Deliver core behavior',
      status: 'complete',
      scope: ['core'],
      deliverables: ['src/main.py'],
      dependsOn: [],
    }],
    globalPrompt: '',
    baselineSummary: '',
    userAddenda: '',
    createdAt: new Date().toISOString(),
    steps: [step],
  };
}
