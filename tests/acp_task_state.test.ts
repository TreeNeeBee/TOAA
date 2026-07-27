import { describe, expect, it } from 'vitest';
import {
  transitionAcpTaskPhase,
  transitionAcpTaskStatus,
} from '../src/acp/task_state.js';
import type { AcpTask } from '../src/acp/types.js';

function task(): AcpTask {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    status: 'running',
    workspace: '/tmp/project',
    userTask: 'Fix tests',
    phase: 'build',
    changedFiles: [],
    startedAt: new Date(0).toISOString(),
    abortController: new AbortController(),
  };
}

describe('ACP task state policy', () => {
  it('allows confirmation and build-to-run lifecycle transitions', () => {
    const current = task();
    transitionAcpTaskStatus(current, 'waiting_for_confirmation');
    transitionAcpTaskStatus(current, 'running');
    transitionAcpTaskPhase(current, 'run');
    transitionAcpTaskStatus(current, 'completed');
    transitionAcpTaskPhase(current, 'complete');
    expect(current).toMatchObject({ status: 'completed', phase: 'complete' });
  });

  it('keeps terminal tasks and completed phases terminal', () => {
    const current = task();
    transitionAcpTaskStatus(current, 'failed');
    transitionAcpTaskPhase(current, 'complete');
    expect(() => transitionAcpTaskStatus(current, 'running')).toThrow(
      /Invalid ACP task status transition/,
    );
    expect(() => transitionAcpTaskPhase(current, 'run')).toThrow(
      /Invalid ACP task phase transition/,
    );
  });
});
