import {
  V_MODEL_DEVELOPMENT_PHASES,
  V_MODEL_SOURCE_TO_TEST_PHASE,
  V_MODEL_TEST_PHASES,
  type Phase,
  type StageQualityGate,
  type Step,
} from './plan.js';


export interface StageQualityAssessment {
  completion?: number;
  upstreamAlignment?: number;
  metrics: Record<string, number>;
  tolerance: {
    failedTests: number;
    skippedTests: number;
    warnings: number;
  };
  evidence: string[];
  gaps: string[];
}

export interface QualityGateEvaluation {
  passed: boolean;
  enhancementFailures: string[];
  bugFailures: string[];
}


export function defaultQualityGateForPhase(phase: Phase): StageQualityGate {
  const sourceBase = {
    completionMin: 0.95,
    upstreamAlignmentMin: phase === 'REQUIREMENT_ANALYSIS' ? 0.95 : 0.9,
    metrics: {},
    tolerance: {
      metricShortfall: 0.02,
      maxFailedTests: 0,
      maxSkippedTests: 0,
      maxWarnings: 0,
    },
  };
  switch (phase) {
    case 'REQUIREMENT_ANALYSIS':
    case 'HIGH_LEVEL_DESIGN':
    case 'DETAILED_DESIGN':
    case 'CODE':
      return sourceBase;
    case 'UNIT_TEST':
      return testGate({
        lineCoverage: 0.8,
        branchCoverage: 0.7,
        testCasePassRate: 1,
      });
    case 'INTEGRATION_TEST':
      return testGate({
        interfaceCoverage: 0.85,
        integrationScenarioCoverage: 0.85,
        testCasePassRate: 1,
      });
    case 'MODULE_TEST':
      return testGate({
        moduleCoverage: 0.9,
        contractCoverage: 0.9,
        testCasePassRate: 1,
      });
    case 'FUNCTIONAL_TEST':
      return testGate({
        functionalCoverage: 0.95,
        requirementCoverage: 0.95,
        endToEndPassRate: 1,
      });
  }
}

export function resolveQualityGate(step: Step): StageQualityGate {
  return step.qualityGate ?? defaultQualityGateForPhase(step.phase);
}

export function withDefaultQualityGate(step: Step): Step {
  return {
    ...step,
    qualityGate: resolveQualityGate(step),
  };
}

export function normalizeQualityAssessment(value: unknown): StageQualityAssessment | undefined {
  if (!isRecord(value)) return undefined;
  const metrics = normalizeRatioRecord(value.metrics);
  const toleranceValue = isRecord(value.tolerance) ? value.tolerance : {};
  const assessment: StageQualityAssessment = {
    completion: normalizeRatio(value.completion),
    upstreamAlignment: normalizeRatio(value.upstreamAlignment),
    metrics,
    tolerance: {
      failedTests: normalizeCount(toleranceValue.failedTests),
      skippedTests: normalizeCount(toleranceValue.skippedTests),
      warnings: normalizeCount(toleranceValue.warnings),
    },
    evidence: normalizeStrings(value.evidence),
    gaps: normalizeStrings(value.gaps),
  };
  return assessment;
}

export function emptyQualityAssessment(): StageQualityAssessment {
  return {
    metrics: {},
    tolerance: {
      failedTests: 0,
      skippedTests: 0,
      warnings: 0,
    },
    evidence: [],
    gaps: [],
  };
}

/**
 * Reconcile a development-stage LLM assessment with output verification
 * performed after its tool actions. Stale "missing required output" gaps and
 * explicitly deferred paired-test execution are removed; semantic, alignment,
 * coverage, and tolerance findings remain.
 */
