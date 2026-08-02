import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Plan } from '../src/core/plan.js';
import { DomainExecutionEngine, type DomainEngineOptions } from '../src/application/execution/domain_engine.js';
import type { AttemptInput, AttemptResult } from '../src/application/execution/attempt_runner.js';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { QualityAssessmentService } from '../src/domain/quality/assessment_service.js';
import type { Step } from '../src/domain/steps/step.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { PluginHost } from '../src/plugins/host.js';
import { Workspace } from '../src/workspace/workspace.js';

describe('DomainExecutionEngine', () => {
  it('keeps infrastructure failures on the same Ticket without opening a Bug', async () => {
    const setup = await fixture();
    let first = true;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        if (first) {
          first = false;
          return {
            ok: false,
            failureKind: 'infrastructure',
            reason: 'all LLM providers failed for role Planner: status=429',
            failureLog: 'OpenAI-compatible provider request failed status=429',
            changedFiles: [],
            wikiEntryIds: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new DomainExecutionEngine(options(setup.workspace, setup.repository, runner), setup.plan);
    const failed = await engine.run(setup.graph.phases[0]!.id);

    expect(failed.failureReason).toContain('remains active for retry');
    const firstStep = await setup.repository.read(setup.graph.steps[0]!.id);
    const tickets = await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id });
    const story = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.stepId === firstStep.id);
    expect(firstStep.objectType === 'step' && firstStep.state).toBe('in_progress');
    expect(firstStep.objectType === 'step' && firstStep.attempts).toBe(0);
    expect(story?.objectType === 'ticket' && story.state).toBe('in_progress');
    expect(story?.objectType === 'ticket' && story.attempts).toBe(0);
    expect(tickets.some((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug')).toBe(false);

    const resumed = await engine.run(setup.graph.phases[0]!.id);
    expect(resumed.failedStepId, JSON.stringify(resumed)).toBeUndefined();
  });

  it('delivers an entire V-model from dependency-ready Tickets', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    const runner = passingRunner(setup.repository, calls);
    const engine = new DomainExecutionEngine(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    expect(result.projectDelivered).toBe(true);
    expect(calls).toEqual(setup.graph.steps.map((step) => `${step.name}:normal`));
    const project = await setup.repository.read(setup.graph.project.id);
    expect(project.objectType === 'project' && project.state).toBe('closed');
  });

  it('routes a test failure to Debug and propagates one CR through every downstream gate', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    const persistedWikiTickets: string[] = [];
    let failedUnit = false;
    const base = passingRunner(setup.repository, calls);
    const runner = {
      initialize: base.initialize,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        calls.push(`${input.domainStep.name}:${input.mode}`);
        if (input.domainStep.type === 'UNIT_TEST' && input.mode === 'normal' && !failedUnit) {
          failedUnit = true;
          return {
            ok: false,
            reason: 'unit contract failed',
            failureLog: 'expected source, received undefined',
            changedFiles: [],
            wikiEntryIds: [],
          };
        }
        const result = await passingAttempt(setup.repository, input.domainStep);
        return input.mode === 'debug' ? { ...result, wikiEntryIds: ['known-fix'] } : result;
      },
      recordVerifiedBugResolution: async (ticketId: string) => {
        calls.push(`wiki:${ticketId}`);
        persistedWikiTickets.push(ticketId);
      },
    };
    const engine = new DomainExecutionEngine(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    expect(calls).toContain('P1-S004:debug');
    expect(calls).toContain('P1-S005:change-request');
    expect(calls).toContain('P1-S008:change-request');
    const tickets = await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id });
    const bug = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug');
    const request = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.type === 'change-request');
    expect(bug?.objectType === 'ticket' && bug.state).toBe('closed');
    expect(request?.objectType === 'ticket' && request.state).toBe('closed');
    expect(bug?.objectType === 'ticket' && bug.type === 'bug' && bug.changelistIds).toHaveLength(1);
    const bugChange = bug?.objectType === 'ticket' && bug.type === 'bug'
      ? await setup.repository.read(bug.changelistIds[0]!)
      : undefined;
    expect(bugChange?.objectType === 'changelist' && bugChange.commit).toBe('commit-P1-S004');
    expect(persistedWikiTickets).toEqual([bug!.id]);
    expect(calls.findIndex((call) => call.startsWith('wiki:'))).toBeGreaterThan(
      calls.lastIndexOf('P1-S008:change-request'),
    );
  });

  it('turns a downstream CR failure into a linked Bug and resumes the parent CR after repair', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let failedUnit = false;
    let failedParentCr = false;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        calls.push(`${input.domainStep.name}:${input.mode}`);
        if (input.domainStep.type === 'UNIT_TEST' && input.mode === 'normal' && !failedUnit) {
          failedUnit = true;
          return {
            ok: false,
            reason: 'unit contract failed',
            failureLog: 'expected source, received undefined',
            changedFiles: [],
            wikiEntryIds: [],
          };
        }
        if (input.domainStep.type === 'INTEGRATION_TEST' && input.mode === 'change-request' && !failedParentCr) {
          failedParentCr = true;
          return {
            ok: false,
            reason: 'CR integration failed',
            failureLog: 'integration contract mismatch',
            changedFiles: [],
            wikiEntryIds: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new DomainExecutionEngine(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    const tickets = (await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }))
      .filter((ticket) => ticket.objectType === 'ticket');
    const bugs = tickets.filter((ticket) => ticket.type === 'bug');
    const requests = tickets.filter((ticket) => ticket.type === 'change-request');
    expect(bugs).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(bugs.every((ticket) => ticket.state === 'closed')).toBe(true);
    expect(requests.every((ticket) => ticket.state === 'closed')).toBe(true);
    const child = requests.find((ticket) => ticket.type === 'change-request' && ticket.parentChangeRequestId);
    expect(child?.type === 'change-request' && child.parentChangeRequestId).toBe(
      requests.find((ticket) => ticket.id !== child?.id)?.id,
    );
    expect(calls.filter((call) => call === 'P1-S006:change-request')).toHaveLength(3);
    expect(calls).toContain('P1-S003:debug');
  });

  it('routes a CR quality shortfall through a linked Enhancement instead of a Bug', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let failedUnit = false;
    let failedCrQuality = false;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        calls.push(`${input.domainStep.name}:${input.mode}`);
        if (input.domainStep.type === 'UNIT_TEST' && input.mode === 'normal' && !failedUnit) {
          failedUnit = true;
          return {
            ok: false,
            reason: 'unit behavior failed',
            failureLog: 'expected item, received undefined',
            changedFiles: [],
            wikiEntryIds: [],
          };
        }
        if (
          input.domainStep.type === 'UNIT_TEST' &&
          input.mode === 'change-request' &&
          !failedCrQuality
        ) {
          failedCrQuality = true;
          const assessment = await failingAssessment(setup.repository, input.domainStep);
          return {
            ok: false,
            reason: `Quality gate failed: ${assessment.gaps.join('; ')}`,
            failureLog: assessment.gaps.join('\n'),
            assessment,
            changedFiles: [],
            wikiEntryIds: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new DomainExecutionEngine(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    expect(calls).toContain('P1-S004:enhancement');
    const tickets = (await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }))
      .filter((ticket) => ticket.objectType === 'ticket');
    const bugs = tickets.filter((ticket) => ticket.type === 'bug');
    const enhancements = tickets.filter((ticket) => ticket.type === 'enhancement');
    expect(bugs).toHaveLength(1);
    expect(enhancements).toHaveLength(1);
    expect(enhancements[0]?.state).toBe('closed');
    const childRequest = tickets.find((ticket) =>
      ticket.type === 'change-request' && ticket.sourceTicketId === enhancements[0]?.id,
    );
    expect(childRequest?.type === 'change-request' && childRequest.parentChangeRequestId).toBeTruthy();
  });
});

