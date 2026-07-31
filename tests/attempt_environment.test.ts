import { describe, expect, it } from 'vitest';
import type { Step } from '../src/core/plan.js';
import { ensureAttemptToolRefs } from '../src/core/engine/attempt_environment.js';

const step: Step = {
  id: 'S001',
  iterationId: 'P1',
  phase: 'REQUIREMENT_ANALYSIS',
  title: 'Requirements',
  description: 'Write the requirements and paired functional tests.',
  systemPrompt: 'Only produce the declared requirement artifacts.',
  role: 'Planner',
  tools: ['write_file'],
  inputs: ['docs/topic.md'],
  outputs: ['docs/01-requirement-analysis.md'],
  dependsOn: [],
  acceptance: 'The requirement artifact is complete.',
  status: 'PENDING',
  retries: 0,
  maxRetries: 3,
};

describe('attempt environment tool capabilities', () => {
  it('keeps ordinary execution on the planned tool set', () => {
    expect(ensureAttemptToolRefs(step, { incremental: false })).toEqual([
      'write_file',
      'append_file',
    ]);
  });

  it('adds bounded inspection and patch tools for Enhance/CR execution', () => {
    expect(ensureAttemptToolRefs(step, { incremental: true })).toEqual([
      'write_file',
      'append_file',
      'read_file',
      'list_dir',
      'code_search',
      'replace_in_file',
      'apply_patch',
    ]);
  });
});
