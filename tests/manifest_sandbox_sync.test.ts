import { describe, expect, it } from 'vitest';
import { syncSandboxIfManifestWritten } from '../src/agents/executor.js';
import type { ToolContext, ToolResult } from '../src/tools/types.js';

function context(build: (manifest: string) => Promise<void>): {
  ctx: ToolContext;
  builds: string[];
  events: string[];
} {
  const builds: string[] = [];
  const events: string[] = [];
  return {
    builds,
    events,
    ctx: {
      language: 'typescript',
      sandbox: { build: async (manifest: string) => { builds.push(manifest); await build(manifest); } },
      audit: { event: async (_kind: string, _message: string, fields: Record<string, unknown>) => {
        events.push(String(fields.messageId));
      } },
    } as unknown as ToolContext,
  };
}

const ok: ToolResult = { ok: true };

describe('manifest writes and the sandbox', () => {
  // HIGH_LEVEL_DESIGN authors the whole manifest, so it writes the file rather than appending one
  // package. `add_dependency` rebuilt and delivery rebuilt, but this path — the one a design Step
  // actually takes — did not, so the Step ran its module tests against a sandbox with no toolchain
  // and got `vitest: command not found` for packages it had just declared.
  it('rebuilds when a tool writes the manifest', async () => {
    const { ctx, builds, events } = context(async () => undefined);
    await syncSandboxIfManifestWritten({ tool: 'write_file', args: { path: 'package.json' } }, ok, ctx);
    expect(builds).toEqual(['package.json']);
    expect(events).toEqual(['execute.sandbox_synced_after_manifest_write']);
  });

  it('ignores writes to anything else, and failed writes', async () => {
    const { ctx, builds } = context(async () => undefined);
    await syncSandboxIfManifestWritten({ tool: 'write_file', args: { path: 'src/cli.ts' } }, ok, ctx);
    await syncSandboxIfManifestWritten(
      { tool: 'write_file', args: { path: 'package.json' } },
      { ok: false, error: 'denied' },
      ctx,
    );
    expect(builds).toEqual([]);
  });

  // add_dependency stages the manifest and rebuilds with its own options, rolling back if the build
  // fails. A second rebuild here would run after that decision and undo its meaning.
  it('leaves add_dependency to its own rebuild', async () => {
    const { ctx, builds } = context(async () => undefined);
    await syncSandboxIfManifestWritten(
      { tool: 'add_dependency', args: { packages: ['vitest'] } }, ok, ctx,
    );
    expect(builds).toEqual([]);
  });

  it('records a failed sync rather than failing the tool call', async () => {
    const { ctx, events } = context(async () => { throw new Error('npm install timed out'); });
    await expect(syncSandboxIfManifestWritten(
      { tool: 'write_file', args: { path: 'package.json' } }, ok, ctx,
    )).resolves.toBeUndefined();
    expect(events).toEqual(['execute.sandbox_sync_after_manifest_write_failed']);
  });
});
