import { describe, expect, it } from 'vitest';
import type { AttemptResult } from '../src/application/execution/attempt_runner.js';
import {
  correctiveAffectedArtifacts,
  isAgentExecutionStall,
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
