import {
  V_MODEL_DEVELOPMENT_PHASES,
  V_MODEL_TEST_PHASES,
  type Phase,
  type StageQualityGate,
  type Step,
} from './plan.js';
import {
  DeliveryGateFindingSchema,
  type DeliveryGateFinding,
} from '../domain/quality/delivery_gate.js';


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
  /** Gate metric identifiers that a concrete probe could not measure. */
  unavailableMetrics: string[];
  /** Shortfalls in this Step's own work. Any one of them fails its gate. */
  gaps: string[];
  /**
   * Preconditions this Step does not own and cannot satisfy.
   *
   * Separate from `gaps` because the gate fails a Step for every gap it reports, and a Step that
   * accurately says "the product source does not exist yet, which is expected before CODE" was being
   * failed for being right. The alternative — recognising such statements in `gaps` — means matching
   * internal metric identifiers against free prose, and it lost to a model writing "test pass rate"
   * where the matcher expected "testCasePassRate".
   *
   * Recorded as evidence and never gate-failing. A precondition that actually needs action reaches
   * PM through a tool failure code or a Change Request, not through this field.
   */
  blockedBy: string[];
  /** Independent defects/shortfalls discovered by this gate. */
  findings?: DeliveryGateFinding[];
}

export interface QualityGateEvaluation {
  passed: boolean;
  enhancementFailures: string[];
  bugFailures: string[];
}

export interface QualityAssessmentConsistencyContext {
  /** S1-S3 have authored a baseline, but Runtime intentionally has no product code to execute yet. */
  baselineExecutionDeferred?: boolean;
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
  const findingValue = value.findings ?? value.deliveryFindings;
  const findings = normalizeDeliveryGateFindings(findingValue);
  if (findingValue !== undefined && findings === undefined) return undefined;
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
    unavailableMetrics: normalizeStrings(value.unavailableMetrics ?? value.unavailable_metrics),
    gaps: normalizeStrings(value.gaps),
    blockedBy: normalizeStrings(value.blockedBy ?? value.blocked_by),
    findings: findings ?? [],
  };
  return assessment;
}

/**
 * Reject structurally contradictory model evidence before it can create a corrective Ticket.
 *
 * Runtime owns the execution policy, so this deliberately uses typed fields rather than trying to
 * recognise phrases such as "source code is missing" in model prose.
 */
export function qualityAssessmentConsistencyIssues(
  assessment: StageQualityAssessment,
  context: QualityAssessmentConsistencyContext = {},
): string[] {
  const issues: string[] = [];
  const unavailable = new Set(assessment.unavailableMetrics);
  for (const metric of Object.keys(assessment.metrics)) {
    if (unavailable.has(metric)) {
      issues.push(
        `qualityAssessment.metrics.${metric} conflicts with qualityAssessment.unavailableMetrics`,
      );
    }
  }
  if (
    context.baselineExecutionDeferred &&
    assessment.completion === 1 &&
    assessment.gaps.length > 0 &&
    assessment.blockedBy.length > 0 &&
    (assessment.findings?.length ?? 0) === 0 &&
    assessment.tolerance.failedTests === 0 &&
    assessment.tolerance.skippedTests === 0 &&
    assessment.tolerance.warnings === 0
  ) {
    issues.push(
      'qualityAssessment.gaps contradict completion=1 during deferred baseline execution; ' +
        'an expected downstream precondition belongs only in blockedBy, while a real current-Step gap must reduce completion or produce a finding',
    );
  }
  return issues;
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
    unavailableMetrics: [],
    gaps: [],
    blockedBy: [],
    findings: [],
  };
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
  enhancementFailures.push(
    ...assessment.gaps
      .filter((gap) => !namesAToolThisStepLacks(gap, step))
      .map((gap) => `declared gap: ${gap}`),
  );
  for (const finding of assessment.findings ?? []) {
    const rendered = `${finding.category}: ${finding.summary}`;
    if (finding.category === 'test-defect' || finding.category === 'product-defect') {
      bugFailures.push(rendered);
    } else if (finding.category !== 'dependency') {
      enhancementFailures.push(rendered);
    }
  }
  return {
    passed: enhancementFailures.length === 0 && bugFailures.length === 0,
    enhancementFailures,
    bugFailures,
  };
}

/**
 * Whether a declared gap is about work this Step has no tool to do.
 *
 * `blockedBy` is the channel for a precondition a Step does not own, and a model that uses it is
 * never in this branch. Three live runs showed models putting it in `gaps` instead — "cannot run
 * tsc/vitest here, the whitelist has no run_program/run_tests" — and the gate failed the Step for
 * being right, raised an Enhancement, and left it with nothing to do but stall.
 *
 * The judgment is the Step's own tool whitelist, which is a fact the system owns; the tool names
 * matched here are XCompiler's identifiers, not model prose. It cannot rescue a gap phrased without
 * naming a tool — that is what `blockedBy` is for, and this only stops the gate punishing accuracy.
 */
function namesAToolThisStepLacks(gap: string, step: Step): boolean {
  const granted = new Set(step.tools ?? []);
  return VERIFICATION_TOOL_NAMES.some((tool) =>
    !granted.has(tool) && new RegExp(`\\b${tool}\\b`, 'u').test(gap));
}

const VERIFICATION_TOOL_NAMES = ['run_tests', 'run_program', 'install_deps', 'add_dependency'] as const;

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

function normalizeDeliveryGateFindings(value: unknown): DeliveryGateFinding[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map((candidate) => {
    const parsed = DeliveryGateFindingSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  });
  return parsed.some((candidate) => candidate === undefined)
    ? undefined
    : parsed as DeliveryGateFinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
