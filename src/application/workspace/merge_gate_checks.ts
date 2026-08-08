import type { Language } from '../../core/plan.js';
import type { Sandbox } from '../../sandbox/types.js';
import type { GateCheckResult } from '../../domain/workspace/merge_request.js';
import { classifyFailure } from '../execution/failure_classification.js';
import type { RecordReplayController } from '../record_replay/controller.js';

/**
 * Runs the generated project's own build and tests against a merge candidate.
 *
 * These are the project's gates, not XCompiler's: what has to hold before a change lands is that
 * the project still builds and its tests still pass once merged with the mainline.
 *
 * Verification never records fixtures, so the whole run is forced into replay when fixtures are
 * under control — a gate that quietly reached a live service would be judging a different world
 * from the one the tests describe.
 */
export async function runMergeGateChecks(
  sandbox: Sandbox,
  language: Language,
  recordReplay?: RecordReplayController,
): Promise<GateCheckResult[]> {
  const execute = async (): Promise<GateCheckResult[]> => {
    const checks: GateCheckResult[] = [];
    const manifest = language === 'python' ? 'requirements.txt' : 'package.json';

    const build = await attempt('dependencies', () => sandbox.build(manifest));
    checks.push(build);
    // Without dependencies the test result would say nothing about the change, so reporting it
    // would be worse than reporting only that the environment could not be prepared.
    if (!build.ok) return checks;

    checks.push(await attempt('tests', () => sandbox.runTests()));
    return checks;
  };
  return recordReplay && recordReplay.mode !== 'off'
    ? recordReplay.runWithMode('replay', execute)
    : execute();
}

async function attempt(
  name: string,
  action: () => Promise<{ code?: number; stdout?: string; stderr?: string } | unknown>,
): Promise<GateCheckResult> {
  try {
    const result = await action() as { code?: number; stdout?: string; stderr?: string };
    const code = typeof result?.code === 'number' ? result.code : 0;
    return {
      name,
      ok: code === 0,
      summary: code === 0
        ? `${name} passed`
        : truncate(`${name} exited ${code}\n${result?.stderr ?? result?.stdout ?? ''}`),
      kind: 'execution',
    };
  } catch (error) {
    // An unreachable sandbox or provider is not evidence that the change is wrong, so it is
    // reported as infrastructure and blocks the merge instead of opening a defect.
    const classified = classifyFailure(error);
    return {
      name,
      ok: false,
      summary: truncate(`${name} could not run: ${classified.message}`),
      kind: classified.kind === 'infrastructure' ? 'infrastructure' : 'execution',
    };
  }
}

function truncate(text: string, limit = 2000): string {
  const trimmed = text.trim() || 'no output';
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n... truncated`;
}
