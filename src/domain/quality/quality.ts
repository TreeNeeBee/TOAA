import { z } from 'zod';
import { ObjectEnvelopeSchema } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { ObjectRefSchema } from '../objects/object_ref.js';

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
  evidence: z.array(z.string().min(1)).default([]),
}).strict();

export type QualityAssessment = z.infer<typeof QualityAssessmentSchema>;

export function evaluateKpi(kpi: Kpi, value: number): boolean {
  switch (kpi.comparator) {
    case 'gte':
      return value + kpi.tolerance >= kpi.target;
    case 'lte':
      return value - kpi.tolerance <= kpi.target;
    case 'eq':
      return Math.abs(value - kpi.target) <= kpi.tolerance;
  }
}

export function calculateQuality(
  kpis: readonly Kpi[],
  observations: readonly KpiObservation[],
): { score: number; passed: boolean; missingKpiIds: string[] } {
  const byId = new Map(observations.map((observation) => [observation.kpiId, observation]));
  const missingKpiIds = kpis.filter((kpi) => !byId.has(kpi.id)).map((kpi) => kpi.id);
  const totalWeight = kpis.reduce((sum, kpi) => sum + kpi.weight, 0);
  const passedWeight = kpis.reduce((sum, kpi) => {
    const observation = byId.get(kpi.id);
    return sum + (observation?.passed ? kpi.weight : 0);
  }, 0);
  return {
    score: totalWeight === 0 ? 0 : passedWeight / totalWeight,
    passed: missingKpiIds.length === 0 && kpis.every((kpi) => byId.get(kpi.id)?.passed === true),
    missingKpiIds,
  };
}
