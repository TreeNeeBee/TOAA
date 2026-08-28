import { describe, expect, it } from 'vitest';
import type { AttemptResult } from '../src/application/execution/attempt_runner.js';
import {
  AttemptResultProcessor,
  correctiveAffectedArtifacts,
  isAgentExecutionStall,
  renderFindingMessage,
} from '../src/application/project_management/attempt_result_processor.js';
import type { Step } from '../src/domain/steps/step.js';

describe('correctiveAffectedArtifacts', () => {
  it('carries exact downstream outputs named by the Bug resolution into the CR', () => {
    const requirement = {
      type: 'REQUIREMENT_ANALYSIS',
      outputs: ['docs/01-requirement-analysis.md'],
    } as Step;
    const code = {
      type: 'CODE',
      outputs: ['src/cli.ts', 'src/reporter.ts'],
    } as Step;
    const result = {
      changedFiles: [],
      solutionPlan: 'The executable entry in src/cli.ts must be implemented by CODE.',
      bugResolutionDisposition: {
        outcome: 'deferred',
        reasonCategory: 'downstream-owned',
        rationale: 'The inspected executable entrypoint belongs to the downstream CODE Step.',
        affectedArtifacts: ['src/cli.ts'],
        evidence: ['src/cli.ts was inspected from the current workspace'],
      },
    } as AttemptResult;

    expect(correctiveAffectedArtifacts([requirement, code], requirement, result)).toEqual([
      'src/cli.ts',
    ]);
  });

  it('uses the current Step outputs when no downstream artifact was identified', () => {
    const requirement = {
      type: 'REQUIREMENT_ANALYSIS',
      outputs: ['docs/01-requirement-analysis.md'],
    } as Step;
    const result = { changedFiles: [] } as AttemptResult;

    expect(correctiveAffectedArtifacts([requirement], requirement, result)).toEqual([
      'docs/01-requirement-analysis.md',
    ]);
  });

  it('uses the baseline-test-only scope at the production propagation call site', async () => {
    const propagated: Array<Record<string, unknown>> = [];
    const requirement = {
      id: 'requirement-step',
      name: 'P1-S001',
      type: 'REQUIREMENT_ANALYSIS',
      projectId: 'project-id',
      phaseId: 'phase-id',
      outputs: ['docs/01-requirements.md', 'tests/functional/baseline.test.ts'],
      pairedStepId: 'functional-step',
    } as Step;
    const design = {
      id: 'design-step', name: 'P1-S002', type: 'HIGH_LEVEL_DESIGN',
      projectId: 'project-id', phaseId: 'phase-id', outputs: ['docs/02-design.md'],
    } as Step;
    const code = {
      id: 'code-step', name: 'P1-S004', type: 'CODE',
      projectId: 'project-id', phaseId: 'phase-id', outputs: ['src/main.ts'],
    } as Step;
    const functional = {
      id: 'functional-step', name: 'P1-S008', type: 'FUNCTIONAL_TEST',
      projectId: 'project-id', phaseId: 'phase-id', outputs: ['reports/functional.md'],
    } as Step;
    const processor = new AttemptResultProcessor({
      repository: {
        // The propagation scope is language-dependent, so the call site reads the Project.
        read: async (id: string) => id === 'project-id'
          ? { objectType: 'project', id, language: 'typescript' }
          : undefined,
        list: async () => [],
        commit: async () => {},
      },
      controller: {
        propagateCorrectiveChange: async (input: Record<string, unknown>) => {
          propagated.push(input);
          return undefined;
        },
      },
      tickets: {},
      audit: { event: async () => {} },
      onTransition: async () => {},
    } as never);

    await processor.process({
      phase: { id: 'phase-id' } as never,
      work: {
        step: requirement,
        ticket: {
          id: 'bug-id',
          name: 'BUG-P1-001',
          type: 'bug',
          description: 'The functional baseline has a bad assertion.',
          acceptance: ['The paired baseline passes.'],
          source: { correlationId: 'correlation-id' },
        },
      } as never,
      steps: [requirement, design, code, functional],
      result: {
        ok: true,
        assessment: { id: 'assessment-id', evidence: ['baseline rewritten'] },
        changedFiles: ['tests/functional/baseline.test.ts'],
        changes: [],
        solutionPlan: 'Correct the functional baseline assertion.',
        wikiEntryIds: [],
        testOutcomes: [],
        gateFindings: [],
      } as never,
    });

    expect(propagated).toHaveLength(1);
    expect(propagated[0]?.affectedStepIds).toEqual(['functional-step']);
  });
});

