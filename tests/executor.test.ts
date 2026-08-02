import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { isCompleteTurnJson, StepExecutor } from '../src/agents/executor.js';
import type { ChatMessage, ChatOptions, LLMClient } from '../src/llm/types.js';
import type { Step } from '../src/core/plan.js';
import { getLanguageProfile } from '../src/core/language.js';
import type { Tool, ToolContext, ToolExecutionEvent } from '../src/tools/types.js';
import { readFileTool, writeFileTool } from '../src/tools/fs.js';
import { replaceInFileTool } from '../src/tools/edit.js';
import { runTestsTool } from '../src/tools/sandbox.js';

class CapturingLLM implements LLMClient {
  readonly name = 'cap';
  public lastSystem = '';
  public lastUser = '';
  async chat(messages: ChatMessage[], _o?: ChatOptions): Promise<string> {
    const sys = messages.find((m) => m.role === 'system');
    const users = messages.filter((m) => m.role === 'user');
    const user = users[users.length - 1];
    this.lastSystem = sys?.content ?? '';
    this.lastUser = user?.content ?? '';
    return JSON.stringify({
      thoughts: 'create file',
      actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } }],
      done: true,
    });
  }
}

let tmp: string;
let ws: Workspace;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-exec-'));
  ws = new Workspace(tmp);
  ctx = { ws, sandbox: undefined as never, allowedWrites: ['src/'], stepId: 'S010' };
});

const baseStep: Step = {
  id: 'S010',
  iterationId: 'P1',
  phase: 'CODE',
  title: 't',
  description: 'd',
  systemPrompt: '本 Step 专属：仅生成 src/x.py，禁止触碰其它文件。',
  role: 'Coder',
  tools: ['write_file'],
  inputs: [],
  outputs: ['src/x.py'],
  dependsOn: [],
  acceptance: 'src/x.py exists',
  maxAttempts: 3,
};

