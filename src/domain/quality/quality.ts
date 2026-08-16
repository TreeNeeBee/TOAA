import { z } from 'zod';
import { ObjectEnvelopeSchema } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { ObjectRefSchema } from '../objects/object_ref.js';
import { DeliveryGateFindingSchema } from './delivery_gate.js';

export const KPI_COMPARATORS = ['gte', 'lte', 'eq'] as const;

export const KpiSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('kpi'),
  description: z.string().min(1),
  metric: z.string().min(1),
  comparator: z.enum(KPI_COMPARATORS),
  target: z.number().finite(),
  tolerance: z.number().nonnegative().default(0),
  weight: z.number().positive().max(1).default(1),
  subjectId: ObjectIdSchema,
}).strict();

export type Kpi = z.infer<typeof KpiSchema>;

export const KpiObservationSchema = z.object({
  kpiId: ObjectIdSchema,
  value: z.number().finite(),
  passed: z.boolean(),
  evidence: z.array(z.string().min(1)).default([]),
  observedAt: z.string().datetime({ offset: true }),
}).strict();

export type KpiObservation = z.infer<typeof KpiObservationSchema>;

export const QualityAssessmentSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('quality-assessment'),
  subject: ObjectRefSchema,
  observations: z.array(KpiObservationSchema),
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  gaps: z.array(z.string().min(1)).default([]),
  /**
   * Structural KPIs this attempt could not observe at all.
   *
   * Separate from `gaps` because the two ask for different things: a gap says the Step fell short
   * and must repair, while an unavailable structural metric says nobody produced the number.
   * Routing the second as the first opened corrective chains that no amount of work could close —
   * a live MODULE_TEST reopened twice for coverage numbers no attempt ever measured. A *functional*
   * metric that is missing stays in `gaps`, because its claim was never established.
   */
  unavailableMetrics: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([]),
  /** Independent gate findings retained until each has been converted into its own Ticket. */
  findings: z.array(DeliveryGateFindingSchema).default([]),
}).strict();

export type QualityAssessment = z.infer<typeof QualityAssessmentSchema>;

/**
 * Metrics that measure how thoroughly the code was exercised, rather than whether it works.
 *
 * The distinction decides two things that pull in opposite directions. A structural metric is a
 * sampling judgement: it may be approximately right, and a number nobody produced is a gap in
 * instrumentation rather than a defect in the product, so skipping it is the honest reading. A
 * functional metric says whether the thing does what it must — there an unmeasured number is as
 * serious as a failing one, because the claim it carries was never established.
 *
 * A live Phase showed both halves of the cost: three separate Enhancements chased the same
 * `lineCoverage` shortfall while every test passed, and MODULE_TEST reopened twice for coverage
 * numbers no attempt ever produced.
 *
 * Anything not listed here counts as functional. A metric nobody recognised that quietly stopped
 * counting would be a gate weakened by omission, which is the failure this distinction exists to
 * prevent.
 */
export const STRUCTURAL_METRICS: ReadonlySet<string> = new Set([
  'lineCoverage',
  'branchCoverage',
  'conditionCoverage',
  'statementCoverage',
  'moduleCoverage',
  'startupTime',
  'buildDuration',
  'memoryFootprint',
]);

export function isStructuralMetric(metric: string): boolean {
  return STRUCTURAL_METRICS.has(metric);
}

/**
 * How far a structural metric may miss its target before it counts as a shortfall.
 *
 * Applied here rather than written into the KPI when it is compiled, because tolerance is policy
 * and a KPI object is data. A band frozen at compile time can only be changed by rebuilding the
 * project, so every existing workspace keeps enforcing the rule that was current the day it was
 * planned — the same shape that made a repaired defect unreachable until the build fingerprint
 * moved. The stored `tolerance` stays the floor; policy may widen it, never narrow it.
 */
export const STRUCTURAL_TOLERANCE_FLOOR = 0.1;

/** The band actually enforced for a KPI: its own, widened for structural metrics. */
export function effectiveTolerance(kpi: Pick<Kpi, 'metric' | 'tolerance'>): number {
  return isStructuralMetric(kpi.metric)
    ? Math.max(kpi.tolerance, STRUCTURAL_TOLERANCE_FLOOR)
    : kpi.tolerance;
}

export function evaluateKpi(kpi: Kpi, value: number): boolean {
  const tolerance = effectiveTolerance(kpi);
  switch (kpi.comparator) {
    case 'gte':
      return value + tolerance >= kpi.target;
    case 'lte':
      return value - tolerance <= kpi.target;
    case 'eq':
      return Math.abs(value - kpi.target) <= tolerance;
  }
}

export function calculateQuality(
  kpis: readonly Kpi[],
  observations: readonly KpiObservation[],
): {
  score: number;
  passed: boolean;
  missingStructuralKpiIds: string[];
  missingFunctionalKpiIds: string[];
} {
  const byId = new Map(observations.map((observation) => [observation.kpiId, observation]));
  const missing = kpis.filter((kpi) => !byId.has(kpi.id));
  const missingStructuralKpiIds = missing.filter((kpi) => isStructuralMetric(kpi.metric))
    .map((kpi) => kpi.id);
  const missingFunctionalKpiIds = missing.filter((kpi) => !isStructuralMetric(kpi.metric))
    .map((kpi) => kpi.id);
  const totalWeight = kpis.reduce((sum, kpi) => sum + kpi.weight, 0);
  const passedWeight = kpis.reduce((sum, kpi) => {
    const observation = byId.get(kpi.id);
    return sum + (observation?.passed ? kpi.weight : 0);
  }, 0);
  return {
    // Unobserved KPIs stay in the denominator whichever kind they are, so the score keeps saying
    // the assessment was incomplete even when the gate is allowed to pass.
    score: totalWeight === 0 ? 0 : passedWeight / totalWeight,
    // A structural number nobody produced does not fail the gate: asking for a repair that cannot
    // exist is what reopened a Step twice. A functional one does.
    passed: missingFunctionalKpiIds.length === 0 &&
      kpis.every((kpi) => byId.get(kpi.id)?.passed !== false),
    missingStructuralKpiIds,
    missingFunctionalKpiIds,
  };
}
