import { describe, expect, it, vi } from 'vitest';
import { createCliRuntimeIO, isCliCancellation } from '../src/cli/runtime_adapter.js';
import {
  runtimePermissionAuthorizer,
  silentRuntimeIO,
  type ToolPermissionRequest,
} from '../src/runtime.js';
import { isCancellationError } from '../src/core/cancellation.js';

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
  it('recognizes graceful CLI cancellation errors', () => {
    const aborted = new Error('CLI task cancelled by SIGINT');
    aborted.name = 'AbortError';
    expect(isCliCancellation(aborted)).toBe(true);
    expect(isCliCancellation(new Error('generated project failed'))).toBe(false);
  });

  it('recognizes an aborted Runtime independently of provider error wording', () => {
    const controller = new AbortController();
    controller.abort(new Error('host requested cancellation'));

    expect(isCancellationError(new Error('provider stream stopped'), controller.signal)).toBe(true);
    expect(isCancellationError(new Error('provider stream stopped'))).toBe(false);
  });

  it('fails closed when a headless Runtime has no permission requester', async () => {
    const decision = await runtimePermissionAuthorizer(silentRuntimeIO)(request);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/denied/u);
  });

  it('keeps CLI sensitive operations interactive', () => {
    const interactive = createCliRuntimeIO();
    expect(interactive.permissionPolicy).toBe('request');
    expect(interactive.requestPermission).toBeDefined();
  });

  it('renders the discoverer-to-PM-to-handler Ticket route', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const interactive = createCliRuntimeIO();

    interactive.emit?.({
      id: 'route-event',
      timestamp: new Date().toISOString(),
      type: 'workflow',
      event: 'ticket_routed',
      projectId: 'project',
      phaseId: 'phase',
      stepId: 'step',
      stepName: 'P1-S005',
      ticketId: 'bug',
      ticketName: 'BUG-P1-009',
      ticketType: 'bug',
      creatorActorId: 'tester',
      creatorRole: 'tester',
      assigneeActorId: 'requirements',
      assigneeRole: 'requirements-engineer',
      assigneeAgent: 'Debugger',
      correlationId: 'correlation',
      message: 'tester created BUG-P1-009; PM routed it to requirements-engineer/Debugger',
    });

    expect(output.mock.calls.flat().join(' ')).toContain(
      'tester created BUG-P1-009; PM routed it to requirements-engineer/Debugger',
    );
    output.mockRestore();
  });

  it('allows trusted hosts to opt in explicitly', async () => {
    const decision = await runtimePermissionAuthorizer({
      ...silentRuntimeIO,
      permissionPolicy: 'allow',
    })(request);
    expect(decision.approved).toBe(true);
    expect(decision.reason).toMatch(/Explicit Runtime permission policy/u);
  });
});
