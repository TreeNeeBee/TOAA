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
});