export function reconcileDevelopmentQualityAssessment(
  step: Step,
  assessment: StageQualityAssessment | undefined,
  missingOutputs: readonly string[],
): StageQualityAssessment | undefined {
  if (
    !assessment ||
    !(V_MODEL_DEVELOPMENT_PHASES as readonly string[]).includes(step.phase)
  ) {
    return assessment;
  }
  const missing = new Set(missingOutputs);
  const verifiedOutputs = step.outputs.filter(
    (output) => !output.endsWith('/') && !missing.has(output),
  );
  const staleOutputGaps = assessment.gaps.filter((gap) =>
    isVerifiedMissingOutputGap(gap, step.outputs, missing),
  );
  const deferredVerificationGaps = assessment.gaps.filter((gap) =>
    isDeferredPairedTestExecutionGap(step, gap),
  );
  const downstreamMetricGaps = assessment.gaps.filter(isDownstreamVerificationMetricGap);
  const reconciledGaps = new Set([
    ...staleOutputGaps,
    ...deferredVerificationGaps,
    ...downstreamMetricGaps,
  ]);
  const gaps = assessment.gaps.filter((gap) => !reconciledGaps.has(gap));
  const evidence = dedup([...assessment.evidence, ...verifiedOutputs]);
  const completion =
    missing.size === 0 &&
    reconciledGaps.size > 0 &&
    gaps.length === 0
      ? 1
      : assessment.completion;
  if (
    reconciledGaps.size === 0 &&
    evidence.length === assessment.evidence.length &&
    completion === assessment.completion
  ) {
    return assessment;
  }
  return {
    ...assessment,
    completion,
    evidence,
    gaps,
  };
}

function isDownstreamVerificationMetricGap(gap: string): boolean {
  const normalized = gap.toLowerCase().replaceAll(/[^a-z0-9]+/g, '');
  return [
    'lineCoverage',
    'branchCoverage',
    'testCasePassRate',
    'interfaceCoverage',
    'integrationScenarioCoverage',
    'moduleCoverage',
    'contractCoverage',
    'functionalCoverage',
    'requirementCoverage',
    'endToEndPassRate',
  ].some((metric) => normalized.includes(metric.toLowerCase()));
}

export function evaluateQualityGate(
  step: Step,
  assessment: StageQualityAssessment | undefined,
): QualityGateEvaluation {
  const policy = resolveQualityGate(step);
  const enhancementFailures: string[] = [];
  const bugFailures: string[] = [];
  if (!assessment) {
    enhancementFailures.push(`${step.phase} did not provide a qualityAssessment`);
    return { passed: false, enhancementFailures, bugFailures };
  }

  const tolerance = policy.tolerance.metricShortfall;
  if ((V_MODEL_DEVELOPMENT_PHASES as readonly string[]).includes(step.phase)) {
    compareRatio(
      'completion',
      assessment.completion,
      policy.completionMin,
      tolerance,
      enhancementFailures,
    );
    compareRatio(
      'upstreamAlignment',
      assessment.upstreamAlignment,
      policy.upstreamAlignmentMin,
      tolerance,
      enhancementFailures,
    );
  }
  if ((V_MODEL_TEST_PHASES as readonly string[]).includes(step.phase)) {
    for (const [metric, threshold] of Object.entries(policy.metrics)) {
      compareRatio(
        metric,
        assessment.metrics[metric],
        threshold,
        tolerance,
        enhancementFailures,
      );
    }
  }

  if (assessment.tolerance.failedTests > policy.tolerance.maxFailedTests) {
    bugFailures.push(
      `failedTests=${assessment.tolerance.failedTests} exceeds tolerance ${policy.tolerance.maxFailedTests}`,
    );
  }
  if (assessment.tolerance.skippedTests > policy.tolerance.maxSkippedTests) {
    enhancementFailures.push(
      `skippedTests=${assessment.tolerance.skippedTests} exceeds tolerance ${policy.tolerance.maxSkippedTests}`,
    );
  }
  if (assessment.tolerance.warnings > policy.tolerance.maxWarnings) {
    enhancementFailures.push(
      `warnings=${assessment.tolerance.warnings} exceeds tolerance ${policy.tolerance.maxWarnings}`,
    );
  }
  if (assessment.evidence.length === 0) {
    enhancementFailures.push('qualityAssessment evidence is empty');
  }
  enhancementFailures.push(...assessment.gaps.map((gap) => `declared gap: ${gap}`));
  return {
    passed: enhancementFailures.length === 0 && bugFailures.length === 0,
    enhancementFailures,
    bugFailures,
  };
}

