import { randomUUID } from 'node:crypto';
import { pendingRequestNotFound, sessionNotFound, taskNotFound } from './errors.js';
import type { AcpSession, AcpTask, PendingInteraction, PendingPermission } from './types.js';
import { transitionAcpTaskStatus } from './task_state.js';

export class AcpSessionStore {
  private readonly sessions = new Map<string, AcpSession>();

  create(workspace?: string): AcpSession {
    const session: AcpSession = {
      id: randomUUID(),
      workspace,
      createdAt: new Date().toISOString(),
      tasks: new Map(),
      pendingInteractions: new Map(),
      pendingPermissions: new Map(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string): AcpSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw sessionNotFound(sessionId);
    return session;
  }

  close(sessionId: string): void {
    const session = this.get(sessionId);
    for (const pending of session.pendingInteractions.values()) {
      pending.reject(new Error('ACP session closed'));
    }
    for (const pending of session.pendingPermissions.values()) {
      pending.reject(new Error('ACP session closed'));
    }
    this.sessions.delete(session.id);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  createTask(session: AcpSession, input: { workspace: string; userTask: string }): AcpTask {
    const task: AcpTask = {
      id: randomUUID(),
      sessionId: session.id,
      status: 'running',
      workspace: input.workspace,
      userTask: input.userTask,
      phase: 'build',
      changedFiles: [],
      startedAt: new Date().toISOString(),
      abortController: new AbortController(),
    };
    session.tasks.set(task.id, task);
    return task;
  }

  getTask(sessionId: string, taskId: string): AcpTask {
    const session = this.get(sessionId);
    const task = session.tasks.get(taskId);
    if (!task) throw taskNotFound(taskId);
    return task;
  }

  addInteraction(session: AcpSession, pending: PendingInteraction): void {
    session.pendingInteractions.set(pending.id, pending);
    const task = session.tasks.get(pending.taskId);
    if (task) transitionAcpTaskStatus(task, 'waiting_for_confirmation');
  }

  resolveInteraction(sessionId: string, requestId: string, value: unknown): void {
    const session = this.get(sessionId);
    const pending = session.pendingInteractions.get(requestId);
    if (!pending) throw pendingRequestNotFound(requestId);
    session.pendingInteractions.delete(requestId);
    const task = session.tasks.get(pending.taskId);
    if (task && task.status === 'waiting_for_confirmation') {
      transitionAcpTaskStatus(task, 'running');
    }
    pending.resolve(value);
  }

  addPermission(session: AcpSession, pending: PendingPermission): void {
    session.pendingPermissions.set(pending.id, pending);
    const task = session.tasks.get(pending.taskId);
    if (task) transitionAcpTaskStatus(task, 'waiting_for_permission');
  }

  resolvePermission(sessionId: string, requestId: string, approved: boolean, reason?: string): void {
    const session = this.get(sessionId);
    const pending = session.pendingPermissions.get(requestId);
    if (!pending) throw pendingRequestNotFound(requestId);
    session.pendingPermissions.delete(requestId);
    const task = session.tasks.get(pending.taskId);
    if (task && task.status === 'waiting_for_permission') {
      transitionAcpTaskStatus(task, 'running');
    }
    pending.resolve(approved, reason);
  }

  rejectPendingForTask(sessionId: string, taskId: string, reason: Error): string[] {
    const session = this.get(sessionId);
    const rejectedIds: string[] = [];
    for (const [id, pending] of session.pendingInteractions) {
      if (pending.taskId !== taskId) continue;
      session.pendingInteractions.delete(id);
      rejectedIds.push(id);
      pending.reject(reason);
    }
    for (const [id, pending] of session.pendingPermissions) {
      if (pending.taskId !== taskId) continue;
      session.pendingPermissions.delete(id);
      rejectedIds.push(id);
      pending.reject(reason);
    }
    return rejectedIds;
  }
}
