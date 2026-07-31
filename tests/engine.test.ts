import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { GitService } from '../src/workspace/git.js';
import { SubprocessSandbox } from '../src/sandbox/subprocess.js';
import { AuditLogger } from '../src/audit/audit.js';
import {
  PhaseEngine,
  codeValidationCommand,
  collectRollbackRepairOutputs,
  shouldRunCodeValidation,
  type EngineResult,
} from '../src/core/engine.js';
import { shouldRollbackTestPhaseFailure } from '../src/core/debug_policy.js';
import { savePlan } from '../src/core/storage.js';
import { buildDebugBrief } from '../src/core/debug_brief.js';
import { DebugWiki } from '../src/core/debug_wiki.js';
import {
  buildContextSnippets,
  computeDebugAllowedWrites,
} from '../src/core/engine/context.js';
import { CodePhaseValidator } from '../src/core/engine/code_phase_validator.js';
import type { BugLifecycle } from '../src/core/engine/bug_lifecycle.js';
import type { WorkTicketLifecycle } from '../src/core/engine/work_ticket_lifecycle.js';
import { getLanguageProfile } from '../src/core/language.js';
import { stepExecutionKey, type Plan } from '../src/core/plan.js';
import { TicketStore } from '../src/core/ticket.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { ChatMessage, ChatOptions, LLMClient } from '../src/llm/types.js';
import type { Role } from '../src/core/plan.js';
import type { ExecExtra, ExecResult, Sandbox } from '../src/sandbox/types.js';
import type { ProjectAuditResult } from '../src/core/project_audit.js';
import { PluginHost } from '../src/plugins/host.js';
import { XCOMPILER_PLUGIN_API_VERSION } from '../src/version.js';
import { setLocale } from '../src/i18n/index.js';

class ScriptedLLM implements LLMClient {
  readonly name = 'scripted';
  private idx = 0;
  constructor(private readonly script: string[]) {}
  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    const out = this.script[this.idx++];
    if (out === undefined) throw new Error('script exhausted');
    return addDefaultBugTicketPlan(out, messages);
  }
}

function addDefaultBugTicketPlan(out: string, messages: ChatMessage[]): string {
  try {
    const parsed = JSON.parse(out) as Record<string, unknown>;
    if (
      messages.some((m) => m.role === 'user' && m.content.includes('## bug ticket')) &&
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.bugResolutionPlan !== 'string'
    ) {
      parsed.bugResolutionPlan = 'Test scripted bug plan: identify the failing contract, patch the declared target, and rerun the relevant gate.';
    }
    parsed.qualityAssessment ??= {
      completion: 1,
      upstreamAlignment: 1,
      metrics: {
        lineCoverage: 1,
        branchCoverage: 1,
        testCasePassRate: 1,
        interfaceCoverage: 1,
        integrationScenarioCoverage: 1,
        moduleCoverage: 1,
        contractCoverage: 1,
        functionalCoverage: 1,
        requirementCoverage: 1,
        endToEndPassRate: 1,
      },
      tolerance: {
        failedTests: 0,
        skippedTests: 0,
        warnings: 0,
      },
      evidence: ['scripted test evidence'],
      gaps: [],
    };
    return JSON.stringify(parsed);
  } catch {
    return out;
  }
}

class CapturingScriptedLLM extends ScriptedLLM {
  public lastUser = '';
  public calls: ChatMessage[][] = [];
  override async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    this.calls.push(messages);
    this.lastUser = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
    return super.chat(messages, options);
  }
}

class ThrowingLLM implements LLMClient {
  readonly name = 'throwing';
  public calls = 0;
  constructor(private readonly error: Error) {}
  async chat(): Promise<string> {
    this.calls++;
    throw this.error;
  }
}

class FakeRouter {
  readonly scoreOutcomes: Array<{
    providers: string[];
    outcome: string;
    ticketId: string;
  }> = [];

  constructor(private readonly clients: Record<string, LLMClient>) {}
  for(role: Role | 'default' = 'default'): LLMClient {
    const c = this.clients[role];
    if (!c) throw new Error(`no scripted llm for role ${role}`);
    return c;
  }

  recordTicketOutcome(
    providers: readonly string[],
    outcome: string,
    ticketId: string,
  ): void {
    this.scoreOutcomes.push({ providers: [...providers], outcome, ticketId });
  }
}

class EntrypointProbeSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(argv: string[], _extra?: ExecExtra): Promise<ExecResult> {
    if (argv.includes('--help')) {
      return okExec({ stdout: 'usage: checkpoint [-h]\n' });
    }
    const source = await this.workspace.readFile('src/holiday.py');
    if (source.includes('timor.tech')) {
      return okExec({
        stdout: 'An unexpected error occurred.\n',
        stderr: 'Failed to fetch holiday data: 403 Client Error: Forbidden for url: https://timor.tech/api/holiday/\n',
      });
    }
    return okExec({ stdout: 'Spring Festival countdown: 20 days\nWeather: sunny\n' });
  }

  async runTests(): Promise<ExecResult> {
    return okExec();
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class IterationGateSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  private testRuns = 0;
  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: gate app\n' });
  }

  async runTests(): Promise<ExecResult> {
    this.testRuns += 1;
    if (this.testRuns === 1) return okExec({ stdout: 'functional phase test gate passed\n' });
    const content = await this.workspace.readFile('tests/test_main.py').catch(() => '');
    return content.includes('fixed')
      ? okExec({ stdout: '1 passed\n' })
      : okExec({ exitCode: 1, stderr: 'gate regression failed: expected fixed marker\n' });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class UnitRollbackSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: rollback app\n' });
  }

  async runTests(): Promise<ExecResult> {
    const source = await this.workspace.readFile('src/hello.py').catch(() => '');
    return source.includes('fixed')
      ? okExec({ stdout: 'tests passed after rollback\n' })
      : okExec({ exitCode: 1, stderr: 'unit regression failed: expected fixed implementation\n' });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class CodeValidationSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  public readonly validationArgs: string[][] = [];
  public readonly testArgs: string[][] = [];
  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(_cmd: string, args: string[]): Promise<ExecResult> {
    this.validationArgs.push(args);
    const source = await this.workspace.readFile('src/hello.py').catch(() => '');
    return source.includes('syntax_error')
      ? okExec({ exitCode: 1, stderr: 'SyntaxError: invalid syntax in src/hello.py' })
      : okExec({ stdout: 'source validation passed' });
  }

  async runProgram(): Promise<ExecResult> {
    return okExec();
  }

  async runTests(args: string[] = []): Promise<ExecResult> {
    this.testArgs.push(args);
    return okExec();
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class FirstFailThenPassSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  private testRuns = 0;

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: flaky app\n' });
  }

  async runTests(): Promise<ExecResult> {
    this.testRuns += 1;
    return this.testRuns === 1
      ? okExec({ exitCode: 1, stderr: 'first test run failed before repair\n' })
      : okExec({ stdout: 'second test run passed\n' });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class FirstNoTestFilesThenPassSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  private testRuns = 0;

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: missing test files app\n' });
  }

  async runTests(): Promise<ExecResult> {
    this.testRuns += 1;
    return this.testRuns === 1
      ? okExec({
          exitCode: 1,
          stderr: [
            'filter:  tests/test_hello.py',
            'include: **/*.{test,spec}.?(c|m)[jt]s?(x)',
            'No test files found, exiting with code 1',
          ].join('\n'),
        })
      : okExec({ stdout: 'tests passed after test artifact generation\n' });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class DebugPreserveSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: preserve app\n' });
  }

  async runTests(): Promise<ExecResult> {
    const source = await this.workspace.readFile('src/hello.py').catch(() => '');
    return source.includes('partial') && source.includes('final')
      ? okExec({ stdout: 'debug repair preserved and completed\n' })
      : okExec({ exitCode: 1, stderr: 'debug repair incomplete: expected partial and final markers\n' });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class IntegrationRollbackSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: integration rollback app\n' });
  }

  async runTests(): Promise<ExecResult> {
    const detail = await this.workspace.readFile('docs/03-detailed-design.md').catch(() => '');
    return detail.includes('fixed-detail-contract')
      ? okExec({ stdout: 'integration tests passed after detailed design repair\n' })
      : okExec({ exitCode: 1, stderr: 'integration contract failed: expected fixed detailed design\n' });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class ChangeRequestReworkSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  private unitFailureReported = false;

  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: CR rework app\n' });
  }

  async runTests(args: string[] = []): Promise<ExecResult> {
    if (args.some((arg) => arg.includes('test_hello')) && !this.unitFailureReported) {
      this.unitFailureReported = true;
      return okExec({ exitCode: 1, stderr: 'unit change implementation mismatch\n' });
    }
    const detail = await this.workspace.readFile('docs/03-detailed-design.md').catch(() => '');
    return detail.includes('fixed-detail-contract')
      ? okExec({ stdout: 'change request tests passed\n' })
      : okExec({ exitCode: 1, stderr: 'integration contract failed: expected fixed detailed design\n' });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class FunctionalGateOwnerSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: functional owner app\n' });
  }

  async runTests(args: string[] = []): Promise<ExecResult> {
    const detail = await this.workspace.readFile('docs/03-detailed-design.md').catch(() => '');
    const fixed = detail.includes('fixed-detail-contract');
    if (fixed) return okExec({ stdout: 'regression suite passed\n' });
    const failure = [
      'tests/test_functional.py ........',
      'tests/test_integration.py ..F',
      '',
      'FAILED tests/test_integration.py::test_contract - AssertionError: stale contract',
    ].join('\n');
    return okExec({
      exitCode: 1,
      stdout: args.includes('tests/test_integration.py')
        ? 'FAILED tests/test_integration.py::test_contract - AssertionError: stale contract\n'
        : failure,
    });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class CapturingTestArgsSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  public readonly testArgs: string[][] = [];

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: scoped test app\n' });
  }

  async runTests(args: string[] = []): Promise<ExecResult> {
    this.testArgs.push(args);
    return okExec({ stdout: `scoped ${args.join(' ')}` });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class FirstFailCapturingTestArgsSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  public readonly testArgs: string[][] = [];

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: scoped retry app\n' });
  }

  async runTests(args: string[] = []): Promise<ExecResult> {
    this.testArgs.push(args);
    return this.testArgs.length === 1
      ? okExec({ exitCode: 1, stderr: 'scoped retry failed before repair\n' })
      : okExec({ stdout: `scoped retry passed ${args.join(' ')}` });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

function okExec(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 1,
    ...overrides,
  };
}

let tmp: string;
let ws: Workspace;
let git: GitService;
let sandbox: SubprocessSandbox;
let audit: AuditLogger;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-engine-'));
  ws = new Workspace(tmp);
  git = new GitService(ws);
  audit = new AuditLogger({ root: tmp, command: 'test' });
  sandbox = new SubprocessSandbox({
    ws,
    limits: { cpu: 1, memory_mb: 512, wall_seconds: 10, network: 'off' },
    audit,
  });
  await ws.writeFile('docs/tests/functional-test-plan.md', '# functional test plan\n');
  await ws.writeFile('docs/tests/module-test-plan.md', '# module test plan\n');
  await ws.writeFile('docs/tests/integration-test-plan.md', '# integration test plan\n');
  await ws.writeFile('docs/tests/unit-test-plan.md', '# unit test plan\n');
  const productTest = 'import hello\n\n\ndef test_product_contract():\n    assert hello is not None\n';
  await ws.writeFile('tests/test_functional.py', productTest);
  await ws.writeFile('tests/test_module.py', productTest);
  await ws.writeFile('tests/test_integration.py', productTest);
  await ws.writeFile('tests/test_hello.py', productTest);
});

