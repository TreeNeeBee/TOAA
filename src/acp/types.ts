import type {
  RuntimeBuildCommandOptions,
  RuntimeBuildCommandResult,
  RuntimeRunCommandOptions,
  ExecuteResult,
} from '../runtime.js';

export const ACP_PROTOCOL_VERSION = 1;

export type AcpPromptStopReason = 'end_turn' | 'cancelled';

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo: {
    name: 'xcompiler';
    title: string;
    version: string;
  };
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities: {
      image: boolean;
      audio: boolean;
      embeddedContext: boolean;
    };
    mcpCapabilities: {
      http: boolean;
      sse: boolean;
    };
    sessionCapabilities: {
      close: Record<string, never>;
    };
    auth: Record<string, never>;
  };
  authMethods: unknown[];
}

export interface AcpPromptResponse {
  stopReason: AcpPromptStopReason;
}

export interface AcpSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface AcpSession {
  id: string;
  workspace?: string;
  createdAt: string;
  tasks: Map<string, AcpTask>;
  pendingInteractions: Map<string, PendingInteraction>;
  pendingPermissions: Map<string, PendingPermission>;
}

export type AcpTaskStatus =
  | 'running'
  | 'waiting_for_confirmation'
  | 'waiting_for_permission'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled';

export interface AcpTask {
  id: string;
  sessionId: string;
  status: AcpTaskStatus;
  workspace: string;
  userTask: string;
  phase: 'build' | 'run' | 'complete';
  planPath?: string;
  changedFiles: string[];
  startedAt: string;
  completedAt?: string;
  cancellationRequested?: boolean;
  abortController: AbortController;
  lastBuildStatus?: string;
  lastRunStatus?: string;
}

export interface PendingInteraction {
  id: string;
  taskId: string;
  sessionId: string;
  phase: 'build' | 'run';
  kind: 'input' | 'confirm' | 'select' | 'editor' | 'multiline';
  message: string;
  choices?: Array<{ name: string; value: string }>;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export interface PendingPermission {
  id: string;
  taskId: string;
  sessionId: string;
  request: unknown;
  resolve: (approved: boolean, reason?: string) => void;
  reject: (reason: Error) => void;
}

export interface AcpCodeTaskParams {
  sessionId: string;
  workspace: string;
  task: string;
  configPath?: string;
  intent?: RuntimeBuildCommandOptions['intent'];
  requirePlanConfirmation?: boolean;
  autoRunAfterBuild?: boolean;
  force?: boolean;
}

export interface AcpRuntimeFacade {
  build(opts: RuntimeBuildCommandOptions): Promise<RuntimeBuildCommandResult>;
  run(opts: RuntimeRunCommandOptions): Promise<ExecuteResult>;
}

export interface AcpServerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface AcpServerOptions {
  runtime?: AcpRuntimeFacade;
  logger?: AcpServerLogger;
}
