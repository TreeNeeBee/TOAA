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
});

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
  return { workspace: { root: `/${tag}` }, git: { tag }, sandbox: { tag } };
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
