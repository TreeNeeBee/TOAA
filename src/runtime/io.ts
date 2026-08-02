export type RuntimeLogLevel =
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'dim'
  | 'accent'
  | 'raw';

import type {
  ToolExecutionEvent,
  ToolPermissionRequester,
  ToolPermissionRequest,
} from '../tools/types.js';

export interface RuntimeLogEvent {
  type: 'log';
  level: RuntimeLogLevel;
  message: string;
}

export interface RuntimeResultEvent {
  type: 'result';
  command: 'build' | 'run';
  status: string;
  data?: Record<string, unknown>;
}

export interface RuntimeProgressEvent {
  type: 'progress';
  status: 'start' | 'succeed' | 'fail';
  message: string;
}

export interface RuntimeToolCallEvent {
  type: 'tool_call';
  callId: string;
  status: ToolExecutionEvent['status'];
  stepId: string;
  stepName?: string;
  tool: string;
  target?: string;
  ok?: boolean;
  summary?: string;
  error?: string;
}

export interface RuntimeFileChangedEvent {
  type: 'file_changed';
  callId: string;
  stepId: string;
  stepName?: string;
  tool: string;
  path: string;
}

export interface RuntimePatchProposedEvent {
  type: 'patch_proposed';
  callId: string;
  stepId: string;
  stepName?: string;
  tool: string;
  patch: string;
}

export interface RuntimePermissionEvent {
  type: 'permission';
  status: 'requested' | 'approved' | 'denied';
  request: ToolPermissionRequest;
}

export interface RuntimeWorkflowEvent {
  type: 'workflow';
  event:
    | 'project_planned'
    | 'phase_started'
    | 'step_started'
    | 'ticket_started'
    | 'ticket_routed'
    | 'step_delivered'
    | 'phase_delivered'
    | 'project_delivered';
  projectId: string;
  phaseId?: string;
  stepId?: string;
  stepName?: string;
  ticketId?: string;
  ticketType?: string;
  correlationId: string;
  causationId?: string;
  message?: string;
}

export type RuntimeEvent =
  | RuntimeLogEvent
  | RuntimeProgressEvent
  | RuntimeResultEvent
  | RuntimeToolCallEvent
  | RuntimeFileChangedEvent
  | RuntimePatchProposedEvent
  | RuntimePermissionEvent
  | RuntimeWorkflowEvent;

export interface RuntimeProgress {
  succeed(message: string): void | Promise<void>;
  fail(message: string): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface RuntimeSelectChoice<T extends string = string> {
  name: string;
  value: T;
}

export interface RuntimeInteraction {
  input(args: { message: string }): Promise<string>;
  confirm(args: { message: string; default?: boolean }): Promise<boolean>;
  editor(args: { message: string; default?: string; postfix?: string }): Promise<string>;
  select<T extends string>(args: { message: string; choices: RuntimeSelectChoice<T>[] }): Promise<T>;
  readMultiline(args: { message: string }): Promise<string>;
  pauseStdin?(): void;
}

export interface RuntimeIO {
  /** Enables human-oriented lower-level stream rendering. Runtime adapters default to false. */
  terminalOutput?: boolean;
  emit(event: RuntimeEvent): void | Promise<void>;
  progress(message: string, opts?: { animate?: boolean }): RuntimeProgress;
  interaction?: RuntimeInteraction;
  requestPermission?: ToolPermissionRequester;
}

const noopProgress: RuntimeProgress = {
  succeed: () => undefined,
  fail: () => undefined,
  stop: () => undefined,
};

export const silentRuntimeIO: RuntimeIO = {
  terminalOutput: false,
  emit: () => undefined,
  progress: () => noopProgress,
};

export function runtimeLog(io: RuntimeIO, level: RuntimeLogLevel, message: string): Promise<void> {
  return Promise.resolve(io.emit({ type: 'log', level, message }));
}

export function runtimeResult(
  io: RuntimeIO,
  command: 'build' | 'run',
  status: string,
  data?: Record<string, unknown>,
): Promise<void> {
  return Promise.resolve(io.emit({ type: 'result', command, status, data }));
}

export function requireRuntimeInteraction(io: RuntimeIO, operation: string): RuntimeInteraction {
  if (!io.interaction) {
    throw new Error(`Runtime interaction required for ${operation}; provide RuntimeIO.interaction or run non-interactively.`);
  }
  return io.interaction;
}