function fakePlan(): Plan {
  const step = (
    id: string,
    phase: Plan['steps'][number]['phase'],
    role: Role,
    outputs: string[],
    dependsOn: string[] = [],
    inputs: string[] = [],
  ): Plan['steps'][number] => ({
    id,
    iterationId: 'P1',
    phase,
    title: `${phase} ${id}`,
    description: `Execute ${phase}.`,
    systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
    role,
    tools: ['write_file'],
    inputs,
    outputs,
    dependsOn,
    acceptance: 'declared outputs exist',
    status: 'PENDING',
    retries: 0,
    maxRetries: 3,
  });
  return {
    version: '1',
    language: 'python',
    intent: 'greenfield',
    projectType: 'application',
    createdAt: new Date().toISOString(),
    requirementDigest: 'demo',
    globalPrompt: '',
    baselineSummary: '',
    userAddenda: '',
    dependencies: ['pytest'],
    complexityAssessment: {
      level: 'simple',
      rationale: 'Single V-model test fixture.',
      splitRecommended: false,
      userForcedPhaseSplit: false,
    },
    implementationPhases: [
      {
        id: 'P1',
        title: 'Core',
        objective: 'Complete the test V-model.',
        status: 'current',
        scope: ['test fixture'],
        deliverables: ['verified fixture'],
        dependsOn: [],
        verificationGate: {
          summary: 'Fixture passes.',
          checks: ['run tests'],
          failurePolicy: 'Return to the paired V-model source phase.',
        },
      },
    ],
    steps: [
      step('S001', 'REQUIREMENT_ANALYSIS', 'Planner', [
        'docs/01-requirement-analysis.md',
        'docs/tests/functional-test-plan.md',
        'tests/test_functional.py',
      ]),
      step('S002', 'HIGH_LEVEL_DESIGN', 'Architect', [
        'docs/02-high-level-design.md',
        'docs/tests/module-test-plan.md',
        'tests/test_module.py',
      ], ['S001']),
      step('S003', 'DETAILED_DESIGN', 'Architect', [
        'docs/03-detailed-design.md',
        'docs/tests/integration-test-plan.md',
        'tests/test_integration.py',
      ], ['S002']),
      step('S004', 'CODE', 'Coder', [
        'src/hello.py',
        'docs/tests/unit-test-plan.md',
        'tests/test_hello.py',
      ], ['S003']),
      step('S005', 'UNIT_TEST', 'Tester', ['docs/05-unit-test.md'], ['S004'], ['src/hello.py', 'tests/test_hello.py']),
      step('S006', 'INTEGRATION_TEST', 'Tester', ['docs/06-integration-test.md'], ['S005'], ['tests/test_integration.py']),
      step('S007', 'MODULE_TEST', 'Tester', ['docs/07-module-test.md'], ['S006'], ['tests/test_module.py']),
      step('S008', 'FUNCTIONAL_TEST', 'Tester', ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'], ['S007'], ['tests/test_functional.py']),
    ],
  };
}

async function seedPairedTestAssets(plan: Plan): Promise<void> {
  for (const step of plan.steps) {
    if (!['REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN', 'CODE'].includes(step.phase)) {
      continue;
    }
    for (const output of step.outputs) {
      if (output.includes('test-plan.md')) {
        if (!(await ws.exists(output))) await ws.writeFile(output, `# ${step.phase} test plan\n`);
      } else if (output.startsWith('tests/') && output.endsWith('.py')) {
        if (!(await ws.exists(output))) {
          await ws.writeFile(
            output,
            'import hello\n\n\ndef test_declared_case():\n    assert hello is not None\n',
          );
        }
      }
    }
  }
}

describe('PhaseEngine end-to-end (no real LLM, no real sandbox build)', () => {
  it('routes a source-stage completion gap through an Enhance Ticket and incremental rerun', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    codeStep.dependsOn = [];
    codeStep.outputs = ['src/hello.py'];
    plan.steps = [codeStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const coder = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'write the initial implementation but report the missing branch',
        actions: [{
          tool: 'write_file',
          args: { path: 'src/hello.py', content: 'def hi():\n    return "partial"\n' },
        }],
        qualityAssessment: {
          completion: 0.5,
          upstreamAlignment: 1,
          metrics: {},
          tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
          evidence: ['src/hello.py'],
          gaps: ['error handling branch is missing'],
        },
        done: true,
      }),
      JSON.stringify({
        thoughts: 'append only the missing branch required by the enhancement',
        actions: [{
          tool: 'write_file',
          args: {
            path: 'src/hello.py',
            content: 'def hi(value=None):\n    if value is None:\n        return "fallback"\n    return value\n',
          },
        }],
        qualityAssessment: {
          // The model emitted this assessment before its write action. The
          // runtime must reconcile the now-stale output gap with disk state.
          completion: 0,
          upstreamAlignment: 1,
          metrics: {},
          tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
          evidence: [],
          gaps: ['missing required output: src/hello.py'],
        },
        done: true,
      }),
    ]);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({ Coder: coder }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(codeStep.status).toBe('DONE');
    expect(coder.calls[1]?.find((message) => message.role === 'user')?.content)
      .toContain('## active enhancement ticket');
    const tickets = JSON.parse(await ws.readFile('.xcompiler/tickets/index.json')) as Array<{
      type: string;
      status: string;
      sourceQualityGateStepId?: string;
    }>;
    expect(tickets).toContainEqual(expect.objectContaining({
      type: 'enhance',
      status: 'closed',
      sourceQualityGateStepId: codeStep.id,
    }));
  });

  it('preserves the document baseline and adds read/patch tools for an Enhance rerun', async () => {
    const plan = fakePlan();
    const requirementStep = plan.steps.find(
      (step) => step.phase === 'REQUIREMENT_ANALYSIS',
    )!;
    requirementStep.dependsOn = [];
    requirementStep.tools = ['write_file'];
    requirementStep.outputs = ['docs/requirements-baseline.md'];
    plan.steps = [requirementStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const planner = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'write the baseline and report the missing error scenarios',
        actions: [{
          tool: 'write_file',
          args: {
            path: 'docs/requirements-baseline.md',
            content: '# Requirements\n',
          },
        }],
        qualityAssessment: {
          completion: 0.7,
          upstreamAlignment: 1,
          metrics: {},
          tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
          evidence: ['docs/requirements-baseline.md'],
          gaps: ['error scenarios are incomplete'],
        },
        done: true,
      }),
      JSON.stringify({
        thoughts: 'inspect and patch only the missing section',
        actions: [
          {
            tool: 'read_file',
            args: { path: 'docs/requirements-baseline.md' },
          },
          {
            tool: 'replace_in_file',
            args: {
              path: 'docs/requirements-baseline.md',
              find: '# Requirements\n',
              replace: '# Requirements\n\n## Error scenarios\n- timeout\n',
            },
          },
        ],
        qualityAssessment: {
          completion: 1,
          upstreamAlignment: 1,
          metrics: {},
          tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
          evidence: ['docs/requirements-baseline.md'],
          gaps: [],
        },
        done: true,
      }),
    ]);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({ Planner: planner }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(await ws.readFile('docs/requirements-baseline.md')).toContain(
      '## Error scenarios',
    );
    expect(planner.calls[1]?.find((message) => message.role === 'user')?.content)
      .toContain('## active enhancement ticket');
    expect(planner.calls[1]?.find((message) => message.role === 'user')?.content)
      .toContain('### docs/requirements-baseline.md');
    expect(await ws.exists('docs/history')).toBe(false);
  });

  it('resumes an interrupted Enhance inspection as incremental validation instead of Debugger', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    codeStep.dependsOn = [];
    codeStep.outputs = ['src/hello.py'];
    plan.steps = [codeStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);

    const interruptedCoder = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'write the complete output but request an independent quality review',
        actions: [{
          tool: 'write_file',
          args: { path: 'src/hello.py', content: 'def hi():\n    return "complete"\n' },
        }],
        qualityAssessment: {
          completion: 0.8,
          upstreamAlignment: 1,
          metrics: {},
          tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
          evidence: ['src/hello.py'],
          gaps: ['independent output review is still required'],
        },
        done: true,
      }),
      ...Array.from({ length: 3 }, () => JSON.stringify({
        thoughts: 'inspect the existing output before completing the quality review',
        actions: [{ tool: 'read_file', args: { path: 'src/hello.py' } }],
        done: false,
      })),
    ]);
    const firstRun = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({ Coder: interruptedCoder }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 3,
      maxDebugRetries: 0,
    });

    const interrupted = await firstRun.run(plan);
    expect(interrupted.failedStepId).toBe(codeStep.id);

    const resumedCoder = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'the existing output satisfies the enhancement after direct inspection',
        actions: [{ tool: 'read_file', args: { path: 'src/hello.py' } }],
        qualityAssessment: {
          completion: 1,
          upstreamAlignment: 1,
          metrics: {},
          tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
          evidence: ['src/hello.py contains the complete implementation'],
          gaps: [],
        },
        done: true,
      }),
    ]);
    const resumedRun = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({
        Coder: resumedCoder,
        Debugger: new ThrowingLLM(new Error('Debugger must not handle an inspection-only Enhance loop')),
      }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const resumed = await resumedRun.run(plan);

    expect(resumed.failedStepId).toBeUndefined();
    expect(resumedCoder.calls).toHaveLength(1);
    expect(resumedCoder.lastUser).toContain('## active enhancement ticket');
    const tickets = JSON.parse(await ws.readFile('.xcompiler/tickets/index.json')) as Array<{
      type: string;
      status: string;
      source?: { stepId?: string };
    }>;
    expect(tickets).toContainEqual(expect.objectContaining({
      type: 'enhance',
      status: 'closed',
      source: expect.objectContaining({ stepId: codeStep.id }),
    }));
    expect(tickets).toContainEqual(expect.objectContaining({
      type: 'bug',
      status: 'closed',
      source: expect.objectContaining({ stepId: codeStep.id }),
    }));
  });

  it('routes UNIT_TEST coverage shortfall to CODE as Enhance without opening a Bug', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.dependsOn = [];
    codeStep.status = 'DONE';
    unitStep.dependsOn = [codeStep.id];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi(value=None):\n    return value\n');

    const tester = new ScriptedLLM([
      JSON.stringify({
        thoughts: 'tests pass but coverage is below the engineering threshold',
        actions: [{
          tool: 'write_file',
          args: { path: 'docs/05-unit-test.md', content: '# Unit coverage gap\n' },
        }],
        qualityAssessment: {
          metrics: {
            lineCoverage: 0.65,
            branchCoverage: 0.5,
            testCasePassRate: 1,
          },
          tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
          evidence: ['docs/05-unit-test.md'],
          gaps: [],
        },
        done: true,
      }),
      JSON.stringify({
        thoughts: 'coverage now satisfies the gate',
        actions: [{
          tool: 'write_file',
          args: { path: 'docs/05-unit-test.md', content: '# Unit coverage passed\n' },
        }],
        qualityAssessment: {
          metrics: {
            lineCoverage: 0.9,
            branchCoverage: 0.8,
            testCasePassRate: 1,
          },
          tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
          evidence: ['docs/05-unit-test.md'],
          gaps: [],
        },
        done: true,
      }),
    ]);
    const coder = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'add the missing branch test only',
        actions: [{
          tool: 'write_file',
          args: {
            path: 'tests/test_hello.py',
            content:
              'from hello import hi\n\n\ndef test_value():\n    assert hi("value") == "value"\n\n' +
              'def test_none_branch():\n    assert hi() is None\n',
          },
        }],
        done: true,
      }),
    ]);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new CapturingTestArgsSandbox(),
      router: new FakeRouter({
        Coder: coder,
        Tester: tester,
      }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(coder.lastUser).toContain('## active enhancement ticket');
    const tickets = JSON.parse(await ws.readFile('.xcompiler/tickets/index.json')) as Array<{
      type: string;
      status: string;
      targetStepId?: string;
      verificationStepId?: string;
    }>;
    expect(tickets.filter((ticket) => ticket.type === 'bug')).toEqual([]);
    expect(tickets).toContainEqual(expect.objectContaining({
      type: 'enhance',
      status: 'closed',
      targetStepId: codeStep.id,
      verificationStepId: unitStep.id,
    }));
  });

  it('validates CODE outputs and routes compiler errors to same-phase Debugger', async () => {
    const plan = fakePlan();
    const code = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{ ...code, dependsOn: [], tools: ['write_file'] }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const validationSandbox = new CodeValidationSandbox(ws);
    const router = new FakeRouter({
      Coder: new ScriptedLLM([JSON.stringify({
        thoughts: 'write initial source',
        actions: [
          { tool: 'write_file', args: { path: 'src/hello.py', content: 'syntax_error\n' } },
          { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
        ],
        done: true,
      })]),
      Debugger: new ScriptedLLM([JSON.stringify({
        thoughts: 'repair compiler error',
        actions: [
          { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
        ],
        done: true,
      })]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: validationSandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      debugWikiPath: path.join(tmp, '.xcompiler', 'debug-wiki'),
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(plan.steps[0]?.status).toBe('DONE');
    expect(validationSandbox.validationArgs).toEqual([
      codeValidationCommand('python').args,
      codeValidationCommand('python').args,
    ]);
    expect(await ws.readFile('src/hello.py')).toContain('def hi');
    expect(await ws.readFile('.xcompiler/tickets/events.jsonl')).toContain('CODE validation failed');
  });

  it('revalidates preserved CODE state before resuming cached Debugger evidence', async () => {
    const plan = fakePlan();
    const code = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{ ...code, dependsOn: [] }];
    const validationSandbox = new CodeValidationSandbox(ws);
    const validator = new CodePhaseValidator(
      ws,
      validationSandbox,
      audit,
      async () => ({ approved: true }),
    );
    await ws.writeFile('src/hello.py', 'syntax_error\n');

    const failed = await validator.validateExisting(
      plan,
      plan.steps[0]!,
      getLanguageProfile('python'),
      (candidate) => candidate.status === 'DONE',
    );

    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') {
      expect(failed.reason).toContain('CODE revalidation failed');
      expect(failed.failureLog).toContain('SyntaxError: invalid syntax in src/hello.py');
    }

    await ws.writeFile('src/hello.py', 'def hi():\n    return 1\n');
    const passed = await validator.validateExisting(
      plan,
      plan.steps[0]!,
      getLanguageProfile('python'),
      (candidate) => candidate.status === 'DONE',
    );

    expect(passed.status).toBe('passed');
    expect(validationSandbox.validationArgs).toEqual([
      codeValidationCommand('python').args,
      codeValidationCommand('python').args,
    ]);
  });

  it('defers project-wide CODE validation until the final CODE step in an iteration', () => {
    const plan = fakePlan();
    const code = plan.steps.find((step) => step.phase === 'CODE')!;
    const laterCode = { ...code, id: 'S004B', status: 'PENDING' as const };
    plan.steps = [code, laterCode];

    expect(shouldRunCodeValidation(plan, code, (step) => step.status === 'DONE')).toBe(false);
    code.status = 'DONE';
    expect(shouldRunCodeValidation(plan, laterCode, (step) => step.status === 'DONE')).toBe(true);
    code.status = 'FAILED';
    expect(shouldRunCodeValidation(plan, laterCode, (step) => step.status === 'DONE')).toBe(false);
  });

  it('does not let --from bypass an earlier incomplete V-model step', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.dependsOn = [];
    codeStep.status = 'FAILED';
    unitStep.dependsOn = [codeStep.id];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({}) as unknown as LLMRouter,
      audit,
      planPath,
      fromStepId: unitStep.id,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBe(codeStep.id);
    expect(result.failureReason).toContain(`cannot start from ${unitStep.id}`);
    expect(codeStep.status).toBe('FAILED');
    expect(unitStep.status).toBe('PENDING');
  });

  it('does not let --phase execute a test phase with incomplete dependencies', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.dependsOn = [];
    codeStep.status = 'FAILED';
    unitStep.dependsOn = [codeStep.id];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({}) as unknown as LLMRouter,
      audit,
      planPath,
      onlyPhase: 'UNIT_TEST',
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBe(unitStep.id);
    expect(result.failureReason).toContain('dependency chain is incomplete');
    expect(unitStep.status).toBe('PENDING');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.step_blocked_incomplete_dependencies');
  });

  it.each([
    ['UNIT_TEST', 'CODE'],
    ['INTEGRATION_TEST', 'DETAILED_DESIGN'],
    ['MODULE_TEST', 'HIGH_LEVEL_DESIGN'],
    ['FUNCTIONAL_TEST', 'REQUIREMENT_ANALYSIS'],
  ] as const)(
    'rolls %s failures back to %s and resets every later V-model phase',
    async (testPhase, sourcePhase) => {
      const plan = fakePlan();
      for (const step of plan.steps) step.status = 'DONE';
      const failedTest = plan.steps.find((step) => step.phase === testPhase)!;
      const sourceStep = plan.steps.find((step) => step.phase === sourcePhase)!;
      failedTest.status = 'FAILED';
      const planPath = path.join(tmp, 'plan.json');
      await savePlan(planPath, plan);

      const engine = new PhaseEngine({
        ws,
        git,
        sandbox,
        router: new FakeRouter({}) as unknown as LLMRouter,
        audit,
        planPath,
      });
      const repairedStepIds: string[] = [];
      const internal = engine as unknown as {
        lastFailure: { reason: string; failureLog: string };
        executeStepWithDebug: (plan: Plan, step: Plan['steps'][number]) => Promise<boolean>;
        validateTestPhaseWithoutRegeneration: () => Promise<{ status: 'passed' }>;
        rollbackFailedTestPhase: (
          plan: Plan,
          order: Plan['steps'],
          failedTest: Plan['steps'][number],
        ) => Promise<EngineResult & { ok: boolean; restartIndex?: number }>;
      };
      internal.lastFailure = {
        reason: `${testPhase} gate failed`,
        failureLog: `run_tests failed in ${testPhase}`,
      };
      internal.executeStepWithDebug = async (_plan, step) => {
        repairedStepIds.push(step.id);
        step.status = 'DONE';
        return true;
      };
      internal.validateTestPhaseWithoutRegeneration = async () => ({ status: 'passed' });

      const result = await internal.rollbackFailedTestPhase(plan, plan.steps, failedTest);
      const sourceIndex = plan.steps.findIndex((step) => step.id === sourceStep.id);

      expect(result.ok).toBe(true);
      expect(result.restartIndex).toBe(sourceIndex);
      expect(repairedStepIds).toEqual([sourceStep.id]);
      expect(sourceStep.status).toBe('DONE');
      expect(plan.steps.slice(0, sourceIndex).every((step) => step.status === 'DONE')).toBe(true);
      expect(plan.steps.slice(sourceIndex + 1).every((step) => step.status === 'PENDING')).toBe(true);
    },
  );

  it('records a denied CODE validation permission without invoking Debugger', async () => {
    const plan = fakePlan();
    const code = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{ ...code, dependsOn: [], tools: ['write_file'] }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const debuggerLlm = new ThrowingLLM(new Error('Debugger must not run for denied permission'));
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new CodeValidationSandbox(ws),
      router: new FakeRouter({
        Coder: new ScriptedLLM([JSON.stringify({
          thoughts: 'write valid source',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
          ],
          done: true,
        })]),
        Debugger: debuggerLlm,
      }) as unknown as LLMRouter,
      audit,
      planPath,
      debugWikiPath: path.join(tmp, '.xcompiler', 'debug-wiki'),
      requestPermission: async (request) => ({
        approved: request.operationType !== 'build_command',
        reason: request.operationType === 'build_command' ? 'user denied compiler execution' : undefined,
      }),
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBe('S004');
    expect(debuggerLlm.calls).toBe(0);
    expect(await ws.readFile('.xcompiler/tickets/events.jsonl')).toContain('permission denied for CODE validation');
  });

  it('keeps right-side validation DEBUG writes scoped to its own report outputs', async () => {
    const plan = fakePlan();
    const debugSourceStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    const allowed = computeDebugAllowedWrites(
      plan,
      debugSourceStep,
      getLanguageProfile(plan.language),
    );
    expect(allowed).toEqual(expect.arrayContaining(debugSourceStep.outputs));
    expect(allowed).not.toContain('src/hello.py');
    expect(allowed).not.toContain('tests/test_hello.py');
    expect(allowed).not.toContain('docs/03-detailed-design.md');
  });

  it('emits run, step, attempt and tool hooks in lifecycle order', async () => {
    const plan = fakePlan();
    plan.steps = plan.steps.slice(0, 1);
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const events: string[] = [];
    const plugins = new PluginHost({
      plugins: [{
        manifest: {
          id: 'engine-lifecycle',
          version: '1.0.0',
          apiVersion: XCOMPILER_PLUGIN_API_VERSION,
          minXCompilerVersion: '0.1.3',
        },
        setup(api) {
          for (const hook of [
            'run.before',
            'step.before',
            'step.attempt.before',
            'tool.before',
            'tool.after',
            'step.attempt.after',
            'step.after',
            'run.after',
          ] as const) {
            api.on(hook, () => { events.push(hook); });
          }
        },
      }],
    });
    const router = new FakeRouter({
      Planner: new ScriptedLLM([JSON.stringify({
        thoughts: 'write requirements',
        actions: [
          { tool: 'write_file', args: { path: 'docs/01-requirement-analysis.md', content: '# req' } },
          { tool: 'write_file', args: { path: 'docs/tests/functional-test-plan.md', content: '# functional plan' } },
          { tool: 'write_file', args: { path: 'tests/test_functional.py', content: 'import hello\n\n\ndef test_functional():\n    assert hello is not None\n' } },
        ],
        done: true,
      })]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      plugins,
      planPath,
      maxRoundsPerStep: 1,
    });
    const result = await engine.run(plan);
    expect(result.failedStepId).toBeUndefined();
    expect(events).toEqual([
      'run.before',
      'step.before',
      'step.attempt.before',
      'tool.before',
      'tool.after',
      'tool.before',
      'tool.after',
      'tool.before',
      'tool.after',
      'step.attempt.after',
      'step.after',
      'run.after',
    ]);
  });

  it('walks all phases and persists plan with DONE statuses', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    codeStep.outputs = ['src/hello.py', 'src/main.py', 'docs/tests/unit-test-plan.md', 'tests/test_hello.py'];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);

    // Empty requirements.txt absent → engine skips sandbox build before run.
    // S002 will write requirements.txt; engine then attempts to (re)build sandbox.
    // To avoid invoking real python in CI, we monkey-patch sandbox.build.
    let buildCalls = 0;
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => {
        buildCalls++;
        return { rebuilt: false, reason: 'stubbed' };
      };
    // V-model test gates stub: pretend pytest passed.
    (sandbox as unknown as { runTests: () => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> }).runTests =
      async () => ({ exitCode: 0, stdout: '1 passed', stderr: '', timedOut: false });
    (sandbox as unknown as { runProgram: () => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }> }).runProgram =
      async () => okExec({ stdout: 'usage: demo\n' });

    const router = new FakeRouter({
      Planner: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write requirements',
          actions: [
            { tool: 'write_file', args: { path: 'docs/01-requirement-analysis.md', content: '# req' } },
            { tool: 'write_file', args: { path: 'docs/tests/functional-test-plan.md', content: '# functional plan' } },
            { tool: 'write_file', args: { path: 'tests/test_functional.py', content: 'import hello\n\n\ndef test_functional():\n    assert hello is not None\n' } },
          ],
          done: true,
        }),
      ]),
      Architect: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'declare high level design',
          actions: [
            { tool: 'write_file', args: { path: 'docs/02-high-level-design.md', content: '# high level\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/module-test-plan.md', content: '# module plan\n' } },
            { tool: 'write_file', args: { path: 'tests/test_module.py', content: 'import hello\n\n\ndef test_module():\n    assert hello is not None\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'declare detailed design',
          actions: [
            { tool: 'write_file', args: { path: 'docs/03-detailed-design.md', content: '# detailed\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/integration-test-plan.md', content: '# integration plan\n' } },
            { tool: 'write_file', args: { path: 'tests/test_integration.py', content: 'import hello\nimport main\n\n\ndef test_integration():\n    assert hello is not None\n    assert main is not None\n' } },
          ],
          done: true,
        }),
      ]),
      Coder: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'add hello',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
            { tool: 'write_file', args: { path: 'src/main.py', content: 'import argparse\n\nif __name__ == "__main__":\n    argparse.ArgumentParser(description="demo").parse_args()\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
            { tool: 'write_file', args: { path: 'tests/test_hello.py', content: 'from src.hello import hi\n\ndef test_hi():\n    assert hi() == 1\n' } },
          ],
          done: true,
        }),
      ]),
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'add unit test',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# unit test\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'add integration test',
          actions: [
            { tool: 'write_file', args: { path: 'docs/06-integration-test.md', content: '# integration test\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'add module test',
          actions: [
            { tool: 'write_file', args: { path: 'docs/07-module-test.md', content: '# module test\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'write functional docs',
          actions: [
            { tool: 'write_file', args: { path: 'README.md', content: '# Demo\n' } },
            { tool: 'write_file', args: { path: 'docs/quickstart.md', content: '# QuickStart\n' } },
            { tool: 'write_file', args: { path: 'docs/08-functional-test.md', content: '# functional test\n' } },
          ],
          done: true,
        }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });

    const r = await engine.run(plan);
    expect(r.failedStepId).toBeUndefined();
    expect(r.executedSteps).toBe(8);
    expect(plan.steps.every((s) => s.status === 'DONE')).toBe(true);

    // Files exist
    expect(await ws.exists('docs/01-requirement-analysis.md')).toBe(true);
    expect(await ws.exists('docs/02-high-level-design.md')).toBe(true);
    expect(await ws.exists('docs/03-detailed-design.md')).toBe(true);
    expect(await ws.exists('src/hello.py')).toBe(true);
    expect(await ws.exists('tests/test_hello.py')).toBe(true);
    expect(await ws.exists('docs/08-functional-test.md')).toBe(true);

    // Sandbox build call count is environment-dependent; just assert it didn't error.
    // engine builds once at start only if requirements.txt pre-exists. Just assert it didn't error.
    expect(buildCalls).toBeGreaterThanOrEqual(0);

    // Plan was persisted with DONE
    const saved = JSON.parse(await fs.readFile(planPath, 'utf8')) as Plan;
    expect(saved.steps.every((s) => s.status === 'DONE')).toBe(true);
  });

  it('scopes V-model test gates to the current test step inputs', async () => {
    const plan = fakePlan();
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    plan.steps = [{
      ...unitStep,
      dependsOn: [],
      inputs: ['tests/test_unit_s005.py'],
      outputs: ['docs/05-unit-test.md'],
    }];
    await ws.writeFile('tests/test_unit_s005.py', 'def test_unit():\n    assert True\n');
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const router = new FakeRouter({
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write the unit validation report',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit Test\n' } },
          ],
          done: true,
        }),
      ]),
    });
    const scopedSandbox = new CapturingTestArgsSandbox();
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: scopedSandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(scopedSandbox.testArgs).toContainEqual(['tests/test_unit_s005.py']);
  });

  it('does not roll back a test phase when a later run_tests call succeeds in the same attempt', async () => {
    const plan = fakePlan();
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    plan.steps = [{
      ...unitStep,
      dependsOn: [],
      tools: ['write_file', 'run_tests'],
      inputs: ['tests/test_unit_s005.py'],
      outputs: ['docs/05-unit-test.md'],
    }];
    await ws.writeFile('tests/test_unit_s005.py', 'def test_unit():\n    assert True\n');
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const router = new FakeRouter({
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write the unit validation report, observe one failure, then verify the repair',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit Test\n' } },
            { tool: 'run_tests', args: { args: ['tests/test_unit_s005.py'] } },
            { tool: 'run_tests', args: { args: ['tests/test_unit_s005.py'] } },
          ],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new FirstFailThenPassSandbox(),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(plan.steps[0]?.status).toBe('DONE');
  });

  it('does not roll back after an optional dependency action is denied and the configured test gate passes', async () => {
    const plan = fakePlan();
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    plan.steps = [{
      ...unitStep,
      dependsOn: [],
      tools: ['write_file', 'run_tests'],
      inputs: ['tests/test_unit_s005.py'],
      outputs: ['docs/05-unit-test.md'],
    }];
    await ws.writeFile('tests/test_unit_s005.py', 'def test_unit():\n    assert True\n');
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const router = new FakeRouter({
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'coverage is optional; use the configured test command after dependency denial',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit Test\n' } },
            { tool: 'add_dependency', args: { name: '@vitest/coverage-v8', dev: true } },
            { tool: 'run_tests', args: { args: ['tests/test_unit_s005.py'] } },
          ],
          done: false,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new CapturingTestArgsSandbox(),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(plan.steps[0]?.status).toBe('DONE');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).not.toContain('rolling back to paired V-model source phase');
  });

  it('rejects a validation phase when its paired test asset is missing before any LLM call', async () => {
    const plan = fakePlan();
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    plan.steps = [{
      ...unitStep,
      dependsOn: [],
      tools: ['write_file', 'run_tests'],
      inputs: ['tests/test_unit_s005.py'],
      outputs: ['docs/05-unit-test.md'],
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const tester = new CapturingScriptedLLM([
      JSON.stringify({ thoughts: 'must not run', actions: [], done: true }),
    ]);
    const debuggerLlm = new CapturingScriptedLLM([
      JSON.stringify({ thoughts: 'must not run', actions: [], done: true }),
    ]);
    const router = new FakeRouter({
      Tester: tester,
      Debugger: debuggerLlm,
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new CapturingTestArgsSandbox(),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBe('S005');
    expect(tester.calls).toHaveLength(0);
    expect(debuggerLlm.calls).toHaveLength(0);
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"stepId":"S005"');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.test_case_completeness_failed');
  });

  it('does not let cached test history bypass the paired test completeness gate', async () => {
    const plan = fakePlan();
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    plan.steps = [{
      ...unitStep,
      dependsOn: [],
      tools: ['write_file', 'run_tests'],
      inputs: ['tests/test_unit_s005.py'],
      outputs: ['docs/05-unit-test.md'],
      status: 'FAILED',
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await fs.mkdir(path.join(tmp, '.xcompiler'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.xcompiler/debug_cache.json'),
      JSON.stringify({
        version: 1,
        steps: {
          [stepExecutionKey(unitStep)]: {
            lastUpdated: new Date().toISOString(),
            lastStatus: 'RUNNING',
            lastReason: 'UNIT_TEST tool verification failed; rolling back to paired V-model source phase.',
            attempts: [{
              attempt: 0,
              ts: new Date().toISOString(),
              reason: 'UNIT_TEST tool verification failed; rolling back to paired V-model source phase.',
              failureLogTail: [
                '工具调用：',
                '  - run_tests 成功 pytest exit=0',
                '  - write_file 成功 wrote tests/test_unit_s005.py (7457B)',
                '  - run_tests 失败 pytest exit=1',
                'FAILED tests/test_unit_s005.py::test_bad_assertion',
              ].join('\n'),
            }],
          },
        },
      }),
      'utf8',
    );

    const debuggerLlm = new CapturingScriptedLLM([
        JSON.stringify({
          thoughts: 'must not bypass completeness',
          actions: [],
          done: true,
        }),
      ]);
    const router = new FakeRouter({
      Debugger: debuggerLlm,
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new CapturingTestArgsSandbox(),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBe('S005');
    expect(debuggerLlm.calls).toHaveLength(0);
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.rollback_validation_test_cases_incomplete');
  });

  it('rolls back a test-phase run_tests tool failure to the paired CODE step', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    plan.steps = [codeStep, unitStep];
    codeStep.dependsOn = [];
    codeStep.outputs = ['src/hello.py', 'docs/tests/unit-test-plan.md', 'tests/test_hello.py'];
    unitStep.inputs = ['src/hello.py', 'tests/test_hello.py'];
    unitStep.outputs = ['docs/05-unit-test.md'];
    unitStep.tools = ['write_file', 'run_tests'];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await fs.mkdir(path.join(tmp, '.xcompiler'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.xcompiler/debug_cache.json'),
      JSON.stringify({
        version: 1,
        steps: {
          [stepExecutionKey(codeStep)]: {
            lastUpdated: new Date().toISOString(),
            lastStatus: 'RUNNING',
            lastReason: 'all LLM providers failed for role Debugger',
            attempts: [
              {
                attempt: 1,
                ts: new Date().toISOString(),
                reason: 'all LLM providers failed for role Debugger: groq/OpenAI HTTP 429 tokens per day',
                failureLogTail: 'OpenAI HTTP 429 tokens per day\n## latest Debugger attempt failure\nstale provider noise',
              },
              {
                attempt: 2,
                ts: new Date().toISOString(),
                reason: 'repeated read-only/probe actions without progress for 3 rounds',
                failureLogTail: 'read_file src/hello.py',
              },
            ],
          },
        },
      }),
      'utf8',
    );

    const debuggerLlm = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'repair implementation instead of rewriting the test',
        actions: [
          { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "fixed"\n' } },
        ],
        done: true,
      }),
    ]);

    const router = new FakeRouter({
      Coder: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write broken implementation',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "broken"\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# Unit plan\n' } },
            { tool: 'write_file', args: { path: 'tests/test_hello.py', content: 'from src.hello import hi\n\ndef test_hi():\n    assert hi() == "fixed"\n' } },
          ],
          done: true,
        }),
      ]),
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write unit test and verify',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit\n' } },
            { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
          ],
          done: false,
        }),
        JSON.stringify({
          thoughts: 'formally rerun the repaired unit gate and report quality evidence',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit verified\n' } },
            { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
          ],
          done: true,
        }),
      ]),
      Debugger: debuggerLlm,
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new UnitRollbackSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(await ws.readFile('src/hello.py')).toContain('fixed');
    expect(await ws.readFile('tests/test_hello.py')).toContain('assert hi() == "fixed"');
    expect(unitStep.status).toBe('DONE');
    expect(debuggerLlm.lastUser).toContain('test_hi');
    expect(debuggerLlm.lastUser).not.toContain('paired source phase latest failure');
    expect(debuggerLlm.lastUser).not.toContain('tokens per day');
    expect(debuggerLlm.lastUser).not.toContain('stale provider noise');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.test_phase_rollback');
    expect(auditLog).toContain('engine.failed_validation_evidence_preserved');
    expect(auditLog).toContain('engine.rollback_validation_deferred');
    const qualityRecords = JSON.parse(
      await ws.readFile('.xcompiler/quality/assessments.json'),
    ) as Array<{ stepId: string; evaluation: { passed: boolean } }>;
    expect(qualityRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: unitStep.id,
        evaluation: { passed: true, enhancementFailures: [], bugFailures: [] },
      }),
    ]));
    const allTickets = JSON.parse(await ws.readFile('.xcompiler/tickets/index.json')) as Array<{ type: string }>;
    expect(allTickets.filter((ticket) => ticket.type === 'change-request')).toHaveLength(0);
    const bugEvents = (await ws.readFile('.xcompiler/tickets/events.jsonl'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        event: string;
        ticketId: string;
        ticketType: string;
        status: string;
        stepId?: string;
        targetStepId?: string;
        verificationStepId?: string;
      });
    const bugTicketId = bugEvents.find((event) =>
      event.event === 'created' &&
      event.ticketType === 'bug' &&
      event.stepId === unitStep.id)?.ticketId;
    expect(bugTicketId).toBeTruthy();
    expect(bugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'verification-required',
        ticketId: bugTicketId,
        targetStepId: codeStep.id,
        verificationStepId: unitStep.id,
      }),
      expect.objectContaining({
        event: 'repair-ready',
        ticketId: bugTicketId,
        status: 'verification',
      }),
      expect.objectContaining({
        event: 'resolved',
        ticketId: bugTicketId,
        status: 'resolved',
      }),
    ]));
    const repairReadyIndex = bugEvents.findIndex((event) =>
      event.event === 'repair-ready' && event.ticketId === bugTicketId);
    const resolvedIndex = bugEvents.findIndex((event) =>
      event.event === 'resolved' && event.ticketId === bugTicketId);
    expect(repairReadyIndex).toBeGreaterThanOrEqual(0);
    expect(resolvedIndex).toBeGreaterThan(repairReadyIndex);
  });

  it('preloads implementation files into test-phase context within the model window budget', async () => {
    const plan = fakePlan();
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [codeStep, unitStep];
    codeStep.outputs = [
      'src/hello.py',
      'src/support.py',
      'docs/tests/unit-test-plan.md',
      'tests/test_hello.py',
    ];
    unitStep.inputs = ['docs/tests/unit-test-plan.md'];
    await ws.writeFile('src/hello.py', 'def hi():\n    return "hello"\n');
    await ws.writeFile('src/support.py', 'VALUE = 1\n');
    await ws.writeFile('docs/tests/unit-test-plan.md', '# Unit plan\n');
    const snippets = await buildContextSnippets({
      workspace: ws,
      plan,
      step: unitStep,
      tickets: new TicketStore(ws),
      projectMemory: null,
      profile: getLanguageProfile(plan.language),
      contextWindowTokens: 16 * 1024,
    });

    expect(snippets).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/hello.py', content: expect.stringContaining('return "hello"') }),
      expect.objectContaining({ path: 'src/support.py', content: expect.stringContaining('VALUE = 1') }),
    ]));
  });

  it('clears infra-only cached debug history and reruns the step normally instead of exiting', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{ ...codeStep, dependsOn: [] }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await fs.mkdir(path.join(tmp, '.xcompiler'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.xcompiler/debug_cache.json'),
      JSON.stringify({
        version: 1,
        steps: {
          [stepExecutionKey(codeStep)]: {
            lastUpdated: new Date().toISOString(),
            lastStatus: 'FAILED',
            lastReason: 'all LLM providers failed for role Coder',
            attempts: [
              {
                attempt: 0,
                ts: new Date().toISOString(),
                reason: 'all LLM providers failed for role Coder: openrouter_free/openrouter/free: OpenAI stream idle before first token for 300000ms; aborting',
                failureLogTail: 'OpenAI stream idle before first token for 300000ms; aborting',
              },
              {
                attempt: 1,
                ts: new Date().toISOString(),
                reason: 'all LLM providers failed for role Coder: TypeError: fetch failed',
                failureLogTail: 'TypeError: fetch failed',
              },
            ],
          },
        },
      }),
      'utf8',
    );

    // 只提供 Coder：若引擎错误地沿用旧行为（合成失败退出或进入 Debugger resume），
    // FakeRouter 会因缺少 Debugger 而失败，failedStepId 将被设置。
    const coder = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'provider connectivity restored; write implementation normally',
        actions: [
          { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
          { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
        ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({ Coder: coder });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new CodeValidationSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(coder.calls.length).toBe(1);
    expect(coder.lastUser).not.toContain('历史 DEBUG 尝试');
    const cache = JSON.parse(await fs.readFile(path.join(tmp, '.xcompiler/debug_cache.json'), 'utf8')) as {
      steps: Record<string, unknown>;
    };
    expect(cache.steps[stepExecutionKey(codeStep)]).toBeUndefined();
  });

  it('rolls INTEGRATION_TEST gate failures back to DETAILED_DESIGN, not HIGH_LEVEL_DESIGN', async () => {
    const plan = fakePlan();
    const detailedStep = plan.steps.find((step) => step.phase === 'DETAILED_DESIGN')!;
    const integrationStep = plan.steps.find((step) => step.phase === 'INTEGRATION_TEST')!;
    plan.steps = [detailedStep, integrationStep];
    detailedStep.dependsOn = [];
    detailedStep.outputs = [
      'docs/03-detailed-design.md',
      'docs/tests/integration-test-plan.md',
      'tests/test_integration.py',
    ];
    integrationStep.dependsOn = [detailedStep.id];
    integrationStep.inputs = ['docs/03-detailed-design.md', 'tests/test_integration.py'];
    integrationStep.outputs = ['docs/06-integration-test.md'];
    integrationStep.tools = ['write_file', 'run_tests'];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);

    const testerLlm = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'write integration test and verify',
          actions: [
            { tool: 'write_file', args: { path: 'docs/06-integration-test.md', content: '# Integration\n' } },
            { tool: 'run_tests', args: { args: ['tests/test_integration.py'] } },
        ],
        done: false,
      }),
      JSON.stringify({
        thoughts: 'apply and verify only the detailed design change',
          actions: [
            { tool: 'write_file', args: { path: 'docs/06-integration-test.md', content: '# Integration fixed\n' } },
          ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({
      Architect: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write initial detailed design',
          actions: [
            { tool: 'write_file', args: { path: 'docs/03-detailed-design.md', content: '# Detail\ninitial-contract\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/integration-test-plan.md', content: '# Integration plan\n' } },
            { tool: 'write_file', args: { path: 'tests/test_integration.py', content: 'def test_contract():\n    assert True\n' } },
          ],
          done: true,
        }),
      ]),
      Tester: testerLlm,
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'repair the paired detailed design contract',
          actions: [
            { tool: 'write_file', args: { path: 'docs/03-detailed-design.md', content: '# Detail\nfixed-detail-contract\n' } },
          ],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new IntegrationRollbackSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(await ws.readFile('docs/03-detailed-design.md')).toContain('fixed-detail-contract');
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"targetStepId":"S003"');
    expect(ticketLog).toContain('"targetPhase":"DETAILED_DESIGN"');
    expect(ticketLog).not.toContain('"targetStepId":"S002"');
    const requests = (JSON.parse(await ws.readFile('.xcompiler/tickets/index.json')) as Array<{
      type: string;
      status: string;
      triggerTicketId: string;
      originBugTicketId: string;
      sourceEnhanceTicketId: string;
      affectedSteps: Array<{ stepId: string }>;
      applications: Array<{ stepId: string; kind: string; commit: string }>;
    }>).filter((ticket) => ticket.type === 'change-request');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      status: 'closed',
      affectedSteps: [{ stepId: integrationStep.id }],
    });
    expect(requests[0]?.applications).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: detailedStep.id, kind: 'design-change' }),
      expect.objectContaining({ stepId: integrationStep.id, kind: 'verification' }),
    ]));
    expect(requests[0]?.triggerTicketId).toBe(requests[0]?.sourceEnhanceTicketId);
    const bug = JSON.parse(await ws.readFile(
      `.xcompiler/tickets/${requests[0]!.originBugTicketId}.json`,
    )) as { status: string; enhanceTicketId: string };
    expect(bug.status).toBe('closed');
    expect(bug.enhanceTicketId).toBe(requests[0]?.sourceEnhanceTicketId);
    const enhancement = JSON.parse(await ws.readFile(
      `.xcompiler/tickets/${requests[0]!.sourceEnhanceTicketId}.json`,
    )) as {
      type: string;
      status: string;
      disposition: string;
      changeRequestTicketIds: string[];
    };
    expect(enhancement).toMatchObject({
      type: 'enhance',
      status: 'closed',
      disposition: 'change-request',
      changeRequestTicketIds: [expect.stringMatching(/^CR-P1-/u)],
    });
    const summary = JSON.parse(await ws.readFile('.xcompiler/tickets/summary.json')) as {
      byType: Record<string, number>;
      changeRequests: { total: number; totalRevisions: number };
    };
    expect(summary.byType.enhance).toBe(1);
    expect(summary.changeRequests).toMatchObject({ total: 1, totalRevisions: 1 });
    expect(router.scoreOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'quality-gap', ticketId: expect.stringMatching(/^ENHANCE-P1-/u) }),
      expect.objectContaining({ outcome: 'change-verified', ticketId: expect.stringMatching(/^CR-P1-/u) }),
      expect.objectContaining({ outcome: 'repair-verified', ticketId: expect.stringMatching(/^ENHANCE-P1-/u) }),
    ]));
    expect(ticketLog.indexOf('"event":"change-request-linked"')).toBeLessThan(
      ticketLog.indexOf('"event":"resolved"'),
    );
  });

  it('resumes cached INTEGRATION_TEST failures by rolling back to DETAILED_DESIGN instead of same-phase Debugger', async () => {
    const plan = fakePlan();
    const detailedStep = plan.steps.find((step) => step.phase === 'DETAILED_DESIGN')!;
    const integrationStep = plan.steps.find((step) => step.phase === 'INTEGRATION_TEST')!;
    plan.steps = [detailedStep, integrationStep];
    detailedStep.dependsOn = [];
    detailedStep.outputs = [
      'docs/03-detailed-design.md',
      'docs/tests/integration-test-plan.md',
      'tests/test_integration.py',
    ];
    detailedStep.status = 'DONE';
    integrationStep.dependsOn = [detailedStep.id];
    integrationStep.inputs = ['docs/03-detailed-design.md', 'tests/test_integration.py'];
    integrationStep.outputs = ['docs/06-integration-test.md'];
    integrationStep.tools = ['write_file', 'run_tests'];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('tests/test_integration.py', 'def test_contract():\n    assert True\n');
    await fs.mkdir(path.join(tmp, '.xcompiler'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.xcompiler/debug_cache.json'),
      JSON.stringify({
        version: 1,
        steps: {
          [stepExecutionKey(integrationStep)]: {
            lastUpdated: new Date().toISOString(),
            lastStatus: 'FAILED',
            lastReason: 'cached integration failure',
            attempts: [{
              attempt: 1,
              ts: new Date().toISOString(),
              reason: 'cached integration failure',
              failureLogTail: 'run_tests FAIL pytest exit=1',
            }],
          },
        },
      }),
      'utf8',
    );

    const debuggerLlm = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'repair detailed design from cached integration failure',
        actions: [
          { tool: 'write_file', args: { path: 'docs/03-detailed-design.md', content: '# Detail\nfixed-detail-contract\n' } },
        ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'rerun integration after source rollback',
          actions: [
            { tool: 'write_file', args: { path: 'docs/06-integration-test.md', content: '# Integration\n' } },
          ],
          done: true,
        }),
      ]),
      Debugger: debuggerLlm,
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new IntegrationRollbackSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"targetStepId":"S003"');
    expect(ticketLog).toContain('"targetPhase":"DETAILED_DESIGN"');
    expect(ticketLog).not.toContain('"targetStepId":"S006"');
    expect(debuggerLlm.lastUser).toContain('integration contract failed: expected fixed detailed design');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.rollback_validation_started');
    expect(auditLog).toContain('"missingNonTestOutputs":["docs/06-integration-test.md"]');
  });

  it('reruns every intervening V-model step after an integration rollback instead of jumping to later tests', async () => {
    const plan = fakePlan();
    const detailedStep = plan.steps.find((step) => step.phase === 'DETAILED_DESIGN')!;
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    const integrationStep = plan.steps.find((step) => step.phase === 'INTEGRATION_TEST')!;
    const moduleStep = plan.steps.find((step) => step.phase === 'MODULE_TEST')!;
    plan.steps = [detailedStep, codeStep, unitStep, integrationStep, moduleStep];
    detailedStep.dependsOn = [];
    detailedStep.outputs = [
      'docs/03-detailed-design.md',
      'docs/tests/integration-test-plan.md',
      'tests/test_integration.py',
    ];
    detailedStep.status = 'DONE';
    codeStep.dependsOn = [detailedStep.id];
    codeStep.outputs = ['src/hello.py', 'docs/tests/unit-test-plan.md', 'tests/test_hello.py'];
    codeStep.status = 'DONE';
    unitStep.dependsOn = [codeStep.id];
    unitStep.inputs = ['src/hello.py', 'tests/test_hello.py'];
    unitStep.outputs = ['docs/05-unit-test.md'];
    unitStep.status = 'DONE';
    integrationStep.dependsOn = [unitStep.id];
    integrationStep.inputs = ['tests/test_integration.py'];
    integrationStep.outputs = ['docs/06-integration-test.md'];
    integrationStep.status = 'FAILED';
    moduleStep.dependsOn = [integrationStep.id];
    moduleStep.inputs = ['tests/test_module.py'];
    moduleStep.outputs = ['docs/07-module-test.md'];
    moduleStep.status = 'PENDING';
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/03-detailed-design.md', '# Detail\nbroken contract\n');
    await ws.writeFile('src/hello.py', 'def hi():\n    return "old"\n');
    await ws.writeFile('docs/tests/unit-test-plan.md', '# Unit plan\n');
    await ws.writeFile('docs/05-unit-test.md', '# Unit\n');
    await ws.writeFile('tests/test_hello.py', 'from hello import hi\n\n\ndef test_hi():\n    assert hi() == "old"\n');
    await ws.writeFile('docs/06-integration-test.md', '# Integration\n');
    await ws.writeFile('tests/test_integration.py', 'import hello\n\n\ndef test_contract():\n    assert hello is not None\n');
    await fs.mkdir(path.join(tmp, '.xcompiler'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.xcompiler/debug_cache.json'),
      JSON.stringify({
        version: 1,
        steps: {
          [stepExecutionKey(integrationStep)]: {
            lastUpdated: new Date().toISOString(),
            lastStatus: 'FAILED',
            lastReason: 'cached integration test failure',
            attempts: [{
              attempt: 1,
              ts: new Date().toISOString(),
              reason: 'cached integration test failure',
              failureLogTail: 'run_tests FAIL pytest exit=1',
            }],
          },
        },
      }),
      'utf8',
    );

    const coderLlm = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'apply only the detailed design change to code',
        actions: [
          { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "fresh"\n' } },
          { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# Unit plan rerun\n' } },
          { tool: 'write_file', args: { path: 'tests/test_hello.py', content: 'from hello import hi\n\n\ndef test_hi():\n    assert hi() == "fresh"\n' } },
        ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'repair the detailed design contract',
          actions: [
            { tool: 'write_file', args: { path: 'docs/03-detailed-design.md', content: '# Detail\nfixed-detail-contract\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'repair the CR implementation without expanding design scope',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "reworked"\n' } },
          ],
          done: true,
        }),
      ]),
      Coder: coderLlm,
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'apply unit verification for the design CR',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit rerun\n' } },
            { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
          ],
          done: false,
        }),
        JSON.stringify({
          thoughts: 'formally rerun unit verification after the CODE bug repair',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit verified\n' } },
            { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'rerun integration tests',
          actions: [
            { tool: 'write_file', args: { path: 'docs/06-integration-test.md', content: '# Integration rerun\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'run module tests after integration',
          actions: [
            { tool: 'write_file', args: { path: 'docs/07-module-test.md', content: '# Module\n' } },
          ],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new ChangeRequestReworkSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(plan.steps.every((step) => step.status === 'DONE')).toBe(true);
    const phaseStarts = (await ws.readFile('.xcompiler/audit.jsonl'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { messageId?: string; message?: string })
      .filter((event) => event.messageId === 'engine.phase_start')
      .map((event) => event.message ?? '');
    expect(phaseStarts).toEqual(expect.arrayContaining([
      expect.stringContaining('S003 DEBUG'),
      expect.stringContaining('S004 CODE'),
      expect.stringContaining('S005 UNIT_TEST'),
      expect.stringContaining('S006 INTEGRATION_TEST'),
      expect.stringContaining('S007 MODULE_TEST'),
    ]));
    expect(phaseStarts.findIndex((message) => message.includes('S004 CODE')))
      .toBeLessThan(phaseStarts.findIndex((message) => message.includes('S005 UNIT_TEST')));
    expect(phaseStarts.findIndex((message) => message.includes('S005 UNIT_TEST')))
      .toBeLessThan(phaseStarts.findIndex((message) => message.includes('S006 INTEGRATION_TEST')));
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.rollback_validation_deferred');
    expect(coderLlm.lastUser).toContain('## active change-request ticket');
    expect(coderLlm.lastUser).toContain('Apply only the affected contract');
    expect(coderLlm.lastUser).toContain('.xcompiler/tickets/CR-P1-001.json');
    const requests = (JSON.parse(await ws.readFile('.xcompiler/tickets/index.json')) as Array<{
      type: string;
      status: string;
      revision: number;
      parentTicketId?: string;
      relatedTicketIds: string[];
      applications: Array<{ revision: number; stepId: string }>;
    }>).filter((ticket) => ticket.type === 'change-request');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.applications.map((application) => application.stepId))
      .toEqual(expect.arrayContaining([
        detailedStep.id,
        codeStep.id,
        unitStep.id,
        integrationStep.id,
        moduleStep.id,
      ]));
    expect(requests[0]).toMatchObject({
      status: 'closed',
      revision: 2,
    });
    expect(requests[0]?.relatedTicketIds.length).toBeGreaterThanOrEqual(2);
    expect(requests[0]?.applications).toEqual(expect.arrayContaining([
      expect.objectContaining({ revision: 2, stepId: codeStep.id }),
      expect.objectContaining({ revision: 2, stepId: unitStep.id }),
    ]));
  });

  it('revalidates a cached test failure and clears it without rollback when the current gate passes', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.dependsOn = [];
    codeStep.status = 'DONE';
    unitStep.dependsOn = [codeStep.id];
    unitStep.status = 'FAILED';
    unitStep.outputs = ['docs/05-unit-test.md'];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "fixed"\n');
    await ws.writeFile('docs/05-unit-test.md', '# Unit\n');
    await ws.writeFile('tests/test_hello.py', 'from hello import hi\n\n\ndef test_hi():\n    assert hi() == "fixed"\n');
    await fs.mkdir(path.join(tmp, '.xcompiler'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.xcompiler/debug_cache.json'),
      JSON.stringify({
        version: 1,
        steps: {
          [stepExecutionKey(unitStep)]: {
            lastUpdated: new Date().toISOString(),
            lastStatus: 'FAILED',
            lastReason: 'UNIT_TEST tool verification failed; rolling back to paired V-model source phase.',
            attempts: [{
              attempt: 0,
              ts: new Date().toISOString(),
              reason: 'UNIT_TEST tool verification failed; rolling back to paired V-model source phase.',
              failureLogTail: 'FAILED tests/test_hello.py::test_hi - expected fixed implementation',
            }],
          },
        },
      }),
      'utf8',
    );
    const testerLlm = new ScriptedLLM([
      JSON.stringify({
        thoughts: 'record the successful cached test revalidation with quality evidence',
        actions: [],
        done: true,
      }),
    ]);
    const debuggerLlm = new ThrowingLLM(new Error('stale cached test failure must not invoke Debugger'));
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new UnitRollbackSandbox(ws),
      router: new FakeRouter({ Tester: testerLlm, Debugger: debuggerLlm }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(unitStep.status).toBe('DONE');
    expect(debuggerLlm.calls).toBe(0);
    const cache = JSON.parse(await ws.readFile('.xcompiler/debug_cache.json')) as {
      steps: Record<string, unknown>;
    };
    expect(cache.steps[stepExecutionKey(unitStep)]).toBeUndefined();
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.rollback_validation_passed');
    expect(auditLog).not.toContain('engine.test_phase_rollback');
  });

  it('keeps cached test recovery in the test phase when its gate passes but a non-test output is missing', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.dependsOn = [];
    codeStep.status = 'DONE';
    unitStep.dependsOn = [codeStep.id];
    unitStep.status = 'FAILED';
    unitStep.outputs = ['docs/05-unit-test.md'];
    unitStep.tools = ['write_file', 'run_tests'];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "fixed"\n');
    await ws.writeFile('tests/test_hello.py', 'from hello import hi\n\n\ndef test_hi():\n    assert hi() == "fixed"\n');
    await fs.mkdir(path.join(tmp, '.xcompiler'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.xcompiler/debug_cache.json'),
      JSON.stringify({
        version: 1,
        steps: {
          [stepExecutionKey(unitStep)]: {
            lastUpdated: new Date().toISOString(),
            lastStatus: 'FAILED',
            lastReason: 'UNIT_TEST cached failure',
            attempts: [{
              attempt: 1,
              ts: new Date().toISOString(),
              reason: 'UNIT_TEST cached failure',
              failureLogTail: 'FAILED tests/test_hello.py::test_hi - stale failure',
            }],
          },
        },
      }),
      'utf8',
    );

    const debuggerLlm = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'restore the missing unit test report without changing source code',
        actions: [
          { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit test report\n' } },
        ],
        done: true,
      }),
    ]);
    const scopedSandbox = new CapturingTestArgsSandbox();
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: scopedSandbox,
      router: new FakeRouter({ Debugger: debuggerLlm }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(unitStep.status).toBe('DONE');
    expect(scopedSandbox.testArgs).toEqual([
      ['tests/test_hello.py'],
      ['tests/test_hello.py'],
    ]);
    expect(debuggerLlm.lastUser).toContain('missing outputs: docs/05-unit-test.md');
    expect(debuggerLlm.lastUser).not.toContain('stale failure');
    expect(await ws.readFile('src/hello.py')).toContain('fixed');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.rollback_validation_incomplete_outputs');
    expect(auditLog).not.toContain('engine.test_phase_rollback');
  });

  it('fails cached test recovery explicitly when revalidation permission is denied', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.dependsOn = [];
    codeStep.status = 'DONE';
    unitStep.dependsOn = [codeStep.id];
    unitStep.status = 'FAILED';
    unitStep.outputs = ['docs/05-unit-test.md'];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "fixed"\n');
    await ws.writeFile('docs/05-unit-test.md', '# Unit\n');
    await ws.writeFile('tests/test_hello.py', 'from hello import hi\n\n\ndef test_hi():\n    assert hi() == "fixed"\n');
    await fs.mkdir(path.join(tmp, '.xcompiler'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.xcompiler/debug_cache.json'),
      JSON.stringify({
        version: 1,
        steps: {
          [stepExecutionKey(unitStep)]: {
            lastUpdated: new Date().toISOString(),
            lastStatus: 'FAILED',
            lastReason: 'UNIT_TEST cached failure',
            attempts: [{
              attempt: 1,
              ts: new Date().toISOString(),
              reason: 'UNIT_TEST cached failure',
              failureLogTail: 'FAILED tests/test_hello.py::test_hi',
            }],
          },
        },
      }),
      'utf8',
    );
    const debuggerLlm = new ThrowingLLM(new Error('permission denial must not invoke Debugger'));
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new UnitRollbackSandbox(ws),
      router: new FakeRouter({ Debugger: debuggerLlm }) as unknown as LLMRouter,
      audit,
      planPath,
      requestPermission: async (request) =>
        request.target.includes('rollback validation')
          ? { approved: false, reason: 'test execution denied by user' }
          : { approved: true },
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBe(unitStep.id);
    expect(result.failureLog).toContain('permission denied for test revalidation');
    expect(debuggerLlm.calls).toBe(0);
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.rollback_validation_denied');
    expect(auditLog).not.toContain('engine.test_phase_rollback');
  });

  it('routes full functional regression failures to the owner test phase rollback target', async () => {
    const plan = fakePlan();
    const detailedStep = plan.steps.find((step) => step.phase === 'DETAILED_DESIGN')!;
    const integrationStep = plan.steps.find((step) => step.phase === 'INTEGRATION_TEST')!;
    const functionalStep = plan.steps.find((step) => step.phase === 'FUNCTIONAL_TEST')!;
    plan.steps = [detailedStep, integrationStep, functionalStep];
    detailedStep.dependsOn = [];
    detailedStep.outputs = [
      'docs/03-detailed-design.md',
      'docs/tests/integration-test-plan.md',
      'tests/test_integration.py',
    ];
    detailedStep.status = 'DONE';
    integrationStep.dependsOn = [detailedStep.id];
    integrationStep.inputs = ['docs/03-detailed-design.md', 'tests/test_integration.py'];
    integrationStep.outputs = ['docs/06-integration-test.md'];
    integrationStep.status = 'DONE';
    functionalStep.dependsOn = [integrationStep.id];
    functionalStep.outputs = ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/main.py', 'import argparse\nargparse.ArgumentParser().parse_args()\n');
    await ws.writeFile('docs/03-detailed-design.md', '# Detail\nstale-contract\n');
    await ws.writeFile('docs/06-integration-test.md', '# Integration\n');
    await ws.writeFile('tests/test_integration.py', 'def test_contract():\n    assert False\n');

    const router = new FakeRouter({
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write functional outputs',
          actions: [
            { tool: 'write_file', args: { path: 'README.md', content: '# App\n' } },
            { tool: 'write_file', args: { path: 'docs/quickstart.md', content: '# Quickstart\n' } },
            { tool: 'write_file', args: { path: 'docs/08-functional-test.md', content: '# Functional\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'formally rerun the repaired integration quality gate',
          actions: [
            { tool: 'write_file', args: { path: 'docs/06-integration-test.md', content: '# Integration verified\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'rewrite functional outputs after regression repair',
          actions: [
            { tool: 'write_file', args: { path: 'README.md', content: '# App\n' } },
            { tool: 'write_file', args: { path: 'docs/quickstart.md', content: '# Quickstart\n' } },
            { tool: 'write_file', args: { path: 'docs/08-functional-test.md', content: '# Functional\n' } },
          ],
          done: true,
        }),
      ]),
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'repair detailed design because the failing regression belongs to integration',
          actions: [
            { tool: 'write_file', args: { path: 'docs/03-detailed-design.md', content: '# Detail\nfixed-detail-contract\n' } },
          ],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new FunctionalGateOwnerSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(await ws.readFile('docs/03-detailed-design.md')).toContain('fixed-detail-contract');
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"stepId":"S008"');
    expect(ticketLog).toContain('"targetStepId":"S003"');
    expect(ticketLog).toContain('"targetPhase":"DETAILED_DESIGN"');
    expect(ticketLog).not.toContain('"targetStepId":"S001"');
  });

  it('preserves the latest actionable cached failure across a failed resumed Debugger attempt', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [codeStep];
    codeStep.dependsOn = [];
    codeStep.status = 'FAILED';
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await fs.mkdir(path.join(tmp, '.xcompiler'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.xcompiler/debug_cache.json'),
      JSON.stringify({
        version: 1,
        steps: {
          [stepExecutionKey(codeStep)]: {
            lastUpdated: new Date().toISOString(),
            lastStatus: 'RUNNING',
            lastReason: 'read-only recovery mode repeated probe actions for 2 rounds',
            attempts: [
              {
                attempt: 1,
                ts: new Date().toISOString(),
                reason: 'unresolved tool failures remain: run_tests FAIL pytest exit=1',
                failureLogTail: [
                  'pytest exit=1',
                  'SyntaxError: unterminated string literal in src/hello.py',
                  '## latest Debugger attempt failure',
                  'reason: stale provider failure',
                  'OpenAI HTTP 429: stale cache noise',
                ].join('\n'),
              },
              {
                attempt: 2,
                ts: new Date().toISOString(),
                reason: 'read-only recovery mode repeated probe actions for 2 rounds',
                failureLogTail: 'read_file src/hello.py\nread_file tests/test_hello.py',
              },
              {
                attempt: 3,
                ts: new Date().toISOString(),
                reason: 'request timed out after 900000ms',
                failureLogTail: 'Error: request timed out after 900000ms',
              },
            ],
          },
        },
      }),
      'utf8',
    );

    const debuggerLlm = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'need another turn before applying the repair',
        actions: [],
        done: false,
      }),
      JSON.stringify({
        thoughts: 'repair from cached pytest syntax failure',
        actions: [
          { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "fixed"\n' } },
          { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
        ],
        done: true,
      }),
    ]);
    const rollbackSandbox = new CodeValidationSandbox(ws);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: rollbackSandbox,
      router: new FakeRouter({ Debugger: debuggerLlm }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    const failureBlock = debuggerLlm.lastUser.match(/## compact failure evidence\n```\n([\s\S]*?)\n```/u)?.[1] ?? '';
    expect(debuggerLlm.lastUser).toContain('## debug brief');
    expect(failureBlock).toContain('SyntaxError: unterminated string literal');
    expect(failureBlock).not.toContain('latest Debugger attempt failure');
    expect(failureBlock).not.toContain('stale cache noise');
    expect(failureBlock).not.toContain('request timed out after 900000ms');
    expect(debuggerLlm.lastUser).toContain('omitted 2 noisy provider/read-only/recovery attempt');
    expect(debuggerLlm.lastUser).not.toContain('read-only recovery mode repeated probe actions');
    expect(debuggerLlm.calls).toHaveLength(2);
    expect(plan.steps[0]?.status).toBe('DONE');
  });

  it('marks step FAILED and reverts when LLM never produces outputs', async () => {
    const plan = fakePlan();
    plan.steps = plan.steps.slice(0, 1); // only S001
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const router = new FakeRouter({
      Planner: new ScriptedLLM([
        JSON.stringify({ thoughts: 'do nothing', actions: [], done: true }),
        JSON.stringify({ thoughts: 'still nothing', actions: [], done: true }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });
    const r = await engine.run(plan);
    expect(r.failedStepId).toBe('S001');
    expect(plan.steps[0]?.status).toBe('FAILED');
  });

  it('records and routes startup exceptions before Debugger recovery', async () => {
    const plan = fakePlan();
    plan.steps = [plan.steps.find((step) => step.phase === 'CODE')!];
    plan.steps[0]!.dependsOn = [];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const router = new FakeRouter({
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'repair startup failure',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
          ],
          done: true,
        }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });
    const r = await engine.run(plan);
    expect(r.failedStepId).toBeUndefined();
    expect(plan.steps[0]?.status).toBe('DONE');

    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"event":"created"');
    expect(ticketLog).toContain('"event":"routed"');
    expect(ticketLog).toContain('"event":"resolved"');
    expect(ticketLog).toContain('no scripted llm for role Coder');
    expect(ticketLog).toContain('"targetPhase":"CODE"');
  });

  it('does not route LLM transport failures into code Debugger retries', async () => {
    const plan = fakePlan();
    plan.steps = [plan.steps.find((step) => step.phase === 'CODE')!];
    plan.steps[0]!.dependsOn = [];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/tests/unit-test-plan.md', '# previous unit plan\n');
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const coder = new ThrowingLLM(new TypeError('fetch failed'));
    const debuggerLlm = new ScriptedLLM([
      JSON.stringify({
        thoughts: 'should not be called for provider transport failures',
        actions: [
          { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
        ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({ Coder: coder, Debugger: debuggerLlm });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 3,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBe('S004');
    expect(coder.calls).toBe(1);
    expect(plan.steps[0]?.retries).toBe(0);
    await expect(ws.exists('src/hello.py')).resolves.toBe(false);
    await expect(ws.readFile('docs/tests/unit-test-plan.md')).resolves.toBe('# previous unit plan\n');
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"event":"created"');
    expect(ticketLog).toContain('"event":"stage-feature-deferred"');
    expect(ticketLog).not.toContain('"ticketType":"bug"');
    expect(ticketLog).not.toContain('"event":"routed"');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('audit.llm_chat_aborted');

  });

  it('archives the previous document only when its replacement attempt succeeds', async () => {
    const plan = fakePlan();
    plan.steps = [plan.steps.find((step) => step.phase === 'CODE')!];
    plan.steps[0]!.dependsOn = [];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/tests/unit-test-plan.md', '# previous unit plan\n');
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({
        Coder: new ScriptedLLM([
          JSON.stringify({
            thoughts: 'replace the source and unit plan',
            actions: [
              { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
              { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# current unit plan\n' } },
            ],
            done: true,
          }),
        ]),
      }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(await ws.readFile('docs/tests/unit-test-plan.md')).toBe('# current unit plan\n');
    const historyFiles = await fs.readdir(path.join(tmp, 'docs/history'));
    const archivedPlan = historyFiles.find((file) => file.startsWith('unit-test-plan-'));
    expect(archivedPlan).toBeDefined();
    expect(await ws.readFile(`docs/history/${archivedPlan}`)).toBe('# previous unit plan\n');
  });

  it('does not route provider context-limit failures into code Debugger retries', async () => {
    const plan = fakePlan();
    plan.steps = [plan.steps.find((step) => step.phase === 'CODE')!];
    plan.steps[0]!.dependsOn = [];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const coder = new ThrowingLLM(
      new Error(
        'OpenAI HTTP 400: {"code":"prefill_memory_exceeded","message":"prefill memory guard dynamic ceiling exceeded"}',
      ),
    );
    const debuggerLlm = new ScriptedLLM([
      JSON.stringify({
        thoughts: 'should not be called for provider context-limit failures',
        actions: [
          { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
        ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({ Coder: coder, Debugger: debuggerLlm });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 3,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBe('S004');
    expect(coder.calls).toBe(1);
    expect(plan.steps[0]?.retries).toBe(0);
    await expect(ws.exists('src/hello.py')).resolves.toBe(false);
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"event":"created"');
    expect(ticketLog).toContain('"event":"stage-feature-deferred"');
    expect(ticketLog).not.toContain('"ticketType":"bug"');
    expect(ticketLog).not.toContain('"event":"routed"');
  });

  it('resumes a provider-failed declarative Step without creating a project Bug Ticket', async () => {
    const plan = fakePlan();
    const designStep = plan.steps.find((step) => step.phase === 'DETAILED_DESIGN')!;
    designStep.dependsOn = [];
    plan.steps = [designStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const providerError = new Error(
      'all LLM providers failed for role Architect: deepseek_paid/openai:deepseek/deepseek-v4-flash: ' +
      'OpenAI-compatible provider request failed provider=deepseek_paid model=deepseek/deepseek-v4-flash ' +
      'base_url=https://openrouter.ai/api/v1: fetch failed; cause=getaddrinfo ENOTFOUND openrouter.ai',
    );
    const failedEngine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({ Architect: new ThrowingLLM(providerError) }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });
    const failed = await failedEngine.run(plan);
    expect(failed.failedStepId).toBe(designStep.id);

    const resumedEngine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({
        Architect: new ScriptedLLM([
          JSON.stringify({
            thoughts: 'write the complete declarative design outputs after provider recovery',
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
          }),
        ]),
      }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });
    const resumed = await resumedEngine.run(plan);
    expect(resumed.failedStepId).toBeUndefined();

    const bugFiles = (await fs.readdir(path.join(tmp, '.xcompiler/tickets')))
      .filter((file) => /^BUG-.*\.json$/u.test(file));
    expect(bugFiles).toHaveLength(0);
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.infrastructure_failure_deferred');
  });

  it('does not route LLM provider rate limits from test phases into Debugger retries', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.status = 'DONE';
    codeStep.dependsOn = [];
    unitStep.dependsOn = ['S004'];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const tester = new ThrowingLLM(
      new Error(
        'OpenAI HTTP 429: {"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"openrouter/free is temporarily rate-limited upstream","retry_after_seconds":8}}}',
      ),
    );
    const debuggerLlm = new ScriptedLLM([
      JSON.stringify({
        thoughts: 'should not be called for provider rate limits',
        actions: [
          { tool: 'write_file', args: { path: 'tests/test_hello.py', content: 'def test_bad():\n    assert False\n' } },
        ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({ Tester: tester, Debugger: debuggerLlm });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 3,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBe('S005');
    expect(tester.calls).toBe(1);
    expect(unitStep.retries).toBe(0);
    await expect(ws.exists('tests/test_hello.py')).resolves.toBe(true);
    await expect(ws.exists('src/hello.py')).resolves.toBe(false);
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"event":"created"');
    expect(ticketLog).toContain('"event":"stage-feature-deferred"');
    expect(ticketLog).not.toContain('"ticketType":"bug"');
    expect(ticketLog).not.toContain('"event":"routed"');

    const resumedTester = new ThrowingLLM(
      new Error(
        'OpenAI HTTP 429: {"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"openrouter/free is temporarily rate-limited upstream","retry_after_seconds":8}}}',
      ),
    );
    const resumed = new PhaseEngine({
      ws,
      git,
      sandbox,
      // 仅提供 Tester：缓存里只有基础设施失败时，恢复应现场重试正常流程而不是拿陈旧断连记录直接判死，
      // 也不得路由进 Debugger。
      router: new FakeRouter({ Tester: resumedTester }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 3,
    });
    const resumedResult = await resumed.run(plan);
    expect(resumedResult.failedStepId).toBe('S005');
    expect(resumedTester.calls).toBe(1);
    expect(resumedResult.failureReason).toMatch(/OpenAI HTTP 429|provider|rate/i);
    expect(resumedResult.failureReason).not.toMatch(/rolling back to the paired/i);
    const resumedTicketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(resumedTicketLog).not.toContain('"event":"routed"');
  });

  it('resumes cached test-phase quality failures in the same test step', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.status = 'DONE';
    codeStep.dependsOn = [];
    unitStep.dependsOn = ['S004'];
    unitStep.tools = ['write_file', 'run_tests'];
    unitStep.outputs = ['docs/05-unit-test.md'];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "fixed"\n');
    await fs.mkdir(path.join(tmp, '.xcompiler'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.xcompiler/debug_cache.json'),
      JSON.stringify({
        version: 1,
        steps: {
          [stepExecutionKey(unitStep)]: {
            lastUpdated: new Date().toISOString(),
            lastStatus: 'FAILED',
            lastReason: 'repeated read-only/probe actions without progress for 3 rounds',
            attempts: [
              {
                attempt: 0,
                ts: new Date().toISOString(),
                reason: 'repeated read-only/probe actions without progress for 3 rounds',
                failureLogTail: [
                  '原因：repeated read-only/probe actions without progress for 3 rounds',
                  '工具调用：',
                  '  - read_file 成功 read tests/test_hello.py',
                  '  - list_dir 成功 list tests',
                ].join('\n'),
              },
            ],
          },
        },
      }),
      'utf8',
    );

    const debuggerLlm = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'repair the unit validation report and rerun the existing paired test',
        actions: [
          { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit Test\n' } },
          { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
        ],
        done: true,
      }),
    ]);
    const sandboxWithCapturedTests = new CapturingTestArgsSandbox();
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: sandboxWithCapturedTests,
      router: new FakeRouter({ Debugger: debuggerLlm }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(debuggerLlm.calls).toHaveLength(1);
    expect(sandboxWithCapturedTests.testArgs).toContainEqual(['tests/test_hello.py']);
    expect(unitStep.status).toBe('DONE');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).not.toContain('engine.test_phase_rollback');
    expect(auditLog).not.toContain('rolling back to the paired V-model source phase');
  });

  it('keeps validation report generation failures in the same test phase', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.status = 'DONE';
    codeStep.dependsOn = [];
    unitStep.dependsOn = ['S004'];
    unitStep.tools = ['write_file'];
    unitStep.outputs = ['docs/05-unit-test.md'];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "fixed"\n');
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const tester = new ScriptedLLM([
      JSON.stringify({
        thoughts: 'malformed write leaves the validation report missing',
        actions: [{ tool: 'write_file', args: { content: '# missing path\n' } }],
        done: false,
      }),
    ]);
    const debuggerLlm = new ScriptedLLM([
      JSON.stringify({
        thoughts: 'still malformed in same test phase',
        actions: [{ tool: 'write_file', args: { content: '# missing path\n' } }],
        done: false,
      }),
    ]);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({ Tester: tester, Debugger: debuggerLlm }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBe(unitStep.id);
    expect(unitStep.status).toBe('FAILED');
    expect(codeStep.status).toBe('DONE');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).not.toContain('engine.test_phase_rollback');
    expect(auditLog).not.toContain('rolling back to paired CODE');
  });

  it('routes no-test-files verification failures back to the paired CODE step', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.status = 'DONE';
    codeStep.dependsOn = [];
    unitStep.dependsOn = ['S004'];
    unitStep.tools = ['write_file', 'run_tests'];
    unitStep.outputs = ['docs/05-unit-test.md'];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "fixed"\n');

    const tester = new ScriptedLLM([
      JSON.stringify({
        thoughts: 'run the paired unit test',
        actions: [
          { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit Test\n' } },
          { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
        ],
        done: false,
      }),
      JSON.stringify({
        thoughts: 'rerun unit validation after the paired source repaired its test asset',
        actions: [
          { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit Test verified\n' } },
        ],
        done: true,
      }),
    ]);
    const debuggerLlm = new ScriptedLLM([
      JSON.stringify({
        thoughts: 'repair the CODE-owned unit test artifact',
        actions: [
          { tool: 'write_file', args: { path: 'tests/test_hello.py', content: 'from hello import hi\n\n\ndef test_hi():\n    assert hi() == "fixed"\n' } },
          { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
        ],
        done: true,
      }),
    ]);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new FirstNoTestFilesThenPassSandbox(),
      router: new FakeRouter({ Tester: tester, Debugger: debuggerLlm }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(unitStep.status).toBe('DONE');
    expect(codeStep.status).toBe('DONE');
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"targetStepId":"S004"');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.test_phase_rollback');
  });

  it('routes a semantic validationDefect to the paired source even when existing tests can pass', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.status = 'DONE';
    codeStep.dependsOn = [];
    unitStep.dependsOn = [codeStep.id];
    unitStep.tools = ['write_file'];
    unitStep.outputs = ['docs/05-unit-test.md'];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi(value):\n    return value\n');

    const router = new FakeRouter({
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'the paired unit test is runnable but omits the required invalid-input case',
          validationDefect:
            'tests/test_hello.py omits invalid-input behavior required by docs/tests/unit-test-plan.md',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit Test gap\n' } },
          ],
          done: false,
        }),
        JSON.stringify({
          thoughts: 'the repaired paired test now covers the required behavior',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit Test verified\n' } },
          ],
          done: true,
        }),
      ]),
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'add the missing CODE-owned test case',
          actions: [
            {
              tool: 'write_file',
              args: {
                path: 'tests/test_hello.py',
                content:
                  'from hello import hi\n\n\ndef test_hello():\n    assert hi("ok") == "ok"\n\n' +
                  'def test_invalid_input():\n    assert hi(None) is None\n',
              },
            },
          ],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new CapturingTestArgsSandbox(),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(await ws.readFile('tests/test_hello.py')).toContain('test_invalid_input');
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"targetStepId":"S004"');
    const enhancements = (JSON.parse(await ws.readFile(
      '.xcompiler/tickets/index.json',
    )) as Array<{
      type: string;
      kind?: string;
      status: string;
      disposition?: string;
    }>).filter((ticket) => ticket.type === 'enhance');
    expect(enhancements).toEqual([]);
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.validation_defect_reported');
    expect(auditLog).toContain('engine.test_phase_rollback');
    expect(auditLog).not.toContain('"kind":"ticket.enhance.created"');
    expect(router.scoreOutcomes).toEqual([]);
  });

  it('treats explicit rollback and no-test discovery as paired-source failures', () => {
    expect(
      shouldRollbackTestPhaseFailure(
        'INTEGRATION_TEST tool verification failed; rolling back to paired V-model source phase.',
        [
          'FAIL tests/integration.test.ts [ tests/integration.test.ts ]',
          'Error: No test suite found in file /tmp/project/tests/integration.test.ts',
          'Tests no tests',
        ].join('\n'),
      ),
    ).toBe(true);

    expect(
      shouldRollbackTestPhaseFailure(
        'run_tests failed before test artifacts existed',
        [
          'filter: tests/test_hello.py',
          'No test files found, exiting with code 1',
        ].join('\n'),
      ),
    ).toBe(true);
  });

  it('allows rollback Debugger repairs across declared outputs on the affected V-model chain', () => {
    const plan = fakePlan();
    const detailed = plan.steps.find((step) => step.phase === 'DETAILED_DESIGN')!;
    const code = plan.steps.find((step) => step.phase === 'CODE')!;
    const unit = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    const integration = plan.steps.find((step) => step.phase === 'INTEGRATION_TEST')!;
    detailed.outputs = [
      'docs/03-detailed-design.md',
      'docs/tests/integration-test-plan.md',
      'tests/app.integration.test.ts',
    ];
    code.outputs = [
      'src/app.ts',
      'package.json',
      'docs/tests/unit-test-plan.md',
      'tests/app.unit.test.ts',
    ];
    unit.outputs = ['docs/05-unit-test.md'];
    integration.outputs = ['docs/06-integration-test.md'];

    const writes = collectRollbackRepairOutputs(
      plan.steps,
      detailed,
      integration,
      'package.json',
    );

    expect(writes).toContain('src/app.ts');
    expect(writes).toContain('tests/app.unit.test.ts');
    expect(writes).toContain('tests/app.integration.test.ts');
    expect(writes).not.toContain('package.json');
  });

  it('keeps inherited rollback test scope across Debugger retries', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{
      ...codeStep,
      dependsOn: [],
      status: 'DONE',
      tools: ['run_tests'],
      outputs: ['src/hello.py'],
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "fixed"\n');

    const scopedSandbox = new FirstFailCapturingTestArgsSandbox();
    const router = new FakeRouter({
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'first scoped verification fails',
          actions: [{ tool: 'run_tests', args: {} }],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'retry scoped verification passes',
          actions: [{ tool: 'run_tests', args: {} }],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: scopedSandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const ok = await (engine as unknown as {
      executeStepWithDebug: (
        p: Plan,
        s: Plan['steps'][number],
        opts: {
          initialDebug: {
            failureLog: string;
            reason: string;
            completedBeforeDebug: boolean;
            contextMode: string;
            testScopeArgs: string[];
          };
        },
      ) => Promise<boolean>;
    }).executeStepWithDebug(plan, plan.steps[0]!, {
      initialDebug: {
        reason: 'UNIT_TEST failed; rolling back to paired CODE phase for Debugger repair.',
        failureLog: 'unit test failed',
        completedBeforeDebug: true,
        contextMode: 'test-rollback',
        testScopeArgs: ['tests/scoped.unit.test.ts'],
      },
    });

    expect(ok).toBe(true);
    expect(scopedSandbox.testArgs).toEqual([
      ['tests/scoped.unit.test.ts'],
      ['tests/scoped.unit.test.ts'],
    ]);
  });

  it('infers cached rollback test scope when resuming a failed source step', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{
      ...codeStep,
      dependsOn: [],
      status: 'FAILED',
      tools: ['run_tests'],
      outputs: ['src/hello.py'],
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "fixed"\n');
    await fs.mkdir(path.join(tmp, '.xcompiler'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.xcompiler/debug_cache.json'),
      JSON.stringify({
        version: 1,
        steps: {
          [stepExecutionKey(codeStep)]: {
            lastUpdated: new Date().toISOString(),
            lastStatus: 'FAILED',
            lastReason: 'completed phase debug finished with failed verification but without a successful repair mutation',
            attempts: [{
              attempt: 1,
              ts: new Date().toISOString(),
              reason: 'completed phase debug finished with failed verification but without a successful repair mutation',
              failureLogTail: [
                'UNIT_TEST failed during rollback repair',
                '- run_tests 失败 npm test exit=1 args=tests/cached-scope.unit.test.ts',
              ].join('\n'),
            }],
          },
        },
      }),
      'utf8',
    );

    const scopedSandbox = new CapturingTestArgsSandbox();
    const router = new FakeRouter({
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'resume cached scoped verification',
          actions: [{ tool: 'run_tests', args: {} }],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: scopedSandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);

    expect(result.failedStepId).toBeUndefined();
    expect(scopedSandbox.testArgs).toEqual([['tests/cached-scope.unit.test.ts']]);
  });

  it('recovers a failing CODE step via Debugger retry', async () => {
    const plan = fakePlan();
    plan.steps = [plan.steps.find((step) => step.phase === 'CODE')!]; // only CODE
    plan.steps[0]!.dependsOn = [];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const router = new FakeRouter({
      // Coder claims done but writes nothing → outputs missing → FAILED
      Coder: new ScriptedLLM([
        JSON.stringify({ thoughts: 'lazy', actions: [], done: true }),
        JSON.stringify({ thoughts: 'still lazy', actions: [], done: true }),
      ]),
      // Debugger writes the missing file on first round
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'fix it',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
          ],
          done: true,
        }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
      maxDebugRetries: 2,
    });
    const r = await engine.run(plan);
    expect(r.failedStepId).toBeUndefined();
    expect(plan.steps[0]?.status).toBe('DONE');
    expect(plan.steps[0]?.retries).toBe(1);
    expect(await ws.exists('src/hello.py')).toBe(true);
  });

  it('preserves partial Debugger edits between failed debug retries', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{
      ...codeStep,
      dependsOn: [],
      outputs: ['src/hello.py', 'docs/tests/unit-test-plan.md', 'tests/test_hello.py'],
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);

    const router = new FakeRouter({
      Coder: new ScriptedLLM([
        JSON.stringify({ thoughts: 'claim done without outputs', actions: [], done: true }),
      ]),
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write the first half of the repair and verify it still fails',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'partial\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
            { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
          ],
          done: false,
        }),
        JSON.stringify({
          thoughts: 'continue from the preserved partial repair',
          actions: [
            { tool: 'append_file', args: { path: 'src/hello.py', content: 'final\n' } },
            { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
          ],
          done: true,
        }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new DebugPreserveSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRoundsPerStep: 1,
      maxDebugRetries: 2,
    });

    const r = await engine.run(plan);

    expect(r.failedStepId).toBeUndefined();
    expect(await ws.readFile('src/hello.py')).toBe('partial\nfinal\n');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.debug_failed_attempt_preserved');
  });

  it('does not resolve completed-phase debug without a mutation or successful verification', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{
      ...codeStep,
      dependsOn: [],
      status: 'DONE',
      outputs: ['src/hello.py'],
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "still broken"\n');

    const router = new FakeRouter({
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'inspect only and incorrectly claim done',
          actions: [{ tool: 'read_file', args: { path: 'src/hello.py' } }],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'inspect only again and incorrectly claim done',
          actions: [{ tool: 'read_file', args: { path: 'src/hello.py' } }],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
      maxDebugRetries: 1,
    });

    const ok = await (engine as unknown as {
      executeStepWithDebug: (
        p: Plan,
        s: Plan['steps'][number],
        opts: {
          initialDebug: {
            failureLog: string;
            reason: string;
            completedBeforeDebug: boolean;
            contextMode: string;
          };
        },
      ) => Promise<boolean>;
    }).executeStepWithDebug(plan, plan.steps[0]!, {
      initialDebug: {
        failureLog: 'unit regression failed',
        reason: 'test gate failed',
        completedBeforeDebug: true,
        contextMode: 'test-rollback',
      },
    });

    expect(ok).toBe(false);
    expect(plan.steps[0]?.status).toBe('FAILED');
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"event":"debug-failed"');
    expect(ticketLog).not.toContain('"event":"resolved"');
    expect(ticketLog).toContain('without a successful repair mutation or verification tool call');
  });

  it('treats failed verification without mutation as missing completed-phase repair evidence', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{
      ...codeStep,
      dependsOn: [],
      status: 'DONE',
      tools: ['read_file', 'run_tests'],
      outputs: ['src/hello.py'],
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "still broken"\n');

    const router = new FakeRouter({
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'probe the failure but do not patch',
          actions: [
            { tool: 'read_file', args: { path: 'src/hello.py' } },
            { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
          ],
          done: false,
        }),
        JSON.stringify({
          thoughts: 'probe again but still do not patch',
          actions: [
            { tool: 'read_file', args: { path: 'src/hello.py' } },
            { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
          ],
          done: false,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new UnitRollbackSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const ok = await (engine as unknown as {
      executeStepWithDebug: (
        p: Plan,
        s: Plan['steps'][number],
        opts: {
          initialDebug: {
            failureLog: string;
            reason: string;
            completedBeforeDebug: boolean;
            contextMode: string;
          };
        },
      ) => Promise<boolean>;
    }).executeStepWithDebug(plan, plan.steps[0]!, {
      initialDebug: {
        failureLog: 'unit regression failed',
        reason: 'test gate failed',
        completedBeforeDebug: true,
        contextMode: 'test-rollback',
      },
    });

    expect(ok).toBe(false);
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('failed verification but without a successful repair mutation');
  });

  it('resolves completed-phase debug with successful verification evidence', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{
      ...codeStep,
      dependsOn: [],
      status: 'DONE',
      outputs: ['src/hello.py'],
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "fixed"\n');

    const router = new FakeRouter({
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'inspect and verify the completed source phase',
          actions: [
            { tool: 'read_file', args: { path: 'src/hello.py' } },
            { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
          ],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new UnitRollbackSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
      maxDebugRetries: 1,
    });

    const ok = await (engine as unknown as {
      executeStepWithDebug: (
        p: Plan,
        s: Plan['steps'][number],
        opts: {
          initialDebug: {
            failureLog: string;
            reason: string;
            completedBeforeDebug: boolean;
            contextMode: string;
          };
        },
      ) => Promise<boolean>;
    }).executeStepWithDebug(plan, plan.steps[0]!, {
      initialDebug: {
        failureLog: 'unit regression failed before retry',
        reason: 'test gate failed',
        completedBeforeDebug: true,
        contextMode: 'test-rollback',
      },
    });

    expect(ok).toBe(true);
    expect(plan.steps[0]?.status).toBe('DONE');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('tool run_tests');
    expect(auditLog).not.toContain('without a successful repair mutation or verification tool call');
  });

  it('treats run_tests as advisory during design-phase Debugger repair', async () => {
    const plan = fakePlan();
    const designStep = plan.steps.find((step) => step.phase === 'DETAILED_DESIGN')!;
    plan.steps = [{
      ...designStep,
      dependsOn: [],
      status: 'DONE',
      tools: ['replace_in_file', 'write_file', 'run_tests'],
      outputs: ['docs/03-detailed-design.md'],
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/03-detailed-design.md', '# Old Design\n');

    const router = new FakeRouter({
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'update the design contract and keep the failing downstream test as diagnostic evidence',
          actions: [
            { tool: 'replace_in_file', args: { path: 'src/hello.py', find: 'return "broken"', replace: 'return "fixed"' } },
            { tool: 'write_file', args: { path: 'docs/03-detailed-design.md', content: '# Revised Design\n\nCODE must handle empty ECU lists explicitly.\n' } },
            { tool: 'run_tests', args: { args: ['tests/test_integration.py'] } },
          ],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new FirstFailThenPassSandbox(),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });

    const ok = await (engine as unknown as {
      executeStepWithDebug: (
        p: Plan,
        s: Plan['steps'][number],
        opts: {
          initialDebug: {
            failureLog: string;
            reason: string;
            completedBeforeDebug: boolean;
            contextMode: string;
          };
        },
      ) => Promise<boolean>;
    }).executeStepWithDebug(plan, plan.steps[0]!, {
      initialDebug: {
        failureLog: 'integration test still fails before CODE is rerun',
        reason: 'INTEGRATION_TEST failed; rolling back to DETAILED_DESIGN.',
        completedBeforeDebug: true,
        contextMode: 'test-rollback',
      },
    });

    expect(ok).toBe(true);
    expect(plan.steps[0]?.status).toBe('DONE');
    expect(await ws.readFile('docs/03-detailed-design.md')).toContain('empty ECU lists');
  });

  it('keeps the original test rollback failure visible across Debugger retries', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{
      ...codeStep,
      dependsOn: [],
      status: 'DONE',
      outputs: ['src/hello.py'],
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "broken"\n');

    const debuggerLlm = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'inspect only and fail completed-phase repair gate',
        actions: [{ tool: 'read_file', args: { path: 'src/hello.py' } }],
        done: true,
      }),
      JSON.stringify({
        thoughts: 'repair after seeing the original pytest failure again',
        bugResolutionPlan: 'Repair src/hello.py for the original pytest assertion, then rerun the inherited unit gate.',
        actions: [{ tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "fixed"\n' } }],
        done: true,
      }),
    ]);
    const rollbackSandbox = new CodeValidationSandbox(ws);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: rollbackSandbox,
      router: new FakeRouter({ Debugger: debuggerLlm }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
      maxDebugRetries: 1,
    });

    const ok = await (engine as unknown as {
      executeStepWithDebug: (
        p: Plan,
        s: Plan['steps'][number],
        opts: {
          initialDebug: {
            failureLog: string;
            reason: string;
            completedBeforeDebug: boolean;
            contextMode: string;
          };
        },
      ) => Promise<boolean>;
    }).executeStepWithDebug(plan, plan.steps[0]!, {
      initialDebug: {
        failureLog: 'pytest exit=1\nFAILED tests/test_unit.py::test_parse_dbc_ecu_filtering\nassert 0 > 0',
        reason: 'UNIT_TEST failed; rolling back to paired CODE phase for Debugger repair, then rerunning subsequent V-model phases.',
        completedBeforeDebug: true,
        contextMode: 'test-rollback',
      },
    });

    expect(ok).toBe(true);
    expect(debuggerLlm.calls.length).toBeGreaterThanOrEqual(2);
    const secondPrompt = debuggerLlm.calls[1]!
      .map((message) => message.content)
      .join('\n');
    expect(secondPrompt).toContain('test_parse_dbc_ecu_filtering');
    expect(secondPrompt).toContain('assert 0 > 0');
    expect(secondPrompt).not.toContain('latest Debugger attempt failure');
  });

  it('recovers an interrupted test rollback from its routed Bug Ticket as Debugger', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    codeStep.dependsOn = [];
    codeStep.outputs = ['src/hello.py'];
    unitStep.dependsOn = [codeStep.id];
    unitStep.inputs = ['src/hello.py', 'tests/test_hello.py'];
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "broken"\n');

    const debuggerLlm = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'apply the routed Bug Ticket repair and verify its inherited unit gate',
        actions: [{
          tool: 'write_file',
          args: { path: 'src/hello.py', content: 'def hi():\n    return "fixed"\n' },
        }],
        done: true,
      }),
    ]);
    const routedRollbackSandbox = new CodeValidationSandbox(ws);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: routedRollbackSandbox,
      router: new FakeRouter({ Debugger: debuggerLlm }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 1,
    });
    const internal = engine as unknown as {
      ensureExecutionGraph: (p: Plan) => Promise<void>;
      workTickets: WorkTicketLifecycle;
      bugLifecycle: BugLifecycle;
      executeStepWithDebug: (p: Plan, s: Plan['steps'][number]) => Promise<boolean>;
    };
    await internal.ensureExecutionGraph(plan);
    await internal.workTickets.completeStep(codeStep);
    const bug = await internal.bugLifecycle.recordBug(plan, unitStep, {
      kind: 'test-gate',
      reason: 'UNIT_TEST failed; rolling back to the paired CODE phase.',
      failureLog: 'FAIL tests/test_hello.py::test_product_contract\nexpected fixed implementation',
    });
    await internal.bugLifecycle.routeBug(
      bug,
      codeStep,
      'UNIT_TEST failure belongs to the paired CODE phase',
    );
    bug.verificationStepId = unitStep.id;
    bug.verificationPhase = unitStep.phase;
    await internal.bugLifecycle.persistBug(bug, 'verification-required');
    await internal.workTickets.startStep(codeStep);

    const ok = await internal.executeStepWithDebug(plan, codeStep);

    expect(ok).toBe(true);
    expect(debuggerLlm.calls).toHaveLength(1);
    expect(debuggerLlm.lastUser).toContain(bug.id);
    expect(debuggerLlm.lastUser).toContain('test_product_contract');
    expect(routedRollbackSandbox.testArgs).toContainEqual(['tests/test_hello.py']);
    expect(await ws.readFile('src/hello.py')).toContain('"fixed"');
  });

  it('records the original test rollback failure in source Debugger cache after failed retries', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{
      ...codeStep,
      dependsOn: [],
      status: 'DONE',
      outputs: ['src/hello.py'],
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "broken"\n');

    const router = new FakeRouter({
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'inspect only and incorrectly claim done',
          actions: [{ tool: 'read_file', args: { path: 'src/hello.py' } }],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'inspect only again and still incorrectly claim done',
          actions: [{ tool: 'read_file', args: { path: 'src/hello.py' } }],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
      maxDebugRetries: 1,
    });

    const ok = await (engine as unknown as {
      executeStepWithDebug: (
        p: Plan,
        s: Plan['steps'][number],
        opts: {
          initialDebug: {
            failureLog: string;
            reason: string;
            completedBeforeDebug: boolean;
            contextMode: string;
          };
        },
      ) => Promise<boolean>;
    }).executeStepWithDebug(plan, plan.steps[0]!, {
      initialDebug: {
        failureLog: 'pytest exit=1\nFAILED tests/test_unit.py::test_parse_dbc_malformed_raises\nDID NOT RAISE <DBCParseError>',
        reason: 'UNIT_TEST failed; rolling back to paired CODE phase for Debugger repair, then rerunning subsequent V-model phases.',
        completedBeforeDebug: true,
        contextMode: 'test-rollback',
      },
    });

    expect(ok).toBe(false);
    const cache = JSON.parse(await ws.readFile('.xcompiler/debug_cache.json')) as {
      steps: Record<string, { lastStatus: string; attempts: Array<{ failureLogTail: string }> }>;
    };
    const debugKey = stepExecutionKey(plan.steps[0]!);
    const logs = cache.steps[debugKey]!.attempts
      .map((attempt) => attempt.failureLogTail)
      .join('\n');
    expect(cache.steps[debugKey]!.lastStatus).toBe('FAILED');
    expect(logs).toContain('test_parse_dbc_malformed_raises');
    expect(logs).toContain('DID NOT RAISE <DBCParseError>');
    expect(logs).not.toContain('latest Debugger attempt failure');
    expect(logs).not.toContain('script exhausted');
  });

  it('stops Debugger retries immediately on provider rate-limit infrastructure failures', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    plan.steps = [{
      ...codeStep,
      dependsOn: [],
      status: 'DONE',
      outputs: ['src/hello.py'],
    }];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "broken"\n');

    class InspectThenRateLimitLLM implements LLMClient {
      readonly name = 'rate-limit-after-inspect';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'inspect but do not repair yet',
            actions: [{ tool: 'read_file', args: { path: 'src/hello.py' } }],
            done: true,
          });
        }
        throw new Error(
          'OpenAI HTTP 429: {"error":{"message":"Rate limit exceeded: free-models-per-day","code":429}}',
        );
      }
    }
    const llm = new InspectThenRateLimitLLM();
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({ Debugger: llm }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRetries: 3,
    });

    const ok = await (engine as unknown as {
      executeStepWithDebug: (
        p: Plan,
        s: Plan['steps'][number],
        opts: {
          initialDebug: {
            failureLog: string;
            reason: string;
            completedBeforeDebug: boolean;
            contextMode: string;
          };
        },
      ) => Promise<boolean>;
    }).executeStepWithDebug(plan, plan.steps[0]!, {
      initialDebug: {
        failureLog: 'pytest exit=1\nFAILED tests/test_unit.py::test_hi',
        reason: 'UNIT_TEST failed; rolling back to paired CODE phase for Debugger repair, then rerunning subsequent V-model phases.',
        completedBeforeDebug: true,
        contextMode: 'test-rollback',
      },
    });

    expect(ok).toBe(false);
    expect(llm.calls).toBe(2);
    expect(plan.steps[0]?.status).toBe('FAILED');
  });

  it('rolls UNIT_TEST gate failures back to CODE and reruns subsequent V-model phases', async () => {
    const plan = fakePlan();
    plan.steps = [
      plan.steps.find((step) => step.phase === 'CODE')!,
      plan.steps.find((step) => step.phase === 'UNIT_TEST')!,
      plan.steps.find((step) => step.phase === 'INTEGRATION_TEST')!,
    ].map((step) => ({
      ...step,
      dependsOn:
        step.phase === 'CODE' ? [] :
          step.phase === 'UNIT_TEST' ? ['S004'] : ['S005'],
      status: 'PENDING' as const,
      retries: 0,
    }));
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);

    const debugWikiPath = path.join(tmp, '.xcompiler', 'debug-wiki');
    const seedWiki = new DebugWiki(debugWikiPath);
    const seedBrief = buildDebugBrief({
      reason: 'Test gate: tests exit=1',
      failureLog: 'unit regression failed: expected fixed implementation',
      phase: 'UNIT_TEST',
      targetPhase: 'CODE',
    });
    const seed = await seedWiki.recordResolution({
      brief: seedBrief,
      ticketId: 'SEED-BUG',
      stepId: 'S004',
      phase: 'CODE',
      targetPhase: 'CODE',
      language: 'python',
      solution: 'Inspect src/hello.py and patch hi() so the unit gate observes the fixed implementation.',
      repairFiles: ['src/hello.py'],
    });
    const seedId = seed.created!;
    const debuggerLlm = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'repair CODE from unit test failure',
        actions: [
          { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "fixed"\n' } },
          { tool: 'write_file', args: { path: 'tests/test_hello.py', content: 'from hello import hi\n\ndef test_hi():\n    assert hi() == "fixed"\n' } },
          { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan fixed\n' } },
        ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({
      Coder: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write buggy implementation',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "buggy"\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
          ],
          done: true,
        }),
      ]),
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write unit tests',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# unit\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'formally rerun unit tests after the CODE repair',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# unit verified\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'write integration tests after unit passes',
          actions: [
            { tool: 'write_file', args: { path: 'docs/06-integration-test.md', content: '# integration\n' } },
          ],
          done: true,
        }),
      ]),
      Debugger: debuggerLlm,
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new UnitRollbackSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
      maxDebugRetries: 1,
      debugWikiPath,
    });

    const result = await engine.run(plan);
    expect(result.failedStepId).toBeUndefined();
    expect(debuggerLlm.lastUser).toContain('## debug wiki matches');
    expect(debuggerLlm.lastUser).toContain(seedId);
    expect(await ws.readFile('src/hello.py')).toContain('fixed');
    expect(await ws.readFile('tests/test_hello.py')).toContain('hi() == "fixed"');
    expect(plan.steps.every((step) => step.status === 'DONE')).toBe(true);
    expect(await ws.exists('docs/06-integration-test.md')).toBe(true);
    const bugEvents = (await ws.readFile('.xcompiler/tickets/events.jsonl'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        event: string;
        ticketId: string;
        ticketType: string;
        targetStepId?: string;
        targetPhase?: string;
      })
      .filter((event) => event.ticketType === 'bug');
    const ticketId = bugEvents[0]!.ticketId;
    expect(bugEvents.map((event) => event.event)).toEqual(
      expect.arrayContaining(['created', 'routed', 'resolved', 'closed-after-wiki']),
    );
    expect(bugEvents.find((event) => event.event === 'routed')).toMatchObject({
      targetStepId: 'S004',
      targetPhase: 'CODE',
    });
    const bug = JSON.parse(await ws.readFile(`.xcompiler/tickets/${ticketId}.json`)) as {
      status: string;
      kind: string;
      rawFailureLogPath?: string;
      failureLogBytes?: number;
      debugBrief?: { category: string; summary: string; debugDemand: string };
      bugResolutionPlan?: string;
      repair?: { completedBeforeDebug: boolean; mode: string; patchPath?: string; summaryPath?: string };
    };
    expect(bug.status).toBe('closed');
    expect(bug.kind).toBe('test-gate');
    expect(bug.rawFailureLogPath).toBe(`.xcompiler/tickets/${ticketId}/failure.raw.log`);
    expect(bug.failureLogBytes).toBeGreaterThan(0);
    expect(bug.debugBrief).toMatchObject({ category: 'test_failure' });
    expect(bug.debugBrief?.debugDemand).toContain('Fix the root implementation/contract defect');
    expect(bug.bugResolutionPlan).toContain('Test scripted bug plan');
    const rawBugLog = await ws.readFile(bug.rawFailureLogPath!);
    expect(rawBugLog).toContain('Test gate: tests exit=1');
    expect(rawBugLog).toContain('unit regression failed: expected fixed implementation');
    expect(bug.repair).toMatchObject({ completedBeforeDebug: true });
    expect(bug.repair?.mode).toMatch(/rewrite|patch/);
    expect(await ws.readFile(bug.repair!.patchPath!)).toContain('fixed');
    expect(await ws.readFile(bug.repair!.summaryPath!)).toContain('Repair');
    const reloadedWiki = new DebugWiki(debugWikiPath);
    const seeded = (await reloadedWiki.search(seedBrief, { language: 'python' }))
      .find((match) => match.entry.id === seedId)?.entry;
    expect(seeded?.stats.uses).toBeGreaterThan(0);
    expect(seeded?.stats.successes).toBeGreaterThan(1);
    expect(seeded?.resolutionPlan).toContain('Test scripted bug plan');
  });

  it('bubbles test rollback signals raised during same-phase Debugger retries to the V-model source phase', async () => {
    setLocale('zh');
    const plan = fakePlan();
    const codeStep = {
      ...plan.steps.find((step) => step.phase === 'CODE')!,
      dependsOn: [],
      outputs: ['src/hello.py', 'docs/tests/unit-test-plan.md', 'tests/test_hello.py'],
      status: 'DONE' as const,
      retries: 0,
    };
    const unitStep = {
      ...plan.steps.find((step) => step.phase === 'UNIT_TEST')!,
      dependsOn: ['S004'],
      tools: ['write_file', 'run_tests'],
      inputs: ['src/hello.py', 'tests/test_hello.py'],
      outputs: ['docs/05-unit-test.md'],
      status: 'PENDING' as const,
      retries: 0,
    };
    plan.steps = [codeStep, unitStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "buggy"\n');
    await ws.writeFile('docs/tests/unit-test-plan.md', '# unit plan\n');

    const router = new FakeRouter({
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'produce the report and run the unit gate, exposing a source defect',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# unit failed\n' } },
            { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
          ],
          done: false,
        }),
        JSON.stringify({
          thoughts: 'rewrite the unit validation report after source repair',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# unit\n' } },
          ],
          done: true,
        }),
      ]),
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'same-phase unit Debugger writes only the report, but verification exposes a source bug',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# unit\n' } },
            { tool: 'run_tests', args: { args: ['tests/test_hello.py'] } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'repair CODE after the bubbled unit failure',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "fixed"\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan fixed\n' } },
          ],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new UnitRollbackSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
      maxDebugRoundsPerStep: 1,
      maxDebugRetries: 2,
    });

    try {
      const result = await engine.run(plan);

      expect(result.failedStepId).toBeUndefined();
      expect(await ws.readFile('src/hello.py')).toContain('fixed');
      expect(plan.steps.every((step) => step.status === 'DONE')).toBe(true);
      const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
      expect(auditLog).toContain('engine.test_phase_rollback');
      expect(auditLog).toContain('"sourceStepId":"S004"');
    } finally {
      setLocale('en');
    }
  });

  it('repairs final audit API failures through Debugger instead of only reporting the audit error', async () => {
    const plan = fakePlan();
    plan.steps = [
      {
        ...plan.steps.find((step) => step.phase === 'CODE')!,
        id: 'S004',
        iterationId: 'P1',
        phase: 'CODE',
        title: 'Implement API-backed entrypoint',
        outputs: ['src/holiday.py', 'src/main.py'],
        dependsOn: [],
        status: 'DONE',
      },
      {
        id: 'S008',
        iterationId: 'P1',
        phase: 'FUNCTIONAL_TEST',
        title: 'Functional validation',
        description: 'final functional docs and runnable entrypoint',
        systemPrompt: 'Keep the entrypoint runnable and repair final audit failures without masking errors.',
        role: 'Tester',
        tools: ['write_file'],
        inputs: ['src/holiday.py', 'src/main.py'],
        outputs: ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'],
        dependsOn: ['S004'],
        acceptance: 'entrypoint and docs pass final audit',
        status: 'DONE',
        retries: 0,
        maxRetries: 3,
      },
    ];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/main.py', [
      'import argparse',
      'from holiday import get_countdown',
      '',
      'def main():',
      '    argparse.ArgumentParser(description="checkpoint").parse_args()',
      '    print(get_countdown())',
      '',
      'if __name__ == "__main__":',
      '    main()',
      '',
    ].join('\n'));
    await ws.writeFile('src/holiday.py', [
      'API_URL = "https://timor.tech/api/holiday/"',
      '',
      'def get_countdown():',
      '    return API_URL',
      '',
    ].join('\n'));
    await ws.writeFile('README.md', '# Checkpoint\n');
    await ws.writeFile('docs/quickstart.md', '# QuickStart\n');
    await ws.writeFile('docs/08-functional-test.md', '# Functional Test\n');

    const router = new FakeRouter({
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'replace the failed holiday API integration with a reachable built-in calculation',
          actions: [
            {
              tool: 'write_file',
              args: {
                path: 'src/holiday.py',
                content: [
                  'def get_countdown():',
                  '    return "Spring Festival countdown: 20 days"',
                  '',
                ].join('\n'),
              },
            },
          ],
          done: true,
        }),
      ]),
    });
    const repairSandbox = new EntrypointProbeSandbox(ws);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: repairSandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
      maxDebugRetries: 2,
    });
    const auditResult: ProjectAuditResult = {
      ok: false,
      warnings: 0,
      errors: 1,
      checks: [
        {
          name: 'entrypoint',
          severity: 'error',
          ok: false,
          summary: 'entrypoint failed: python src/main.py',
          detail:
            'Network API failure detected. Evidence: Failed to fetch holiday data: 403 Client Error: Forbidden for url: https://timor.tech/api/holiday/',
        },
      ],
    };

    const repair = await engine.repairProjectAuditFailure(plan, auditResult);
    expect(repair.failedStepId).toBeUndefined();
    expect(await ws.readFile('src/holiday.py')).not.toContain('timor.tech');
    expect(repair.restartIndex).toBe(0);
    expect(plan.steps[1]?.status).toBe('PENDING');
    const probe = await repairSandbox.runProgram(['src/main.py']);
    expect(probe.stderr).toBe('');
    expect(probe.stdout).toContain('Spring Festival countdown');
  });

  it('resets downstream V-model phases after an upstream project-audit repair', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    const functionalStep = plan.steps.find((step) => step.phase === 'FUNCTIONAL_TEST')!;
    codeStep.dependsOn = [];
    codeStep.outputs = ['src/hello.py', 'docs/tests/unit-test-plan.md', 'tests/test_hello.py'];
    codeStep.status = 'DONE';
    unitStep.dependsOn = [codeStep.id];
    unitStep.status = 'DONE';
    functionalStep.dependsOn = [unitStep.id];
    functionalStep.status = 'DONE';
    plan.steps = [codeStep, unitStep, functionalStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/hello.py', 'def hi():\n    return "old"\n');
    await ws.writeFile('docs/tests/unit-test-plan.md', '# Unit plan\n');

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new UnitRollbackSandbox(ws),
      router: new FakeRouter({
        Debugger: new ScriptedLLM([
          JSON.stringify({
            thoughts: 'repair the upstream build defect',
            actions: [
              { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "fixed"\n' } },
            ],
            done: true,
          }),
        ]),
      }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });
    const auditResult: ProjectAuditResult = {
      ok: false,
      warnings: 0,
      errors: 1,
      checks: [{
        name: 'build',
        severity: 'error',
        ok: false,
        summary: 'build failed',
        detail: 'src/hello.py has an invalid implementation',
      }],
    };

    const repair = await engine.repairProjectAuditFailure(plan, auditResult);

    expect(repair.failedStepId).toBeUndefined();
    expect(repair.restartIndex).toBe(0);
    expect(codeStep.status).toBe('DONE');
    expect(unitStep.status).toBe('PENDING');
    expect(functionalStep.status).toBe('PENDING');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.audit_repair_downstream_reset');
  });

  it('routes project-audit test failures to the source phase that owns the failed test', async () => {
    const plan = fakePlan();
    const detailedStep = plan.steps.find((step) => step.phase === 'DETAILED_DESIGN')!;
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    const unitStep = plan.steps.find((step) => step.phase === 'UNIT_TEST')!;
    const integrationStep = plan.steps.find((step) => step.phase === 'INTEGRATION_TEST')!;
    detailedStep.dependsOn = [];
    detailedStep.status = 'DONE';
    codeStep.dependsOn = [detailedStep.id];
    codeStep.status = 'DONE';
    unitStep.dependsOn = [codeStep.id];
    unitStep.status = 'DONE';
    integrationStep.dependsOn = [unitStep.id];
    integrationStep.status = 'DONE';
    plan.steps = [detailedStep, codeStep, unitStep, integrationStep];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/03-detailed-design.md', '# Detail\nstale contract\n');

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new CapturingTestArgsSandbox(),
      router: new FakeRouter({
        Debugger: new ScriptedLLM([
          JSON.stringify({
            thoughts: 'repair the detailed-design contract that owns the failed integration test',
            actions: [
              {
                tool: 'write_file',
                args: {
                  path: 'docs/03-detailed-design.md',
                  content: '# Detail\nfixed integration contract\n',
                },
              },
            ],
            done: true,
          }),
        ]),
      }) as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 1,
    });
    const auditResult: ProjectAuditResult = {
      ok: false,
      warnings: 0,
      errors: 1,
      checks: [{
        name: 'tests',
        severity: 'error',
        ok: false,
        summary: 'integration tests failed',
        detail: 'FAILED tests/test_integration.py::test_contract - AssertionError: stale contract',
      }],
    };

    const repair = await engine.repairProjectAuditFailure(plan, auditResult);

    expect(repair.failedStepId).toBeUndefined();
    expect(repair.restartIndex).toBe(0);
    expect(await ws.readFile('docs/03-detailed-design.md')).toContain('fixed integration contract');
    expect(detailedStep.status).toBe('DONE');
    expect(codeStep.status).toBe('PENDING');
    expect(unitStep.status).toBe('PENDING');
    expect(integrationStep.status).toBe('PENDING');
    const ticketLog = await ws.readFile('.xcompiler/tickets/events.jsonl');
    expect(ticketLog).toContain('"targetStepId":"S003"');
    expect(ticketLog).toContain('"targetPhase":"DETAILED_DESIGN"');
  });

  it('runs an iteration gate after FUNCTIONAL_TEST and routes failures back through Debugger repair', async () => {
    const plan = fakePlan();
    plan.implementationPhases = [
      {
        id: 'P1',
        title: 'Core iteration',
        objective: 'Deliver and verify the core slice.',
        status: 'current',
        scope: ['Core'],
        deliverables: ['Core delivery'],
        dependsOn: [],
        verificationGate: {
          summary: 'P1 gate',
          checks: ['tests pass', 'entrypoint runs', 'delivery docs exist'],
          failurePolicy: 'Repair P1 before continuing.',
        },
      },
    ];
    plan.steps = [
      {
        ...plan.steps.find((step) => step.phase === 'CODE')!,
        id: 'S004',
        iterationId: 'P1',
        phase: 'CODE',
        outputs: ['src/main.py', 'docs/tests/unit-test-plan.md', 'tests/test_main.py'],
        dependsOn: [],
        status: 'DONE',
      },
      {
        ...plan.steps.find((step) => step.phase === 'UNIT_TEST')!,
        id: 'S005',
        iterationId: 'P1',
        phase: 'UNIT_TEST',
        inputs: ['src/main.py', 'tests/test_main.py'],
        outputs: ['docs/05-unit-test.md'],
        dependsOn: ['S004'],
        status: 'DONE',
      },
      {
        id: 'S008',
        iterationId: 'P1',
        phase: 'FUNCTIONAL_TEST',
        title: 'Functional validation',
        description: 'Write functional validation docs.',
        systemPrompt: 'Write the functional validation documentation bundle.',
        role: 'Tester',
        tools: ['write_file'],
        inputs: ['src/main.py', 'tests/test_main.py'],
        outputs: ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'],
        dependsOn: ['S005'],
        acceptance: 'functional docs exist',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
    ];
    await ws.writeFile('src/main.py', 'def main(): print("usage: gate app")\n');
    await ws.writeFile('tests/test_main.py', 'import main\n\n\ndef test_gate(): assert main is None\n');
    await ws.writeFile('docs/05-unit-test.md', '# Unit Test\n');
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);

    const router = new FakeRouter({
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write functional docs',
          actions: [
            { tool: 'write_file', args: { path: 'README.md', content: '# Gate App\n' } },
            { tool: 'write_file', args: { path: 'docs/quickstart.md', content: '# QuickStart\n' } },
            { tool: 'write_file', args: { path: 'docs/08-functional-test.md', content: '# Functional Test\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'rerun unit validation after the repaired code phase',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Unit Test\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'rerun functional docs after the repaired unit phase',
          actions: [
            { tool: 'write_file', args: { path: 'README.md', content: '# Gate App\n' } },
            { tool: 'write_file', args: { path: 'docs/quickstart.md', content: '# QuickStart\n' } },
            { tool: 'write_file', args: { path: 'docs/08-functional-test.md', content: '# Functional Test\n' } },
          ],
          done: true,
        }),
      ]),
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'repair the failing iteration gate test',
          actions: [
            {
              tool: 'write_file',
              args: { path: 'tests/test_main.py', content: 'import main\n\n\ndef test_gate():\n    assert main is not None  # fixed\n' },
            },
          ],
          done: true,
        }),
      ]),
    });
    const gateSandbox = new IterationGateSandbox(ws);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: gateSandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });

    const result = await engine.run(plan);
    expect(result.failedStepId).toBeUndefined();
    expect(result.executedSteps).toBe(4);
    expect(await ws.readFile('tests/test_main.py')).toContain('fixed');
    const auditLog = await ws.readFile('.xcompiler/audit.jsonl');
    expect(auditLog).toContain('engine.audit_repair_downstream_reset');
  });

  it('auto-adds chunked author tools when a doc-producing step omits them', async () => {
    const plan = fakePlan();
    plan.steps = [
      {
        id: 'S003',
        iterationId: 'P1',
        phase: 'DETAILED_DESIGN',
        title: 'Detailed design',
        description: 'Write docs/03-detailed-design.md with executable implementation design.',
        systemPrompt: 'Split the high-level design into concrete module internals and save them to docs/03-detailed-design.md.',
        role: 'Architect',
        tools: ['write_file'],
        inputs: ['docs/02-high-level-design.md'],
        outputs: ['docs/03-detailed-design.md'],
        dependsOn: [],
        acceptance: 'docs/03-detailed-design.md exists',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
    ];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/02-high-level-design.md', '# high level\n- module A\n- module B\n');
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const router = new FakeRouter({
      Architect: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write detailed design',
          actions: [
            {
              tool: 'write_file',
              args: { path: 'docs/03-detailed-design.md', content: '# detailed design\n' },
            },
            {
              tool: 'append_file',
              args: { path: 'docs/03-detailed-design.md', content: '- T001\n- T002\n' },
            },
          ],
          done: true,
        }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });

    const r = await engine.run(plan);
    expect(r.failedStepId).toBeUndefined();
    expect(plan.steps[0]?.status).toBe('DONE');
    expect(await ws.exists('docs/03-detailed-design.md')).toBe(true);
    expect(await ws.readFile('docs/03-detailed-design.md')).toContain('- T002');
  });

  it('injects refreshed project memory and related files into step context', async () => {
    const plan = fakePlan();
    plan.language = 'typescript';
    plan.intent = 'feature';
    plan.steps = [
      {
        ...plan.steps[2]!,
        id: 'S003',
        phase: 'CODE',
        title: 'Extend reporting service',
        description: 'Add invoice export orchestration to the reporting service.',
        systemPrompt: 'Only extend the existing reporting module.',
        role: 'Coder',
        outputs: [
          'src/reporting/export.ts',
          'docs/tests/unit-test-plan.md',
          'tests/reporting/export.test.ts',
        ],
        dependsOn: [],
      },
      {
        ...plan.steps[3]!,
        id: 'S004',
        phase: 'UNIT_TEST',
        title: 'Verify reporting export',
        description: 'Consume the reporting export API from tests.',
        role: 'Tester',
        inputs: ['src/reporting/export.ts', 'tests/reporting/export.test.ts'],
        outputs: ['docs/05-unit-test.md'],
        dependsOn: ['S003'],
        acceptance: 'export API is covered by tests',
      },
    ];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/topic.md', 'Existing reporting workflow already exports invoices.');
    await ws.writeFile('docs/02-high-level-design.md', 'ReportingService is the central coordinator.');
    await ws.writeFile('src/reporting/service.ts', 'export class ReportingService { exportInvoices() { return "csv"; } }\n');
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });
    (sandbox as unknown as { runTests: () => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> }).runTests =
      async () => ({ exitCode: 0, stdout: '1 passed', stderr: '', timedOut: false });

    const coder = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'extend reporting',
        actions: [
          { tool: 'write_file', args: { path: 'src/reporting/export.ts', content: 'export const exportReport = () => "ok";\n' } },
          { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# Reporting unit test plan\n' } },
          {
            tool: 'write_file',
            args: {
              path: 'tests/reporting/export.test.ts',
              content: 'import { describe, it, expect } from "vitest";\nimport { exportReport } from "../../src/reporting/export.ts";\ndescribe("export", () => { it("works", () => expect(exportReport()).toBe("ok")); });\n',
            },
          },
        ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({
      Coder: coder,
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'add export test',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# Reporting unit validation\n' } },
          ],
          done: true,
        }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });

    const r = await engine.run(plan);
    expect(r.failedStepId).toBeUndefined();
    expect(coder.lastUser).toContain('.xcompiler/project_memory.json#summary');
    expect(coder.lastUser).toContain('docs/02-high-level-design.md');
    expect(coder.lastUser).toContain('src/reporting/service.ts');
    expect(coder.lastUser).toContain('ReportingService');
    expect(coder.lastUser).toContain('.xcompiler/downstream/S003.md');
    expect(coder.lastUser).toContain('Verify reporting export');
  });

  it('refreshes project memory between steps so later work sees newly created modules', async () => {
    const plan = fakePlan();
    plan.language = 'typescript';
    plan.intent = 'feature';
    plan.steps = [
      {
        ...plan.steps[2]!,
        id: 'S003',
        phase: 'CODE',
        title: 'Create reporting service',
        description: 'Add the reporting service module.',
        systemPrompt: 'Create the reporting module.',
        role: 'Coder',
        outputs: ['src/reporting/service.ts'],
        dependsOn: [],
      },
      {
        ...plan.steps[2]!,
        id: 'S004',
        phase: 'CODE',
        title: 'Extend reporting service',
        description: 'Build the export module on top of the reporting service.',
        systemPrompt: 'Reuse the reporting module instead of rewriting it.',
        role: 'Coder',
        outputs: ['src/reporting/export.ts'],
        dependsOn: ['S003'],
      },
    ];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/topic.md', 'Add invoice export support to the reporting flow.');
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const coder = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'create reporting service',
        actions: [
          { tool: 'write_file', args: { path: 'src/reporting/service.ts', content: 'export class ReportingService { exportInvoices() { return "csv"; } }\n' } },
        ],
        done: true,
      }),
      JSON.stringify({
        thoughts: 'extend reporting service',
        actions: [
          { tool: 'write_file', args: { path: 'src/reporting/export.ts', content: 'export const exportReport = () => "ok";\n' } },
        ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({ Coder: coder });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });

    const r = await engine.run(plan);
    expect(r.failedStepId).toBeUndefined();
    expect(coder.lastUser).toContain('src/reporting/service.ts');
    expect(coder.lastUser).toContain('exportInvoices');
  });
});
