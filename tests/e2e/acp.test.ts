import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AcpServer, AcpMethod, type AcpTransport, type JsonRpcMessage } from '../../src/acp/index.js';
import type { AcpRuntimeFacade } from '../../src/acp/types.js';
import type {
  RuntimeBuildCommandOptions,
  RuntimeBuildCommandResult,
  RuntimeRunCommandOptions,
} from '../../src/runtime/commands.js';
import type { ExecuteResult } from '../../src/runtime/run.js';

const root = path.resolve(__dirname, '..', '..');

class MemoryTransport implements AcpTransport {
  sent: JsonRpcMessage[] = [];
  private messageHandler?: (message: unknown) => void | Promise<void>;
  private closeHandler?: () => void | Promise<void>;
  private waiters: Array<() => void> = [];

  send(message: JsonRpcMessage): void {
    this.sent.push(message);
    for (const wake of this.waiters.splice(0)) wake();
  }

  onMessage(handler: (message: unknown) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void | Promise<void>): void {
    this.closeHandler = handler;
  }

  async start(): Promise<void> {}

  close(): void {
    void this.closeHandler?.();
  }

  async inject(message: unknown): Promise<void> {
    void Promise.resolve(this.messageHandler?.(message));
    await Promise.resolve();
  }

  async waitForResponse(id: number | string): Promise<Record<string, unknown>> {
    const msg = await this.waitFor((candidate) => 'id' in candidate && candidate.id === id) as
      | { result?: Record<string, unknown>; error?: unknown }
      | undefined;
    if (!msg?.result) throw new Error(`response not found: ${id}`);
    return msg.result;
  }

  async waitForClientRequest(method: string, predicate: (params: Record<string, unknown>) => boolean = () => true): Promise<JsonRpcMessage> {
    return this.waitFor((msg) => {
      if (!('method' in msg) || msg.method !== method || !('id' in msg)) return false;
      return predicate((msg as { params?: Record<string, unknown> }).params ?? {});
    });
  }

  async waitForEvent(type: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 100; i++) {
      const found = this.events().find((event) => event.type === type);
      if (found) return found;
      await this.waitForNextMessage();
    }
    throw new Error(`event not observed: ${type}`);
  }

  events(): Record<string, unknown>[] {
    return this.sent
      .filter((msg) => 'method' in msg && msg.method === AcpMethod.SessionUpdate)
      .map((msg) => {
        const params = (msg as { params?: Record<string, unknown> }).params ?? {};
        const update = (params.update ?? {}) as Record<string, unknown>;
        const meta = ((update._meta as Record<string, unknown> | undefined)?.xcompiler ?? {}) as Record<string, unknown>;
        return {
          type: meta.eventType,
          sessionId: params.sessionId,
          update,
          ...meta,
        };
      })
      .filter((event) => typeof event.type === 'string');
  }

  private async waitFor(predicate: (msg: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
    for (let i = 0; i < 100; i++) {
      const found = this.sent.find(predicate);
      if (found) return found;
      await this.waitForNextMessage();
    }
    throw new Error('message not observed');
  }

  private async waitForNextMessage(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      setTimeout(resolve, 10);
    });
  }
}

class FakeRuntime implements AcpRuntimeFacade {
  buildCalls: RuntimeBuildCommandOptions[] = [];
  runCalls: RuntimeRunCommandOptions[] = [];
  runOrdinaryInteraction = false;

  async build(opts: RuntimeBuildCommandOptions): Promise<RuntimeBuildCommandResult> {
    this.buildCalls.push(opts);
    await opts.io?.emit({ type: 'log', level: 'info', message: 'build preparing plan' });
    const ok = await opts.io!.interaction!.confirm({ message: 'Apply generated plan?', default: true });
    if (!ok) return { workspace: opts.workspace };
    const planPath = path.join(opts.workspace, 'plan.json');
    await opts.io?.emit({ type: 'result', command: 'build', status: 'ok', data: { planPath } });
    return { workspace: opts.workspace, planPath };
  }

