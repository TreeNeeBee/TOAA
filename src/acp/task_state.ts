import { assertStateTransition, type StateTransitions } from '../util/state_machine.js';
import type { AcpTask, AcpTaskStatus } from './types.js';

const TASK_STATUS_TRANSITIONS: StateTransitions<AcpTaskStatus> = {
  running: [
    'waiting_for_confirmation',
    'waiting_for_permission',
    'completed',
    'failed',
    'cancel_requested',
    'cancelled',
  ],
  waiting_for_confirmation: ['running', 'failed', 'cancel_requested', 'cancelled'],
  waiting_for_permission: ['running', 'failed', 'cancel_requested', 'cancelled'],
  cancel_requested: ['cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const TASK_PHASE_TRANSITIONS: StateTransitions<AcpTask['phase']> = {
  build: ['run', 'complete'],
  run: ['complete'],
  complete: [],
};

export function transitionAcpTaskStatus(task: AcpTask, next: AcpTaskStatus): boolean {
  const changed = assertStateTransition(
    'ACP task status',
    task.id,
    task.status,
    next,
    TASK_STATUS_TRANSITIONS,
  );
  if (!changed) return false;
  task.status = next;
  return true;
}

export function transitionAcpTaskPhase(task: AcpTask, next: AcpTask['phase']): boolean {
  const changed = assertStateTransition(
    'ACP task phase',
    task.id,
    task.phase,
    next,
    TASK_PHASE_TRANSITIONS,
  );
  if (!changed) return false;
  task.phase = next;
  return true;
}
