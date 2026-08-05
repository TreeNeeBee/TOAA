import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  XCOMPILER_VERSION,
  XCompilerRuntime,
  type RuntimeBuildCommandOptions,
  type RuntimeIO,
  type RuntimeInteraction,
  type RuntimeProgress,
  type RuntimeRunCommandOptions,
  type RuntimeSelectChoice,
  type ToolPermissionRequest,
} from '../runtime.js';
import { AcpError, invalidParams } from './errors.js';
import { mapRuntimeEventToAcpUpdates, taskUpdate } from './mapper.js';
import {
  parsePermissionChoice,
  toAcpInteractionPermissionParams,
  toAcpPermissionRequestParams,
} from './permissions.js';
import {
  AcpMethod,
  failure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  JsonRpcErrorCode,
  notification,
  request,
  success,
  type JsonRpcFailure,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from './protocol.js';
import { AcpSessionStore } from './session.js';
import type {
  AcpPromptResponse,
  AcpCodeTaskParams,
  AcpInitializeResult,
  AcpRuntimeFacade,
  AcpServerLogger,
  AcpServerOptions,
  AcpSession,
  AcpTask,
} from './types.js';
import { transitionAcpTaskPhase, transitionAcpTaskStatus } from './task_state.js';
import { ACP_PROTOCOL_VERSION } from './types.js';
import type { AcpTransport } from './transport.js';

const stderrLogger: AcpServerLogger = {
  info: (message) => process.stderr.write(`[xcompiler-acp] ${message}\n`),
  warn: (message) => process.stderr.write(`[xcompiler-acp] warning: ${message}\n`),
  error: (message) => process.stderr.write(`[xcompiler-acp] error: ${message}\n`),
};

const runtimeFacade = new XCompilerRuntime();
const defaultRuntime: AcpRuntimeFacade = {
  build: (options) => runtimeFacade.buildCommand(options),
  run: (options) => runtimeFacade.runCommand(options),
};

interface PendingClientRequest {
  sessionId: string;
  requestId: string;
  kind: 'permission' | 'interaction';
  interactionKind?: 'input' | 'confirm' | 'select' | 'editor' | 'multiline';
  choiceValues?: Map<string, unknown>;
}

export class AcpServer {
  readonly sessions = new AcpSessionStore();
  private readonly runtime: AcpRuntimeFacade;
  private readonly logger: AcpServerLogger;
  private readonly pendingClientRequests = new Map<string, PendingClientRequest>();
  private transport?: AcpTransport;

  constructor(opts: AcpServerOptions = {}) {
    this.runtime = opts.runtime ?? defaultRuntime;
    this.logger = opts.logger ?? stderrLogger;
  }

  async start(transport: AcpTransport): Promise<void> {
    this.transport = transport;
    transport.onMessage(async (message) => {
      await this.handleMessage(message);
    });
    transport.onClose(() => this.sessions.closeAll());
    await transport.start();
  }

  async handleMessage(message: unknown): Promise<JsonRpcMessage | undefined> {
    if (isJsonRpcResponse(message)) {
      this.dispatchClientResponse(message);
      return undefined;
    }
    if (isJsonRpcNotification(message)) {
      try {
        await this.dispatchNotification(message.method, message.params);
      } catch (err) {
        this.logger.error((err as Error).message);
      }
      return undefined;
    }
    if (!isJsonRpcRequest(message)) {
      const response = failure(null, JsonRpcErrorCode.InvalidRequest, 'invalid JSON-RPC request');
      this.transport?.send(response);
      return response;
    }
    let response: JsonRpcMessage;
    try {
      response = success(message.id, await this.dispatchRequest(message));
    } catch (err) {
      response = this.errorResponse(message.id, err);
    }
    this.transport?.send(response);
    return response;
  }

  private async dispatchRequest(message: JsonRpcRequest): Promise<unknown> {
    switch (message.method) {
      case AcpMethod.Initialize:
        return this.initialize(message.params);
      case AcpMethod.Shutdown:
        this.sessions.closeAll();
        this.transport?.close();
        return { ok: true };
      case AcpMethod.SessionNew:
        return this.createSession(message.params);
      case AcpMethod.SessionClose:
        return this.closeSession(message.params);
      case AcpMethod.SessionPrompt:
        return this.prompt(message.params);
      case AcpMethod.SessionCancel:
        return this.cancelTask(message.params);
      default:
        throw new AcpError(JsonRpcErrorCode.MethodNotFound, `unknown ACP method: ${message.method}`);
    }
  }

  private async dispatchNotification(method: string, params: unknown): Promise<void> {
    if (method === AcpMethod.SessionCancel) {
      this.cancelTask(params);
      return;
    }
    throw new AcpError(JsonRpcErrorCode.MethodNotFound, `unknown ACP notification: ${method}`);
  }

  private initialize(params?: unknown): AcpInitializeResult {
    const requestedVersion = typeof asOptionalRecord(params).protocolVersion === 'number'
      ? asOptionalRecord(params).protocolVersion as number
      : ACP_PROTOCOL_VERSION;
    return {
      protocolVersion: Math.min(requestedVersion, ACP_PROTOCOL_VERSION),
      agentInfo: {
        name: 'xcompiler',
        title: 'XCompiler ACP Code Agent',
        version: XCOMPILER_VERSION,
      },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          close: {},
        },
        auth: {},
      },
      authMethods: [],
    };
  }

  private createSession(params: unknown): { sessionId: string } {
    const p = asOptionalRecord(params);
    const workspace =
      typeof p.cwd === 'string'
        ? path.resolve(p.cwd)
        : typeof p.workspace === 'string'
          ? path.resolve(p.workspace)
          : process.cwd();
    const session = this.sessions.create(workspace);
    return { sessionId: session.id };
  }

  private closeSession(params: unknown): { ok: true } {
    const sessionId = requiredString(asRecord(params), 'sessionId');
    this.sessions.close(sessionId);
    return { ok: true };
  }

  private async prompt(params: unknown): Promise<AcpPromptResponse> {
    const p = parsePromptParams(params);
    const session = this.sessions.get(p.sessionId);
    const workspace = path.resolve(session.workspace || process.cwd());
    const task = this.sessions.createTask(session, { workspace, userTask: p.task });
    try {
      await this.runCodeTask(session, task, { ...p, workspace });
    } catch (err) {
      this.finishTaskFromError(session, task, err);
    }
    return {
      stopReason: task.status === 'cancelled' || task.status === 'cancel_requested' ? 'cancelled' : 'end_turn',
    };
  }

  private cancelTask(params: unknown): { cancelled: boolean; reason: string } {
    const p = asRecord(params);
    const sessionId = requiredString(p, 'sessionId');
    const session = this.sessions.get(sessionId);
    const taskId = typeof p.taskId === 'string' ? p.taskId : activeTaskId(session);
    if (!taskId) {
      return {
        cancelled: false,
        reason: 'No active task is running for this ACP session.',
      };
    }
    const task = this.sessions.getTask(sessionId, taskId);
    task.cancellationRequested = true;
    transitionAcpTaskStatus(task, 'cancel_requested');
    task.abortController.abort(new Error('ACP task cancelled by client'));
    const rejectedIds = this.sessions.rejectPendingForTask(
      sessionId,
      taskId,
      new Error('ACP task cancelled by client'),
    );
    for (const requestId of rejectedIds) this.pendingClientRequests.delete(requestId);
    this.notifyTask(session, task, 'task_cancelled', 'Cancellation accepted; no further Runtime phase will start.', {
      status: task.status,
    });
    return {
      cancelled: true,
      reason: 'Cancellation accepted. An active non-interruptible operation may finish before the task closes.',
    };
  }

  private async runCodeTask(session: AcpSession, task: AcpTask, params: AcpCodeTaskParams): Promise<void> {
    this.throwIfCancelled(task);
    this.notifyTask(session, task, 'task_started', `Task started in ${task.workspace}`, { workspace: task.workspace });
    this.notifyTask(session, task, 'build_started', 'Build started', { workspace: task.workspace });
    const buildIo = this.createRuntimeIO(session, task, 'build');
    const buildOpts: RuntimeBuildCommandOptions = {
      workspace: task.workspace,
      configPath: params.configPath,
      intent: params.intent ?? 'feature',
      yes: params.requirePlanConfirmation === false,
      force: !!params.force,
      io: buildIo,
      abortSignal: task.abortController.signal,
    };
    const build = await this.runtime.build(buildOpts);
    this.throwIfCancelled(task);
    if (build.planPath) task.planPath = build.planPath;
    this.notifyTask(session, task, 'build_completed', `Build ${task.lastBuildStatus ?? 'completed'}`, {
      planPath: task.planPath,
      status: task.lastBuildStatus,
    });
    if (!task.planPath) {
      transitionAcpTaskStatus(
        task,
        task.lastBuildStatus === 'cancelled' || task.lastBuildStatus === 'rejected'
          ? 'cancelled'
          : 'failed',
      );
      transitionAcpTaskPhase(task, 'complete');
      task.completedAt = new Date().toISOString();
      this.notifyTask(session, task, 'task_completed', `Task ${task.status}: build produced no runnable plan`, {
        status: task.status,
        buildStatus: task.lastBuildStatus,
        planPath: task.planPath,
        changedFiles: task.changedFiles,
      });
      return;
    }
    if (params.autoRunAfterBuild === false) {
      transitionAcpTaskStatus(task, 'completed');
      transitionAcpTaskPhase(task, 'complete');
      task.completedAt = new Date().toISOString();
      this.notifyTask(session, task, 'task_completed', 'Task completed after Build', {
        status: task.status,
        planPath: task.planPath,
        changedFiles: task.changedFiles,
      });
      return;
    }

    transitionAcpTaskPhase(task, 'run');
    this.throwIfCancelled(task);
    this.notifyTask(session, task, 'run_started', 'Run started', { planPath: task.planPath });
    const runIo = this.createRuntimeIO(session, task, 'run');
    const runOpts: RuntimeRunCommandOptions = {
      planArg: task.planPath,
      workspace: task.workspace,
      configPath: params.configPath,
      force: !!params.force,
      terminalOutput: false,
      io: runIo,
      abortSignal: task.abortController.signal,
    };
    const run = await this.runtime.run(runOpts);
    this.throwIfCancelled(task);
    transitionAcpTaskStatus(
      task,
      run.status === 'ok' || run.status === 'dry-run' ? 'completed' : 'failed',
    );
    transitionAcpTaskPhase(task, 'complete');
    task.completedAt = new Date().toISOString();
    this.notifyTask(session, task, 'task_completed', `Task ${task.status}`, {
      status: task.status,
      runStatus: run.status,
      message: run.message,
      changedFiles: task.changedFiles,
    });
  }

  private createRuntimeIO(session: AcpSession, task: AcpTask, phase: 'build' | 'run'): RuntimeIO {
    const io: RuntimeIO = {
      terminalOutput: false,
      emit: async (event) => {
        if (event.type === 'permission' && event.status === 'requested') return;
        if (event.type === 'result') {
          if (event.command === 'build') task.lastBuildStatus = event.status;
          if (event.command === 'run') task.lastRunStatus = event.status;
        }
        const mapped = mapRuntimeEventToAcpUpdates(event, { taskId: task.id, phase });
        for (const acpEvent of mapped) {
          if (acpEvent.eventType === 'file_changed' && typeof acpEvent.path === 'string') {
            task.changedFiles.push(acpEvent.path);
          }
          this.notifyUpdate(session.id, acpEvent.update);
        }
      },
      progress: (message) => this.runtimeProgress(session.id, task.id, phase, message),
      requestPermission: phase === 'run'
        ? (request) => this.requestPermission(session, task, request)
        : undefined,
    };
    io.interaction = this.createInteraction(session, task, phase);
    return io;
  }

  private createInteraction(session: AcpSession, task: AcpTask, phase: 'build' | 'run'): RuntimeInteraction {
    return {
      input: async ({ message }) => interactionText(
        await this.requestInteraction(session, task, phase, 'input', message),
        'input',
      ),
      confirm: async ({ message, default: defaultValue }) => {
        const result = await this.requestInteraction(session, task, phase, 'confirm', message, undefined, defaultValue);
        return result === true || result === 'true' || result === 'yes' || result === 'confirm';
      },
      editor: async ({ message, default: defaultValue }) => {
        const result = await this.requestInteraction(session, task, phase, 'editor', message, undefined, defaultValue);
        if (typeof result === 'string') return result;
        if (result === true) return defaultValue ?? '';
        throw new Error('ACP client rejected the Build editor request.');
      },
      select: async <T extends string>({ message, choices }: { message: string; choices: RuntimeSelectChoice<T>[] }) => {
        const result = await this.requestInteraction(session, task, phase, 'select', message, choices);
        return String(result) as T;
      },
      readMultiline: async ({ message }) => {
        if (phase === 'build' && task.userTask.trim()) return task.userTask;
        return interactionText(
          await this.requestInteraction(session, task, phase, 'multiline', message),
          'multiline input',
        );
      },
      pauseStdin: () => undefined,
    };
  }

  private requestInteraction(
    session: AcpSession,
    task: AcpTask,
    phase: 'build' | 'run',
    kind: 'input' | 'confirm' | 'select' | 'editor' | 'multiline',
    message: string,
    choices?: Array<{ name: string; value: string }>,
    defaultValue?: unknown,
  ): Promise<unknown> {
    if (phase === 'run') {
      const err = new Error('Run phase does not support ordinary chat-style interaction.');
      this.notifyTask(session, task, 'error', err.message, { phase });
      return Promise.reject(err);
    }
    const requestId = randomUUID();
    const effectiveChoices = choices ?? (kind === 'input' ? clarificationChoices(message) : undefined);
    const choiceValues = new Map<string, unknown>();
    if (effectiveChoices?.length) {
      for (const choice of effectiveChoices) choiceValues.set(choice.value, choice.value);
    } else {
      choiceValues.set('allow_once', true);
      choiceValues.set('reject_once', false);
    }
    this.pendingClientRequests.set(requestId, {
      sessionId: session.id,
      requestId,
      kind: 'interaction',
      interactionKind: kind,
      choiceValues,
    });
    this.transport?.send(request(
      requestId,
      AcpMethod.SessionRequestPermission,
      toAcpInteractionPermissionParams({
        sessionId: session.id,
        requestId,
        taskId: task.id,
        kind,
        message,
        choices: effectiveChoices,
        defaultValue,
      }),
    ));
    this.notifyTask(session, task, 'build_confirmation_required', message, {
      requestId,
      kind,
      choices: effectiveChoices,
      default: defaultValue,
    });
    return new Promise((resolve, reject) => {
      this.sessions.addInteraction(session, {
        id: requestId,
        taskId: task.id,
        sessionId: session.id,
        phase,
        kind,
        message,
        choices: effectiveChoices,
        resolve,
        reject,
      });
    });
  }

  private requestPermission(
    session: AcpSession,
    task: AcpTask,
    permissionRequest: ToolPermissionRequest,
  ): Promise<{ approved: boolean; reason?: string }> {
    const requestId = randomUUID();
    this.pendingClientRequests.set(requestId, {
      sessionId: session.id,
      requestId,
      kind: 'permission',
    });
    this.transport?.send(request(
      requestId,
      AcpMethod.SessionRequestPermission,
      toAcpPermissionRequestParams(session.id, requestId, task.id, permissionRequest),
    ));
    this.notifyTask(session, task, 'permission_required', `Permission required: ${permissionRequest.operationType} ${permissionRequest.target}`, {
      requestId,
      operationType: permissionRequest.operationType,
      target: permissionRequest.target,
    });
    return new Promise((resolve, reject) => {
      this.sessions.addPermission(session, {
        id: requestId,
        taskId: task.id,
        sessionId: session.id,
        request: permissionRequest,
        resolve: (approved, reason) => resolve({ approved, reason }),
        reject,
      });
    });
  }

  private runtimeProgress(sessionId: string, taskId: string, phase: 'build' | 'run', message: string): RuntimeProgress {
    this.notifyUpdate(sessionId, taskUpdate(
      phase === 'build' ? 'build_progress' : 'run_progress',
      taskId,
      message,
      { phase, status: 'start' },
    ));
    return {
      succeed: (next) => this.notifyUpdate(sessionId, taskUpdate(
        phase === 'build' ? 'build_progress' : 'run_progress',
        taskId,
        next,
        { phase, status: 'succeed' },
      )),
      fail: (next) => this.notifyUpdate(sessionId, taskUpdate(
        phase === 'build' ? 'build_progress' : 'run_progress',
        taskId,
        next,
        { phase, status: 'fail' },
      )),
      stop: () => undefined,
    };
  }

  private dispatchClientResponse(message: JsonRpcSuccess | JsonRpcFailure): void {
    const id = String(message.id);
    const pending = this.pendingClientRequests.get(id);
    if (!pending) {
      this.logger.warn(`received response for unknown ACP client request: ${id}`);
      return;
    }
    this.pendingClientRequests.delete(id);
    if ('error' in message) {
      const reason = message.error.message;
      if (pending.kind === 'permission') {
        this.sessions.resolvePermission(pending.sessionId, pending.requestId, false, reason);
      } else {
        this.sessions.resolveInteraction(pending.sessionId, pending.requestId, false);
      }
      return;
    }
    const choice = parsePermissionChoice(message.result);
    if (pending.kind === 'permission') {
      this.sessions.resolvePermission(pending.sessionId, pending.requestId, choice.approved, choice.reason);
      return;
    }
    const selected = typeof choice.value === 'string' && pending.choiceValues?.has(choice.value)
      ? pending.choiceValues.get(choice.value)
      : choice.approved;
    this.sessions.resolveInteraction(pending.sessionId, pending.requestId, selected);
  }

  private throwIfCancelled(task: AcpTask): void {
    if (!task.cancellationRequested && !task.abortController.signal.aborted) return;
    const error = new Error('ACP task cancelled by client');
    error.name = 'AbortError';
    throw error;
  }

  private finishTaskFromError(session: AcpSession, task: AcpTask, err: unknown): void {
    const cancelled = task.cancellationRequested || task.abortController.signal.aborted;
    transitionAcpTaskStatus(task, cancelled ? 'cancelled' : 'failed');
    transitionAcpTaskPhase(task, 'complete');
    task.completedAt = new Date().toISOString();
    if (!cancelled) this.notifyTask(session, task, 'error', (err as Error).message);
    this.notifyTask(
      session,
      task,
      'task_completed',
      cancelled ? 'Task cancelled' : `Task failed: ${(err as Error).message}`,
      { status: task.status, changedFiles: task.changedFiles },
    );
  }

  private notifyTask(
    session: AcpSession,
    task: AcpTask,
    type: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.notifyUpdate(session.id, taskUpdate(type, task.id, message, extra));
  }

  private notifyUpdate(sessionId: string, update: Record<string, unknown>): void {
    this.transport?.send(notification(AcpMethod.SessionUpdate, { sessionId, update }));
  }

  private errorResponse(id: JsonRpcRequest['id'], err: unknown): JsonRpcMessage {
    if (err instanceof AcpError) return failure(id, err.code, err.message, err.data);
    this.logger.error((err as Error).stack ?? (err as Error).message ?? String(err));
    return failure(id, JsonRpcErrorCode.InternalError, (err as Error).message ?? String(err));
  }
}

