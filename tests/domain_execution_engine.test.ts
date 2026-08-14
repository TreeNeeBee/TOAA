import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Plan } from '../src/core/plan.js';
import { ProjectOrchestrator, type ProjectOrchestratorOptions } from '../src/application/project_management/orchestrator.js';
import type { AttemptInput, AttemptResult } from '../src/application/execution/attempt_runner.js';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { QualityAssessmentService } from '../src/application/execution/quality_assessment_service.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import type { Step } from '../src/domain/steps/step.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { FileProjectProjectionWriter } from '../src/infrastructure/projections/file_project_projection.js';
import { PluginHost } from '../src/plugins/host.js';
import { Workspace } from '../src/workspace/workspace.js';
import { reviseActor } from '../src/domain/project_management/index.js';
import { VALIDATION_CONTRACT_DEFECT_CODE } from '../src/domain/tickets/ticket.js';

describe('ProjectOrchestrator', () => {
  it('returns cancelled attempt capacity to PM without opening a project defect', async () => {
    const setup = await fixture();
    const cancelled = new Error('CLI task cancelled by SIGINT');
    cancelled.name = 'AbortError';
    const runner = {
      initialize: async () => undefined,
      run: async (): Promise<AttemptResult> => { throw cancelled; },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);

    await expect(engine.run(setup.graph.phases[0]!.id)).rejects.toBe(cancelled);

    const firstStep = await setup.repository.read(setup.graph.steps[0]!.id);
    const tickets = await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id });
    const story = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.stepId === firstStep.id);
    expect(firstStep.objectType === 'step' && firstStep.state).toBe('pending');
    expect(firstStep.objectType === 'step' && firstStep.attempts).toBe(0);
    expect(story?.objectType === 'ticket' && story.state).toBe('pending');
    expect(story?.objectType === 'ticket' && story.attempts).toBe(0);
    expect(tickets.some((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug')).toBe(false);
  });

  it('keeps infrastructure failures on the same Ticket without opening a Bug', async () => {
    const setup = await fixture();
    const projectionWriter = new FileProjectProjectionWriter(setup.workspace);
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
            testOutcomes: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator({
      ...options(setup.workspace, setup.repository, runner),
      projectionWriter,
    }, setup.plan);
    const failed = await engine.run(setup.graph.phases[0]!.id);

    expect(failed.failureReason).toContain('is pending for retry');
    const firstStep = await setup.repository.read(setup.graph.steps[0]!.id);
    const tickets = await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id });
    const story = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.stepId === firstStep.id);
    expect(firstStep.objectType === 'step' && firstStep.state).toBe('pending');
    expect(firstStep.objectType === 'step' && firstStep.attempts).toBe(0);
    expect(story?.objectType === 'ticket' && story.state).toBe('pending');
    expect(story?.objectType === 'ticket' && story.attempts).toBe(0);
    expect(tickets.some((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug')).toBe(false);
    const projection = await projectionWriter.read(setup.graph.project.id);
    expect(projection?.activeTickets.find((ticket) => ticket.id === story?.id)?.state).toBe('pending');

    const resumed = await engine.run(setup.graph.phases[0]!.id);
    expect(resumed.failedStepId, JSON.stringify(resumed)).toBeUndefined();
  });

  it('hands each attempt the provider binding of the actor that was assigned the work', async () => {
    const setup = await fixture();
    const developer = setup.graph.actors.find((actor) => actor.role === 'developer')!;
    await setup.repository.update(reviseActor(developer, {
      llmBinding: { providerPool: ['bound_provider'] },
    }));
    const seen = new Map<string, readonly string[] | undefined>();
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        seen.set(input.domainStep.name, input.assignee?.actor.llmBinding?.providerPool);
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    await engine.run(setup.graph.phases[0]!.id);

    const steps = await Promise.all(setup.graph.steps.map((step) => setup.repository.read(step.id)));
    const developerSteps = steps.filter((step) => step.objectType === 'step' && step.role === 'developer');
    expect(developerSteps.length).toBeGreaterThan(0);
    for (const step of developerSteps) {
      expect(seen.get(step.name), step.name).toEqual(['bound_provider']);
    }
    // Every other role is unbound, so nothing overrides the configured pool for their attempts.
    for (const step of steps) {
      if (step.objectType !== 'step' || step.role === 'developer') continue;
      expect(seen.get(step.name), step.name).toBeUndefined();
    }
  });

  it('rolls back to HIGH_LEVEL_DESIGN when a Step reports a package it does not own', async () => {
    // A Step needing a dependency has not produced a defect. Opening a Bug would ask the wrong role
    // to repair the wrong artifact; the need belongs to the design that owns the whole set.
    const setup = await fixture();
    const design = setup.graph.steps.find((step) => step.type === 'HIGH_LEVEL_DESIGN')!;
    const coding = setup.graph.steps.find((step) => step.type === 'CODE')!;
    let asked = false;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        if (input.domainStep.id === coding.id && !asked) {
          asked = true;
          return {
            ok: false,
            reason: 'needs packages',
            failureLog: 'add_dependency is owned by HIGH_LEVEL_DESIGN',
            dependencyRequest: { packages: ['zod'], reason: 'schema validation' },
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    await engine.run(setup.graph.phases[0]!.id);

    expect(asked).toBe(true);
    const tickets = await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id });
    const dependency = tickets.find((ticket) =>
      ticket.objectType === 'ticket' && ticket.type === 'change-request' && ticket.name.startsWith('DEP-'));
    expect(dependency, tickets.map((t) => t.objectType === 'ticket' ? t.name : '').join(',')).toBeDefined();
    // It targets the design, not the Step that asked, and no Bug was opened for it.
    expect(dependency?.objectType === 'ticket' && dependency.type === 'change-request'
      && dependency.targetStepId).toBe(design.id);
    expect(tickets.some((t) => t.objectType === 'ticket' && t.type === 'bug')).toBe(false);
  });

  it('delivers an entire V-model from dependency-ready Tickets', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    const runner = passingRunner(setup.repository, calls);
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify({ result, calls })).toBeUndefined();
    expect(result.projectDelivered).toBe(true);
    expect(calls).toEqual(setup.graph.steps.map((step) => `${step.name}:normal`));
    const project = await setup.repository.read(setup.graph.project.id);
    expect(project.objectType === 'project' && project.state).toBe('closed');
  });

  it('routes every Phase delivery finding as its own Ticket and keeps dependencies separate', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let gateRuns = 0;
    const base = options(setup.workspace, setup.repository, passingRunner(setup.repository, calls));
    const engine = new ProjectOrchestrator({
      ...base,
      finalGate: async () => {
        gateRuns += 1;
        if (gateRuns > 1) return { ok: true, evidence: ['all corrected delivery checks pass'] };
        return {
          ok: false,
          reason: 'Phase delivery found three independent problems.',
          evidence: ['live acceptance and deliverable audit failed'],
          findings: [
            {
              category: 'product-defect' as const,
              summary: 'The live entrypoint returns an invalid payload.',
              evidence: ['expected source:string, received undefined'],
              target: 'code' as const,
              dependencyPackages: [],
            },
            {
              category: 'test-incomplete' as const,
              summary: 'The functional baseline omits the empty-response scenario.',
              evidence: ['requirement R-12 has no executable case'],
              target: 'requirement-analysis' as const,
              dependencyPackages: [],
            },
            {
              category: 'dependency' as const,
              summary: 'Schema validation requires the declared package.',
              evidence: ['Cannot resolve package zod'],
              target: 'high-level-design' as const,
              dependencyPackages: ['zod'],
            },
          ],
        };
      },
    }, setup.plan);

    const result = await engine.run(setup.graph.phases[0]!.id);
    expect(result.failedStepId, JSON.stringify({ result, calls })).toBeUndefined();
    expect(gateRuns).toBeGreaterThanOrEqual(2);
    const tickets = (await setup.repository.list({
      objectType: 'ticket',
      projectId: setup.graph.project.id,
    })).filter((ticket) => ticket.objectType === 'ticket');
    expect(tickets.filter((ticket) => ticket.type === 'bug' &&
      ticket.description.includes('invalid payload'))).toHaveLength(1);
    expect(tickets.filter((ticket) => ticket.type === 'enhancement' &&
      ticket.description.includes('empty-response scenario'))).toHaveLength(1);
    expect(tickets.filter((ticket) => ticket.type === 'change-request' &&
      ticket.name.startsWith('DEP-') &&
      ticket.description.includes('Schema validation'))).toHaveLength(1);
    const actors = (await setup.repository.list({
      objectType: 'actor-registration',
      projectId: setup.graph.project.id,
    })).filter((actor) => actor.objectType === 'actor-registration');
    const pm = actors.find((actor) => actor.role === 'project-manager');
    expect(pm).toBeDefined();
    const intakeTickets = tickets.filter((ticket) => ticket.source.kind === 'pm-intake');
    expect(intakeTickets.length).toBeGreaterThanOrEqual(3);
    expect(intakeTickets.every((ticket) => ticket.creatorActorId === pm?.id)).toBe(true);
    const phaseAssessments = (await setup.repository.list({
      objectType: 'quality-assessment',
      projectId: setup.graph.project.id,
    })).filter((object) => object.objectType === 'quality-assessment' &&
      object.subject.objectType === 'phase');
    expect(phaseAssessments.some((assessment) => !assessment.passed && assessment.findings.length === 3))
      .toBe(true);
    expect(phaseAssessments.some((assessment) => assessment.passed)).toBe(true);
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
        if (input.domainStep.type === 'INTEGRATION_TEST' && input.mode === 'change-request') {
          const tickets = await setup.repository.list({
            objectType: 'ticket',
            projectId: setup.graph.project.id,
          });
          const sourceBug = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug');
          expect(sourceBug?.objectType === 'ticket' && sourceBug.state).toBe('pending');
          const activeRequest = tickets.find((ticket) =>
            ticket.objectType === 'ticket' &&
            ticket.type === 'change-request' &&
            ticket.targetStepId === input.domainStep.id &&
            ticket.state !== 'closed');
          const failedStory = tickets.find((ticket) =>
            ticket.objectType === 'ticket' &&
            ticket.type === 'story' &&
            ticket.stepId === setup.graph.steps.find((step) => step.type === 'UNIT_TEST')!.id);
          expect(activeRequest?.objectType).toBe('ticket');
          expect(failedStory?.objectType === 'ticket' && failedStory.blockedByTicketIds).toContain(activeRequest!.id);
        }
        if (input.domainStep.type === 'UNIT_TEST' && input.mode === 'normal' && !failedUnit) {
          failedUnit = true;
          return {
            ok: false,
            reason: 'unit contract failed',
            failureLog: 'expected source, received undefined',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        const result = await passingAttempt(setup.repository, input.domainStep);
        if (input.mode === 'debug') return { ...result, wikiEntryIds: ['known-fix'] };
        // A downstream owner can verify that the CR requires no local file edit. This no-op is an
        // application record, not permission to skip the remaining V-model gates.
        if (input.mode === 'change-request' && input.domainStep.type === 'UNIT_TEST') {
          return { ...result, changedFiles: [], commit: undefined };
        }
        return result;
      },
      recordVerifiedBugResolution: async (ticketId: string) => {
        calls.push(`wiki:${ticketId}`);
        persistedWikiTickets.push(ticketId);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
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
    const rootRequests = tickets.filter((ticket) =>
      ticket.type === 'change-request' && ticket.sourceTicketId === bug!.id,
    );
    expect(rootRequests.length).toBeGreaterThan(1);
    // Every hop descends from the same Bug, but each carries the change it must check rather than a
    // copy of the repair that started the chain: a downstream Step handed "create the requirement
    // analysis docs" owns none of those files, has nothing to do, and stalls for no progress.
    for (const hop of rootRequests) {
      expect(hop.type === 'change-request' && hop.contractDelta.affectedArtifacts.length)
        .toBeGreaterThan(0);
    }
    const hops = rootRequests.filter((ticket) => ticket.type === 'change-request');
    const downstream = hops.filter((hop) => hop.parentChangeRequestId);
    expect(downstream.length).toBeGreaterThan(0);
    for (const hop of downstream) {
      expect(hop.type === 'change-request' && hop.implementationPlan.join(' '))
        .toContain('against the accepted change');
    }
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

  // A live run produced six validation-contract Bugs against one Change Request that never closed.
  // The first contradiction is a finding — the verifier disproved the diagnosis and the original
  // failed gate still needs repair. A second contradiction of the same CR is the same verifier
  // disproving the same premise again; escalating it opens another Bug that resolves nothing, and
  // each carried slightly different evidence text so the recurrence breaker never saw a repeat.
  it('escalates a contradicted diagnosis once, not on every re-application', async () => {
    const { AttemptResultProcessor } = await import(
      '../src/application/project_management/attempt_result_processor.js'
    );
    const { VALIDATION_CONTRACT_DEFECT_CODE } = await import('../src/domain/tickets/ticket.js');
    const changeRequestId = 'cr-1';
    const contradiction = {
      objectType: 'ticket',
      type: 'bug',
      parentTicketId: changeRequestId,
      failure: { code: VALIDATION_CONTRACT_DEFECT_CODE },
    };
    const build = (stored: unknown[]) => {
      const processor = new AttemptResultProcessor({
        repository: { list: async () => stored } as never,
        controller: {} as never,
        tickets: {} as never,
        audit: { event: async () => undefined } as never,
        onTransition: async () => undefined,
      });
      return processor as unknown as {
        alreadyContradicted(ticket: { id: string; projectId: string }): Promise<boolean>;
      };
    };
    const ticket = { id: changeRequestId, projectId: 'p1' };

    // Nothing recorded yet: the first contradiction is a finding and must escalate.
    expect(await build([]).alreadyContradicted(ticket)).toBe(false);
    // A contradiction against a *different* Change Request says nothing about this one.
    expect(await build([{ ...contradiction, parentTicketId: 'cr-2' }]).alreadyContradicted(ticket))
      .toBe(false);
    // An ordinary Bug on this CR is not a contradiction of its diagnosis.
    expect(await build([{ ...contradiction, failure: { code: 'test_failure' } }])
      .alreadyContradicted(ticket)).toBe(false);
    // The same premise disproved a second time is evidence, not a new finding.
    expect(await build([contradiction]).alreadyContradicted(ticket)).toBe(true);
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
            testOutcomes: [],
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
            testOutcomes: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    const tickets = (await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }))
      .filter((ticket) => ticket.objectType === 'ticket');
    const bugs = tickets.filter((ticket) => ticket.type === 'bug');
    const requests = tickets.filter((ticket) => ticket.type === 'change-request');
    const stepIds = (...names: string[]) =>
      names.map((name) => setup.graph.steps.find((step) => step.name === name)!.id).sort();
    const targetsOf = (sourceTicketId: string) => requests
      .filter((ticket) => ticket.type === 'change-request' && ticket.sourceTicketId === sourceTicketId)
      .map((ticket) => (ticket.type === 'change-request' ? ticket.targetStepId : ''))
      .sort();

    expect(bugs).toHaveLength(2);
    expect(bugs.every((ticket) => ticket.state === 'closed')).toBe(true);
    expect(requests.every((ticket) => ticket.state === 'closed')).toBe(true);

    // The Bug raised while a Change Request was being applied attaches to that CR, not to the
    // Story of the Step it failed on.
    const failedRequest = requests.find((ticket) =>
      ticket.type === 'change-request' && ticket.targetStepId === stepIds('P1-S006')[0])!;
    const repairBug = bugs.find((ticket) => ticket.parentTicketId === failedRequest.id);
    expect(repairBug, 'the downstream CR failure opens a Bug attached to that CR').toBeDefined();

    // Each chain advances one Step at a time, and the two chains here do not overlap. The Bug at
    // the head walks the rest of the V-model. The repair chain stops at S005, where it meets the
    // CR it was repairing: that CR resumes and applies S006 itself, carrying the repair onward,
    // rather than the Step being handed the same delta by both chains.
    const rootBug = bugs.find((ticket) => ticket.id !== repairBug!.id)!;
    expect(targetsOf(rootBug.id)).toEqual(stepIds('P1-S005', 'P1-S006', 'P1-S007', 'P1-S008'));
    expect(targetsOf(repairBug!.id)).toEqual(stepIds('P1-S004', 'P1-S005'));

    // S006 is attempted twice: the application that failed, and the one after the repair landed.
    expect(calls.filter((call) => call === 'P1-S006:change-request')).toHaveLength(2);
    expect(calls).toContain('P1-S003:debug');
    // The corrective Ticket owns the S003 repair. Closing it must not leave the ordinary Story
    // reopened and schedule a second full detailed-design pass before the parent CR resumes.
    expect(calls.filter((call) => call === 'P1-S003:normal')).toHaveLength(1);
  });

  it('routes a CR diagnosis contradiction from its discoverer back through the original failed gate', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let failedFunctional = false;
    let reportedContradiction = false;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        calls.push(`${input.domainStep.name}:${input.mode}`);
        if (input.domainStep.type === 'FUNCTIONAL_TEST' && input.mode === 'normal' && !failedFunctional) {
          failedFunctional = true;
          return {
            ok: false,
            reason: 'functional CLI acceptance failed',
            failureLog: 'npm test exit=1 args=tests/functional/cli.test.ts',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        if (input.domainStep.type === 'CODE' && input.mode === 'change-request' && !reportedContradiction) {
          reportedContradiction = true;
          return {
            ok: false,
            reason: 'validation defect reported: the CR diagnosis is contradicted by current files',
            failureLog: 'src/cli.ts exists; the functional test calls live HTTP without deterministic fixtures',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
            executor: {
              success: false,
              rounds: 1,
              toolCalls: [],
              validationDefect: 'The CR premise is false; the functional test must isolate live HTTP.',
              metrics: {
                rounds: 1,
                parseFailures: 0,
                repeatedTurns: 0,
                toolFailRatio: 0,
                progressRatio: 1,
                healthScore: 1,
                providers: ['test'],
              },
            },
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    const tickets = (await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }))
      .filter((ticket) => ticket.objectType === 'ticket');
    const bugs = tickets.filter((ticket) => ticket.type === 'bug');
    const discovered = bugs.find((ticket) => ticket.description.includes('CR premise is false'));
    const requirement = setup.graph.steps.find((step) => step.type === 'REQUIREMENT_ANALYSIS')!;
    const functional = setup.graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;

    expect(bugs).toHaveLength(2);
    expect(discovered?.type).toBe('bug');
    expect(discovered?.type === 'bug' && discovered.failure.failedStepId).toBe(functional.id);
    expect(discovered?.type === 'bug' && discovered.failure.targetStepId).toBe(requirement.id);
    expect(discovered?.type === 'bug' && discovered.failure.category).toBe('contract');
    expect(discovered?.type === 'bug' && discovered.failure.code).toBe(VALIDATION_CONTRACT_DEFECT_CODE);
    expect(discovered?.type === 'bug' && discovered.failure.details?.originFailureCode).toBe('unclassified_execution_failure');
    expect(discovered?.parentTicketId).toBeDefined();
    expect(calls.filter((call) => call === 'P1-S001:debug')).toHaveLength(2);
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
            testOutcomes: [],
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
            testOutcomes: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    expect(calls).toContain('P1-S004:enhancement');
    const tickets = (await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }))
      .filter((ticket) => ticket.objectType === 'ticket');
    const bugs = tickets.filter((ticket) => ticket.type === 'bug');
    const enhancements = tickets.filter((ticket) => ticket.type === 'enhancement');
    const requests = tickets.filter((ticket) => ticket.type === 'change-request');
    expect(bugs).toHaveLength(1);
    expect(enhancements).toHaveLength(1);
    expect(enhancements[0]?.state).toBe('closed');
    expect(requests.every((ticket) => ticket.state === 'closed')).toBe(true);

    // The shortfall attaches to the Change Request whose gate rejected it, which is what makes it
    // that CR's own quality debt rather than a defect against the Step's Story.
    expect(requests.some((ticket) => ticket.id === enhancements[0]?.parentTicketId)).toBe(true);

    // It opens no chain of its own. The CR it repairs is parked on the very Step the repair would
    // propagate to, and resumes to re-apply that Step carrying the repair — so the Step is never
    // handed the same delta by two chains at once.
    expect(requests.some((ticket) =>
      ticket.type === 'change-request' && ticket.sourceTicketId === enhancements[0]?.id)).toBe(false);
    expect(calls.filter((call) => call === 'P1-S005:change-request')).toHaveLength(2);
  });
});

  // The merge gate judges the merged result; a Step's own attempt judges its worktree. A gate that
  // says the merged project is broken has discovered a defect, and halting the run left the one
  // finding that most clearly describes a broken project with nowhere to go.
  it('turns a failing merge gate into a Bug instead of halting the run', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let gateFailures = 0;
    const base = options(setup.workspace, setup.repository, passingRunner(setup.repository, calls));
    const engine = new ProjectOrchestrator({
      ...base,
      integrateTicket: async () => {
        // Only the first delivery is rejected; the repair must be able to land afterwards.
        if (gateFailures > 0) return { status: 'merged' };
        gateFailures += 1;
        return {
          status: 'failed',
          reason: 'merge gate failed for ticket/code',
          failureLog: 'tests: tests exited 1\nsrc/cli.ts is not defined',
        };
      },
    }, setup.plan);
    const outcome = await engine.run(setup.graph.phases[0]!.id);

    const tickets = await setup.repository.list({
      objectType: 'ticket',
      projectId: setup.graph.project.id,
    });
    const bug = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug');
    expect(bug, tickets.map((t) => (t.objectType === 'ticket' ? `${t.name}:${t.type}` : '')).join(',')).toBeDefined();
    // The gate's own checks are the evidence; PM routes, it does not author the finding.
    expect(JSON.stringify(bug)).toContain('src/cli.ts is not defined');
    expect(outcome.failureReason ?? '').not.toContain('merge gate failed');
  });

  it('stops before downstream execution when merge authorization is missing', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    const notes: Array<Record<string, unknown>> = [];
    const base = options(setup.workspace, setup.repository, passingRunner(setup.repository, calls));
    const engine = new ProjectOrchestrator({
      ...base,
      audit: {
        event: async (_kind: string, message: string, fields: Record<string, unknown>) => {
          notes.push({ message, ...fields });
        },
      } as never,
      integrateTicket: async () => ({
        status: 'awaiting-authorization',
        reason: 'this repository already existed when XCompiler was pointed at it',
      }),
    }, setup.plan);
    const outcome = await engine.run(setup.graph.phases[0]!.id);

    expect(outcome.failureReason).toContain('already existed');
    expect(calls).toHaveLength(1);
    const recorded = notes.filter((note) => note.messageId === 'domain.merge_awaiting_authorization');
    expect(recorded.length).toBeGreaterThan(0);
    expect(String(recorded[0]!.reason)).toContain('already existed');
  });

function options(
  workspace: Workspace,
  repository: DomainObjectRepository,
  attemptRunner: ProjectOrchestratorOptions['attemptRunner'],
): ProjectOrchestratorOptions {
  return {
    workspace,
    repository,
    attemptRunner,
    plugins: new PluginHost(),
    git: {
      ensureRepo: async () => undefined,
    } as ProjectOrchestratorOptions['git'],
    sandbox: {} as ProjectOrchestratorOptions['sandbox'],
    router: {} as ProjectOrchestratorOptions['router'],
    audit: { event: async () => undefined } as unknown as ProjectOrchestratorOptions['audit'],
    requestPermission: async () => ({ approved: true }),
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
    testOutcomes: [],
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
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
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
      tools: ['read_file'], inputs: [], outputs: [`artifact-${index + 1}`],
      subTasks: index === 6
        ? [{
            id: 'M001',
            title: 'Validate module contract',
            description: 'Run the module-level contract checks.',
            acceptance: 'Module contract passes.',
          }]
        : [],
      dependsOn: index ? [`S${String(index).padStart(3, '0')}`] : [], acceptance: `${phase} passes.`,
      maxAttempts: 4,
    })),
  };
}
