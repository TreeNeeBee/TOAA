import { createObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { Step } from '../../domain/steps/step.js';
import type { Phase } from '../../domain/phases/phase.js';
import type { DeliveryGateFinding } from '../../domain/quality/delivery_gate.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  KpiObservationSchema,
  QualityAssessmentSchema,
  calculateQuality,
  evaluateKpi,
  type QualityAssessment,
} from '../../domain/quality/quality.js';

export interface QualityMetricInput {
  metric: string;
  value: number;
  evidence?: string[];
}

export class QualityAssessmentService {
  constructor(private readonly repository: DomainObjectRepositoryPort) {}

  async assessStep(input: {
    step: Step;
    metrics: readonly QualityMetricInput[];
    evidence?: string[];
    gaps?: string[];
    findings?: readonly DeliveryGateFinding[];
    now?: string;
  }): Promise<QualityAssessment> {
    const kpis = await Promise.all(input.step.kpiIds.map(async (id) => {
      const object = await this.repository.read(id);
      if (object.objectType !== 'kpi') throw new Error(`Object ${id} is not a KPI`);
      if (object.subjectId !== input.step.id) {
        throw new Error(`KPI ${object.name} does not belong to Step ${input.step.name}`);
      }
      return object;
    }));
    const values = new Map(input.metrics.map((metric) => [metric.metric, metric]));
    const observedAt = input.now ?? new Date().toISOString();
    const observations = kpis.flatMap((kpi) => {
      const metric = values.get(kpi.metric);
      if (!metric) return [];
      return [KpiObservationSchema.parse({
        kpiId: kpi.id,
        value: metric.value,
        passed: evaluateKpi(kpi, metric.value),
        evidence: metric.evidence ?? [],
        observedAt,
      })];
    });
    const result = calculateQuality(kpis, observations);
    const metricOf = (id: string) => kpis.find((kpi) => kpi.id === id)?.metric ?? id;
    // A structural number nobody produced is recorded and skipped; a functional one is a gap, so
    // the Step is asked for the measurement it never made rather than being let through on silence.
    const unavailableMetrics = result.missingStructuralKpiIds.map(metricOf);
    const missingFunctional = result.missingFunctionalKpiIds.map((id) =>
      `missing KPI observation: ${metricOf(id)}`,
    );
    const failedMetrics = observations.filter((item) => !item.passed).map((item) =>
      `KPI below target: ${kpis.find((kpi) => kpi.id === item.kpiId)?.metric ?? item.kpiId}`,
    );
    const assessment = QualityAssessmentSchema.parse({
      ...createObjectEnvelope({
        name: `${input.step.name}-QA${String(input.step.attempts + 1).padStart(3, '0')}`,
        objectType: 'quality-assessment',
        projectId: input.step.projectId,
        now: observedAt,
      }),
      subject: { id: input.step.id, objectType: 'step' },
      observations,
      score: result.score,
      passed: result.passed && (input.gaps?.length ?? 0) === 0 && (input.findings?.length ?? 0) === 0,
      gaps: [...missingFunctional, ...failedMetrics, ...(input.gaps ?? [])],
      unavailableMetrics,
      evidence: input.evidence ?? [],
      findings: input.findings ?? [],
    });
    await this.repository.insert(assessment, assessment.passed ? 'passed' : 'failed');
    return assessment;
  }

  async assessPhase(input: {
    phase: Phase;
    passed: boolean;
    evidence: readonly string[];
    findings?: readonly DeliveryGateFinding[];
    now?: string;
  }): Promise<QualityAssessment> {
    const observedAt = input.now ?? new Date().toISOString();
    const findings = input.findings ?? [];
    const assessment = QualityAssessmentSchema.parse({
      ...createObjectEnvelope({
        name: `${input.phase.name}-DELIVERY-QA${String(input.phase.revision + 1).padStart(3, '0')}`,
        objectType: 'quality-assessment',
        projectId: input.phase.projectId,
        now: observedAt,
      }),
      subject: { id: input.phase.id, objectType: 'phase' },
      observations: [],
      score: input.passed && findings.length === 0 ? 1 : 0,
      passed: input.passed && findings.length === 0,
      gaps: findings.map((finding) => `${finding.category}: ${finding.summary}`),
      evidence: input.evidence,
      findings,
    });
    await this.repository.insert(assessment, assessment.passed ? 'passed' : 'failed');
    return assessment;
  }
}
