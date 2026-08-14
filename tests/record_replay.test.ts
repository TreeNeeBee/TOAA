import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RecordReplayController,
  RecordReplayError,
  activeEntries,
  verifyEntryChain,
} from '../src/application/record_replay/controller.js';
import { FileRecordReplayStore } from '../src/infrastructure/record_replay/file_store.js';
import { RecordReplaySandbox } from '../src/infrastructure/record_replay/sandbox.js';
import type { Sandbox } from '../src/sandbox/types.js';

describe('generic record/replay', () => {
  it('records redacted external interactions and replays without live access', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-record-replay-'));
    const store = new FileRecordReplayStore(root);
    const record = new RecordReplayController({ mode: 'record', store, enabledChannels: ['http'] });
    const response = await record.execute({
      channel: 'http',
      operation: 'GET',
      request: { url: 'https://example.test/data', authorization: 'Bearer top-secret-value' },
    }, async () => ({ status: 200, token: 'sk-secretsecretsecretsecret' }));
    expect(response.status).toBe(200);

    let liveCalls = 0;
    const replay = new RecordReplayController({ mode: 'replay', store, enabledChannels: ['http'] });
    const replayed = await replay.execute({
      channel: 'http',
      operation: 'GET',
      request: { url: 'https://example.test/data', authorization: 'Bearer another-secret' },
    }, async () => {
      liveCalls += 1;
      return { status: 500 };
    });
    expect(liveCalls).toBe(0);
    expect(replayed).toEqual({ status: 200, token: '[REDACTED]' });
    expect(JSON.stringify(await store.list())).not.toContain('top-secret-value');
    expect(JSON.stringify(await store.list())).not.toContain('secretsecretsecret');
  });

  it('refreshes a fixture through an append-only supersession chain', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-record-refresh-'));
    const store = new FileRecordReplayStore(root);
    const input = { channel: 'llm' as const, operation: 'chat', request: { prompt: 'hello' } };
    await new RecordReplayController({ mode: 'record', store }).execute(input, async () => ({ answer: 'one' }));
    await new RecordReplayController({ mode: 'refresh', store }).execute(input, async () => ({ answer: 'two' }));
    const chain = verifyEntryChain(await store.list());
    expect(chain).toHaveLength(2);
    expect(chain[1]!.supersedesEntryIds).toEqual([chain[0]!.id]);
    expect(activeEntries(chain).map((entry) => entry.response)).toEqual([{ answer: 'two' }]);
  });

  it('fails explicitly when replay has no fixture', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-record-miss-'));
    const controller = new RecordReplayController({
      mode: 'replay',
      store: new FileRecordReplayStore(root),
      enabledChannels: ['subprocess'],
    });
    await expect(controller.execute({
      channel: 'subprocess',
      operation: 'test',
      request: { command: 'npm test' },
    }, async () => ({ exitCode: 0 }))).rejects.toMatchObject<RecordReplayError>({ code: 'replay_miss' });
  });

  it('accounts for replayed, recorded, and unmanaged interactions as delivery evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-record-replay-usage-'));
    const store = new FileRecordReplayStore(root);
    const record = new RecordReplayController({ mode: 'record', store, enabledChannels: ['http'] });
    await record.execute(
      { channel: 'http', operation: 'GET', request: { url: 'https://example.test/a' } },
      async () => ({ status: 200 }),
    );
    // `subprocess` is outside the enabled channels here, so it runs live and is reported as such.
    await record.execute(
      { channel: 'subprocess', operation: 'test', request: { command: 'npm test' } },
      async () => ({ exitCode: 0 }),
    );
    expect(record.evidence().usage.http).toEqual({ replayed: 0, recorded: 1, live: 0 });
    expect(record.evidence().usage.subprocess).toEqual({ replayed: 0, recorded: 0, live: 1 });
    // `subprocess` is not fixture-controlled here, so it must be reported as unmanaged rather than
    // silently counted as "nothing happened".
    expect(record.evidence().managedChannels).toEqual(['http']);

    const replay = new RecordReplayController({ mode: 'replay', store, enabledChannels: ['http'] });
    await replay.execute(
      { channel: 'http', operation: 'GET', request: { url: 'https://example.test/a' } },
      async () => ({ status: 500 }),
    );
    expect(replay.evidence().usage.http).toEqual({ replayed: 1, recorded: 0, live: 0 });
  });

  it('reports no managed channels when fixtures are off, so evidence cannot claim replay', async () => {
    // Callers skip execute() entirely when a channel is disabled, so counters stay zero for a run
    // that made real calls. Evidence must therefore key off managedChannels, not the counters.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-record-replay-off-'));
    const off = new RecordReplayController({ mode: 'off', store: new FileRecordReplayStore(root) });
    expect(off.enabled('llm')).toBe(false);
    expect(off.evidence()).toMatchObject({ mode: 'off', managedChannels: [] });
  });

  it('never replays sandbox preparation, dependency installation, or delivery checks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-record-replay-sandbox-'));
    const controller = new RecordReplayController({
      mode: 'replay',
      store: new FileRecordReplayStore(root),
      enabledChannels: ['subprocess'],
    });
    const calls: string[] = [];
    const result = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 1,
    };
    const delegate = {
      kind: 'subprocess',
      async build() { calls.push('build'); return { rebuilt: true, reason: 'live' }; },
      async exec() { calls.push('exec'); return result; },
      async runProgram() { calls.push('program'); return result; },
      async runTests() { calls.push('tests'); return result; },
      async installDeps() { calls.push('install'); return result; },
    } satisfies Sandbox;
    const sandbox = new RecordReplaySandbox(delegate, controller);

    await sandbox.build('package.json');
    await sandbox.exec('npm', ['run', 'build']);
    await sandbox.installDeps(['vitest']);
    await sandbox.runProgram(['npm', 'run', 'build']);
    await sandbox.runTests();

    expect(calls).toEqual(['build', 'exec', 'install', 'program', 'tests']);
    expect(await controller.evidence()).toMatchObject({
      usage: { subprocess: { replayed: 0, recorded: 0, live: 0 } },
    });
  });
});
