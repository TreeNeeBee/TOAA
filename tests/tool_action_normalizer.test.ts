import { describe, expect, it } from 'vitest';
import {
  describeToolForStep,
  normalizeActions,
} from '../src/agents/execution/tool_action_normalizer.js';
import { applyPatchTool } from '../src/tools/patch.js';
import type { Step } from '../src/core/plan.js';
import type { ToolContext } from '../src/tools/types.js';

describe('tool action normalization', () => {
  it('canonicalizes unambiguous provider-style flattened arguments', () => {
    const patch = '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const normalized = normalizeActions(
      [{ tool: 'apply_patch', patch }],
      new Map([[applyPatchTool.name, applyPatchTool]]),
    );

    expect(normalized.invalid).toEqual([]);
    expect(normalized.actions).toEqual([{
      tool: 'apply_patch',
      args: { patch },
    }]);
  });

  it('does not bypass schema validation for malformed flattened arguments', () => {
    const normalized = normalizeActions(
      [{ tool: 'apply_patch', patch: 42 }],
      new Map([[applyPatchTool.name, applyPatchTool]]),
    );

    expect(normalized.actions).toEqual([]);
    expect(normalized.invalid[0]?.result.error).toContain('patch must be a string');
  });

  it('shows the exact apply_patch action envelope in Step tool documentation', () => {
    const docs = describeToolForStep(
      applyPatchTool,
      {
        allowedWrites: ['src/'],
      } as ToolContext,
      {
        inputs: ['src/x.ts'],
        outputs: ['src/x.ts'],
      } as Step,
    );

    expect(docs).toContain('{"tool":"apply_patch","args":{"patch":"<unified diff>"}}');
  });
});
