import { describe, expect, it, vi } from 'vitest';
import { runMergeGateChecks } from '../src/application/workspace/merge_gate_checks.js';
import type { Sandbox } from '../src/sandbox/types.js';

function sandbox(): Sandbox {
  return {
    kind: 'subprocess',
    build: vi.fn(async () => ({ rebuilt: false, reason: 'ready' })),
    exec: vi.fn(),
    runProgram: vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 1,
    })),
    runTests: vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 1,
    })),
    installDeps: vi.fn(),
  } as Sandbox;
}

describe('merge gate checks', () => {
  it('uses dependency and static checks for a Ticket merge without running later V-model tests', async () => {
    const target = sandbox();
    const checks = await runMergeGateChecks(target, 'typescript', undefined, 'ticket');

    expect(checks.map((check) => check.name)).toEqual(['dependencies', 'typecheck']);
    expect(target.runProgram).toHaveBeenCalledWith(['tsc', '--noEmit']);
    expect(target.runTests).not.toHaveBeenCalled();
  });

  it('keeps the full project test gate for phase integration', async () => {
    const target = sandbox();
    const checks = await runMergeGateChecks(target, 'typescript', undefined, 'phase');

    expect(checks.map((check) => check.name)).toEqual(['dependencies', 'tests']);
    expect(target.runTests).toHaveBeenCalledOnce();
    expect(target.runProgram).not.toHaveBeenCalled();
  });
});
