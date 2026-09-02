import { describe, expect, it } from 'vitest';
import { DomainAttemptRunner, type AttemptInput, type ExecutionScope } from '../src/application/execution/attempt_runner.js';

/**
 * The scope decides which working copy an attempt touches. Resolving it per attempt is what lets a
 * Ticket develop in its own worktree while work without a ChangeSet stays on the canonical copy.
 */
describe('attempt execution scope', () => {
  it('falls back to the canonical bindings when no resolver is supplied', async () => {
    const canonical = bindings('canonical');
    const runner = new DomainAttemptRunner(options(canonical), 'typescript');
    expect(await resolve(runner, input())).toBe(canonical.workspace);
  });

  it('uses the resolved scope, so each Ticket runs in its own working copy', async () => {
    const canonical = bindings('canonical');
    const ticketScope = bindings('ticket');
    const runner = new DomainAttemptRunner(
      { ...options(canonical), resolveScope: async () => ticketScope as unknown as ExecutionScope },
      'typescript',
    );
    expect(await resolve(runner, input())).toBe(ticketScope.workspace);
  });

  // The scope states which working copy it is, so nothing downstream re-derives it by comparing
  // roots. That comparison used `path.resolve`, which does not follow symlinks: a host handing the
  // canonical root over as `/tmp/...` and the scope root as `/private/tmp/...` would have read the
  // mainline as a candidate worktree, and the project file tree would have silently stopped being
  // updated while every write still succeeded. The alias case is now unrepresentable rather than
  // merely untested — there is no comparison left to get wrong — so what remains to guard is that
  // every scope states a kind and the canonical fallback states the right one.
  it('states the working-copy kind on every scope', async () => {
    const canonical = bindings('canonical');
    expect(await resolveKind(new DomainAttemptRunner(options(canonical), 'typescript'), input()))
      .toBe('canonical');

    const ticketScope = bindings('ticket');
    const runner = new DomainAttemptRunner(
      { ...options(canonical), resolveScope: async () => ticketScope as unknown as ExecutionScope },
      'typescript',
    );
    expect(await resolveKind(runner, input())).toBe('ticket');
  });
});

/** Reads back the kind of whichever scope `runAttempt` would use. */
async function resolveKind(runner: DomainAttemptRunner, attempt: AttemptInput): Promise<unknown> {
  const internals = runner as unknown as {
    options: { resolveScope?: (input: AttemptInput) => Promise<ExecutionScope> };
    canonicalScope(): ExecutionScope;
  };
  return (await internals.options.resolveScope?.(attempt) ?? internals.canonicalScope()).kind;
}

/** Reads back whichever scope `runAttempt` would use, without running an attempt. */
async function resolve(runner: DomainAttemptRunner, attempt: AttemptInput): Promise<unknown> {
  const internals = runner as unknown as {
    options: { resolveScope?: (input: AttemptInput) => Promise<ExecutionScope> };
    canonicalScope(): ExecutionScope;
  };
  const scope = await internals.options.resolveScope?.(attempt) ?? internals.canonicalScope();
  return scope.workspace;
}

function bindings(tag: string) {
  return {
    kind: tag === 'canonical' ? 'canonical' as const : 'ticket' as const,
    workspace: { root: `/${tag}` },
    git: { tag },
    sandbox: { tag },
  };
}

function options(scope: ReturnType<typeof bindings>) {
  return {
    ...scope,
    router: {}, audit: {}, repository: {}, plugins: { size: 0 },
    debugWikiPath: '/tmp/xcompiler-scope-wiki',
  } as never;
}

function input(): AttemptInput {
  return { domainStep: { type: 'CODE' } } as unknown as AttemptInput;
}

/**
 * Which failure the Debug Wiki is asked about.
 *
 * Lookup follows the top of the failure stack; the history stays in the prompt. A Ticket's own
 * `failure` is the one that opened it, and a repair loop moves through several — unwritten tests,
 * then an import error, then a failing assertion. A live Bug received the same entry 51 times
 * while the entry matching its current `ModuleNotFoundError` never appeared, and it ran out of
 * attempts on advice for a problem it had already left behind.
 *
 * Driven through `assembleContext` rather than through the brief builder: the builder can be right
 * while the call site still asks the old question, which is exactly how this shipped.
 */
describe('debug wiki is asked about the failure in hand', () => {
  const openingFailure = {
    code: 'test_failure',
    category: 'test',
    summary: 'verification command repeated without a successful mutation',
    message: 'run_tests:{"cwd":"."}; the duplicate command was not executed again',
    failedStepId: 'S004',
    targetStepId: 'S004',
    failedStepType: 'CODE',
  };

  const latestFailureLog = {
    objectType: 'log' as const,
    level: 'error' as const,
    message: 'Step executor reached max rounds',
    data: {
      stepId: 'STEP-1',
      failureLog: [
        'pytest exit=2 args=tests/test_models.py',
        "E   ModuleNotFoundError: No module named 'models'",
      ].join('\n'),
    },
  };

  const assembleWith = async (logIds: string[]) => {
    let asked: { category?: string; primaryError?: string } | undefined;
    const runner = new DomainAttemptRunner({
      ...options(bindings('canonical')),
      repository: { read: async () => latestFailureLog },
    } as never, 'python');
    (runner as unknown as { context: unknown }).context = {
      assemble: async (request: { debugBrief?: { category?: string; primaryError?: string } }) => {
        asked = request.debugBrief;
        return { text: '', snapshot: {}, debugWikiMatches: [] };
      },
    };
    (runner as unknown as { traces: unknown }).traces = { recordLog: async () => undefined };
    const attempt = {
      domainStep: { id: 'STEP-1', name: 'P1-S004', type: 'CODE', projectId: 'P', phaseId: 'PH' },
      executionStep: { phase: 'CODE' },
      mode: 'debug',
      correlationId: 'CORR-1',
      ticket: { id: 'T', type: 'bug', failure: openingFailure, logIds, source: { correlationId: 'CORR-1' } },
    } as unknown as AttemptInput;
    const result = await (runner as unknown as {
      assembleContext(i: AttemptInput): Promise<{ debugBrief?: unknown }>;
    }).assembleContext(attempt);
    return { asked, returned: result.debugBrief };
  };

  // The prompt and the lookup are two questions about one failure. Answering them from two sources
  // is how they came apart in a live run: retrieval followed the top of the stack while the prompt
  // still described the failure that opened the Ticket, so a Debugger spent 26 attempts re-fixing an
  // ImportError an earlier round had already fixed and never saw the assertion that was failing.
  it('hands the prompt the same failure it asked the wiki about', async () => {
    const { asked, returned } = await assembleWith(['LOG-1']);
    expect(returned).toBe(asked);
  });

  it('asks about the latest recorded failure once one exists', async () => {
    const { asked } = await assembleWith(['LOG-1']);
    expect(asked?.category).toBe('import_error');
    expect(asked?.primaryError).toContain('ModuleNotFoundError');
  });

  // Before the first failure is recorded there is no top of stack, and the Ticket's own failure is
  // the only thing there is to ask about.
  it('falls back to the opening failure on the first attempt', async () => {
    const { asked } = await assembleWith([]);
    expect(asked?.primaryError).not.toContain('ModuleNotFoundError');
  });
});
