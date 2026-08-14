export type RuntimeLogLevel =
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'dim'
  | 'accent'
  | 'raw';

import { randomUUID } from 'node:crypto';

import type {
  ToolExecutionEvent,
  ToolPermissionRequester,
  ToolPermissionRequest,
} from '../tools/types.js';

export interface RuntimeEventEnvelope {
  eventId: string;
  eventVersion: 1;
  occurredAt: string;
}

export interface RuntimeLogEvent extends RuntimeEventEnvelope {
  type: 'log';
  level: RuntimeLogLevel;
  message: string;
}

export interface RuntimeResultEvent extends RuntimeEventEnvelope {
  type: 'result';
  command: 'build' | 'run';
  status: string;
  data?: Record<string, unknown>;
}

export interface RuntimeProgressEvent extends RuntimeEventEnvelope {
  type: 'progress';
  status: 'start' | 'succeed' | 'fail';
  message: string;
}

export interface RuntimeToolCallEvent extends RuntimeEventEnvelope {
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

export interface RuntimeFileChangedEvent extends RuntimeEventEnvelope {
  type: 'file_changed';
  callId: string;
  stepId: string;
  stepName?: string;
  tool: string;
  path: string;
}

export interface RuntimePatchProposedEvent extends RuntimeEventEnvelope {
  type: 'patch_proposed';
  callId: string;
  stepId: string;
  stepName?: string;
  tool: string;
  patch: string;
}

export interface RuntimePermissionEvent extends RuntimeEventEnvelope {
  type: 'permission';
  status: 'requested' | 'approved' | 'denied';
  request: ToolPermissionRequest;
}

export interface RuntimeWorkflowEvent extends RuntimeEventEnvelope {
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
  ticketName?: string;
  ticketType?: string;
  creatorActorId?: string;
  creatorRole?: string;
  assigneeActorId?: string;
  assigneeRole?: string;
  assigneeAgent?: string;
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

export type RuntimeEventInput = RuntimeEvent extends infer Event
  ? Event extends RuntimeEventEnvelope
    ? Omit<Event, keyof RuntimeEventEnvelope>
    : never
  : never;

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

export type RuntimePermissionPolicy = 'request' | 'auto' | 'deny';

export interface RuntimeIO {
  /** Enables human-oriented lower-level stream rendering. Runtime adapters default to false. */
  terminalOutput?: boolean;
  emit(event: RuntimeEvent): void | Promise<void>;
  progress(message: string, opts?: { animate?: boolean }): RuntimeProgress;
  interaction?: RuntimeInteraction;
  /** Sensitive-operation policy. Headless callers fail closed unless they explicitly opt in. */
  permissionPolicy?: RuntimePermissionPolicy;
  requestPermission?: ToolPermissionRequester;
}

const noopProgress: RuntimeProgress = {
  succeed: () => undefined,
  fail: () => undefined,
  stop: () => undefined,
};

export const silentRuntimeIO: RuntimeIO = {
  terminalOutput: false,
  permissionPolicy: 'deny',
  emit: () => undefined,
  progress: () => noopProgress,
};

export function runtimePermissionAuthorizer(
  io: RuntimeIO,
  configuredPolicy: RuntimePermissionPolicy = 'request',
): ToolPermissionRequester {
  const policy = io.permissionPolicy ?? configuredPolicy;
  return async (request) => {
    if (policy === 'auto') {
      return {
        approved: true,
        outcome: 'approved',
        reason: `Runtime auto permission mode allowed ${request.operationType} for this run.`,
      };
    }
    if (policy === 'deny') {
      return {
        approved: false,
        outcome: 'denied',
        reason: `Runtime permission policy denied ${request.operationType}.`,
      };
    }
    if (io.requestPermission) return io.requestPermission(request);
    return {
      approved: false,
      outcome: 'denied',
      reason: `No permission requester is configured for ${request.operationType}.`,
    };
  };
}

export function runtimeLog(io: RuntimeIO, level: RuntimeLogLevel, message: string): Promise<void> {
  return emitRuntimeEvent(io, { type: 'log', level, message });
}

export function runtimeResult(
  io: RuntimeIO,
  command: 'build' | 'run',
  status: string,
  data?: Record<string, unknown>,
): Promise<void> {
  return emitRuntimeEvent(io, { type: 'result', command, status, data });
}

export function emitRuntimeEvent(io: RuntimeIO, event: RuntimeEventInput): Promise<void> {
  return Promise.resolve(io.emit({
    ...event,
    eventId: randomUUID(),
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
  } as RuntimeEvent));
}

export function requireRuntimeInteraction(io: RuntimeIO, operation: string): RuntimeInteraction {
  if (!io.interaction) {
    throw new Error(`Runtime interaction required for ${operation}; provide RuntimeIO.interaction or run non-interactively.`);
  }
  return io.interaction;
}