describe('StepExecutor system prompt assembly', () => {
  it('renders the readable Step name while retaining the canonical UUID in tool events', async () => {
    const canonicalId = '019fbc80-af28-728a-949c-1ac2396a57d0';
    const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const events: ToolExecutionEvent[] = [];
    const exec = new StepExecutor({ llm: new CapturingLLM(), maxRounds: 1, streamOutput: true });

    const result = await exec.run({
      step: { ...baseStep, id: canonicalId },
      stepName: 'P1-S004',
      tools: [writeFileTool],
      ctx: {
        ...ctx,
        stepId: canonicalId,
        onToolEvent: (event) => { events.push(event); },
      },
    });
    const output = writes.mock.calls.map((args) => String(args[0])).join('');
    writes.mockRestore();

    expect(result.success).toBe(true);
    expect(output).toContain('$ P1-S004 Coder round 1');
    expect(output).toMatch(/\$ P1-S004 (?:工具|tool) write_file/u);
    expect(output).not.toContain(canonicalId);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.stepId === canonicalId)).toBe(true);
    expect(events.every((event) => event.stepName === 'P1-S004')).toBe(true);
  });

  it('injects globalPrompt + step.systemPrompt into system message', async () => {
    const llm = new CapturingLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({
      step: baseStep,
      tools: [writeFileTool],
      ctx,
      globalPrompt: '项目背景：CLI 工具，全局禁止网络访问。',
    });
    expect(r.success).toBe(true);
    expect(llm.lastSystem).toContain('## Project-wide constraints');
    expect(llm.lastSystem).toContain('CLI 工具');
    expect(llm.lastSystem).toContain('## Current Step prompt');
    expect(llm.lastSystem).toContain('禁止触碰其它文件');
  });

  it('injects required path contracts and current Step path candidates into tool docs', async () => {
    const llm = new CapturingLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const r = await exec.run({
      step: { ...baseStep, inputs: ['docs/topic.md'], tools: ['read_file', 'write_file', 'replace_in_file'] },
      tools: [readFileTool, writeFileTool, replaceInFileTool],
      ctx,
    });

    expect(r.success).toBe(true);
    expect(llm.lastUser).toContain('read_file:');
    expect(llm.lastUser).toContain('args.path is required');
    expect(llm.lastUser).toContain('inputs=[docs/topic.md]');
    expect(llm.lastUser).toContain('outputs=[src/x.py]');
    expect(llm.lastUser).toContain('writable=[src/]');
    expect(llm.lastUser).toContain('The target must already exist');
  });

  it('keeps design-stage paired tests separate from CODE implementation ownership', async () => {
    const llm = new CapturingLLM();
    const designStep: Step = {
      ...baseStep,
      id: 'S003',
      phase: 'DETAILED_DESIGN',
      role: 'Architect',
      outputs: ['docs/03-detailed-design.md', 'tests/integration/pipeline.test.ts'],
    };
    await ws.writeFile('docs/03-detailed-design.md', '# design\n');
    await ws.writeFile('tests/integration/pipeline.test.ts', 'test("contract", () => {});\n');
    const exec = new StepExecutor({ llm, maxRounds: 1 });

    await exec.run({
      step: designStep,
      tools: [],
      ctx: {
        ...ctx,
        allowedWrites: designStep.outputs,
        stepId: designStep.id,
      },
    });

    expect(llm.lastUser).toContain('## phase write boundary');
    expect(llm.lastUser).toContain('product implementation belongs to CODE');
    expect(llm.lastUser).toContain('may import planned product source paths before those source files exist');
    expect(llm.lastUser).toContain('Do not create src/** stubs');
  });

  it('prioritizes exact missing outputs in the first model turn', async () => {
    const llm = new CapturingLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });

    const result = await exec.run({
      step: baseStep,
      tools: [writeFileTool],
      ctx,
    });

    expect(result.success).toBe(true);
    expect(llm.lastUser).toContain('## highest-priority required-output gate');
    expect(llm.lastUser).toContain('- src/x.py');
    expect(llm.lastUser).toContain('Create these exact paths before rewriting outputs that already exist');
  });

  it('returns a structured validation defect from a right-side test phase', async () => {
    class ValidationDefectLLM implements LLMClient {
      readonly name = 'validation-defect';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'the existing test omits the required error-path acceptance case',
          validationDefect:
            'tests/test_x.py has no case for the required invalid-input behavior in the unit test plan',
          actions: [],
          done: false,
        });
      }
    }
    const step: Step = {
      ...baseStep,
      id: 'S005',
      phase: 'UNIT_TEST',
      role: 'Tester',
      tools: [],
      outputs: [],
    };
    const exec = new StepExecutor({ llm: new ValidationDefectLLM(), maxRounds: 1 });

    const result = await exec.run({
      step,
      tools: [],
      ctx: { ...ctx, allowedWrites: [], stepId: step.id },
    });

    expect(result.success).toBe(false);
    expect(result.validationDefect).toContain('invalid-input behavior');
    expect(result.error).toContain('validation defect reported');
  });

  it('updates skill operation windows when the active LLM provider switches', async () => {
    class SwitchingWindowLLM implements LLMClient {
      readonly name = 'switching-window';
      prompts: string[] = [];
      maxTokens: number[] = [];

      async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        options?.onProviderStart?.('small', 'small-model', {
          contextWindowTokens: 32 * 1024,
          switched: false,
        });
        this.prompts.push(messages[1]?.content ?? '');
        this.maxTokens.push(options?.maxTokens ?? 0);
        options?.onProviderStart?.('large', 'large-model', {
          contextWindowTokens: 256 * 1024,
          switched: true,
        });
        this.prompts.push(messages[1]?.content ?? '');
        this.maxTokens.push(options?.maxTokens ?? 0);
        return JSON.stringify({
          thoughts: 'write after provider switch',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } }],
          done: true,
        });
      }
    }

    const llm = new SwitchingWindowLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1, maxWriteChunkBytes: 'auto' });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });

    expect(r.success).toBe(true);
    expect(llm.prompts[0]).toContain('context_window_tokens: 32768');
    expect(llm.prompts[1]).toContain('context_window_tokens: 262144');
    const readWindow = (prompt: string) =>
      Number(/write_content_chunk_bytes: (\d+)/u.exec(prompt)?.[1] ?? 0);
    expect(readWindow(llm.prompts[1]!)).toBeGreaterThan(readWindow(llm.prompts[0]!));
    expect(llm.maxTokens[1]).toBeGreaterThan(llm.maxTokens[0]!);
  });

  it('records executor.turn audit events with thoughts + actions', async () => {
    const { AuditLogger } = await import('../src/audit/audit.js');
    const audit = new AuditLogger({ root: tmp, command: 'test' });
    await audit.start({});
    const llm = new CapturingLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const ctxWithAudit = { ...ctx, audit };
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx: ctxWithAudit });
    expect(r.success).toBe(true);
    const jsonl = await fs.readFile(path.join(tmp, '.xcompiler/audit.jsonl'), 'utf8');
    const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l));
    const turns = lines.filter((l) => l.kind === 'executor.turn');
    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0].data.thoughts).toBe('create file');
    expect(turns[0].data.actions[0].tool).toBe('write_file');
    expect(turns[0].data.done).toBe(true);
  });

  it('uses the runtime execution role in prompts and audit events', async () => {
    const { AuditLogger } = await import('../src/audit/audit.js');
    const audit = new AuditLogger({ root: tmp, command: 'test' });
    await audit.start({});
    const llm = new CapturingLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const r = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [writeFileTool],
      ctx: { ...ctx, audit },
    });
    expect(r.success).toBe(true);
    expect(llm.lastUser).toContain('role: Debugger');
    expect(llm.lastUser).not.toContain('role: Coder');

    const jsonl = await fs.readFile(path.join(tmp, '.xcompiler/audit.jsonl'), 'utf8');
    const turns = jsonl.trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.kind === 'executor.turn');
    expect(turns[0].data.role).toBe('Debugger');
  });

  it('requires bugResolutionPlan before resolving a DEBUG Bug Ticket', async () => {
    class MissingPlanLLM implements LLMClient {
      readonly name = 'missing-plan';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'patch the Bug Ticket without a reusable plan',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 2\n' } }],
          done: true,
        });
      }
    }
    const exec = new StepExecutor({ llm: new MissingPlanLLM(), maxRounds: 1 });
    const r = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [writeFileTool],
      ctx,
      debugContext: {
        bugTicketId: 'BUG-1',
        reason: 'unit test failed',
        failureLog: 'AssertionError: expected x = 2',
        repairRequired: true,
      },
    });

    expect(r.success).toBe(false);
    expect(r.error).toContain('bugResolutionPlan');
    await expect(fs.access(path.join(tmp, 'src/x.py'))).rejects.toThrow();
    expect(r.toolCalls).toHaveLength(0);
  });

  it('accepts a corrected plan on the next round without executing the rejected repair', async () => {
    class CorrectedPlanLLM implements LLMClient {
      readonly name = 'corrected-plan';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        return this.calls === 1
          ? JSON.stringify({
              thoughts: 'try to repair before documenting the plan',
              actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 2\n' } }],
              done: false,
            })
          : JSON.stringify({
              thoughts: 'document and apply the scoped repair',
              bugResolutionPlan: 'The implementation is stale; update src/x.py and verify the declared output.',
              actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 3\n' } }],
              done: true,
            });
      }
    }
    const llm = new CorrectedPlanLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [writeFileTool],
      ctx,
      debugContext: {
        bugTicketId: 'BUG-1',
        reason: 'unit test failed',
        failureLog: 'AssertionError: expected x = 3',
        repairRequired: true,
      },
    });

    expect(r.success).toBe(true);
    expect(llm.calls).toBe(2);
    expect(await fs.readFile(path.join(tmp, 'src/x.py'), 'utf8')).toBe('x = 3\n');
    expect(r.toolCalls).toHaveLength(1);
  });

  it('reuses the first Bug Ticket plan for later repair actions in the same attempt', async () => {
    class PlanThenRepairLLM implements LLMClient {
      readonly name = 'plan-then-repair';
      calls = 0;
      async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'establish the plan and inspect the implicated source',
            bugResolutionPlan: 'Inspect src/x.py, update the stale value, and verify the declared output.',
            actions: [{ tool: 'read_file', args: { path: 'src/x.py' } }],
            done: false,
          });
        }
        const repairWithoutRepeatedPlan = JSON.stringify({
          thoughts: 'apply the already documented plan',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 4\n' } }],
          done: true,
        });
        expect(options?.validate).toBeTypeOf('function');
        expect(() => options!.validate!(repairWithoutRepeatedPlan)).not.toThrow();
        return repairWithoutRepeatedPlan;
      }
    }
    await ws.writeFile('src/x.py', 'x = 1\n');
    const llm = new PlanThenRepairLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({
      step: { ...baseStep, tools: ['read_file', 'write_file'] },
      executionRole: 'Debugger',
      tools: [readFileTool, writeFileTool],
      ctx,
      debugContext: {
        bugTicketId: 'BUG-1',
        reason: 'unit test failed: src/x.py is stale',
        failureLog: 'AssertionError: expected x = 4',
        repairRequired: true,
      },
    });

    expect(r.success).toBe(true);
    expect(r.bugResolutionPlan).toContain('Inspect src/x.py');
    expect(await fs.readFile(path.join(tmp, 'src/x.py'), 'utf8')).toBe('x = 4\n');
  });

  it('automatically runs the static CODE gate after a Debugger mutation', async () => {
    class RepairOnlyLLM implements LLMClient {
      readonly name = 'repair-only';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'apply the scoped compiler repair',
          bugResolutionPlan: 'Update src/x.ts, then run npx tsc --noEmit.',
          actions: [{ tool: 'write_file', args: { path: 'src/x.ts', content: 'export const x = 1;\n' } }],
          done: false,
        });
      }
    }
    let compilerRuns = 0;
    const runProgram: Tool = {
      name: 'run_program',
      description: 'controlled TypeScript compiler',
      argsSchema: { args: 'string[]' },
      async run(args) {
        compilerRuns++;
        expect(args).toEqual({ args: ['npx', 'tsc', '--noEmit'] });
        return { ok: true, summary: 'npx tsc --noEmit exit=0' };
      },
    };
    const step: Step = {
      ...baseStep,
      outputs: ['src/x.ts'],
      tools: ['write_file', 'run_program'],
    };
    const exec = new StepExecutor({ llm: new RepairOnlyLLM(), maxRounds: 1 });
    const r = await exec.run({
      step,
      executionRole: 'Debugger',
      languageProfile: getLanguageProfile('typescript'),
      tools: [writeFileTool, runProgram],
      ctx: { ...ctx, language: 'typescript' },
      debugContext: {
        bugTicketId: 'BUG-TS',
        reason: 'CODE validation failed',
        failureLog: 'src/x.ts(1,1): compiler error',
        repairRequired: true,
      },
    });

    expect(r.success).toBe(true);
    expect(compilerRuns).toBe(1);
    expect(r.toolCalls.map((call) => call.tool)).toEqual(['write_file', 'run_program']);
  });

  it('automatically reruns inherited rollback tests after a CODE Debugger mutation', async () => {
    class RollbackRepairLLM implements LLMClient {
      readonly name = 'rollback-repair';
      lastUser = '';
      async chat(messages: ChatMessage[]): Promise<string> {
        this.lastUser = messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
        return JSON.stringify({
          thoughts: 'repair the implementation exposed by the inherited unit gate',
          bugResolutionPlan: 'Update src/x.ts, then rerun the inherited unit test.',
          actions: [{ tool: 'write_file', args: { path: 'src/x.ts', content: 'export const x = 2;\n' } }],
          done: false,
        });
      }
    }
    const executed: string[] = [];
    const runProgram: Tool = {
      name: 'run_program',
      description: 'controlled TypeScript compiler',
      argsSchema: { args: 'string[]' },
      async run() {
        executed.push('tsc');
        return { ok: true, summary: 'tsc passed' };
      },
    };
    const runTests: Tool = {
      name: 'run_tests',
      description: 'controlled inherited unit gate',
      argsSchema: { args: 'string[]?' },
      async run(args, toolCtx) {
        executed.push('tests');
        expect(args).toEqual({});
        expect(toolCtx.defaultTestArgs).toEqual(['tests/unit/x.test.ts']);
        return { ok: true, summary: 'unit gate passed' };
      },
    };
    const step: Step = {
      ...baseStep,
      outputs: ['src/x.ts'],
      tools: ['write_file', 'run_program', 'run_tests'],
    };
    const llm = new RollbackRepairLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const r = await exec.run({
      step,
      executionRole: 'Debugger',
      languageProfile: getLanguageProfile('typescript'),
      tools: [writeFileTool, runProgram, runTests],
      ctx: {
        ...ctx,
        language: 'typescript',
        defaultTestArgs: ['tests/unit/x.test.ts'],
      },
      debugContext: {
        bugTicketId: 'BUG-ROLLBACK',
        reason: 'UNIT_TEST rollback failed',
        failureLog: 'tests/unit/x.test.ts failed',
        repairRequired: true,
        verificationScope: {
          stepId: 'S005',
          phase: 'UNIT_TEST',
          testArgs: ['tests/unit/x.test.ts'],
        },
      },
    });

    expect(r.success).toBe(true);
    expect(executed).toEqual(['tests']);
    expect(r.toolCalls.map((call) => call.tool)).toEqual(['write_file', 'run_tests']);
    expect(llm.lastUser).toContain('## inherited paired verification gate');
    expect(llm.lastUser).toContain('tests/unit/x.test.ts');
    expect(llm.lastUser).toContain('Do not run broad compiler or all-project test commands');
  });

  it('returns the DEBUG Bug Ticket resolution plan when the Bug Ticket is fixed', async () => {
    class PlannedLLM implements LLMClient {
      readonly name = 'planned';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'patch with a reusable plan',
          bugResolutionPlan: 'Root cause is stale implementation in src/x.py; update it and verify the declared output exists.',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 3\n' } }],
          done: true,
        });
      }
    }
    const exec = new StepExecutor({ llm: new PlannedLLM(), maxRounds: 1 });
    const r = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [writeFileTool],
      ctx,
      debugContext: {
        bugTicketId: 'BUG-1',
        reason: 'unit test failed',
        failureLog: 'AssertionError: expected x = 3',
        repairRequired: true,
      },
    });

    expect(r.success).toBe(true);
    expect(r.bugResolutionPlan).toContain('Root cause');
  });

  it('extends past the base round limit when successful writes reduce missing outputs', async () => {
    class ProductiveLLM implements LLMClient {
      readonly name = 'productive';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'write the first required output',
            actions: [{ tool: 'write_file', args: { path: 'src/a.py', content: 'a = 1\n' } }],
            done: false,
          });
        }
        return JSON.stringify({
          thoughts: 'write the remaining output',
          actions: [{ tool: 'write_file', args: { path: 'src/b.py', content: 'b = 1\n' } }],
          done: true,
        });
      }
    }
    const llm = new ProductiveLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const r = await exec.run({
      step: { ...baseStep, outputs: ['src/a.py', 'src/b.py'] },
      tools: [writeFileTool],
      ctx,
    });

    expect(r.success).toBe(true);
    expect(r.rounds).toBe(2);
    expect(llm.calls).toBe(2);
  });

  it('extends an existing-output step to verify a successful final-round mutation', async () => {
    class FinalWriteThenVerifyLLM implements LLMClient {
      readonly name = 'final-write-then-verify';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        return this.calls === 1
          ? JSON.stringify({
              thoughts: 'replace the existing test artifact on the base final round',
              actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 6\n' } }],
              done: false,
            })
          : JSON.stringify({
              thoughts: 'verify the mutation before completion',
              actions: [{ tool: 'run_tests', args: {} }],
              done: false,
            });
      }
    }
    await ws.writeFile('src/x.py', 'x = 1\n');
    const llm = new FinalWriteThenVerifyLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const r = await exec.run({
      step: baseStep,
      tools: [writeFileTool, runTestsTool],
      ctx: {
        ...ctx,
        sandbox: {
          async runProgram() { throw new Error('not used'); },
          async runTests() {
            return { exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false, durationMs: 1 };
          },
          async installDeps() { throw new Error('not used'); },
        } as never,
      },
    });

    expect(r.success).toBe(true);
    expect(r.rounds).toBe(2);
    expect(llm.calls).toBe(2);
  });

  it('extends a final mutation for verification even after an earlier malformed turn', async () => {
    class MalformedThenWriteThenVerifyLLM implements LLMClient {
      readonly name = 'malformed-write-verify';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) return 'not-json';
        if (this.calls === 2) {
          return JSON.stringify({
            thoughts: 'apply the repair after the malformed response',
            actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 8\n' } }],
            done: false,
          });
        }
        return JSON.stringify({
          thoughts: 'verify the latest repair',
          actions: [{ tool: 'run_tests', args: {} }],
          done: false,
        });
      }
    }
    await ws.writeFile('src/x.py', 'x = 1\n');
    const llm = new MalformedThenWriteThenVerifyLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({
      step: baseStep,
      tools: [writeFileTool, runTestsTool],
      ctx: {
        ...ctx,
        sandbox: {
          async runProgram() { throw new Error('not used'); },
          async runTests() {
            return { exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false, durationMs: 1 };
          },
          async installDeps() { throw new Error('not used'); },
        } as never,
      },
    });

    expect(r.success).toBe(true);
    expect(r.rounds).toBe(3);
    expect(llm.calls).toBe(3);
  });

  it('extends a repaired test after an earlier failed verification so it can be rerun', async () => {
    class FailRepairVerifyLLM implements LLMClient {
      readonly name = 'fail-repair-verify';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'reproduce the failure',
            actions: [{ tool: 'run_tests', args: {} }],
            done: false,
          });
        }
        if (this.calls === 2) {
          return JSON.stringify({
            thoughts: 'repair the failing artifact at the base round limit',
            actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 7\n' } }],
            done: false,
          });
        }
        return JSON.stringify({
          thoughts: 'verify the repair',
          actions: [{ tool: 'run_tests', args: {} }],
          done: false,
        });
      }
    }
    let testRuns = 0;
    const runTests: Tool = {
      name: 'run_tests',
      description: 'controlled test gate',
      argsSchema: {},
      async run() {
        testRuns++;
        return testRuns === 1
          ? { ok: false, error: 'test failed' }
          : { ok: true, summary: 'test passed' };
      },
    };
    await ws.writeFile('src/x.py', 'x = 1\n');
    const llm = new FailRepairVerifyLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool, runTests], ctx });

    expect(r.success).toBe(true);
    expect(r.rounds).toBe(3);
    expect(llm.calls).toBe(3);
  });

  it('keeps failed verification commands unresolved when a different command succeeds', async () => {
    class DifferentVerificationLLM implements LLMClient {
      readonly name = 'different-verification';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'run the compiler gate',
            actions: [{ tool: 'run_program', args: { command: 'npx tsc --noEmit', cwd: '.' } }],
            done: false,
          });
        }
        if (this.calls === 2) {
          return JSON.stringify({
            thoughts: 'inspect the current directory with a different command',
            actions: [{ tool: 'run_program', args: { command: 'pwd', cwd: '.' } }],
            done: false,
          });
        }
        return JSON.stringify({ thoughts: 'claim completion', actions: [], done: true });
      }
    }
    const runProgram: Tool = {
      name: 'run_program',
      description: 'controlled command runner',
      argsSchema: {},
      async run(args) {
        const command = (args as { command?: string }).command;
        return command === 'pwd'
          ? { ok: true, summary: '/workspace' }
          : { ok: false, error: 'tsc exit=2: TS2345 incompatible contract' };
      },
    };
    await ws.writeFile('src/x.py', 'x = 1\n');
    const exec = new StepExecutor({ llm: new DifferentVerificationLLM(), maxRounds: 3 });
    const r = await exec.run({
      step: { ...baseStep, tools: ['run_program'] },
      tools: [runProgram],
      ctx,
    });

    expect(r.success).toBe(false);
    expect(r.error).toContain('unresolved tool failures remain');
    expect(r.error).toContain('TS2345 incompatible contract');
  });

  it('stops an identical failed verification repeated without a successful mutation', async () => {
    class RepeatedVerificationLLM implements LLMClient {
      readonly name = 'repeated-verification';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'rerun the same compiler command without changing code',
          actions: [{ tool: 'run_program', args: { command: 'npx tsc --noEmit', cwd: '.' } }],
          done: false,
        });
      }
    }
    const runProgram: Tool = {
      name: 'run_program',
      description: 'always failing compiler gate',
      argsSchema: {},
      async run() {
        return { ok: false, error: 'tsc exit=2: TS2339 missing API' };
      },
    };
    await ws.writeFile('src/x.py', 'x = 1\n');
    const exec = new StepExecutor({ llm: new RepeatedVerificationLLM(), maxRounds: 4 });
    const r = await exec.run({
      step: { ...baseStep, tools: ['run_program'] },
      tools: [runProgram],
      ctx,
    });

    expect(r.success).toBe(false);
    expect(r.rounds).toBe(2);
    expect(r.toolCalls).toHaveLength(2);
    expect(r.error).toContain('verification command repeated without a successful mutation');
    expect(r.error).toContain('next attempt must patch/write');
  });

  it('stops an identical failed dependency mutation repeated without progress', async () => {
    class RepeatedDependencyLLM implements LLMClient {
      readonly name = 'repeated-dependency';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'repeat the same misspelled package',
          actions: [{ tool: 'add_dependency', args: { packages: ['cron-par'] } }],
          done: false,
        });
      }
    }
    const addDependency: Tool = {
      name: 'add_dependency',
      description: 'controlled dependency mutation',
      argsSchema: {},
      async run() {
        return { ok: false, error: 'npm 404 cron-par package not found; manifest restored' };
      },
    };
    await ws.writeFile('src/x.py', 'x = 1\n');
    const exec = new StepExecutor({ llm: new RepeatedDependencyLLM(), maxRounds: 4 });
    const result = await exec.run({
      step: { ...baseStep, tools: ['add_dependency'] },
      tools: [addDependency],
      ctx,
    });

    expect(result.success).toBe(false);
    expect(result.rounds).toBe(2);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.error).toContain('mutation action repeated without a successful mutation');
    expect(result.error).toContain('different repair strategy');
  });

  it('does not count adding an already-present dependency as Debugger repair evidence', async () => {
    class NoopDependencyLLM implements LLMClient {
      readonly name = 'noop-dependency';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'claim repair by adding an existing dependency',
          actions: [{ tool: 'add_dependency', args: { packages: ['cheerio'] } }],
          done: true,
        });
      }
    }
    const addDependency: Tool = {
      name: 'add_dependency',
      description: 'no-op dependency mutation',
      argsSchema: {},
      async run() {
        return {
          ok: true,
          summary: 'add_dependency package.json +0 (none new; sandbox rebuild skipped)',
          data: { added: [], finalLines: ['cheerio'] },
        };
      },
    };
    await ws.writeFile('src/x.py', 'x = 1\n');
    const exec = new StepExecutor({ llm: new NoopDependencyLLM(), maxRounds: 1 });
    const result = await exec.run({
      step: { ...baseStep, tools: ['add_dependency'] },
      executionRole: 'Debugger',
      tools: [addDependency],
      ctx,
      debugContext: {
        reason: 'compiler failure',
        failureLog: 'error TS2339: missing contract',
        repairRequired: true,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('without repair evidence');
  });

  it('does not count an identical write_file rewrite as Debugger repair evidence', async () => {
    class NoopWriteLLM implements LLMClient {
      readonly name = 'noop-write';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'claim repair by rewriting identical bytes',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } }],
          done: true,
        });
      }
    }
    await ws.writeFile('src/x.py', 'x = 1\n');
    const exec = new StepExecutor({ llm: new NoopWriteLLM(), maxRounds: 1 });
    const result = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [writeFileTool],
      ctx,
      debugContext: {
        reason: 'compiler failure',
        failureLog: 'error TS2339: missing contract',
        repairRequired: true,
      },
    });

    expect(result.success).toBe(false);
    expect(result.toolCalls[0]?.summary).toContain('unchanged');
    expect(result.error).toContain('without repair evidence');
  });

  it('omits executed write payloads from assistant history instead of inventing contentBytes args', async () => {
    class HistoryInspectingLLM implements LLMClient {
      readonly name = 'history-inspecting';
      calls = 0;
      assistantHistory = '';
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'write a large generated artifact',
            actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'sensitive generated payload\n' } }],
            done: false,
          });
        }
        this.assistantHistory = messages.filter((message) => message.role === 'assistant').at(-1)?.content ?? '';
        return JSON.stringify({ thoughts: 'outputs are complete', actions: [], done: true });
      }
    }
    const llm = new HistoryInspectingLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });

    expect(r.success).toBe(true);
    expect(llm.assistantHistory).toContain('payload omitted');
    expect(llm.assistantHistory).not.toContain('contentBytes');
    expect(llm.assistantHistory).not.toContain('sensitive generated payload');
    expect(JSON.parse(llm.assistantHistory).actions).toEqual([]);
  });

  it('parses LLM output that contains multiple back-to-back ```json blocks (uses first)', async () => {
    class MultiBlockLLM implements LLMClient {
      readonly name = 'multi';
      async chat(): Promise<string> {
        return [
          '```json',
          JSON.stringify({
            thoughts: 'first block: write file',
            actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } }],
            done: false,
          }),
          '```',
          '',
          '```json',
          JSON.stringify({ thoughts: 'second block', actions: [], done: true }),
          '```',
        ].join('\n');
      }
    }
    const exec = new StepExecutor({ llm: new MultiBlockLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    // 第一轮就应该执行到 write_file，并产出 src/x.py。
    // 由于 done=false，executor 会到 maxRounds 才停；但 toolCalls 必须包含 write_file，
    // 文件也必须真的写出来——这正是修复前 actions=[] 时不会发生的事。
    expect(r.success).toBe(false);
    expect(r.toolCalls.find((c) => c.tool === 'write_file' && c.ok)).toBeTruthy();
    const written = await fs.readFile(path.join(tmp, 'src/x.py'), 'utf8');
    expect(written).toBe('x = 1\n');
  });

  it('normalizes a provider-native tool_use object into an executor action', async () => {
    class NativeToolUseLLM implements LLMClient {
      readonly name = 'native-tool-use';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            type: 'tool_use',
            id: 'toolu_test',
            name: 'write_file',
            input: { path: 'src/x.py', content: 'x = 11\n' },
          });
        }
        return JSON.stringify({ thoughts: 'complete', actions: [], done: true });
      }
    }
    const llm = new NativeToolUseLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const result = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });

    expect(result.success).toBe(true);
    expect(llm.calls).toBe(2);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: 'write_file', ok: true }),
    ]);
    expect(await ws.readFile('src/x.py')).toBe('x = 11\n');
  });

  it('does not execute a mutation recovered from structurally incomplete JSON', async () => {
    class TruncatedMutationLLM implements LLMClient {
      readonly name = 'truncated-mutation';
      async chat(): Promise<string> {
        return '{"thoughts":"replace method","actions":[{"tool":"replace_in_file","args":' +
          '{"path":"src/x.py","find":"stale","replace":"export';
      }
    }
    await ws.writeFile('src/x.py', 'stale\n');
    const exec = new StepExecutor({ llm: new TruncatedMutationLLM(), maxRounds: 1 });
    const result = await exec.run({
      step: { ...baseStep, tools: ['replace_in_file'] },
      tools: [replaceInFileTool],
      ctx,
    });

    expect(result.success).toBe(false);
    expect(result.toolCalls).toHaveLength(0);
    expect(await ws.readFile('src/x.py')).toBe('stale\n');
  });

  it('does not stop a provider stream on a repairable but incomplete file payload', () => {
    expect(isCompleteTurnJson(
      '{"thoughts":"write test","actions":[{"tool":"write_file","args":{"path":"tests/x.test.ts","content":"import',
    )).toBe(false);
    expect(isCompleteTurnJson(JSON.stringify({
      thoughts: 'write test',
      actions: [{ tool: 'write_file', args: { path: 'tests/x.test.ts', content: 'import { it } from "vitest";\n' } }],
      done: false,
    }))).toBe(true);
  });

  it('completes declarative design phases after verified output mutations without an extra handshake round', async () => {
    class DeclarativeWriterLLM implements LLMClient {
      readonly name = 'declarative-writer';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        return JSON.stringify({
          thoughts: 'write both declared design artifacts',
          actions: [
            {
              tool: 'write_file',
              args: { path: 'docs/03-detailed-design.md', content: '# Detailed Design\n' },
            },
            {
              tool: 'write_file',
              args: { path: 'docs/tests/integration-test-plan.md', content: '# Integration Test Plan\n' },
            },
          ],
          done: false,
        });
      }
    }
    const llm = new DeclarativeWriterLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const result = await exec.run({
      step: {
        ...baseStep,
        phase: 'DETAILED_DESIGN',
        role: 'Architect',
        tools: ['write_file'],
        outputs: ['docs/03-detailed-design.md', 'docs/tests/integration-test-plan.md'],
      },
      tools: [writeFileTool],
      ctx: { ...ctx, allowedWrites: ['docs/'] },
    });

    expect(result.success).toBe(true);
    expect(result.rounds).toBe(1);
    expect(llm.calls).toBe(1);
  });

  it('keeps a gated Step in the same conversation until quality evidence is supplied', async () => {
    class QualityHandshakeLLM implements LLMClient {
      readonly name = 'quality-handshake';
      calls = 0;
      sawQualityFeedback = false;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'write the declared design artifact',
            qualityAssessment: {
              completion: 0,
              upstreamAlignment: 0,
              metrics: {},
              tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
              evidence: [],
              gaps: ['all declared outputs have not been created yet'],
            },
            actions: [{
              tool: 'write_file',
              args: { path: 'docs/03-detailed-design.md', content: '# Detailed Design\n' },
            }],
            done: false,
          });
        }
        this.sawQualityFeedback = messages.at(-1)?.content.includes(
          'Quality gate protocol is incomplete',
        ) ?? false;
        return JSON.stringify({
          thoughts: 'submit evidence for the verified artifact without rewriting it',
          qualityAssessment: {
            completion: 1,
            upstreamAlignment: 1,
            metrics: {},
            tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
            evidence: ['docs/03-detailed-design.md'],
            gaps: [],
          },
          actions: [],
          done: true,
        });
      }
    }
    const llm = new QualityHandshakeLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const result = await exec.run({
      step: {
        ...baseStep,
        phase: 'DETAILED_DESIGN',
        role: 'Architect',
        tools: ['write_file'],
        outputs: ['docs/03-detailed-design.md'],
        qualityGate: {
          completionMin: 0.95,
          upstreamAlignmentMin: 0.9,
          metrics: {},
          tolerance: {
            metricShortfall: 0.02,
            maxFailedTests: 0,
            maxSkippedTests: 0,
            maxWarnings: 0,
          },
        },
      },
      tools: [writeFileTool],
      ctx: { ...ctx, allowedWrites: ['docs/'] },
    });

    expect(result.success).toBe(true);
    expect(result.rounds).toBe(2);
    expect(llm.calls).toBe(2);
    expect(llm.sawQualityFeedback).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
  });

  it('hands a measured test-quality gap to the outer Ticket gate without looping on the failed probe', async () => {
    class CoverageGapLLM implements LLMClient {
      readonly name = 'coverage-gap';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'attempt the required coverage probe',
            actions: [{ tool: 'run_tests', args: { args: ['--coverage'] } }],
            done: false,
          });
        }
        return JSON.stringify({
          thoughts: 'report the missing provider as a measured quality gap for Enhancement routing',
          qualityAssessment: {
            completion: 1,
            upstreamAlignment: 1,
            metrics: { testCasePassRate: 1 },
            tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
            evidence: ['reports/unit-test-report.md'],
            gaps: [
              'lineCoverage is unavailable because @vitest/coverage-v8 is missing',
              'branchCoverage is unavailable because @vitest/coverage-v8 is missing',
            ],
          },
          actions: [],
          done: true,
        });
      }
    }
    await ws.writeFile('reports/unit-test-report.md', '# Unit report\n');
    const runTests: Tool = {
      name: 'run_tests',
      description: 'coverage probe',
      argsSchema: { args: 'string[]?' },
      async run() {
        return {
          ok: false,
          error: "MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'",
        };
      },
    };
    const llm = new CoverageGapLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const result = await exec.run({
      step: {
        ...baseStep,
        phase: 'UNIT_TEST',
        role: 'Tester',
        tools: ['run_tests'],
        outputs: ['reports/unit-test-report.md'],
        qualityGate: {
          metrics: { lineCoverage: 0.8, branchCoverage: 0.7, testCasePassRate: 1 },
          tolerance: {
            metricShortfall: 0.02,
            maxFailedTests: 0,
            maxSkippedTests: 0,
            maxWarnings: 2,
          },
        },
      },
      executionRole: 'Tester',
      tools: [runTests],
      ctx: { ...ctx, allowedWrites: ['reports/unit-test-report.md'] },
    });

    expect(result.success).toBe(true);
    expect(result.rounds).toBe(2);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: 'run_tests', ok: false }),
    ]);
    expect(result.qualityAssessment?.gaps).toHaveLength(2);
  });

  it('rejects a stale metric gap when the current attempt has no failed measurement probe', async () => {
    class StaleCoverageGapLLM implements LLMClient {
      readonly name = 'stale-coverage-gap';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'run only the plain test gate',
            actions: [{ tool: 'run_tests', args: {} }],
            done: false,
          });
        }
        return JSON.stringify({
          thoughts: 'reuse an old missing-provider finding without measuring coverage',
          qualityAssessment: {
            completion: 1,
            upstreamAlignment: 1,
            metrics: { testCasePassRate: 1 },
            tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
            evidence: ['plain tests passed'],
            gaps: [
              'lineCoverage is unavailable because the provider is missing',
              'branchCoverage is unavailable because the provider is missing',
            ],
          },
          actions: [],
          done: true,
        });
      }
    }
    const runTests: Tool = {
      name: 'run_tests',
      description: 'test gate',
      argsSchema: { args: 'string[]?' },
      async run() {
        return { ok: true, summary: '2 tests passed' };
      },
    };
    const llm = new StaleCoverageGapLLM();
    const result = await new StepExecutor({ llm, maxRounds: 2 }).run({
      step: {
        ...baseStep,
        phase: 'UNIT_TEST',
        role: 'Tester',
        tools: ['run_tests'],
        outputs: [],
        qualityGate: {
          metrics: { lineCoverage: 0.8, branchCoverage: 0.7, testCasePassRate: 1 },
          tolerance: {
            metricShortfall: 0.02,
            maxFailedTests: 0,
            maxSkippedTests: 0,
            maxWarnings: 2,
          },
        },
      },
      executionRole: 'Tester',
      tools: [runTests],
      ctx,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lineCoverage|quality assessment/u);
    expect(llm.calls).toBe(2);
  });

  it('does not hide unresolved verification failures behind stale quality evidence', async () => {
    class FailedVerificationAfterAssessmentLLM implements LLMClient {
      readonly name = 'failed-verification-after-assessment';
      calls = 0;

      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'record the current artifact assessment before verification',
            qualityAssessment: {
              completion: 1,
              upstreamAlignment: 1,
              metrics: {},
              tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
              evidence: ['src/x.py'],
              gaps: [],
            },
            actions: [],
            done: false,
          });
        }
        return JSON.stringify({
          thoughts: 'run the compiler gate',
          bugResolutionPlan: 'Use the current compiler result to identify the stale contract, patch it, and rerun the same gate.',
          actions: [{ tool: 'run_program', args: { args: ['npx', 'tsc', '--noEmit'] } }],
          done: false,
        });
      }
    }
    const failingProgramTool: Tool<Record<string, unknown>> = {
      name: 'run_program',
      description: 'run a program',
      argsSchema: { args: 'string[]' },
      async run() {
        return {
          ok: false,
          error: 'npx tsc --noEmit exit=2: src/x.py(1,1): error TS2339: Property api is missing',
        };
      },
    };
    await ws.writeFile('src/x.py', 'x = 1\n');
    const exec = new StepExecutor({
      llm: new FailedVerificationAfterAssessmentLLM(),
      maxRounds: 2,
    });
    const result = await exec.run({
      step: {
        ...baseStep,
        tools: ['run_program'],
        qualityGate: {
          completionMin: 0.95,
          upstreamAlignmentMin: 0.9,
          metrics: {},
          tolerance: {
            metricShortfall: 0.02,
            maxFailedTests: 0,
            maxSkippedTests: 0,
            maxWarnings: 0,
          },
        },
      },
      executionRole: 'Debugger',
      tools: [failingProgramTool],
      ctx,
      debugContext: {
        bugTicketId: 'BUG-VERIFY-FAILURE',
        reason: 'CODE validation failed: tsc --noEmit exit=2',
        failureLog: 'src/x.py(1,1): error TS2339: Property api is missing',
        repairRequired: true,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('npx tsc --noEmit exit=2');
    expect(result.error).not.toContain('qualityAssessment.postToolEvidence');
  });

  it('keeps empty or whitespace-only declared artifacts in the missing-output set', async () => {
    class EmptyArtifactLLM implements LLMClient {
      readonly name = 'empty-artifact';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'incorrectly create an empty report',
          actions: [{ tool: 'write_file', args: { path: 'docs/03-detailed-design.md', content: '\n' } }],
          done: true,
        });
      }
    }
    const exec = new StepExecutor({ llm: new EmptyArtifactLLM(), maxRounds: 1 });
    const result = await exec.run({
      step: {
        ...baseStep,
        phase: 'DETAILED_DESIGN',
        role: 'Architect',
        tools: ['write_file'],
        outputs: ['docs/03-detailed-design.md'],
      },
      tools: [writeFileTool],
      ctx: { ...ctx, allowedWrites: ['docs/'] },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing outputs: docs/03-detailed-design.md');
  });

  it('repairs common trailing-comma JSON mistakes so actions still run', async () => {
    class TrailingCommaLLM implements LLMClient {
      readonly name = 'trailing-comma';
      async chat(): Promise<string> {
        return `{
  "thoughts": "create file",
  "actions": [
    { "tool": "write_file", "args": { "path": "src/x.py", "content": "x = 1\\n" } },
  ],
  "done": true
}`;
      }
    }
    const exec = new StepExecutor({ llm: new TrailingCommaLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'write_file' && c.ok)).toBeTruthy();
    const written = await fs.readFile(path.join(tmp, 'src/x.py'), 'utf8');
    expect(written).toBe('x = 1\n');
  });

  it('salvages valid tool calls from a malformed actions list', async () => {
    class MalformedActionsListLLM implements LLMClient {
      readonly name = 'malformed-actions-list';
      async chat(): Promise<string> {
        return [
          '{"thoughts":"write two outputs","actions":[',
          '{"tool":"write_file","args":{"path":"src/a.py","content":"a = 1\\n"}}',
          ']},',
          '{"tool":"write_file","args":{"path":"src/b.py","content":"b = 1\\n"}}',
          '],"done":true}',
        ].join('');
      }
    }
    const exec = new StepExecutor({ llm: new MalformedActionsListLLM(), maxRounds: 1 });
    const r = await exec.run({
      step: { ...baseStep, outputs: ['src/a.py', 'src/b.py'] },
      tools: [writeFileTool],
      ctx,
    });

    expect(r.success).toBe(true);
    expect(r.toolCalls.filter((c) => c.tool === 'write_file' && c.ok)).toHaveLength(2);
    expect(await fs.readFile(path.join(tmp, 'src/a.py'), 'utf8')).toBe('a = 1\n');
    expect(await fs.readFile(path.join(tmp, 'src/b.py'), 'utf8')).toBe('b = 1\n');
  });

  it('repairs malformed code-string JSON with raw newlines and unescaped inner quotes', async () => {
    class BrokenCodeJsonLLM implements LLMClient {
      readonly name = 'broken-code-json';
      async chat(): Promise<string> {
        return `{
  "thoughts": "create file",
  "actions": [
    { "tool": "write_file", "args": { "path": "src/x.py", "content": "def run():
    print("x")
    return None
" } }
  ],
  "done": true
}`;
      }
    }
    const exec = new StepExecutor({ llm: new BrokenCodeJsonLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'write_file' && c.ok)).toBeTruthy();
    const written = await fs.readFile(path.join(tmp, 'src/x.py'), 'utf8');
    expect(written).toBe('def run():\n    print("x")\n    return None\n');
  });

  it('ignores malformed action entries without crashing history compaction', async () => {
    const { AuditLogger } = await import('../src/audit/audit.js');
    const audit = new AuditLogger({ root: tmp, command: 'test' });
    await audit.start({});
    class MalformedActionLLM implements LLMClient {
      readonly name = 'malformed-action';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'write file and accidentally put done in actions',
          actions: [
            { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } },
            { done: true },
          ],
          done: true,
        });
      }
    }

    const exec = new StepExecutor({ llm: new MalformedActionLLM(), maxRounds: 2 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx: { ...ctx, audit } });

    expect(r.success).toBe(true);
    expect(await ws.exists('src/x.py')).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'invalid_action' && !c.ok)?.error).toContain('missing string tool');
    const jsonl = await fs.readFile(path.join(tmp, '.xcompiler/audit.jsonl'), 'utf8');
    expect(jsonl).toContain('audit.executor_invalid_actions_ignored');
  });

  it('does not accept done=true while tool failures remain unresolved', async () => {
    class FailedToolLLM implements LLMClient {
      readonly name = 'failed-tool';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'write required output but also attempted a denied file',
          actions: [
            { tool: 'write_file', args: { path: 'outside/x.py', content: 'bad = True\n' } },
            { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } },
          ],
          done: true,
        });
      }
    }
    const exec = new StepExecutor({ llm: new FailedToolLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(false);
    expect(r.error).toContain('unresolved tool failures remain');
    expect(r.toolCalls.find((c) => c.tool === 'write_file' && !c.ok)?.error).toContain('write denied');
    await expect(fs.readFile(path.join(tmp, 'src/x.py'), 'utf8')).resolves.toBe('x = 1\n');
  });

  it('allows completion when a pathless write_file arg failure is repaired by a later valid write_file', async () => {
    class MissingPathThenValidWriteLLM implements LLMClient {
      readonly name = 'missing-path-then-valid-write';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'first malformed write is followed by the real required output',
          actions: [
            { tool: 'write_file', args: { content: '# missing path\n' } },
            { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } },
          ],
          done: true,
        });
      }
    }
    const exec = new StepExecutor({ llm: new MissingPathThenValidWriteLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'write_file' && !c.ok)?.error).toContain('path must be a non-empty string');
    await expect(fs.readFile(path.join(tmp, 'src/x.py'), 'utf8')).resolves.toBe('x = 1\n');
  });

  it('rejects a pathless replace before permission or execution and feeds back a concrete correction', async () => {
    class MissingPathThenValidReplaceLLM implements LLMClient {
      readonly name = 'missing-path-then-valid-replace';
      calls = 0;
      secondUser = '';

      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'attempt a replacement but accidentally omit the target',
            actions: [{ tool: 'replace_in_file', args: { find: 'old', replace: 'new' } }],
            done: false,
          });
        }
        this.secondUser = messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
        return JSON.stringify({
          thoughts: 'retry with the declared concrete target',
          actions: [{ tool: 'replace_in_file', args: { path: 'src/x.py', find: 'old', replace: 'new' } }],
          done: true,
        });
      }
    }

    await ws.writeFile('src/x.py', 'value = "old"\n');
    const llm = new MissingPathThenValidReplaceLLM();
    const permissionTargets: string[] = [];
    const startedTargets: Array<string | undefined> = [];
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({
      step: { ...baseStep, tools: ['replace_in_file'] },
      tools: [replaceInFileTool],
      ctx: {
        ...ctx,
        requestPermission: async (request) => {
          permissionTargets.push(request.target);
          return { approved: true };
        },
        onToolEvent: (event) => {
          if (event.status === 'started') startedTargets.push(event.target);
        },
      },
    });

    expect(r.success).toBe(true);
    expect(r.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'replace_in_file',
        ok: false,
        error: expect.stringContaining('path must be a non-empty string'),
      }),
      expect.objectContaining({ tool: 'replace_in_file', ok: true }),
    ]);
    expect(permissionTargets).toEqual(['src/x.py']);
    expect(startedTargets).toEqual(['src/x.py']);
    expect(llm.secondUser).toContain('Tool contract violation');
    expect(llm.secondUser).toContain('current Step inputs, outputs, or writable allowlist');
    await expect(ws.readFile('src/x.py')).resolves.toBe('value = "new"\n');
  });

  it('allows completion when a bad edit target is superseded by rewrite plus tests', async () => {
    class BadEditThenRewriteAndTestLLM implements LLMClient {
      readonly name = 'bad-edit-then-rewrite-and-test';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'bad edit target is followed by a complete rewrite and verification',
          actions: [
            { tool: 'replace_in_file', args: { path: '.', find: 'old', replace: 'new' } },
            { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 4\n' } },
            { tool: 'run_tests', args: {} },
          ],
          done: true,
        });
      }
    }
    const exec = new StepExecutor({ llm: new BadEditThenRewriteAndTestLLM(), maxRounds: 1 });
    const r = await exec.run({
      step: baseStep,
      tools: [replaceInFileTool, writeFileTool, runTestsTool],
      ctx: {
        ...ctx,
        sandbox: {
          async runProgram() { throw new Error('not used'); },
          async runTests() {
            return { exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false, durationMs: 1 };
          },
          async installDeps() { throw new Error('not used'); },
        } as never,
      },
    });

    expect(r.success).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'replace_in_file' && !c.ok)?.error).toContain('outside the project directory');
    await expect(fs.readFile(path.join(tmp, 'src/x.py'), 'utf8')).resolves.toBe('x = 4\n');
  });

  it('allows a successful test rerun to supersede a denied optional dependency action', async () => {
    class OptionalCoverageThenPlainTestLLM implements LLMClient {
      readonly name = 'optional-coverage-then-plain-test';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'write tests, then fall back from optional coverage to the configured test gate',
          actions: [
            { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 5\n' } },
            { tool: 'add_dependency', args: { name: '@vitest/coverage-v8', dev: true } },
            { tool: 'run_tests', args: {} },
          ],
          done: false,
        });
      }
    }
    const exec = new StepExecutor({ llm: new OptionalCoverageThenPlainTestLLM(), maxRounds: 1 });
    const r = await exec.run({
      step: baseStep,
      tools: [writeFileTool, runTestsTool],
      ctx: {
        ...ctx,
        sandbox: {
          async runProgram() { throw new Error('not used'); },
          async runTests() {
            return { exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false, durationMs: 1 };
          },
          async installDeps() { throw new Error('not used'); },
        } as never,
      },
    });

    expect(r.success).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'add_dependency')?.error).toContain('tool not allowed');
    expect(r.toolCalls.at(-1)).toMatchObject({ tool: 'run_tests', ok: true });
  });

  it('allows completion after an unauthorized read-only probe once outputs are written', async () => {
    class ReadProbeThenWriteLLM implements LLMClient {
      readonly name = 'read-probe-then-write';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'try reading, then write required output',
          actions: [
            { tool: 'read_file', args: { path: 'src/x.py' } },
            { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } },
          ],
          done: true,
        });
      }
    }
    const exec = new StepExecutor({ llm: new ReadProbeThenWriteLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'read_file' && !c.ok)?.error).toContain('tool not allowed');
    await expect(fs.readFile(path.join(tmp, 'src/x.py'), 'utf8')).resolves.toBe('x = 1\n');
  });

  it('does not make unauthorized downstream verification tools permanent blockers in a development phase', async () => {
    class DeferredVerificationLLM implements LLMClient {
      readonly name = 'deferred-verification';
      private calls = 0;

      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'attempt verification before checking the current phase tool boundary',
            actions: [
              { tool: 'run_tests', args: {} },
              { tool: 'run_program', args: { args: ['src/x.py'] } },
            ],
            done: false,
          });
        }
        return JSON.stringify({
          thoughts: 'accept the authored artifact and defer execution to its paired test phase',
          qualityAssessment: {
            completion: 1,
            upstreamAlignment: 1,
            metrics: {},
            tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
            evidence: ['src/x.py exists and is non-empty'],
            gaps: [],
          },
          actions: [],
          done: true,
        });
      }
    }
    await ws.writeFile('src/x.py', 'x = 1\n');
    const exec = new StepExecutor({ llm: new DeferredVerificationLLM(), maxRounds: 2 });
    const result = await exec.run({
      step: {
        ...baseStep,
        qualityGate: {
          completionMin: 0.95,
          upstreamAlignmentMin: 0.9,
          metrics: {},
          tolerance: {
            metricShortfall: 0.02,
            maxFailedTests: 0,
            maxSkippedTests: 0,
            maxWarnings: 0,
          },
        },
      },
      tools: [writeFileTool],
      ctx,
    });

    expect(result.success).toBe(true);
    expect(result.rounds).toBe(2);
    expect(result.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'run_tests', ok: false }),
      expect.objectContaining({ tool: 'run_program', ok: false }),
    ]));
  });

  it('clears a missing output read_file failure when the same output is later written', async () => {
    class MissingOutputProbeThenWriteLLM implements LLMClient {
      readonly name = 'missing-output-probe-then-write';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'probe the expected output, then create it',
          actions: [
            { tool: 'read_file', args: { path: 'src/x.py' } },
            { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } },
          ],
          done: true,
        });
      }
    }
    const exec = new StepExecutor({ llm: new MissingOutputProbeThenWriteLLM(), maxRounds: 1 });
    const r = await exec.run({
      step: { ...baseStep, tools: ['read_file', 'write_file'] },
      tools: [readFileTool, writeFileTool],
      ctx,
    });
    expect(r.success).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'read_file' && !c.ok)?.error).toMatch(/ENOENT|no such file/i);
    await expect(fs.readFile(path.join(tmp, 'src/x.py'), 'utf8')).resolves.toBe('x = 1\n');
  });

  it('truncates long tool failures before feeding them back to the LLM', async () => {
    class LongFailureLLM implements LLMClient {
      readonly name = 'long-failure';
      public secondUser = '';
      private calls = 0;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls === 2) {
          this.secondUser = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        }
        return this.calls === 1
          ? JSON.stringify({
              thoughts: 'trigger long failure',
              actions: [{ tool: 'huge_fail', args: {} }],
              done: false,
            })
          : JSON.stringify({ thoughts: 'stop after feedback', actions: [], done: true });
      }
    }
    const hugeFailTool: Tool<Record<string, never>, never> = {
      name: 'huge_fail',
      description: 'returns a huge error',
      argsSchema: {},
      async run() {
        return { ok: false, error: `prefix-${'x'.repeat(5000)}-suffix` };
      },
    };
    const llm = new LongFailureLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({ step: { ...baseStep, tools: ['huge_fail'] }, tools: [hugeFailTool], ctx });

    expect(r.success).toBe(false);
    expect(llm.secondUser.length).toBeLessThan(3200);
    expect(llm.secondUser).toContain('[truncated');
    expect(llm.secondUser).not.toContain('x'.repeat(3000));
  });

  it('stops a test step after the configured run_tests failure budget is exhausted', async () => {
    class RepeatingTestFailureLLM implements LLMClient {
      readonly name = 'test-failure-loop';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        return JSON.stringify({
          thoughts: 'run the test gate again',
          actions: [{ tool: 'run_tests', args: { args: ['tests/test_integration.py'] } }],
          done: false,
        });
      }
    }
    const failingRunTestsTool: Tool<{ args?: string[] }, never> = {
      name: 'run_tests',
      description: 'runs pytest and fails',
      argsSchema: { args: 'string[]' },
      async run() {
        return { ok: false, error: 'pytest exit=1\nsrc/parser.py: receivers bug' };
      },
    };
    const llm = new RepeatingTestFailureLLM();
    const exec = new StepExecutor({ llm, maxRounds: 6, maxFailedTestRuns: 2 });
    const testStep: Step = {
      ...baseStep,
      phase: 'INTEGRATION_TEST',
      role: 'Tester',
      tools: ['run_tests'],
      outputs: [],
    };

    const r = await exec.run({ step: testStep, tools: [failingRunTestsTool], ctx });

    expect(r.success).toBe(false);
    expect(r.rounds).toBe(2);
    expect(llm.calls).toBe(2);
    expect(r.error).toContain('V-model rollback');
  });

  it('accepts completion evidence from a successful verification tool even without done=true', async () => {
    class VerifyWithoutDoneLLM implements LLMClient {
      readonly name = 'verify-without-done';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'tests passed, but forgot to declare done',
          actions: [{ tool: 'run_tests', args: { args: [] } }],
          done: false,
        });
      }
    }
    const runTestsTool: Tool = {
      name: 'run_tests',
      description: 'fake pytest',
      argsSchema: {},
      async run() {
        return { ok: true, summary: 'pytest passed' };
      },
    };
    await ws.writeFile('src/x.py', 'x = 1\n');
    const exec = new StepExecutor({ llm: new VerifyWithoutDoneLLM(), maxRounds: 1 });
    const r = await exec.run({
      step: { ...baseStep, tools: ['run_tests'], outputs: ['src/x.py'] },
      tools: [runTestsTool],
      ctx,
    });

    expect(r.success).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.toolCalls.find((c) => c.tool === 'run_tests' && c.ok)).toBeTruthy();
  });

  it('requests permission before sensitive write tools and skips the write when denied', async () => {
    const requests: string[] = [];
    const events: string[] = [];
    let permissionCallId: string | undefined;
    let startedCallId: string | undefined;
    const exec = new StepExecutor({ llm: new CapturingLLM(), maxRounds: 1 });
    const r = await exec.run({
      step: baseStep,
      tools: [writeFileTool],
      ctx: {
        ...ctx,
        requestPermission: async (request) => {
          requests.push(`${request.operationType}:${request.target}`);
          permissionCallId = request.id;
          return { approved: false, reason: 'test denial' };
        },
        onToolEvent: (event) => {
          events.push(`${event.status}:${event.tool}:${event.ok ?? ''}`);
          if (event.status === 'started') startedCallId = event.callId;
        },
      },
    });
    expect(r.success).toBe(false);
    expect(requests).toEqual(['file_write:src/x.py']);
    expect(permissionCallId).toBe(startedCallId);
    expect(r.toolCalls[0]?.error).toContain('permission denied');
    expect(events).toContain('completed:write_file:false');
    await expect(fs.stat(path.join(tmp, 'src/x.py'))).rejects.toThrow();
  });

  it('fails early when the model repeats read-only probes without progress', async () => {
    class ReadLoopLLM implements LLMClient {
      readonly name = 'read-loop';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        return JSON.stringify({
          thoughts: 'inspect again',
          actions: [{ tool: 'read_file', args: { path: 'src/source.py' } }],
          done: false,
        });
      }
    }
    await ws.writeFile('src/source.py', 'value = 1\n');
    const llm = new ReadLoopLLM();
    const exec = new StepExecutor({ llm, maxRounds: 10 });
    const r = await exec.run({ step: baseStep, tools: [readFileTool], ctx });
    expect(r.success).toBe(false);
    expect(r.error).toContain('repeated read-only/probe actions without progress');
    expect(llm.calls).toBe(3);
  });

  it('fails early when the model repeatedly returns empty no-progress turns', async () => {
    class EmptyTurnLLM implements LLMClient {
      readonly name = 'empty-turn';
      calls = 0;
      sawWarning = false;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        this.sawWarning = this.sawWarning ||
          (messages.at(-1)?.content.includes('No-progress warning') ?? false);
        return JSON.stringify({ thoughts: 'still deciding', actions: [], done: false });
      }
    }
    const llm = new EmptyTurnLLM();
    const exec = new StepExecutor({ llm, maxRounds: 10 });
    const result = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid no-progress output');
    expect(result.error).toContain('missing outputs: src/x.py');
    expect(llm.calls).toBe(2);
    expect(llm.sawWarning).toBe(true);
  });

  it('extends once when a successful mutation is followed by one inspection before verification', async () => {
    class WriteInspectVerifyLLM implements LLMClient {
      readonly name = 'write-inspect-verify';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'apply the repair',
            actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 2\n' } }],
            done: false,
          });
        }
        if (this.calls === 2) {
          return JSON.stringify({
            thoughts: 'inspect the repaired file before verification',
            actions: [{ tool: 'read_file', args: { path: 'src/x.py' } }],
            done: false,
          });
        }
        return JSON.stringify({
          thoughts: 'verify the repair',
          actions: [{ tool: 'run_tests', args: {} }],
          done: false,
        });
      }
    }
    const llm = new WriteInspectVerifyLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const result = await exec.run({
      step: { ...baseStep, tools: ['write_file', 'read_file', 'run_tests'] },
      tools: [writeFileTool, readFileTool, runTestsTool],
      ctx: {
        ...ctx,
        sandbox: {
          async runProgram() { throw new Error('not used'); },
          async runTests() {
            return { exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false, durationMs: 1 };
          },
          async installDeps() { throw new Error('not used'); },
        } as never,
      },
    });

    expect(result.success).toBe(true);
    expect(llm.calls).toBe(3);
    expect(result.toolCalls.at(-1)).toMatchObject({ tool: 'run_tests', ok: true });
  });

  it('fails early when write actions stop reducing missing outputs', async () => {
    class StalledWritesLLM implements LLMClient {
      readonly name = 'stalled-writes';
      calls = 0;
      sawOutputWarning = false;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        this.sawOutputWarning =
          this.sawOutputWarning ||
          (messages.at(-1)?.content.includes('Output progress warning: required outputs have not decreased') ?? false);
        return JSON.stringify({
          thoughts: 'keep polishing the same existing output',
          actions: [{ tool: 'write_file', args: { path: 'src/a.py', content: `value = ${this.calls}\n` } }],
          done: false,
        });
      }
    }
    const step: Step = {
      ...baseStep,
      outputs: ['src/a.py', 'src/b.py'],
      acceptance: 'both files exist',
    };
    const llm = new StalledWritesLLM();
    const exec = new StepExecutor({ llm, maxRounds: 10 });
    const r = await exec.run({ step, tools: [writeFileTool], ctx });

    expect(r.success).toBe(false);
    expect(r.error).toContain('write/progress actions did not reduce missing outputs');
    expect(r.error).toContain('src/b.py');
    expect(llm.calls).toBe(4);
    expect(llm.sawOutputWarning).toBe(true);
  });

  it('feeds successful read_file content back to the next model turn', async () => {
    class ReadThenRepairLLM implements LLMClient {
      readonly name = 'read-then-repair';
      calls = 0;
      sawFileContent = false;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'inspect the source',
            actions: [{ tool: 'read_file', args: { path: 'src/source.py' } }],
            done: false,
          });
        }
        this.sawFileContent =
          messages[messages.length - 1]?.content.includes('TOKEN = "visible-to-debugger"') ?? false;
        return JSON.stringify({
          thoughts: 'repair using the actual file content from tool feedback',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 2\n' } }],
          done: true,
        });
      }
    }
    await ws.writeFile('src/source.py', 'TOKEN = "visible-to-debugger"\n');
    const llm = new ReadThenRepairLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({ step: baseStep, tools: [readFileTool, writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(llm.sawFileContent).toBe(true);
  });

  it('warns before the read-only loop guard trips so the model can repair in the next round', async () => {
    class ReadTwiceThenWriteLLM implements LLMClient {
      readonly name = 'read-warning';
      calls = 0;
      sawWarning = false;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls <= 2) {
          return JSON.stringify({
            thoughts: 'inspect first',
            actions: [{ tool: 'read_file', args: { path: 'src/source.py' } }],
            done: false,
          });
        }
        this.sawWarning = messages[messages.length - 1]?.content.includes('Loop guard warning') ?? false;
        return JSON.stringify({
          thoughts: 'repair after warning',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 2\n' } }],
          done: true,
        });
      }
    }
    await ws.writeFile('src/source.py', 'value = 1\n');
    const llm = new ReadTwiceThenWriteLLM();
    const exec = new StepExecutor({ llm, maxRounds: 3 });
    const r = await exec.run({ step: baseStep, tools: [readFileTool, writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(llm.sawWarning).toBe(true);
    expect(await ws.readFile('src/x.py')).toBe('x = 2\n');
  });

  it('tightens read-only recovery after a previous probe-loop debug failure', async () => {
    class RecoveryReadLoopLLM implements LLMClient {
      readonly name = 'read-recovery-loop';
      calls = 0;
      sawRecoveryWarning = false;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls >= 2) {
          this.sawRecoveryWarning = this.sawRecoveryWarning ||
            (messages[messages.length - 1]?.content.includes('Read-only recovery mode') ?? false);
        }
        return JSON.stringify({
          thoughts: 'inspect again despite recovery warning',
          actions: [{ tool: 'read_file', args: { path: 'src/source.py' } }],
          done: false,
        });
      }
    }
    await ws.writeFile('src/source.py', 'value = 1\n');
    const llm = new RecoveryReadLoopLLM();
    const exec = new StepExecutor({ llm, maxRounds: 10 });
    const r = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [readFileTool],
      ctx,
      debugContext: {
        reason: 'repeated read-only/probe actions without progress for 3 rounds',
        failureLog: 'previous attempt only read files and made no repair',
        repairRequired: true,
      },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('read-only recovery mode repeated probe actions');
    expect(llm.calls).toBe(2);
    expect(llm.sawRecoveryWarning).toBe(true);
  });

  it('allows recovery to inspect distinct concrete error targets before patching', async () => {
    class MultiFileRecoveryLLM implements LLMClient {
      readonly name = 'multi-file-recovery';
      calls = 0;
      async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          const response = JSON.stringify({
            thoughts: 'inspect the three compiler-reported contract owners in one bounded round',
            actions: [1, 2, 3].map((index) => ({
              tool: 'read_file',
              args: { path: `src/error-${index}.py` },
            })),
            done: false,
          });
          options?.validate?.(response);
          return response;
        }
        return JSON.stringify({
          thoughts: 'apply the cross-file contract repair',
          bugResolutionPlan: 'Inspect each compiler-reported contract owner, then patch the shared implementation.',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 2\n' } }],
          done: true,
        });
      }
    }
    for (let index = 1; index <= 3; index++) {
      await ws.writeFile(`src/error-${index}.py`, `value = ${index}\n`);
    }
    await ws.writeFile('src/x.py', 'x = 1\n');
    const llm = new MultiFileRecoveryLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const result = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [readFileTool, writeFileTool],
      ctx,
      debugContext: {
        bugTicketId: 'BUG-MULTI-FILE',
        reason: 'CODE validation failed: tsc --noEmit exit=2',
        failureLog:
          'compiler errors reference src/error-1.py, src/error-2.py, and src/error-3.py',
        repairRequired: true,
      },
    });

    expect(result.success).toBe(true);
    expect(llm.calls).toBe(2);
    expect(result.toolCalls.filter((call) => call.tool === 'read_file')).toHaveLength(3);
    expect(await ws.readFile('src/x.py')).toBe('x = 2\n');
  });

  it('adapts direct-repair diagnostic rounds to the number of compiler-reported files', async () => {
    class SequentialMultiFileRecoveryLLM implements LLMClient {
      readonly name = 'sequential-multi-file-recovery';
      calls = 0;
      sawRemainingAllowance = false;

      async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'inspect the first compiler-reported contract group',
            actions: [1, 2, 3].map((index) => ({
              tool: 'read_file',
              args: { path: `src/error-${index}.ts` },
            })),
            done: false,
          });
        }
        if (this.calls === 2) {
          this.sawRemainingAllowance = messages.at(-1)?.content.includes(
            'diagnostic collection remains available for 1 round',
          ) ?? false;
          const response = JSON.stringify({
            thoughts: 'inspect the remaining compiler-reported contract owners',
            actions: [4, 5].map((index) => ({
              tool: 'read_file',
              args: { path: `src/error-${index}.ts` },
            })),
            done: false,
          });
          expect(options?.validate).toBeTypeOf('function');
          expect(() => options!.validate!(response)).not.toThrow();
          return response;
        }
        return JSON.stringify({
          thoughts: 'apply the focused repair after collecting both contract groups',
          bugResolutionPlan: 'Inspect each compiler-reported owner, patch the shared implementation, and verify the gate.',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 3\n' } }],
          done: true,
        });
      }
    }

    for (let index = 1; index <= 5; index++) {
      await ws.writeFile(`src/error-${index}.ts`, `export const value${index} = ${index};\n`);
    }
    await ws.writeFile('src/x.py', 'x = 1\n');
    const llm = new SequentialMultiFileRecoveryLLM();
    const exec = new StepExecutor({ llm, maxRounds: 3 });
    const result = await exec.run({
      step: { ...baseStep, tools: ['read_file', 'write_file'] },
      executionRole: 'Debugger',
      tools: [readFileTool, writeFileTool],
      ctx,
      debugContext: {
        bugTicketId: 'BUG-SEQUENTIAL-MULTI-FILE',
        reason: 'CODE validation failed: tsc --noEmit exit=2',
        failureLog: [1, 2, 3, 4, 5]
          .map((index) => `src/error-${index}.ts(1,1): error TS2339: missing contract ${index}`)
          .join('\n'),
        repairRequired: true,
      },
    });

    expect(result.success).toBe(true);
    expect(llm.calls).toBe(3);
    expect(llm.sawRemainingAllowance).toBe(true);
    expect(result.toolCalls.filter((call) => call.tool === 'read_file')).toHaveLength(5);
    expect(await ws.readFile('src/x.py')).toBe('x = 3\n');
  });

  it('bounds the first recovery inspection round before requiring a mutation', async () => {
    class BoundedRecoveryLLM implements LLMClient {
      readonly name = 'bounded-recovery';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'inspect too many files before repairing',
            actions: Array.from({ length: 9 }, (_, index) => ({
              tool: 'read_file',
              args: { path: `src/probe-${index}.py` },
            })),
            done: false,
          });
        }
        return JSON.stringify({
          thoughts: 'write the missing output using the bounded evidence',
          bugResolutionPlan: 'Inspect a bounded source sample, create the missing output, and verify its presence.',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } }],
          done: true,
        });
      }
    }
    for (let index = 0; index < 9; index++) {
      await ws.writeFile(`src/probe-${index}.py`, `value = ${index}\n`);
    }
    const exec = new StepExecutor({ llm: new BoundedRecoveryLLM(), maxRounds: 2 });
    const result = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [readFileTool, writeFileTool],
      ctx,
      debugContext: {
        bugTicketId: 'BUG-BOUNDED',
        reason: 'repeated read-only/probe actions without progress for 3 rounds',
        failureLog: 'previous attempt inspected the whole workspace without creating src/x.py',
        repairRequired: true,
      },
    });

    expect(result.success).toBe(true);
    expect(result.toolCalls.filter((call) => call.tool === 'read_file')).toHaveLength(4);
    expect(await ws.readFile('src/x.py')).toBe('x = 1\n');
  });

  it('asks the provider chain to reject read-only Debugger turns during recovery mode', async () => {
    class RecoveryValidationLLM implements LLMClient {
      readonly name = 'read-recovery-validation';
      calls = 0;
      sawValidation = false;
      async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        this.calls++;
        const readOnly = JSON.stringify({
          thoughts: 'inspect again despite recovery warning',
          actions: [{ tool: 'read_file', args: { path: 'src/source.py' } }],
          done: false,
        });
        if (this.calls === 1) {
          expect(options?.validate).toBeUndefined();
          return readOnly;
        }
        expect(options?.validate).toBeTypeOf('function');
        expect(() => options!.validate!('{')).toThrow(/empty or unparseable JSON/u);
        expect(() => options!.validate!('{ "thoughts": "')).toThrow(/empty or unparseable JSON/u);
        expect(() =>
          options!.validate!(
            JSON.stringify({
              thoughts: 'previous preserved writes already satisfied the required outputs',
              actions: [],
              done: true,
            }),
          ),
        ).not.toThrow();
        expect(() => options!.validate!(readOnly)).toThrow(/read-only\/probe actions/u);
        expect(() =>
          options!.validate!(
            JSON.stringify({
              thoughts: 'inspect a distinct compiler-reported file',
              actions: [{ tool: 'read_file', args: { path: 'src/other.py' } }],
              done: false,
            }),
          ),
        ).not.toThrow();
        expect(() =>
          options!.validate!(
            JSON.stringify({
              thoughts: 'use a shorthand tool that is not available',
              actions: [{ tool: 'read', args: { path: 'src/source.py' } }],
              done: false,
            }),
          ),
        ).toThrow(/no allowed tool actions/u);
        this.sawValidation = true;
        return JSON.stringify({
          thoughts: 'switch to an actual repair after provider validation',
          actions: [{ tool: 'write_file', args: { path: 'src/source.py', content: 'value = 2\n' } }],
          done: true,
        });
      }
    }
    await ws.writeFile('src/source.py', 'value = 1\n');
    const llm = new RecoveryValidationLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({
      step: { ...baseStep, outputs: ['src/source.py'] },
      executionRole: 'Debugger',
      tools: [readFileTool, writeFileTool],
      ctx,
      debugContext: {
        reason: 'read-only recovery mode repeated probe actions for 2 rounds',
        failureLog: 'previous attempt only read files and made no repair',
        repairRequired: true,
      },
    });
    expect(r.success).toBe(true);
    expect(llm.calls).toBe(2);
    expect(llm.sawValidation).toBe(true);
    expect(await ws.readFile('src/source.py')).toBe('value = 2\n');
  });

  it('requires a repair turn after a Debugger reproduces an actionable compiler failure', async () => {
    class CompilerRepairLLM implements LLMClient {
      readonly name = 'compiler-repair';
      calls = 0;
      async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          expect(options?.validate).toBeTypeOf('function');
          return JSON.stringify({
            thoughts: 'reproduce the current compiler failure once',
            bugResolutionPlan: 'Reproduce TS2339 once, patch the reported public API, and rerun the compiler gate.',
            actions: [{ tool: 'run_program', args: { command: 'npx tsc --noEmit' } }],
            done: false,
          });
        }
        expect(options?.validate).toBeTypeOf('function');
        if (this.calls === 2) {
          expect(() =>
            options!.validate!(JSON.stringify({
              thoughts: 'stall after seeing the compiler diagnostics',
              actions: [],
              done: false,
            })),
          ).toThrow(/no valid tool actions/u);
          expect(() =>
            options!.validate!(JSON.stringify({
              thoughts: 'inspect the newly reported source once',
              actions: [{ tool: 'read_file', args: { path: 'src/x.py' } }],
              done: false,
            })),
          ).not.toThrow();
          return JSON.stringify({
            thoughts: 'inspect the newly reported source once',
            actions: [{ tool: 'read_file', args: { path: 'src/x.py' } }],
            done: false,
          });
        }
        if (this.calls === 3) {
          expect(() =>
            options!.validate!(JSON.stringify({
              thoughts: 'repeat the same inspection',
              actions: [{ tool: 'read_file', args: { path: 'src/x.py' } }],
              done: false,
            })),
          ).toThrow(/read-only\/probe actions/u);
          return JSON.stringify({
            thoughts: 'repair the compiler-reported contract',
            bugResolutionPlan: 'Reproduce TS2339 once, patch the reported public API, and rerun the compiler gate.',
            actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'export const api = 1;\n' } }],
            done: false,
          });
        }
        return JSON.stringify({
          thoughts: 'verify the repaired compiler contract',
          bugResolutionPlan: 'Reproduce TS2339 once, patch the reported public API, and rerun the compiler gate.',
          actions: [{ tool: 'run_program', args: { command: 'npx tsc --noEmit' } }],
          done: false,
        });
      }
    }
    let compilerRuns = 0;
    const runProgram: Tool = {
      name: 'run_program',
      description: 'controlled TypeScript compiler',
      argsSchema: {},
      async run() {
        compilerRuns++;
        return compilerRuns === 1
          ? { ok: false, error: 'tsc exit=2: src/x.py(1,1): error TS2339: Property api is missing' }
          : { ok: true, summary: 'tsc passed' };
      },
    };
    await ws.writeFile('src/x.py', 'export const stale = 1;\n');
    const llm = new CompilerRepairLLM();
    const exec = new StepExecutor({ llm, maxRounds: 4 });
    const result = await exec.run({
      step: { ...baseStep, tools: ['run_program', 'read_file', 'write_file'] },
      executionRole: 'Debugger',
      tools: [runProgram, readFileTool, writeFileTool],
      ctx,
      debugContext: {
        bugTicketId: 'BUG-COMPILER',
        reason: 'CODE validation failed: npx tsc --noEmit exit=2',
        failureLog: 'src/x.py(1,1): error TS2339: Property api is missing',
        repairRequired: true,
      },
    });

    expect(result.success).toBe(true);
    expect(llm.calls).toBe(4);
    expect(await ws.readFile('src/x.py')).toContain('api');
  });

  it('returns provider validation rejections as low-quality debug attempt failures', async () => {
    class LowQualityRejectedLLM implements LLMClient {
      readonly name = 'low-quality-provider-chain';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        throw new Error(
          'all LLM providers failed for role Debugger: ' +
          'openrouter_deepseek_flash/openai:deepseek/deepseek-v4-flash: ' +
          'low-quality Debugger response: read-only/probe actions in read-only recovery mode; ' +
          'produce a repair action, verification action, or concrete blocker instead',
        );
      }
    }
    const exec = new StepExecutor({ llm: new LowQualityRejectedLLM(), maxRounds: 2 });
    const r = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [readFileTool, writeFileTool],
      ctx,
      debugContext: {
        reason: 'read-only recovery mode repeated probe actions for 2 rounds',
        failureLog: 'previous retry only read tests/unit_s005.test.ts',
        repairRequired: true,
      },
    });

    expect(r.success).toBe(false);
    expect(r.error).toContain('low-quality Debugger response');
    expect(r.rounds).toBe(2);
    expect(r.metrics.repeatedTurns).toBe(2);
  });

  it('retains tool feedback and recovers in the same attempt after one low-quality rejection', async () => {
    class RetainedContextLLM implements LLMClient {
      readonly name = 'retained-debug-context';
      calls = 0;
      sawPriorReadFeedback = false;
      async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'inspect the compiler-reported source once',
            actions: [{ tool: 'read_file', args: { path: 'src/x.py' } }],
            done: false,
          });
        }
        if (this.calls === 2) {
          throw new Error(
            'low-quality Debugger response: read-only/probe actions in read-only recovery mode; ' +
            'produce a repair action, verification action, or concrete blocker instead',
          );
        }
        this.sawPriorReadFeedback =
          messages.some((message) =>
            message.role === 'user' && message.content.includes('read src/x.py')
          ) &&
          messages.some((message) =>
            message.role === 'user' && message.content.includes('Do not reread those files')
          );
        expect(options?.validate).toBeTypeOf('function');
        return JSON.stringify({
          thoughts: 'patch using the retained current source content',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'export const api = 2;\n' } }],
          done: true,
        });
      }
    }
    await ws.writeFile('src/x.py', 'export const stale = 1;\n');
    const llm = new RetainedContextLLM();
    const exec = new StepExecutor({ llm, maxRounds: 3 });
    const result = await exec.run({
      step: { ...baseStep, tools: ['read_file', 'write_file'] },
      executionRole: 'Debugger',
      tools: [readFileTool, writeFileTool],
      ctx,
      debugContext: {
        reason: 'CODE validation failed: npx tsc --noEmit exit=2',
        failureLog: 'src/x.py(1,1): error TS2339: Property api is missing',
        repairRequired: true,
      },
    });

    expect(result.success).toBe(true);
    expect(llm.calls).toBe(3);
    expect(llm.sawPriorReadFeedback).toBe(true);
    expect(await ws.readFile('src/x.py')).toContain('api');
  });

  it('requires a repair action on the first turn after a read-only response was rejected', async () => {
    class StrictRecoveryLLM implements LLMClient {
      readonly name = 'strict-read-recovery';
      calls = 0;
      async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        this.calls++;
        expect(options?.validate).toBeTypeOf('function');
        expect(() =>
          options!.validate!(JSON.stringify({
            thoughts: 'repeat the already rejected inspection',
            actions: [{ tool: 'read_file', args: { path: 'src/x.py' } }],
            done: false,
          })),
        ).toThrow(/read-only\/probe actions/u);
        return JSON.stringify({
          thoughts: 'apply the repair immediately using preserved evidence',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 9\n' } }],
          done: true,
        });
      }
    }
    await ws.writeFile('src/x.py', 'x = 1\n');
    const llm = new StrictRecoveryLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const result = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [readFileTool, writeFileTool],
      ctx,
      debugContext: {
        reason:
          'low-quality Debugger response: read-only/probe actions in read-only recovery mode; ' +
          'produce a repair action',
        failureLog: 'src/x.py(1,1): error TS2339: Property api is missing',
        repairRequired: true,
      },
    });

    expect(result.success).toBe(true);
    expect(llm.calls).toBe(1);
    expect(await ws.readFile('src/x.py')).toBe('x = 9\n');
  });

  it('rejects repeated read-only Debugger turns when missing outputs need direct repair', async () => {
    class MissingOutputRepairLLM implements LLMClient {
      readonly name = 'missing-output-repair';
      calls = 0;
      sawValidation = false;
      sawDirectRepairTarget = false;
      async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
        this.calls++;
        const readOnly = JSON.stringify({
          thoughts: 'inspect one more file',
          actions: [{ tool: 'read_file', args: { path: 'src/source.py' } }],
          done: false,
        });
        if (this.calls === 1) {
          expect(options?.validate).toBeUndefined();
          return readOnly;
        }
        this.sawDirectRepairTarget = messages.at(-1)?.content.includes('Direct repair target: required outputs are still missing: docs/05-unit-test.md') ?? false;
        this.sawValidation = typeof options?.validate === 'function';
        expect(() => options!.validate!(readOnly)).toThrow(/read-only\/probe actions/u);
        return JSON.stringify({
          thoughts: 'create the missing unit-test report instead of probing again',
          actions: [{ tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit Test\n' } }],
          done: true,
        });
      }
    }
    await ws.writeFile('src/source.py', 'value = 1\n');
    const llm = new MissingOutputRepairLLM();
    const exec = new StepExecutor({ llm, maxRounds: 3 });
    const r = await exec.run({
      step: {
        ...baseStep,
        outputs: ['docs/05-unit-test.md'],
        tools: ['read_file', 'write_file'],
      },
      executionRole: 'Debugger',
      tools: [readFileTool, writeFileTool],
      ctx: { ...ctx, allowedWrites: ['docs/'] },
      debugContext: {
        reason: 'max rounds exceeded without satisfying outputs',
        failureLog:
          'outputs still missing: docs/05-unit-test.md\n' +
          'write_file FAIL invalid write_file args: content must be a string',
        repairRequired: true,
      },
    });
    expect(r.success).toBe(true);
    expect(llm.sawValidation).toBe(true);
    expect(llm.sawDirectRepairTarget).toBe(true);
    expect(await ws.readFile('docs/05-unit-test.md')).toBe('# Unit Test\n');
  });

  it('allows a Debugger retry to finish when preserved previous writes already satisfy missing outputs', async () => {
    class ConfirmOutputsLLM implements LLMClient {
      readonly name = 'confirm-outputs';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'all required outputs exist after the previous preserved retry',
          actions: [],
          done: true,
        });
      }
    }
    await ws.writeFile('docs/02-high-level-design.md', '# HLD\n');
    await ws.writeFile('docs/tests/module-test-plan.md', '# Module Test Plan\n');
    const exec = new StepExecutor({ llm: new ConfirmOutputsLLM(), maxRounds: 1 });
    const r = await exec.run({
      step: {
        ...baseStep,
        phase: 'HIGH_LEVEL_DESIGN',
        role: 'Architect',
        tools: ['read_file', 'write_file'],
        outputs: ['docs/02-high-level-design.md', 'docs/tests/module-test-plan.md'],
      },
      executionRole: 'Debugger',
      tools: [readFileTool, writeFileTool],
      ctx: { ...ctx, allowedWrites: ['docs/'] },
      debugContext: {
        reason: 'max rounds exceeded without satisfying outputs',
        failureLog:
          'previous Debugger retry wrote docs/02-high-level-design.md and docs/tests/module-test-plan.md but did not return done=true',
        repairRequired: true,
      },
    });
    expect(r.success).toBe(true);
  });

  it('allows output-completion recovery despite untargeted malformed write noise', async () => {
    class NoisyCompletionLLM implements LLMClient {
      readonly name = 'noisy-completion';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'the preserved retry already created the required output, but I accidentally emitted a malformed write',
          bugResolutionPlan: 'The prior debug attempt created the missing output; verify output presence and ignore untargeted malformed write noise.',
          actions: [{ tool: 'write_file', args: {} }],
          done: false,
        });
      }
    }
    await ws.writeFile('src/x.py', 'x = 1\n');
    const exec = new StepExecutor({ llm: new NoisyCompletionLLM(), maxRounds: 1 });
    const r = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [writeFileTool],
      ctx,
      debugContext: {
        bugTicketId: 'BUG-1',
        reason: 'max rounds exceeded without satisfying outputs',
        failureLog: 'previous Debugger retry wrote src/x.py but did not return done=true',
        repairRequired: true,
      },
    });

    expect(r.success).toBe(true);
    expect(r.toolCalls.find((call) => call.tool === 'write_file' && !call.ok)?.error).toContain('path must be a non-empty string');
  });

  it('does not accept DEBUG completion until repair or verification evidence exists', async () => {
    class DebugReadThenWriteLLM implements LLMClient {
      readonly name = 'debug-repair-gate';
      calls = 0;
      sawRepairGate = false;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'inspect and incorrectly claim done',
            actions: [{ tool: 'read_file', args: { path: 'src/x.py' } }],
            done: true,
          });
        }
        this.sawRepairGate = messages[messages.length - 1]?.content.includes('Invalid DEBUG completion') ?? false;
        return JSON.stringify({
          thoughts: 'now provide real repair evidence',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 3\n' } }],
          done: true,
        });
      }
    }
    await ws.writeFile('src/x.py', 'x = 1\n');
    const llm = new DebugReadThenWriteLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [readFileTool, writeFileTool],
      ctx,
      debugContext: {
        reason: 'unit test failed',
        failureLog: 'pytest failed',
        repairRequired: true,
      },
    });
    expect(r.success).toBe(true);
    expect(llm.sawRepairGate).toBe(true);
    expect(await ws.readFile('src/x.py')).toBe('x = 3\n');
  });

  it('does not let advisory tool failures poison a later successful repair', async () => {
    class AdvisoryFailureThenWriteLLM implements LLMClient {
      readonly name = 'advisory-failure';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'a stale replace miss should not block the real design update',
          actions: [
            { tool: 'replace_in_file', args: { path: 'tests/test_integration.py', find: 'old', replace: 'new' } },
            { tool: 'write_file', args: { path: 'docs/03-detailed-design.md', content: '# Revised Design\n' } },
          ],
          done: true,
        });
      }
    }
    const replaceMissTool: Tool = {
      name: 'replace_in_file',
      description: 'fake replace miss',
      argsSchema: {},
      async run() {
        return {
          ok: false,
          error: 'expected 1 occurrences of find, found 0 in tests/test_integration.py',
        };
      },
    };
    const designStep: Step = {
      ...baseStep,
      phase: 'DETAILED_DESIGN',
      role: 'Architect',
      tools: ['replace_in_file', 'write_file'],
      outputs: ['docs/03-detailed-design.md'],
    };
    const llm = new AdvisoryFailureThenWriteLLM();
    const exec = new StepExecutor({
      llm,
      maxRounds: 1,
      advisoryFailureRules: [
        { tool: 'replace_in_file', errorIncludes: 'expected 1 occurrences of find, found 0' },
      ],
    });
    const r = await exec.run({
      step: designStep,
      executionRole: 'Debugger',
      tools: [replaceMissTool, writeFileTool],
      ctx: { ...ctx, allowedWrites: ['docs/', 'tests/'] },
      debugContext: {
        reason: 'integration test failed',
        failureLog: 'replace miss was diagnostic; design needs an update',
        repairRequired: true,
      },
    });
    expect(r.success).toBe(true);
    expect(r.toolCalls.some((call) => call.tool === 'replace_in_file' && !call.ok)).toBe(true);
    expect(await ws.readFile('docs/03-detailed-design.md')).toBe('# Revised Design\n');
  });

  it('gives explicit recovery guidance after replace_in_file misses current bytes', async () => {
    class ReplaceMissThenPatchLLM implements LLMClient {
      readonly name = 'replace-miss-guidance';
      calls = 0;
      sawReplaceMissGuidance = false;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'try a stale replace first',
            actions: [{ tool: 'replace_in_file', args: { path: 'src/x.py', find: 'old', replace: 'new' } }],
            done: false,
          });
        }
        this.sawReplaceMissGuidance = messages.at(-1)?.content.includes('Replace miss recovery') ?? false;
        return JSON.stringify({
          thoughts: 'use the concrete write after guidance',
          actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 4\n' } }],
          done: true,
        });
      }
    }
    const replaceMissTool: Tool = {
      name: 'replace_in_file',
      description: 'fake replace miss',
      argsSchema: {},
      async run() {
        return {
          ok: false,
          error: 'expected 1 occurrences of find, found 0 in src/x.py',
        };
      },
    };
    const llm = new ReplaceMissThenPatchLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({
      step: { ...baseStep, tools: ['replace_in_file', 'write_file'] },
      tools: [replaceMissTool, writeFileTool],
      ctx,
    });

    expect(r.success).toBe(true);
    expect(llm.sawReplaceMissGuidance).toBe(true);
    expect(await ws.readFile('src/x.py')).toBe('x = 4\n');
  });

  it('normalizes common shorthand tool arguments from weaker models', async () => {
    class ShorthandArgsLLM implements LLMClient {
      readonly name = 'shorthand-args';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'use shorthand args that should be normalized',
          actions: [
            { tool: 'read_file', args: 'src/source.py' },
            { tool: 'run_tests', args: ['tests/test_unit.py', '-x', '-v'] },
          ],
          done: true,
        });
      }
    }
    let capturedRunArgs: unknown;
    const runTestsTool: Tool = {
      name: 'run_tests',
      description: 'fake pytest',
      argsSchema: {},
      async run(args) {
        capturedRunArgs = args;
        return { ok: true, summary: 'pytest passed' };
      },
    };
    await ws.writeFile('src/source.py', 'value = 1\n');
    const llm = new ShorthandArgsLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const r = await exec.run({
      step: { ...baseStep, tools: ['read_file', 'run_tests'], outputs: ['src/source.py'] },
      tools: [readFileTool, runTestsTool],
      ctx,
    });
    expect(r.success).toBe(true);
    expect(capturedRunArgs).toEqual({ args: ['tests/test_unit.py', '-x', '-v'] });
    expect(r.toolCalls.every((call) => call.ok)).toBe(true);
  });

  it('compacts large write content out of assistant history before the next round', async () => {
    class LargeWriteThenInspectLLM implements LLMClient {
      readonly name = 'large-history';
      calls = 0;
      sawPayloadOmitted = false;
      sawContentBytes = false;
      sawRawContent = false;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'write a large file',
            actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: `payload = "${'A'.repeat(2000)}"\n` } }],
            done: false,
          });
        }
        const history = messages.map((message) => message.content).join('\n');
        this.sawPayloadOmitted = history.includes('payload omitted');
        this.sawContentBytes = history.includes('"contentBytes"');
        this.sawRawContent = history.includes('A'.repeat(500));
        return JSON.stringify({ thoughts: 'finish', actions: [], done: true });
      }
    }
    const llm = new LargeWriteThenInspectLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(llm.sawPayloadOmitted).toBe(true);
    expect(llm.sawContentBytes).toBe(false);
    expect(llm.sawRawContent).toBe(false);
  });

  it('uses tighter context and failure-log caps in Debugger prompts', async () => {
    class CaptureDebugPromptLLM implements LLMClient {
      readonly name = 'capture-debug-prompt';
      lastUser = '';
      async chat(messages: ChatMessage[]): Promise<string> {
        this.lastUser = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        return JSON.stringify({
          thoughts: 'verify after compact prompt',
          actions: [{ tool: 'run_tests', args: { args: [] } }],
          done: true,
        });
      }
    }
    const runTestsTool: Tool = {
      name: 'run_tests',
      description: 'fake pytest',
      argsSchema: {},
      async run() {
        return { ok: true, summary: 'pytest passed' };
      },
    };
    await ws.writeFile('src/x.py', 'x = 1\n');
    const llm = new CaptureDebugPromptLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const r = await exec.run({
      step: { ...baseStep, tools: ['run_tests'], outputs: ['src/x.py'] },
      executionRole: 'Debugger',
      tools: [runTestsTool],
      ctx,
      contextSnippets: [
        { path: 'src/huge.py', content: 'A'.repeat(12_000) },
      ],
      debugContext: {
        reason: 'unit failed',
        failureLog: 'B'.repeat(5000),
        repairRequired: true,
      },
    });

    expect(r.success).toBe(true);
    expect(llm.lastUser).toContain('src/huge.py');
    expect(llm.lastUser).toContain('## debug repair packet');
    expect(llm.lastUser).toContain('[truncated');
    expect(llm.lastUser).toContain('A'.repeat(3000));
    expect(llm.lastUser).not.toContain('A'.repeat(7000));
    expect(llm.lastUser).not.toContain('B'.repeat(3000));
  });

  it('keeps Debugger chat history bounded across many rounds', async () => {
    class MultiRoundDebugLLM implements LLMClient {
      readonly name = 'bounded-debug-history';
      calls = 0;
      messageCounts: number[] = [];
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        this.messageCounts.push(messages.length);
        return JSON.stringify({
          thoughts: 'continue until final verification',
          actions: this.calls === 5
            ? [{ tool: 'run_tests', args: { args: [] } }]
            : [{ tool: 'inspect_state', args: { round: this.calls } }],
          done: this.calls === 5,
        });
      }
    }
    const inspectStateTool: Tool = {
      name: 'inspect_state',
      description: 'fake bounded diagnostic action',
      argsSchema: { round: 'number' },
      async run() {
        return { ok: true, summary: 'state inspected' };
      },
    };
    const runTestsTool: Tool = {
      name: 'run_tests',
      description: 'fake pytest',
      argsSchema: {},
      async run() {
        return { ok: true, summary: 'pytest passed' };
      },
    };
    await ws.writeFile('src/x.py', 'x = 1\n');
    const llm = new MultiRoundDebugLLM();
    const exec = new StepExecutor({ llm, maxRounds: 5 });
    const r = await exec.run({
      step: { ...baseStep, tools: ['inspect_state', 'run_tests'], outputs: ['src/x.py'] },
      executionRole: 'Debugger',
      tools: [inspectStateTool, runTestsTool],
      ctx,
      debugContext: {
        reason: 'unit failed',
        failureLog: 'pytest failed',
        repairRequired: true,
      },
    });

    expect(r.success).toBe(true);
    expect(llm.messageCounts).toEqual([2, 4, 6, 6, 6]);
  });
});