function options(
  workspace: Workspace,
  repository: DomainObjectRepository,
  attemptRunner: DomainEngineOptions['attemptRunner'],
): DomainEngineOptions {
  return {
    workspace,
    repository,
    attemptRunner,
    plugins: new PluginHost(),
    git: {
      ensureRepo: async () => undefined,
    } as DomainEngineOptions['git'],
    sandbox: {} as DomainEngineOptions['sandbox'],
    router: {} as DomainEngineOptions['router'],
    audit: { event: async () => undefined } as unknown as DomainEngineOptions['audit'],
  };
}

function passingRunner(repository: DomainObjectRepository, calls: string[]) {
  return {
    initialize: async () => undefined,
    run: async (input: AttemptInput): Promise<AttemptResult> => {
      calls.push(`${input.domainStep.name}:${input.mode}`);
      return passingAttempt(repository, input.domainStep);
    },
  };
}

async function passingAttempt(repository: DomainObjectRepository, step: Step): Promise<AttemptResult> {
  const kpis = await Promise.all(step.kpiIds.map((id) => repository.read(id)));
  const assessment = await new QualityAssessmentService(repository).assessStep({
    step,
    metrics: kpis.flatMap((object) => object.objectType === 'kpi'
      ? [{ metric: object.metric, value: 1 }]
      : []),
    evidence: ['test evidence'],
  });
  return {
    ok: true,
    assessment,
    changedFiles: step.outputs,
    commit: `commit-${step.name}`,
    solutionPlan: `Complete ${step.name} incrementally.`,
    wikiEntryIds: [],
  };
}

