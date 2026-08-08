import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuditLogger } from '../src/audit/audit.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
});

describe('AuditLogger jsonl flush', () => {
  it('flushes each event synchronously to disk before the await resolves', async () => {
    const audit = new AuditLogger({ root: tmp, command: 'xcompiler_test' });
    await audit.start({ workspace: tmp });
    const jsonlPath = path.join(tmp, 'audit.jsonl');
    // 多次 await：每次 await 返回后，对应的 jsonl 行必须已在磁盘上（appendFileSync 同步写入）。
    await audit.event('phase.start', 'S007 TEST 测试', { role: 'Tester' });
    let lines = readFileSync(jsonlPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((e) => e.kind === 'phase.start' && e.message === 'S007 TEST 测试')).toBe(true);

    await audit.event('phase.end', 'S007 FAILED', { reason: 'pytest exit=1' });
    lines = readFileSync(jsonlPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const phaseEnd = lines.find((e) => e.kind === 'phase.end');
    expect(phaseEnd?.data.reason).toBe('pytest exit=1');
  });

  it('serialises a burst of 50 awaited events in order', async () => {
    const audit = new AuditLogger({ root: tmp, command: 'xcompiler_test' });
    await audit.start();
    for (let i = 0; i < 50; i++) {
      await audit.event('tool.call', `op-${i}`, { i });
    }
    const lines = readFileSync(path.join(tmp, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === 'tool.call');
    expect(lines).toHaveLength(50);
    expect(lines.map((e) => e.data.i)).toEqual([...Array(50).keys()]);
  });

  it('promotes the i18n message ID to the audit event envelope', async () => {
    const audit = new AuditLogger({ root: tmp, command: 'xcompiler_test' });
    await audit.start();
    await audit.event('note', 'localized message', {
      messageId: 'test.localized_message',
      detail: 1,
    });
    const lines = readFileSync(path.join(tmp, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const event = lines.find((e) => e.kind === 'note');
    expect(event?.messageId).toBe('test.localized_message');
    expect(event?.data.detail).toBe(1);
  });

  it('redacts credentials by default and supports metadata-only content capture', async () => {
    const redacted = new AuditLogger({ root: tmp, command: 'xcompiler_test' });
    await redacted.start();
    await redacted.userInput('requirement', 'api_key=super-secret-value');
    const redactedLog = readFileSync(path.join(tmp, 'audit.jsonl'), 'utf8');
    expect(redactedLog).not.toContain('super-secret-value');
    expect(redactedLog).toContain('[REDACTED]');

    const metadataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-metadata-'));
    const metadata = new AuditLogger({ root: metadataRoot, command: 'xcompiler_test', contentMode: 'metadata' });
    await metadata.start();
    await metadata.llmResponse('Coder', 'model', 'private response');
    const metadataLog = readFileSync(path.join(metadataRoot, 'audit.jsonl'), 'utf8');
    expect(metadataLog).not.toContain('private response');
    expect(metadataLog).toContain('sha256');
  });
});
