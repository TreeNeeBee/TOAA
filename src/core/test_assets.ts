import {
  V_MODEL_TEST_TO_SOURCE_PHASE,
  type Language,
  type Step,
  type VModelTestPhase,
} from './plan.js';
import { getLanguageProfile } from './language.js';

export function isExecutableTestPath(path: string, language: Language): boolean {
  const normalized = normalizePath(path);
  const profile = getLanguageProfile(language);
  return (
    normalized.startsWith('tests/') &&
    !normalized.endsWith('/') &&
    profile.codeExtensions.some((extension) => normalized.endsWith(extension))
  );
}

export function pairedSourceSteps(steps: Step[], testStep: Step): Step[] {
  const sourcePhase =
    V_MODEL_TEST_TO_SOURCE_PHASE[testStep.phase as VModelTestPhase];
  if (!sourcePhase) return [];
  const iterationId = testStep.iterationId ?? 'P1';
  return steps.filter(
    (step) =>
      (step.iterationId ?? 'P1') === iterationId &&
      step.phase === sourcePhase,
  );
}

/**
 * Resolve the executable tests consumed by a right-side V-model phase.
 *
 * Source outputs and explicit test-step inputs are canonical. Right-side
 * outputs are deliberately excluded because validation phases cannot own tests.
 */
export function pairedTestAssetPaths(
  steps: Step[],
  testStep: Step,
  language: Language,
): string[] {
  const paths = [
    ...pairedSourceSteps(steps, testStep).flatMap((step) => step.outputs),
    ...testStep.inputs,
  ];
  return [...new Set(
    paths
      .map(normalizePath)
      .filter((path) => isExecutableTestPath(path, language)),
  )];
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/u, '');
}