  async run(opts: RuntimeRunCommandOptions): Promise<ExecuteResult> {
    this.runCalls.push(opts);
    if (this.runOrdinaryInteraction) {
      await opts.io!.interaction!.confirm({ message: 'ordinary run chat?' });
    }
    const decision = await opts.io!.requestPermission!({
      operationType: 'test_command',
      target: 'npm test',
      reason: 'Validate the generated code.',
      risk: 'Project test scripts may execute local code.',
      scope: 'current workspace',
      skippable: true,
      denyBehavior: 'Skip tests and report unverified result.',
      stepId: 'S005',
      tool: 'run_tests',
    });
    if (!decision.approved) {
      await opts.io?.emit({ type: 'result', command: 'run', status: 'failed', data: { exitCode: 4 } });
      return { status: 'failed', message: 'permission denied', exitCode: 4 };
    }
    await opts.io?.emit({ type: 'tool_call', callId: 'test-call-1', status: 'started', stepId: 'S005', tool: 'run_tests', target: 'npm test' });
    await opts.io?.emit({ type: 'file_changed', callId: 'write-call-1', stepId: 'S004', tool: 'write_file', path: 'src/main.ts' });
    await opts.io?.emit({ type: 'patch_proposed', callId: 'patch-call-1', stepId: 'S004', tool: 'apply_patch', patch: '--- a/src/main.ts\n+++ b/src/main.ts\n' });
    await opts.io?.emit({ type: 'tool_call', callId: 'test-call-1', status: 'completed', stepId: 'S005', tool: 'run_tests', ok: true, summary: 'npm test exit=0' });
    await opts.io?.emit({ type: 'result', command: 'run', status: 'ok', data: { executedSteps: 1 } });
    return { status: 'ok' };
  }
}

function req(id: number, method: string, params?: unknown): JsonRpcMessage {
  return { jsonrpc: '2.0', id, method, params };
}

function res(id: number | string, optionId: string): JsonRpcMessage {
  return { jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId } } };
}