async function failingAssessment(repository: DomainObjectRepository, step: Step) {
  const kpis = await Promise.all(step.kpiIds.map((id) => repository.read(id)));
  return new QualityAssessmentService(repository).assessStep({
    step,
    metrics: kpis.flatMap((object, index) => object.objectType === 'kpi'
      ? [{ metric: object.metric, value: index === 0 ? 0 : 1 }]
      : []),
    evidence: ['quality measurement evidence'],
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-domain-engine-'));
  const workspace = new Workspace(root);
  const repository = new DomainObjectRepository(workspace);
  await repository.load();
  const plan = samplePlan();
  const graph = compileProjectGraph({ draft: plan, topic: 'Build a TS service.', projectName: 'service' });
  await repository.persistCompiledGraph(graph);
  return { workspace, repository, plan, graph };
}

function samplePlan(): Plan {
  const phases = [
    ['REQUIREMENT_ANALYSIS', 'Planner'], ['HIGH_LEVEL_DESIGN', 'Architect'],
    ['DETAILED_DESIGN', 'Architect'], ['CODE', 'Coder'], ['UNIT_TEST', 'Tester'],
    ['INTEGRATION_TEST', 'Tester'], ['MODULE_TEST', 'Tester'], ['FUNCTIONAL_TEST', 'Tester'],
  ] as const;
  return {
    version: '1', language: 'typescript', intent: 'greenfield', phaseId: 'P1', projectType: 'application',
    requirementDigest: 'Build a service.',
    complexityAssessment: { level: 'simple', rationale: 'one phase', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Deliver core.', status: 'current', scope: ['core'],
      deliverables: ['src/main.ts'], dependsOn: [],
      verificationGate: { summary: 'All gates pass.', checks: ['acceptance'], failurePolicy: 'Open a Bug.' },
    }],
    globalPrompt: 'Implement.', baselineSummary: '', dependencies: [], userAddenda: '', createdAt: new Date().toISOString(),
    steps: phases.map(([phase, role], index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase,
      title: phase, description: `Execute ${phase}.`, systemPrompt: `Execute ${phase}.`, role,
      tools: ['read_file'], inputs: [], outputs: [`artifact-${index + 1}`], subTasks: [],
      dependsOn: index ? [`S${String(index).padStart(3, '0')}`] : [], acceptance: `${phase} passes.`,
      maxAttempts: 4,
    })),
  };
}