describe('renderFindingMessage', () => {
  it('does not repeat evidence that is already contained in the finding summary', () => {
    const detail = 'tests/functional/acceptance.test.ts directly awaits loadConfig without isolation';
    expect(renderFindingMessage(
      `Paired baseline test contract is incomplete: ${detail}`,
      [detail, 'Rewrite the invalid test against the declared product module.'],
    )).toBe([
      `Paired baseline test contract is incomplete: ${detail}`,
      'Rewrite the invalid test against the declared product module.',
    ].join('\n'));
  });

  it('keeps independent evidence in discovery order', () => {
    expect(renderFindingMessage('Module contract failed', ['exit=1', 'src/main.ts:42']))
      .toBe('Module contract failed\nexit=1\nsrc/main.ts:42');
  });
});

describe('corrective routing evidence', () => {
  it('carries the preserved workspace and exact finding artifacts into an Enhancement', async () => {
    const { AttemptResultProcessor } = await import(
      '../src/application/project_management/attempt_result_processor.js');
    const routed: Array<Record<string, unknown>> = [];
    const binding = {
      kind: 'ticket',
      relativePath: 'worktrees/tickets/source',
      branch: 'xcompiler/ticket/source',
      revision: 'a'.repeat(40),
      changeSetId: 'changeset-id',
      workspaceId: 'workspace-id',
      reason: 'change-set',
      boundAt: new Date(0).toISOString(),
    } as const;
    const processor = new AttemptResultProcessor({
      repository: {
        // The propagation scope is language-dependent, so the call site reads the Project.
        read: async (id: string) => id === 'project-id'
          ? { objectType: 'project', id, language: 'typescript' }
          : undefined,
        list: async () => [],
        commit: async () => {},
      },
      controller: {
        routeQualityGap: async (input: Record<string, unknown>) => {
          routed.push(input);
          return {
            id: 'enhancement-id',
            type: 'enhancement',
            source: { correlationId: 'correlation-id' },
          };
        },
      },
      tickets: {
        ownerActorId: async () => 'actor-id',
        registerGateBatch: async () => [],
      },
      audit: { event: async () => {} },
      onTransition: async () => {},
    } as never);
    const step = {
      id: 'step-id',
      name: 'P1-S002',
      type: 'HIGH_LEVEL_DESIGN',
      projectId: 'project-id',
    } as Step;
    const work = {
      step,
      ticket: {
        id: 'story-id',
        name: 'P1-S002-STORY',
        type: 'story',
        source: { correlationId: 'correlation-id' },
      },
    };
    await processor.process({
      phase: { id: 'phase-id' } as never,
      work: work as never,
      steps: [step],
      result: {
        ok: false,
        changedFiles: ['tests/modules/domain.test.ts'],
        workspaceBinding: binding as never,
        wikiEntryIds: [],
        testOutcomes: [],
        gateFindings: [{
          category: 'test-incomplete',
          code: 'module_baseline_source_missing',
          summary: 'The module baseline omits the declared source.',
          evidence: ['tests/modules/domain.test.ts exercises 0/1 sources'],
          target: 'current-step',
          affectedArtifacts: ['tests/modules/domain.test.ts'],
          dependencyPackages: [],
        }],
      },
    });

    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      affectedArtifacts: ['tests/modules/domain.test.ts'],
      workspaceBinding: binding,
    });
  });

  it('keeps findings with different machine codes as independent routed Tickets', async () => {
    const routed: Array<Record<string, unknown>> = [];
    const registered: string[][] = [];
    const processor = new AttemptResultProcessor({
      repository: {
        // The propagation scope is language-dependent, so the call site reads the Project.
        read: async (id: string) => id === 'project-id'
          ? { objectType: 'project', id, language: 'typescript' }
          : undefined,
        list: async () => [],
        commit: async () => {},
      },
      controller: {
        routeFailure: async (input: Record<string, unknown>) => {
          routed.push(input);
          return {
            id: `bug-${routed.length}`,
            type: 'bug',
            source: { correlationId: 'correlation-id' },
          };
        },
      },
      tickets: {
        ownerActorId: async () => 'actor-id',
        registerGateBatch: async (ids: string[]) => {
          registered.push(ids);
          return [];
        },
      },
      audit: { event: async () => {} },
      onTransition: async () => {},
    } as never);
    const step = {
      id: 'step-id', name: 'P1-S004', type: 'CODE', projectId: 'project-id', phaseId: 'phase-id',
    } as Step;
    const finding = {
      category: 'product-defect' as const,
      summary: 'The generated contract is incomplete.',
      evidence: ['The public result omits one required field.'],
      target: 'current-step' as const,
      affectedArtifacts: ['src/result.ts'],
      dependencyPackages: [],
    };

    await processor.process({
      phase: { id: 'phase-id' } as never,
      work: {
        step,
        ticket: {
          id: 'story-id', name: 'P1-S004-STORY', type: 'story',
          source: { correlationId: 'correlation-id' },
        },
      } as never,
      steps: [step],
      result: {
        ok: false,
        changedFiles: [],
        wikiEntryIds: [],
        testOutcomes: [],
        gateFindings: [
          { ...finding, code: 'result_source_missing' },
          {
            ...finding,
            code: 'result_source_missing',
            summary: 'A second rendering of the same source problem.',
            evidence: ['The serialized result also omits source.'],
          },
          { ...finding, code: 'result_timestamp_missing' },
        ],
      },
    });

    expect(routed.map((input) => (input.failure as { code: string }).code)).toEqual([
      'result_source_missing',
      'result_timestamp_missing',
    ]);
    expect(routed[0]?.message).toContain('The serialized result also omits source.');
    expect(registered).toEqual([['bug-1', 'bug-2']]);
  });
});

