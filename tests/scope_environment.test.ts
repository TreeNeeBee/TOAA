import { describe, expect, it } from 'vitest';
import { prepareScopeEnvironment } from '../src/application/execution/scope_environment.js';
import type { Sandbox } from '../src/sandbox/types.js';

function sandbox(build: () => Promise<unknown>): { sandbox: Sandbox; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sandbox: {
      async build(manifest: string) { calls.push(manifest); return build(); },
    } as unknown as Sandbox,
  };
}

describe('scope environment preparation', () => {
  // A ticket worktree is a fresh Git checkout: the manifest is tracked, the installed packages are
  // not. CODE is the only Step that develops in isolation, so it was the only one guaranteed to find
  // no toolchain — while the run-start precondition covered the canonical copy it never runs in.
  it('prepares an isolated working copy, which Git left without its packages', async () => {
    const { sandbox: s, calls } = sandbox(async () => undefined);
    const result = await prepareScopeEnvironment({
      sandbox: s, manifestFile: 'package.json', isolated: true, root: '/w/tickets/T1',
    });
    expect(result.prepared).toBe(true);
    expect(calls).toEqual(['package.json']);
  });

  it('leaves the canonical copy alone, because the run already prepared it', async () => {
    const { sandbox: s, calls } = sandbox(async () => undefined);
    const result = await prepareScopeEnvironment({
      sandbox: s, manifestFile: 'package.json', isolated: false, root: '/w/master',
    });
    expect(result.prepared).toBe(false);
    expect(calls).toEqual([]);
  });

  it('records a failure instead of aborting the run', async () => {
    const events: Array<Record<string, unknown>> = [];
    const { sandbox: s } = sandbox(async () => { throw new Error('npm install timed out'); });
    const result = await prepareScopeEnvironment({
      sandbox: s,
      manifestFile: 'package.json',
      isolated: true,
      root: '/w/tickets/T1',
      audit: {
        event: async (_kind: string, message: string, fields: Record<string, unknown>) => {
          events.push({ message, ...fields });
        },
      } as never,
    });
    // Nothing about the change has been shown to be wrong, and the attempt's own tooling reports a
    // missing toolchain in terms the Step can act on. A stack trace would replace that.
    expect(result.prepared).toBe(false);
    expect(result.error).toContain('npm install timed out');
    expect(events).toHaveLength(1);
    expect(events[0]!.messageId).toBe('execute.scope_sandbox_sync_failed');
    expect(String(events[0]!.message)).toContain('/w/tickets/T1');
  });
});