function isDeferredPairedTestExecutionGap(step: Step, gap: string): boolean {
  if (
    !(V_MODEL_DEVELOPMENT_PHASES as readonly string[]).includes(step.phase) ||
    step.tools.includes('run_tests')
  ) {
    return false;
  }
  const pairedPhase = V_MODEL_SOURCE_TO_TEST_PHASE[
    step.phase as keyof typeof V_MODEL_SOURCE_TO_TEST_PHASE
  ];
  const normalized = gap.toLowerCase();
  const deniedCurrentTool =
    /\brun_tests\b/u.test(normalized) &&
    /not (?:authori[sz]ed|allowed)|unauthori[sz]ed|未授权|不允许|未开放/u.test(normalized);
  const scheduledForPairedPhase =
    normalized.includes(pairedPhase.toLowerCase()) ||
    /will be executed|deferred to|scheduled for|留到|将在|后续.*(?:执行|测试)/u.test(normalized);
  const plannedCodeImplementation =
    /\b(?:product\s+)?src\/?.*\b(?:will be|is)\s+(?:created|implemented)\b.*\bcode\b/u.test(normalized) ||
    /(?:产品)?源码.*(?:将在|留到|由).*\bcode\b.*(?:创建|实现)/u.test(normalized);
  const actualDefect =
    /\b(?:bug|error|fail(?:ed|ing|ure)?|invalid|incorrect|incomplete|missing|omit(?:s|ted)?|mismatch|uncovered|unsupported|blocked)\b/u.test(normalized) ||
    /\b(?:coverage|contract|alignment|requirement)\b.*\b(?:gap|missing|below|fail|insufficient)\b/u.test(normalized) ||
    /错误|失败|无效|不正确|不完整|缺失|遗漏|不一致|未覆盖|覆盖率不足|契约缺陷|需求缺陷|阻塞/u.test(normalized);
  return !actualDefect && (
    (deniedCurrentTool && scheduledForPairedPhase) ||
    scheduledForPairedPhase ||
    plannedCodeImplementation
  );
}

function isVerifiedMissingOutputGap(
  gap: string,
  outputs: readonly string[],
  missing: ReadonlySet<string>,
): boolean {
  if (!/(?:missing required outputs?|缺失\s+required outputs?)/iu.test(gap)) {
    return false;
  }
  return outputs.some((output) => gap.includes(output) && !missing.has(output));
}

function dedup(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function testGate(metrics: Record<string, number>): StageQualityGate {
  return {
    metrics,
    tolerance: {
      metricShortfall: 0.02,
      maxFailedTests: 0,
      maxSkippedTests: 0,
      maxWarnings: 2,
    },
  };
}

function compareRatio(
  name: string,
  actual: number | undefined,
  threshold: number | undefined,
  tolerance: number,
  failures: string[],
): void {
  if (threshold === undefined) return;
  if (actual === undefined) {
    failures.push(`${name} is missing; required >= ${threshold.toFixed(2)}`);
    return;
  }
  if (actual + tolerance < threshold) {
    failures.push(
      `${name}=${actual.toFixed(3)} below ${threshold.toFixed(3)} with tolerance ${tolerance.toFixed(3)}`,
    );
  }
}

function normalizeRatio(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}

function normalizeRatioRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, raw]) => [key, normalizeRatio(raw)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
  );
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function normalizeStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
        typeof item === 'string' && item.trim().length > 0
      ).map((item) => item.trim()))]
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