describe('isAgentExecutionStall', () => {
  it('distinguishes agent loops from generated-project test failures', () => {
    expect(isAgentExecutionStall({
      ok: false,
      changedFiles: [],
      wikiEntryIds: [],
      testOutcomes: [],
      failure: {
        kind: 'execution',
        category: 'internal',
        code: 'agent_execution_stalled',
        message: 'read-only loop',
        retryable: true,
        switchProvider: true,
      },
    })).toBe(true);
    expect(isAgentExecutionStall({
      ok: false,
      changedFiles: [],
      wikiEntryIds: [],
      testOutcomes: [],
      failure: {
        kind: 'execution',
        category: 'test',
        code: 'test_command_failed',
        message: '1 failed',
        retryable: true,
        switchProvider: false,
      },
    })).toBe(false);
  });
});

// A stall is a degenerate model turn, not a project defect — hence no Bug — and it is transient: a
// live Step returned an empty round, recovered on the next one with 12KB of real work, then stalled
// again and took the whole run down, with all three of its declared outputs already on disk.
describe('agent execution stall disposition', () => {
  const stall = {
    ok: false,
    reason: 'model returned actions=[] and done=false for 2 consecutive rounds',
    failure: { category: 'internal', code: 'agent_execution_stalled' },
  } as unknown as AttemptResult;

  it('fails the attempt without ending the run', async () => {
    const { AttemptResultProcessor } = await import(
      '../src/application/project_management/attempt_result_processor.js');
    const retained: string[] = [];
    const processor = new AttemptResultProcessor({
      repository: {
        // The propagation scope is language-dependent, so the call site reads the Project.
        read: async (id: string) => id === 'project-id'
          ? { objectType: 'project', id, language: 'typescript' }
          : undefined,
        list: async () => [],
        commit: async () => {},
      },
      controller: {
        retainAgentExecutionFailure: async (_work: unknown, reason: string) => {
          retained.push(reason);
        },
      },
      tickets: {},
      audit: { event: async () => {} },
    } as never);

    const work = {
      phase: { id: 'p' }, step: { id: 's', name: 'P1-S001', projectId: 'proj' },
      ticket: { id: 't', name: 'P1-S001-STORY', type: 'story' },
    };
    const outcome = await (processor as unknown as {
      process(input: unknown): Promise<{ action: string }>;
    }).process({ phase: work.phase, work, steps: [], result: stall });

    // The Ticket stays active and unrouted — a stall is not a defect to open a Bug for.
    expect(retained).toHaveLength(1);
    // But the run keeps going: retrying is bounded by the attempt budget and the progress guard,
    // while exiting turned a model hiccup into an operator action.
    expect(outcome.action).toBe('continue');
  });
});
