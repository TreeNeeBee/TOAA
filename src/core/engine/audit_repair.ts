import { pairedTestAssetPaths } from '../test_assets.js';
import {
  V_MODEL_TEST_PHASES,
  V_MODEL_TEST_TO_SOURCE_PHASE,
  type Plan,
  type Step,
} from '../plan.js';
import type { ProjectAuditResult } from '../project_audit.js';
import { stepTransitivelyDependsOn } from '../workflow_state.js';
import {
  extractFailedTestPaths,
  normalizeGitPath,
} from './v_model_policy.js';

export function selectAuditRepairStep(
  plan: Plan,
  order: Step[],
  auditResult: ProjectAuditResult,
  isComplete: (step: Step) => boolean,
  iterationId?: string,
): Step | undefined {
  const failedNames = new Set(
    auditResult.checks
      .filter((check) => !check.ok && check.severity === 'error')
      .map((check) => check.name),
  );
  const scopedOrder = iterationId
    ? order.filter((step) => (step.iterationId ?? 'P1') === iterationId)
    : order;
  const done = scopedOrder.filter(isComplete);
  const latest = (phases: Step['phase'][]): Step | undefined =>
    [...done].reverse().find((step) => phases.includes(step.phase));

  if (failedNames.has('entrypoint')) {
    return latest(['CODE', 'DETAILED_DESIGN', 'HIGH_LEVEL_DESIGN', 'REQUIREMENT_ANALYSIS']);
  }
  if ([...failedNames].some((name) =>
    name.startsWith('doc:') ||
    name.endsWith('-doc') ||
    name === 'readme' ||
    name === 'quickstart' ||
    name === 'api-guide'
  )) {
    return latest(['FUNCTIONAL_TEST', 'REQUIREMENT_ANALYSIS']);
  }
  if (failedNames.has('tests') || failedNames.has('test-files')) {
    const failureText = auditResult.checks
      .filter((check) =>
        !check.ok &&
        (check.name === 'tests' || check.name === 'test-files')
      )
      .map((check) => `${check.summary}\n${check.detail ?? ''}`)
      .join('\n');
    const failedPaths = extractFailedTestPaths(failureText);
    const testSteps = scopedOrder.filter((step) => isVModelTestPhase(step.phase));
    const stepById = new Map(order.map((step) => [step.id, step] as const));
    for (const failedPath of failedPaths) {
      const ownerTest = testSteps.find((candidate) =>
        pairedTestAssetPaths(plan.steps, candidate, plan.language)
          .map(normalizeGitPath)
          .includes(failedPath));
      if (!ownerTest) continue;
      const sourcePhase =
        V_MODEL_TEST_TO_SOURCE_PHASE[ownerTest.phase as keyof typeof V_MODEL_TEST_TO_SOURCE_PHASE];
      const sourceCandidates = done.filter((candidate) => candidate.phase === sourcePhase);
      const source = [...sourceCandidates].reverse().find((candidate) =>
        stepTransitivelyDependsOn(ownerTest, candidate.id, stepById)
      ) ?? sourceCandidates.at(-1);
      if (source) return source;
    }
    return latest(['CODE', 'DETAILED_DESIGN', 'HIGH_LEVEL_DESIGN', 'REQUIREMENT_ANALYSIS']);
  }
  if (failedNames.has('build') || failedNames.has('lint') || failedNames.has('package-json')) {
    return latest(['CODE', 'HIGH_LEVEL_DESIGN']);
  }
  return latest(['CODE', 'DETAILED_DESIGN', 'HIGH_LEVEL_DESIGN', 'REQUIREMENT_ANALYSIS']) ??
    (iterationId ? selectAuditRepairStep(plan, order, auditResult, isComplete) : undefined);
}

export function auditRepairContextPaths(input: {
  plan: Plan;
  step: Step;
  auditResult: ProjectAuditResult;
  writable: string[];
  manifestFile: string;
}): string[] {
  const failedNames = new Set(
    input.auditResult.checks
      .filter((check) => !check.ok)
      .map((check) => check.name),
  );
  const codeAndTests = input.writable.filter((rel) =>
    rel.startsWith('src/') ||
    rel.startsWith('tests/') ||
    rel === input.manifestFile ||
    rel === 'package.json',
  );
  const iterationId = input.step.iterationId ?? 'P1';
  const iterationPrefix = iterationId === 'P1' ? undefined : `docs/iterations/${iterationId}`;
  const docs = [
    'docs/topic.md',
    'docs/01-requirement-analysis.md',
    'docs/02-high-level-design.md',
    'docs/03-detailed-design.md',
    'docs/tests/functional-test-plan.md',
    'docs/tests/integration-test-plan.md',
    'docs/tests/module-test-plan.md',
    'docs/tests/unit-test-plan.md',
    ...(iterationPrefix
      ? [
          `${iterationPrefix}/01-requirement-analysis.md`,
          `${iterationPrefix}/02-high-level-design.md`,
          `${iterationPrefix}/03-detailed-design.md`,
          `${iterationPrefix}/05-unit-test.md`,
          `${iterationPrefix}/06-integration-test.md`,
          `${iterationPrefix}/07-module-test.md`,
          `${iterationPrefix}/08-functional-test.md`,
          `${iterationPrefix}/quickstart.md`,
          `${iterationPrefix}/api-guide.md`,
        ]
      : []),
  ];
  if (
    failedNames.has('entrypoint') ||
    failedNames.has('tests') ||
    failedNames.has('test-files')
  ) {
    return dedup([...codeAndTests, ...docs]);
  }
  return dedup([...codeAndTests, ...input.step.inputs, ...docs]);
}

function isVModelTestPhase(
  phase: Step['phase'],
): phase is (typeof V_MODEL_TEST_PHASES)[number] {
  return (V_MODEL_TEST_PHASES as readonly string[]).includes(phase);
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}
