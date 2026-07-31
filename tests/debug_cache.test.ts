import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DebugCache,
  sanitizeDebugFailureLogForPrompt,
  stripNestedLatestDebuggerFailures,
} from '../src/core/debug_cache.js';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-dbgcache-'));
}

describe('DebugCache', () => {
  it('round-trips attempts to disk and survives reload', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.xcompiler', 'debug_cache.json');
    const c1 = new DebugCache(file);
    await c1.load();
    expect(c1.attempts('S005')).toEqual([]);
    expect(c1.hasUnresolvedFailure('S005')).toBe(false);

    await c1.recordAttempt('S005', {
      attempt: 1,
      reason: 'pytest exit=1',
      failureLogTail: 'AssertionError: expected 2 got 1',
      suggestions: ['[D001] inspect tests/test_x.py'],
      metrics: { healthScore: 0.4, parseFailures: 0, repeatedTurns: 1, progressRatio: 0.5, rounds: 6 },
    });
    await c1.markFailed('S005', 'pytest exit=1');

    const c2 = new DebugCache(file);
    await c2.load();
    expect(c2.hasUnresolvedFailure('S005')).toBe(true);
    expect(c2.attempts('S005')).toHaveLength(1);
    const prompt = c2.renderPriorAttemptsForPrompt('S005');
    expect(prompt).toContain('attempt #1');
    expect(prompt).toContain('pytest exit=1');
    expect(prompt).toContain('prior suggestions: omitted (1)');
    expect(prompt).not.toContain('[D001] inspect tests/test_x.py');
  });

  it('marks a RUNNING attempt unresolved only when runtime confirms interruption', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.xcompiler', 'debug_cache.json');
    const c1 = new DebugCache(file);
    await c1.load();
    await c1.recordAttempt('S006', {
      attempt: 2,
      reason: 'integration tests still fail',
      failureLogTail: 'FAIL tests/integration/web-server-flow.test.ts',
      contextMode: 'test-rollback',
      bugTicketId: 'BUG-P1-004',
      completedBeforeDebug: true,
      contextPaths: ['src/pipeline.ts', 'tests/integration/web-server-flow.test.ts'],
      extraAllowedWrites: ['src/pipeline.ts', 'src/pipeline.ts'],
      testScopeArgs: ['tests/integration/web-server-flow.test.ts'],
    });

    const c2 = new DebugCache(file);
    await c2.load();
    expect(c2.hasUnresolvedFailure('S006')).toBe(false);
    expect(c2.hasRunningAttempt('S006')).toBe(true);
    expect(await c2.markInterrupted('S006', 'process interrupted')).toBe(true);
    expect(c2.hasRunningAttempt('S006')).toBe(false);
    expect(c2.hasUnresolvedFailure('S006')).toBe(true);
    expect(c2.attempts('S006')[0]?.contextMode).toBe('test-rollback');
    expect(c2.attempts('S006')[0]).toMatchObject({
      bugTicketId: 'BUG-P1-004',
      completedBeforeDebug: true,
      contextPaths: ['src/pipeline.ts', 'tests/integration/web-server-flow.test.ts'],
      extraAllowedWrites: ['src/pipeline.ts'],
      testScopeArgs: ['tests/integration/web-server-flow.test.ts'],
    });
  });

  it('truncates long failure logs and caps stored attempts', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.xcompiler', 'debug_cache.json');
    const c = new DebugCache(file, { maxAttemptsPerStep: 3, maxFailureLogLines: 5 });
    await c.load();
    const longLog = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    for (let i = 1; i <= 7; i++) {
      await c.recordAttempt('S001', { attempt: i, reason: `r${i}`, failureLogTail: longLog });
    }
    const list = c.attempts('S001');
    expect(list).toHaveLength(3);
    expect(list[0]?.attempt).toBe(5); // FIFO drop kept last 3
    expect(list[2]?.failureLogTail.split('\n')).toHaveLength(5);
  });

  it('sanitizes nested prior attempts and suggestions from cached failure logs', async () => {
    const dirty = [
      'pytest exit=1',
      '## 历史 DEBUG 尝试（来自上一次/本次 xcompiler run，请勿重复同样的修复思路）',
      '- attempt #0',
      '    suggestions: [ModuleNotFoundError] stale dependency advice',
      '请基于以上历史，提出新的诊断假设。',
      '原因：current failure',
      '## 修复建议（按优先级，必须遵循）',
      '1. stale suggestion',
      '工具调用：',
      '  - run_tests 失败 pytest exit=1',
      'E AttributeError: current error',
    ].join('\n');
    const cleaned = sanitizeDebugFailureLogForPrompt(dirty);
    expect(cleaned).toContain('pytest exit=1');
    expect(cleaned).toContain('原因：current failure');
    expect(cleaned).toContain('E AttributeError: current error');
    expect(cleaned).not.toContain('stale dependency advice');
    expect(cleaned).not.toContain('stale suggestion');
  });

  it('renders prior attempts with noisy provider and read-only failures summarized', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.xcompiler', 'debug_cache.json');
    const c = new DebugCache(file);
    await c.load();

    await c.recordAttempt('S004', {
      attempt: 1,
      reason: 'OpenAI HTTP 429: free-models-per-day',
      failureLogTail: 'rate limited',
    });
    await c.recordAttempt('S004', {
      attempt: 2,
      reason: 'repeated read-only/probe actions without progress for 3 rounds',
      failureLogTail: 'read only',
      metrics: { healthScore: 0.4, parseFailures: 0, repeatedTurns: 3, progressRatio: 1, rounds: 3 },
    });
    await c.recordAttempt('S004', {
      attempt: 3,
      reason: 'pytest exit=1: AttributeError sig.start_bit',
      failureLogTail: 'real failure',
      metrics: { healthScore: 0.7, parseFailures: 0, repeatedTurns: 0, progressRatio: 1, rounds: 2 },
    });

    const prompt = c.renderPriorAttemptsForPrompt('S004');

    expect(prompt).toContain('omitted 2 noisy provider/read-only/recovery attempt');
    expect(prompt).toContain('attempt #3');
    expect(prompt).toContain('AttributeError sig.start_bit');
    expect(prompt).not.toContain('free-models-per-day');
    expect(prompt).not.toContain('repeated read-only/probe actions');
  });

  it('does not replay noisy attempts when no actionable debug history exists', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.xcompiler', 'debug_cache.json');
    const c = new DebugCache(file);
    await c.load();

    await c.recordAttempt('S004', {
      attempt: 1,
      reason: 'OpenAI HTTP 429: free-models-per-day',
      failureLogTail: 'provider quota exhausted',
    });
    await c.recordAttempt('S004', {
      attempt: 2,
      reason: 'low-quality Debugger response: read-only/probe actions in read-only recovery mode',
      failureLogTail: 'read_file src/x.py',
    });
    await c.recordAttempt('S004', {
      attempt: 3,
      reason: 'UNIT_TEST had an unresolved failure from a previous run; rolling back to the paired V-model source phase instead of resuming same-phase Debugger.',
      failureLogTail: 'pytest failure is carried in the current root log',
    });

    const prompt = c.renderPriorAttemptsForPrompt('S004');

    expect(prompt).toContain('omitted 3 noisy provider/read-only/recovery attempt');
    expect(prompt).toContain('no actionable prior Debugger attempt remains');
    expect(prompt).not.toContain('free-models-per-day');
    expect(prompt).not.toContain('low-quality Debugger response');
    expect(prompt).not.toContain('unresolved failure from a previous run');
  });

  it('strips nested latest Debugger sections before composing new retry logs', () => {
    const raw = [
      'pytest exit=1',
      'FAILED tests/test_unit.py::test_hi',
      '## latest Debugger attempt failure',
      'reason: old read-only loop',
      'old noisy details',
    ].join('\n');

    const cleaned = stripNestedLatestDebuggerFailures(raw);

    expect(cleaned).toContain('pytest exit=1');
    expect(cleaned).toContain('FAILED tests/test_unit.py::test_hi');
    expect(cleaned).not.toContain('old read-only loop');
  });

  it('strips paired source failure sections before composing retry logs', () => {
    const raw = [
      'pytest exit=1',
      'FAILED tests/test_unit.py::test_hi',
      '## paired source phase latest failure (S004)',
      'metrics and noisy old retry detail',
    ].join('\n');

    const cleaned = stripNestedLatestDebuggerFailures(raw);

    expect(cleaned).toContain('pytest exit=1');
    expect(cleaned).toContain('FAILED tests/test_unit.py::test_hi');
    expect(cleaned).not.toContain('paired source phase');
    expect(cleaned).not.toContain('noisy old retry detail');
  });

  it('strips nested debugger sections before storing attempt logs', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.xcompiler', 'debug_cache.json');
    const c = new DebugCache(file);
    await c.load();

    await c.recordAttempt('S004', {
      attempt: 1,
      reason: 'pytest exit=1',
      failureLogTail: [
        'pytest exit=1',
        'FAILED tests/test_unit.py::test_hi',
        '## latest Debugger attempt failure',
        'reason: stale read-only loop',
        'old noisy detail',
      ].join('\n'),
    });

    const stored = c.attempts('S004')[0]?.failureLogTail ?? '';

    expect(stored).toContain('pytest exit=1');
    expect(stored).toContain('FAILED tests/test_unit.py::test_hi');
    expect(stored).not.toContain('stale read-only loop');
    expect(stored).not.toContain('old noisy detail');
  });

  it('markDone clears the step entry so next run starts fresh', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.xcompiler', 'debug_cache.json');
    const c = new DebugCache(file);
    await c.load();
    await c.recordAttempt('S002', { attempt: 1, reason: 'x', failureLogTail: 'log' });
    expect(c.attempts('S002')).toHaveLength(1);
    await c.markDone('S002');
    expect(c.attempts('S002')).toEqual([]);
    expect(c.hasUnresolvedFailure('S002')).toBe(false);

    const c2 = new DebugCache(file);
    await c2.load();
    expect(c2.attempts('S002')).toEqual([]);
  });

  it('clearAll removes all unresolved failure history for reset runs', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.xcompiler', 'debug_cache.json');
    const c = new DebugCache(file);
    await c.load();
    await c.recordAttempt('S004', { attempt: 0, reason: 'coder failed', failureLogTail: 'log 1' });
    await c.markFailed('S004', 'coder failed');
    await c.recordAttempt('S005', { attempt: 0, reason: 'tester failed', failureLogTail: 'log 2' });
    await c.markFailed('S005', 'tester failed');

    await c.clearAll();

    expect(c.hasUnresolvedFailure('S004')).toBe(false);
    expect(c.hasUnresolvedFailure('S005')).toBe(false);
    const c2 = new DebugCache(file);
    await c2.load();
    expect(c2.attempts('S004')).toEqual([]);
    expect(c2.attempts('S005')).toEqual([]);
  });
});
