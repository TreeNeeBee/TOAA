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

/**
 * Paths reserved for risk tests created by a verification Step at runtime.
 *
 * A Planner must never assign these paths to a left-side baseline owner or list them as a
 * right-side planned input/output. Runtime derives the canonical `tests/verification/...` root
 * from the executing Step. Common `supplement*` spellings are reserved as well so an LLM cannot
 * accidentally turn a verification-owned test into an upstream baseline merely by choosing a
 * different directory name.
 */
export function isRuntimeOwnedVerificationTestPath(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  if (!normalized.startsWith('tests/')) return false;
  if (normalized.startsWith('tests/verification/')) return true;
  return /(?:^|\/)(?:supplement|supplements|supplemental)(?:\/|[._-])/u.test(
    normalized.slice('tests/'.length),
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

/** Executable baseline tests authored and owned by a left-side V-model Step. */
export function developmentBaselineTestAssetPaths(
  sourceStep: Step,
  language: Language,
): string[] {
  return [...new Set(
    sourceStep.outputs
      .map(normalizePath)
      .filter((path) => isExecutableTestPath(path, language)),
  )];
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

/**
 * Verification-owned test namespace.
 *
 * Keeping supplements outside the paired source suite makes ownership and defect routing
 * unambiguous: a defect here returns to the verification Step; a baseline/product defect returns
 * to the paired source Step.
 */
export function verificationSupplementRoot(step: Pick<Step, 'id' | 'iterationId' | 'phase'>): string {
  const iteration = (step.iterationId ?? 'P1').toLowerCase().replace(/[^a-z0-9_-]+/gu, '-');
  const phase = step.phase.toLowerCase().replaceAll('_', '-');
  const id = step.id.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-');
  return `tests/verification/${iteration}/${phase}/${id}/`;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/u, '');
}
