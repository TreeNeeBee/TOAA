import { describe, expect, it } from 'vitest';
import {
  judgeScenarioOutcome,
  ScenarioOutcomeJudgementError,
} from '../src/application/execution/scenario_outcome_judge.js';
import type { LLMRouter } from '../src/llm/router.js';

/** A router whose single reply is whatever the test wants the judge to have said. */
function routerReturning(answer: string): LLMRouter {
  return { for: () => ({ name: 'stub', chat: async () => answer }) } as unknown as LLMRouter;
}

const scenario = { name: 'primary-user-flow', description: '', operation: 'run it', environment: 'live', expected: 'two sources appear' } as never;
const scene = { stdoutTail: 'fetched 0 items', stderrTail: '' } as never;
const base = { before: [], scenario, scene };

describe('scenario verdict carries Ticket type and owning Step', () => {
  it('reads a capability Change Request chosen by the judge', async () => {
    const verdict = await judgeScenarioOutcome({
      ...base,
      router: routerReturning('{"ok": false, "reason": "the accepted source capability is no longer viable", "ticketType": "change-request", "target": "high-level-design"}'),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ticketType).toBe('change-request');
    expect(verdict.target).toBe('high-level-design');
  });

  it('rejects a failed judgement that omits Ticket routing', async () => {
    await expect(judgeScenarioOutcome({
      ...base,
      router: routerReturning('{"ok": false, "reason": "the report is empty"}'),
    })).rejects.toBeInstanceOf(ScenarioOutcomeJudgementError);
  });

  it('rejects failed routing values outside the typed contract', async () => {
    await expect(judgeScenarioOutcome({
      ...base,
      router: routerReturning('{"ok": false, "reason": "x", "ticketType": "incident", "target": "the-network"}'),
    })).rejects.toBeInstanceOf(ScenarioOutcomeJudgementError);
  });

  it('claims no corrective routing when the scenario passed', async () => {
    const verdict = await judgeScenarioOutcome({
      ...base,
      router: routerReturning('{"ok": true, "reason": "met", "ticketType": "change-request", "target": "requirement-analysis"}'),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.ticketType).toBeUndefined();
    expect(verdict.target).toBeUndefined();
  });

  it('states the project framing to the judge when one is available', async () => {
    let seen = '';
    const router = {
      for: () => ({
        name: 'stub',
        chat: async (messages: Array<{ content: string }>) => {
          seen = messages.map((m) => m.content).join('\n');
          return '{"ok": true, "reason": "met"}';
        },
      }),
    } as unknown as LLMRouter;
    await judgeScenarioOutcome({ ...base, router, requirementDigest: 'public pages, no API keys' });
    // Without it the same refusal reads both ways: a missing credential and a service that takes none.
    expect(seen).toContain('public pages, no API keys');
  });
});


describe('status codes remain diagnostic evidence rather than Ticket routing rules', () => {
  it('is read as a refusal, not as an exception', async () => {
    const { buildDebugBrief } = await import('../src/core/debug_brief.js');
    const brief = buildDebugBrief({
      reason: 'phase delivery gate',
      failureLog: '- public-source: Request failed with status code 403',
      phase: 'CODE',
      targetPhase: 'CODE',
    });
    expect(brief.category).toBe('network_api_failure');
    expect(brief.debugDemand).toContain('unauthorized/forbidden');
  });

  it('still leaves our own provider outage out of it', async () => {
    // `fetch failed` from the availability probe is XCompiler's own request, and claiming it told
    // the generated project to rewrite working code.
    const { buildDebugBrief } = await import('../src/core/debug_brief.js');
    const brief = buildDebugBrief({
      reason: 'provider outage',
      failureLog: 'Tester availability check failed for qwen_plus: fetch failed',
      phase: 'CODE',
      targetPhase: 'CODE',
    });
    expect(brief.category).toBe('llm_provider');
  });
});

describe('the process result is evidence, not a verdict', () => {
  const liveScenario = {
    name: 'primary-user-flow', description: '', operation: 'run it',
    environment: 'live' as const, expected: 'entries from two sources appear',
    execution: { command: 'node', args: ['src/main.ts'] },
  };

  async function auditWorkspace() {
    const { Workspace } = await import('../src/workspace/workspace.js');
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-probe-'));
    const ws = new Workspace(root);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('package.json', JSON.stringify({ name: 'p', type: 'module', scripts: {} }));
    return ws;
  }

  const sandboxPrinting = (stdout: string) => ({
    exec: async () => ({ exitCode: 0, stdout, stderr: '', timedOut: false }),
    runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
  } as never);

  it('lets a graceful degradation pass when the judge says the expectation was met', async () => {
    // A product that loses one source, says so, and still satisfies an expectation asking for two is
    // passing. Reading network wording out of its own report decided `ok` before the judge did, so
    // the judge's agreement became "exited unsuccessfully but returned ok=true" — a thrown run on
    // the exact shape this kind of project produces every time it degrades.
    const { runProjectAudit } = await import('../src/core/project_audit.js');
    const { getLanguageProfile } = await import('../src/core/language.js');
    const degraded = '# report\n\n## failed sources\n\n- upstream: Request failed with status code 403\n';

    const result = await runProjectAudit({
      ws: await auditWorkspace(),
      sandbox: sandboxPrinting(degraded),
      plan: { version: '2', language: 'typescript', steps: [] } as never,
      profile: getLanguageProfile('typescript'),
      scenarios: [liveScenario],
      judgeScenarioOutcome: async () => ({ ok: true, reason: 'two sources appear', evidence: [] }),
    });

    expect(result.checks.find((entry) => entry.name === 'scenario:primary-user-flow')?.ok).toBe(true);
  });

  it('takes a fresh snapshot before each scenario', async () => {
    // One snapshot for the whole Phase credits the audit's own checks, and every earlier scenario,
    // to whichever scenario is being judged.
    const { runProjectAudit } = await import('../src/core/project_audit.js');
    const { getLanguageProfile } = await import('../src/core/language.js');
    let snapshots = 0;

    await runProjectAudit({
      ws: await auditWorkspace(),
      sandbox: sandboxPrinting('ok'),
      plan: { version: '2', language: 'typescript', steps: [] } as never,
      profile: getLanguageProfile('typescript'),
      scenarios: [liveScenario, { ...liveScenario, name: 'second-flow' }],
      snapshotArtifacts: async () => { snapshots += 1; return []; },
      judgeScenarioOutcome: async () => ({ ok: true, reason: 'met', evidence: [] }),
    });

    expect(snapshots).toBe(2);
  });

  it('tells the judge how the process ended', async () => {
    let seen = '';
    const router = {
      for: () => ({
        name: 'stub',
        chat: async (messages: Array<{ content: string }>) => {
          seen = messages.map((message) => message.content).join('\n');
          return '{"ok": true, "reason": "met"}';
        },
      }),
    } as unknown as LLMRouter;
    await judgeScenarioOutcome({
      router, before: [], scenario,
      scene: { stdoutTail: 'partial', stderrTail: '', exitCode: 3, timedOut: false } as never,
    });
    // It was asked whether the run produced what it should while being shown neither.
    expect(seen).toContain('exited with code 3');
  });
});