function clarificationChoices(message: string): Array<{ name: string; value: string }> | undefined {
  const choices = [...message.matchAll(/^\s{2}([A-E])\.\s+(.+)$/gmu)].map((match) => ({
    name: `${match[1]}. ${match[2]}`,
    value: match[1]!,
  }));
  return choices.length >= 2 ? choices : undefined;
}

function interactionText(value: unknown, operation: string): string {
  if (typeof value === 'string') return value;
  throw new Error(
    `ACP ${operation} requires a text or listed-choice response; received ${typeof value}.`,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidParams('params must be an object');
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw invalidParams(`params.${key} must be a non-empty string`);
  return value;
}

function parsePromptParams(value: unknown): AcpCodeTaskParams {
  const params = asRecord(value);
  const xcompiler = asOptionalRecord(asOptionalRecord(params._meta).xcompiler);
  const task = promptText(params.prompt);
  if (!task.trim()) throw invalidParams('params.prompt must include non-empty text content');
  return {
    sessionId: requiredString(params, 'sessionId'),
    workspace: typeof params.cwd === 'string' ? params.cwd : '',
    task,
    configPath: stringFrom(params, xcompiler, 'configPath'),
    intent: stringFrom(params, xcompiler, 'intent') as AcpCodeTaskParams['intent'] | undefined,
    requirePlanConfirmation: booleanFrom(params, xcompiler, 'requirePlanConfirmation', true),
    autoRunAfterBuild: booleanFrom(params, xcompiler, 'autoRunAfterBuild', true),
    force: booleanFrom(params, xcompiler, 'force', false),
  };
}

function promptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) return prompt.map(contentBlockText).filter(Boolean).join('\n\n');
  const record = asOptionalRecord(prompt);
  if (Array.isArray(record.content)) return record.content.map(contentBlockText).filter(Boolean).join('\n\n');
  return contentBlockText(record);
}

function contentBlockText(block: unknown): string {
  if (typeof block === 'string') return block;
  const record = asOptionalRecord(block);
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) return record.content.map(contentBlockText).filter(Boolean).join('\n\n');
  if (typeof record.uri === 'string') return `[${String(record.type ?? 'resource')}] ${record.uri}`;
  return '';
}

function stringFrom(primary: Record<string, unknown>, fallback: Record<string, unknown>, key: string): string | undefined {
  if (typeof primary[key] === 'string') return primary[key];
  if (typeof fallback[key] === 'string') return fallback[key];
  return undefined;
}

function booleanFrom(
  primary: Record<string, unknown>,
  fallback: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
): boolean {
  if (typeof primary[key] === 'boolean') return primary[key];
  if (typeof fallback[key] === 'boolean') return fallback[key];
  return defaultValue;
}

function activeTaskId(session: AcpSession): string | undefined {
  for (const task of [...session.tasks.values()].reverse()) {
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) return task.id;
  }
  return undefined;
}
