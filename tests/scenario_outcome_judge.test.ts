import { describe, expect, it } from 'vitest';
import { judgeScenarioOutcome } from '../src/application/execution/scenario_outcome_judge.js';

/**
 * Exiting zero answers a narrower question than the Phase gate asks. A delivered project ran its
 * live scenario successfully and produced a hundred records that each carried the same text twice;
 * the scenario's `expected` described exactly that content, and nothing read it.
 */
describe('scenario outcome judgement', () => {
  const scenario = {
    name: 'primary-user-flow',
    description: 'd',
    operation: 'run the entrypoint once',
    environment: 'live' as const,
    expected: 'each record carries a distinct summary',
  };
  const scene = {
    scenario, capturedAt: new Date().toISOString(), command: 'run', exitCode: 0,
    timedOut: false, stdoutTail: 'written to output/report.md',
  };

  it('fails the scenario when the produced artifact contradicts the expectation', async () => {
    const seen: string[] = [];
    const verdict = await judgeScenarioOutcome({
      router: router(seen, '{"ok": false, "reason": "every summary is duplicated"}'),
      before: [{ path: 'output/report.md', mtimeMs: 1 }],
      artifacts: {
        snapshot: async () => [{ path: 'output/report.md', mtimeMs: 2 }],
        read: async () => 'summary A summary A\nsummary B summary B\n',
      },
      scenario, scene,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('duplicated');
    // The judgement must carry what it was made from, or the Bug it becomes is unactionable.
    expect(verdict.evidence.join('\n')).toContain('output/report.md');
    // Only the expectation and the observed result are shown — no project vocabulary.
    expect(seen.join('\n')).toContain('each record carries a distinct summary');
  });

  // The finding this produces is routed to PM. Judging in an executing role's voice would put the
  // verdict and the owner of the verdict in two different places, and only the routing is visible
  // downstream — so a drift back to a borrowed role would be silent.
  it('judges in PM\'s voice, the same role the finding is routed to', async () => {
    const roles: string[] = [];
    await judgeScenarioOutcome({
      router: router([], '{"ok": true, "reason": "fine"}', roles),
      before: [],
      artifacts: { snapshot: async () => [], read: async () => undefined },
      scenario, scene,
    });
    expect(roles).toEqual(['ProjectManager']);
  });

  it('passes when the artifact meets the expectation', async () => {
    const verdict = await judgeScenarioOutcome({
      router: router([], '{"ok": true, "reason": "records are distinct"}'),
      before: [],
      artifacts: {
        snapshot: async () => [{ path: 'output/report.md', mtimeMs: 2 }],
        read: async () => 'summary A\nsummary B\n',
      },
      scenario, scene,
    });
    expect(verdict.ok).toBe(true);
  });

  // A model that answers unusably is not evidence of a defect. Failing delivery on it would open a
  // Bug against work that may be perfectly correct.
  it('does not fail delivery when the judgement cannot be read', async () => {
    const verdict = await judgeScenarioOutcome({
      router: router([], 'I was unable to determine this.'),
      before: [],
      artifacts: { snapshot: async () => [{ path: 'a.md', mtimeMs: 2 }], read: async () => 'x' },
      scenario, scene,
    });
    expect(verdict.ok).toBe(true);
  });

  // Only what the scenario changed is judged; everything already present is not its output.
  it('judges only the artifacts the scenario itself touched', async () => {
    const seen: string[] = [];
    await judgeScenarioOutcome({
      router: router(seen, '{"ok": true, "reason": "fine"}'),
      before: [{ path: 'src/main.ts', mtimeMs: 1 }, { path: 'output/report.md', mtimeMs: 1 }],
      artifacts: {
        snapshot: async () => [
          { path: 'src/main.ts', mtimeMs: 1 },
          { path: 'output/report.md', mtimeMs: 9 },
        ],
        read: async (p: string) => `content of ${p}`,
      },
      scenario, scene,
    });
    expect(seen.join('\n')).toContain('output/report.md');
    expect(seen.join('\n')).not.toContain('src/main.ts');
  });
});

function router(seen: string[], answer: string, roles: string[] = []) {
  return {
    for: (role: string) => {
      roles.push(role);
      return {
        chat: async (messages: { content: string }[]) => {
          seen.push(...messages.map((m) => m.content));
          return answer;
        },
      };
    },
  } as never;
}

// Covering the judgement without covering its call site leaves it able to pass while never running.
describe('phase gate consumes the judgement', () => {
  it('turns a contradicted expectation into a routable product-defect finding', async () => {
    const { runProjectAudit } = await import('../src/core/project_audit.js');
    const { getLanguageProfile } = await import('../src/core/language.js');
    const scenario = {
      name: 'primary-user-flow', description: 'd', operation: 'run once',
      environment: 'live' as const, expected: 'each record carries a distinct summary',
      execution: { command: 'run', args: [] },
    };
    const result = await runProjectAudit({
      ws: { abs: () => '/tmp', exists: async () => true, readFile: async () => 'x' } as never,
      sandbox: {
        exec: async () => ({ exitCode: 0, stdout: 'done', stderr: '', timedOut: false }),
        runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        runProgram: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        build: async () => ({ rebuilt: false, reason: 'ok' }),
      } as never,
      plan: { language: 'typescript', projectType: 'application', steps: [] } as never,
      profile: getLanguageProfile('typescript'),
      scenarios: [scenario],
      judgeScenarioOutcome: async () => ({
        ok: false,
        reason: 'every summary is duplicated',
        evidence: ['artifact output/report.md:\nsummary A summary A'],
      }),
    });

    const check = result.checks.find((item) => item.name === `scenario:${scenario.name}`);
    expect(check?.ok).toBe(false);
    // It must be routable: the Phase gate hands findings to PM, which opens the Ticket.
    expect(check?.finding?.category).toBe('product-defect');
    expect(check?.finding?.evidence.join('\n')).toContain('each record carries a distinct summary');
  });
});
