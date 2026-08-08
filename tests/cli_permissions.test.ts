import { describe, expect, it } from 'vitest';
import {
  createCliRuntimeIO,
  createNonInteractiveCliRuntimeIO,
} from '../src/cli/runtime_adapter.js';
import type { ToolPermissionRequest } from '../src/runtime.js';

const request: ToolPermissionRequest = {
  operationType: 'git_operation',
  target: 'git snapshots for transactional Step execution',
  reason: 'Each Step attempt needs a reversible workspace baseline.',
  risk: 'XCompiler may initialize the workspace repository and create local commits.',
  scope: 'current workspace',
  skippable: false,
  denyBehavior: 'Stop because failed attempts cannot be rolled back safely.',
};

describe('CLI permission adapters', () => {
  it('approves execution-stage requests without prompting', async () => {
    // `build` owns every human gate; asking again while executing a confirmed plan stalls an
    // unattended run on a question that was already answered, with no new information to answer it.
    const decision = await createNonInteractiveCliRuntimeIO().requestPermission!(request);
    expect(decision.approved).toBe(true);
    // The recorded rationale has to say where the authority came from, or the audit trail shows an
    // approval with no source.
    expect(decision.reason).toMatch(/build-stage gate/u);
    expect(decision.reason).toContain(request.operationType);
  });

  it('keeps the interactive adapter interactive', async () => {
    // The build stage and ACP both still ask; this guards against the non-interactive variant being
    // wired in globally by mistake.
    const interactive = createCliRuntimeIO();
    expect(interactive.requestPermission).toBeDefined();
    expect(interactive.requestPermission)
      .not.toBe(createNonInteractiveCliRuntimeIO().requestPermission);
  });
});