async function makeServer(runtime = new FakeRuntime()): Promise<{ server: AcpServer; transport: MemoryTransport; runtime: FakeRuntime }> {
  const transport = new MemoryTransport();
  const server = new AcpServer({
    runtime,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  await server.start(transport);
  return { server, transport, runtime };
}

describe('ACP Code Agent adapter', () => {
  it('starts over stdio, keeps stdout JSON-RPC clean, and responds with standard initialize schema', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/xcompiler.ts', 'acp'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.write(JSON.stringify(req(1, AcpMethod.Initialize, { protocolVersion: 1, clientCapabilities: {}, meta: { name: 'zed' } })) + '\n');
    child.stdin.write(JSON.stringify(req(2, AcpMethod.Shutdown)) + '\n');
    child.stdin.end();
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`xcompiler acp timed out; stderr=${stderr}`));
      }, 5000);
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line).not.toMatch(/^Usage:|^Options:|✔|build_progress/u);
    }
    const init = JSON.parse(lines[0]!) as { result?: { protocolVersion?: number; agentCapabilities?: unknown; authMethods?: unknown[] } };
    expect(init.result?.protocolVersion).toBe(1);
    expect(init.result?.agentCapabilities).toBeTruthy();
    expect(init.result?.authMethods).toEqual([]);
  });

  it('runs the standard session/new -> session/prompt code-agent flow through Runtime', async () => {
    const { transport, runtime } = await makeServer();
    await transport.inject(req(1, AcpMethod.Initialize, { protocolVersion: 1, clientCapabilities: {}, meta: { name: 'test' } }));
    await transport.inject(req(2, AcpMethod.SessionNew, { cwd: root, mcpServers: [] }));
    const sessionId = (await transport.waitForResponse(2)).sessionId as string;
    await transport.inject(req(3, AcpMethod.SessionPrompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'fix failing tests' }],
    }));

    const confirmation = await transport.waitForClientRequest(AcpMethod.SessionRequestPermission, (params) => {
      const toolCall = params.toolCall as Record<string, unknown> | undefined;
      const meta = ((toolCall?._meta as Record<string, unknown> | undefined)?.xcompiler ?? {}) as Record<string, unknown>;
      return meta.eventType === 'build_confirmation_required';
    });
    await transport.inject(res(confirmation.id!, 'allow_once'));

    const permission = await transport.waitForClientRequest(AcpMethod.SessionRequestPermission, (params) => {
      const toolCall = params.toolCall as Record<string, unknown> | undefined;
      const meta = ((toolCall?._meta as Record<string, unknown> | undefined)?.xcompiler ?? {}) as Record<string, unknown>;
      return meta.eventType === 'permission_required';
    });
    await transport.inject(res(permission.id!, 'allow_once'));

    const promptResult = await transport.waitForResponse(3);
    expect(promptResult.stopReason).toBe('end_turn');
    expect(runtime.buildCalls).toHaveLength(1);
    expect(runtime.runCalls).toHaveLength(1);
    expect(runtime.runCalls[0]!.terminalOutput).toBe(false);
    const eventTypes = transport.events().map((event) => event.type);
    expect(eventTypes).toContain('build_started');
    expect(eventTypes).toContain('run_started');
    expect(eventTypes).toContain('test_started');
    expect(eventTypes).toContain('test_completed');
    expect(eventTypes).toContain('file_changed');
    expect(eventTypes).toContain('patch_proposed');
  });

  it('denies sensitive run operations through standard permission responses', async () => {
    const { transport } = await makeServer();
    await transport.inject(req(1, AcpMethod.SessionNew, { cwd: root, mcpServers: [] }));
    const sessionId = (await transport.waitForResponse(1)).sessionId as string;
    await transport.inject(req(2, AcpMethod.SessionPrompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'add feature' }],
    }));
    const confirmation = await transport.waitForClientRequest(AcpMethod.SessionRequestPermission, (params) => {
      const toolCall = params.toolCall as Record<string, unknown> | undefined;
      const meta = ((toolCall?._meta as Record<string, unknown> | undefined)?.xcompiler ?? {}) as Record<string, unknown>;
      return meta.eventType === 'build_confirmation_required';
    });
    await transport.inject(res(confirmation.id!, 'allow_once'));
    const permission = await transport.waitForClientRequest(AcpMethod.SessionRequestPermission, (params) => {
      const toolCall = params.toolCall as Record<string, unknown> | undefined;
      const meta = ((toolCall?._meta as Record<string, unknown> | undefined)?.xcompiler ?? {}) as Record<string, unknown>;
      return meta.eventType === 'permission_required';
    });
    await transport.inject(res(permission.id!, 'reject_once'));
    const promptResult = await transport.waitForResponse(2);
    expect(promptResult.stopReason).toBe('end_turn');
    const done = await transport.waitForEvent('task_completed');
    expect(done.status).toBe('failed');
    expect(transport.events().map((event) => event.type)).not.toContain('file_changed');
  });

  it('rejects ordinary run-phase interaction instead of turning ACP into chat', async () => {
    const runtime = new FakeRuntime();
    runtime.runOrdinaryInteraction = true;
    const { transport } = await makeServer(runtime);
    await transport.inject(req(1, AcpMethod.SessionNew, { cwd: root, mcpServers: [] }));
    const sessionId = (await transport.waitForResponse(1)).sessionId as string;
    await transport.inject(req(2, AcpMethod.SessionPrompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'run should not chat' }],
    }));
    const confirmation = await transport.waitForClientRequest(AcpMethod.SessionRequestPermission);
    await transport.inject(res(confirmation.id!, 'allow_once'));
    const error = await transport.waitForEvent('error');
    expect(error.update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
    });
    const done = await transport.waitForEvent('task_completed');
    expect(done.status).toBe('failed');
  });

  it('maps Build clarification choices to ACP permission options and returns the selected label', async () => {
    let answer = '';
    const runtime: AcpRuntimeFacade = {
      build: async (opts) => {
        answer = await opts.io!.interaction!.input({
          message: 'Q1 [functionality] Choose scope\n  ↳ Define the first delivery\n  A. Core only\n  B. Core and reports\n  Choose A-B or provide a custom answer',
        });
        await opts.io!.emit({ type: 'result', command: 'build', status: 'ok' });
        return { workspace: opts.workspace, planPath: path.join(opts.workspace, 'phasePlan.json') };
      },
      run: async () => ({ status: 'ok' }),
    };
    const transport = new MemoryTransport();
    const server = new AcpServer({
      runtime,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    await server.start(transport);
    await transport.inject(req(1, AcpMethod.SessionNew, { cwd: root, mcpServers: [] }));
    const sessionId = (await transport.waitForResponse(1)).sessionId as string;
    await transport.inject(req(2, AcpMethod.SessionPrompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'build with clarification' }],
      autoRunAfterBuild: false,
    }));
    const clarification = await transport.waitForClientRequest(AcpMethod.SessionRequestPermission);
    const options = ((clarification as { params?: Record<string, unknown> }).params?.options ?? []) as Array<Record<string, unknown>>;
    expect(options.map((option) => option.optionId)).toEqual(['A', 'B']);
    await transport.inject(res(clarification.id!, 'B'));
    await transport.waitForResponse(2);
    expect(answer).toBe('B');
  });

  it('cancels a task waiting for Build interaction and settles the prompt', async () => {
    const runtime: AcpRuntimeFacade = {
      build: async (opts) => {
        await opts.io!.interaction!.confirm({ message: 'Wait for cancellation', default: false });
        return { workspace: opts.workspace };
      },
      run: async () => ({ status: 'ok' }),
    };
    const transport = new MemoryTransport();
    const server = new AcpServer({
      runtime,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    await server.start(transport);
    await transport.inject(req(1, AcpMethod.SessionNew, { cwd: root, mcpServers: [] }));
    const sessionId = (await transport.waitForResponse(1)).sessionId as string;
    await transport.inject(req(2, AcpMethod.SessionPrompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'cancel this task' }],
    }));
    await transport.waitForClientRequest(AcpMethod.SessionRequestPermission);
    await transport.inject(req(3, AcpMethod.SessionCancel, { sessionId }));

    const cancellation = await transport.waitForResponse(3);
    expect(cancellation.cancelled).toBe(true);
    expect((await transport.waitForResponse(2)).stopReason).toBe('cancelled');
    const done = await transport.waitForEvent('task_completed');
    expect(done.status).toBe('cancelled');
  });

  it('maps protocol errors without crashing the server', async () => {
    const { transport } = await makeServer();
    await transport.inject(req(1, 'unknown/method'));
    const response = transport.sent.find((msg) => 'id' in msg && msg.id === 1) as { error?: { code: number } };
    expect(response.error?.code).toBe(-32601);
    await transport.inject({ jsonrpc: '2.0', id: 2, method: AcpMethod.SessionCancel, params: { sessionId: 'missing' } });
    const missing = transport.sent.find((msg) => 'id' in msg && msg.id === 2) as { error?: { code: number } };
    expect(missing.error?.code).toBe(-32001);
  });

  it('keeps ACP adapter out of core business internals', async () => {
    const files = await fs.readdir(path.join(root, 'src/acp'));
    const source = await Promise.all(files.filter((f) => f.endsWith('.ts')).map((file) => fs.readFile(path.join(root, 'src/acp', file), 'utf8')));
    const combined = source.join('\n');
    expect(combined).not.toMatch(/\.\.\/agents\/|\.\.\/core\/|\.\.\/sandbox\/|\.\.\/workspace\/|\.\.\/tools\/index/u);
    // 0.3 contract: adapters reach the Runtime only through its public facade, never through a
    // module inside src/runtime/.
    expect(combined).not.toMatch(/from '\.\.\/runtime\//u);
    expect(combined).toContain("from '../runtime.js'");
  });
});
