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
    const jsonlPath = path.join(tmp, 'audit', 'audit.jsonl');
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
    const lines = readFileSync(path.join(tmp, 'audit', 'audit.jsonl'), 'utf8')
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
    const lines = readFileSync(path.join(tmp, 'audit', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const event = lines.find((e) => e.kind === 'note');
    expect(event?.messageId).toBe('test.localized_message');
    expect(event?.data.detail).toBe(1);
  });

  it('preserves full records while redacting credentials and builds a linked summary', async () => {
    const redacted = new AuditLogger({ root: tmp, command: 'xcompiler_test' });
    await redacted.start();
    await redacted.userInput('requirement', 'api_key=super-secret-value');
    await redacted.llmResponse('Coder', 'model', 'private response body');
    await redacted.end({ status: 'ok' });
    const redactedLog = readFileSync(path.join(tmp, 'audit', 'audit.jsonl'), 'utf8');
    expect(redactedLog).not.toContain('super-secret-value');
    expect(redactedLog).toContain('[REDACTED]');
    expect(redactedLog).toContain('private response body');
    const processLog = readFileSync(path.join(tmp, 'audit', 'process_log.md'), 'utf8');
    expect(processLog).toContain('private response body');
    const summary = readFileSync(path.join(tmp, 'audit', 'summary.md'), 'utf8');
    expect(summary).toContain('[audit.jsonl](./audit.jsonl)');
    expect(summary).toMatch(/\[raw L\d+-L\d+\]\(\.\/audit\.jsonl#L\d+\)/u);
  });

  it('links summary records to the current immutable object revision when registered', async () => {
    const ticketId = '019fd0e5-5210-7e03-9b5e-4876a0541efd';
    await fs.mkdir(path.join(tmp, 'registry'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'registry', 'index.json'), JSON.stringify({
      entries: [{ ticketId, id: ticketId, objectRef: `objects/ticket/${ticketId}/r7.json` }],
    }));
    const audit = new AuditLogger({ root: tmp, command: 'xcompiler_test' });
    await audit.start();
    await audit.event('ticket.bug.created', 'created a defect ticket', { ticketId });
    await audit.end({ status: 'pending' });

    const summary = readFileSync(path.join(tmp, 'audit', 'summary.md'), 'utf8');
    expect(summary).toContain(
      `[ticketId](../objects/ticket/${ticketId}/r7.json)`,
    );
  });

  it('retains complete event payloads in both raw logs and supports controlled full mode', async () => {
    const audit = new AuditLogger({ root: tmp, command: 'xcompiler_test', contentMode: 'full' });
    await audit.start();
    await audit.event('note', 'diagnostic evidence', {
      error: 'complete stack and body',
      token: 'intentionally-visible-in-full-mode',
    });

    const jsonl = readFileSync(path.join(tmp, 'audit', 'audit.jsonl'), 'utf8');
    const markdown = readFileSync(path.join(tmp, 'audit', 'process_log.md'), 'utf8');
    expect(jsonl).toContain('complete stack and body');
    expect(jsonl).toContain('intentionally-visible-in-full-mode');
    expect(markdown).toContain('complete stack and body');
    expect(markdown).toContain('intentionally-visible-in-full-mode');
  });

  it('redacts credentials in generic event messages without dropping diagnostic text', async () => {
    const audit = new AuditLogger({ root: tmp, command: 'xcompiler_test' });
    await audit.start();
    await audit.event('llm.error', 'request failed: api_key=do-not-store status=401', {
      error: 'authorization=do-not-store either; upstream denied the request',
    });

    const jsonl = readFileSync(path.join(tmp, 'audit', 'audit.jsonl'), 'utf8');
    const markdown = readFileSync(path.join(tmp, 'audit', 'process_log.md'), 'utf8');
    expect(jsonl).not.toContain('do-not-store');
    expect(markdown).not.toContain('do-not-store');
    expect(jsonl).toContain('status=401');
    expect(jsonl).toContain('upstream denied the request');
  });
});
