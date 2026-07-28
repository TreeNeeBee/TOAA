import type { Workspace } from '../workspace/workspace.js';
import type { PhasePlan } from './phase_plan.js';
import type { Plan, Step } from './plan.js';
import type { ProjectAuditResult } from './project_audit.js';
import {
  QualityAssessmentStore,
  resolveQualityGate,
  type QualityAssessmentRecord,
} from './quality_gate.js';
import { TicketStore, type Ticket } from './ticket.js';

export const PROJECT_DEVELOPMENT_REPORT_PATH = 'docs/project-development-report.md';

export async function generateProjectDevelopmentReport(input: {
  workspace: Workspace;
  plan: Plan;
  phasePlan?: PhasePlan;
  projectAudit?: ProjectAuditResult;
  finalDelivery: boolean;
}): Promise<string> {
  const quality = new QualityAssessmentStore(input.workspace);
  const tickets = new TicketStore(input.workspace);
  await quality.load();
  await tickets.load();

  const latest = latestQualityRecords(quality.all());
  const unresolved = tickets.all().filter((ticket) =>
    !['resolved', 'closed', 'cancelled'].includes(ticket.status)
  );
  const summary = tickets.summary();
  const steps = input.plan.steps;
  const stageFeatures = steps
    .map((step) => tickets.featureForStep(step.id, step.iterationId ?? 'P1'))
    .filter((ticket) => ticket !== undefined);
  const epic = tickets.epicForIteration(input.plan.phaseId);
  const delivery = tickets.deliveryForIteration(input.plan.phaseId);
  const qualityRows = collectQualityRows(steps, latest);
  const passedQualityGates = qualityRows.filter((row) => row.record?.evaluation.passed).length;
  const allStepsDone =
    stageFeatures.length === steps.length &&
    stageFeatures.every(
      (ticket) => ticket.status === 'closed' && ticket.execution.state === 'passed',
    );
  const auditPassed = input.projectAudit?.ok ?? false;
  const allQualityGatesPassed =
    qualityRows.length > 0 &&
    qualityRows.every((row) => row.record?.evaluation.passed);
  const deliveryPassed =
    allStepsDone &&
    epic?.status === 'closed' &&
    epic.execution.state === 'passed' &&
    delivery?.status === 'closed' &&
    delivery.execution.state === 'passed' &&
    allQualityGatesPassed &&
    auditPassed &&
    unresolved.length === 0;
  const verdict = deliveryPassed
    ? input.finalDelivery ? 'DELIVERED' : 'ITERATION PASSED'
    : 'NOT READY';

  const lines = [
    '# Project Development Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Verdict: **${verdict}**`,
    `Project delivery: ${input.finalDelivery ? 'final project delivery' : 'iteration delivery; later phases remain planned'}`,
    '',
    '## Project',
    '',
    `- Requirement: ${input.plan.requirementDigest}`,
    `- Language: ${input.plan.language}`,
    `- Project type: ${input.plan.projectType}`,
    `- Complexity: ${input.plan.complexityAssessment.level}`,
    `- Current iteration: ${input.plan.phaseId}`,
    `- Current iteration V-model Features complete: ${stageFeatures.filter((ticket) =>
      ticket.status === 'closed' && ticket.execution.state === 'passed'
    ).length}/${steps.length}`,
    `- Project stage quality gates passed: ${passedQualityGates}/${qualityRows.length}`,
    '',
    '## Iterations',
    '',
    ...renderIterations(input.plan, input.phasePlan),
    '',
    '## Stage Quality',
    '',
    '| Step | Stage | Status | Completion / Alignment | Engineering metrics | Tolerance observations |',
    '| --- | --- | --- | --- | --- | --- |',
    ...qualityRows.map(({ step, record }) => renderQualityRow(step, record)),
    '',
    '## Ticket Summary',
    '',
    `- Total: ${summary.total}`,
    `- Epics: ${summary.byType.epic}`,
    `- Features: ${summary.byType.feature}`,
    `- Tasks: ${summary.byType.task}`,
    `- Sub-tasks: ${summary.byType['sub-task']}`,
    `- Bugs: ${summary.byType.bug}`,
    `- Enhancements: ${summary.byType.enhance} (functional gaps ${summary.enhancementsByKind['functional-gap']}, test incomplete ${summary.enhancementsByKind['test-incomplete']}, defects ${summary.enhancementsByKind.defect})`,
    `- Change requests: ${summary.changeRequests.total} (${summary.changeRequests.totalRevisions} revision(s), ${summary.changeRequests.open} open)`,
    `- Unresolved: ${unresolved.length}`,
    '',
    ...renderUnresolvedTickets(unresolved),
    '## Project Audit',
    '',
    ...(input.projectAudit
      ? input.projectAudit.checks.map((check) =>
          `- ${check.ok ? 'PASS' : check.severity.toUpperCase()}: ${check.name} - ${check.summary}`
        )
      : ['- NOT RUN: no final project audit result was supplied.']),
    '',
    '## Delivery Decision',
    '',
    deliveryPassed
      ? '- All stage gates, Ticket verification, and the project audit passed.'
      : '- Delivery is blocked until every V-model Feature passes, every quality gate passes, all blocking Tickets close, and the project audit is clear.',
    '',
  ];
  await input.workspace.writeFile(PROJECT_DEVELOPMENT_REPORT_PATH, `${lines.join('\n')}\n`);
  return PROJECT_DEVELOPMENT_REPORT_PATH;
}

function latestQualityRecords(
  records: readonly QualityAssessmentRecord[],
): Map<string, QualityAssessmentRecord> {
  const latest = new Map<string, QualityAssessmentRecord>();
  for (const record of records) {
    latest.set(qualityKey(record.iterationId, record.stepId), record);
  }
  return latest;
}

function qualityKey(iterationId: string | undefined, stepId: string): string {
  return `${iterationId ?? 'P1'}:${stepId}`;
}

function collectQualityRows(
  currentSteps: readonly Step[],
  records: ReadonlyMap<string, QualityAssessmentRecord>,
): Array<{ step?: Step; record?: QualityAssessmentRecord }> {
  const rows = new Map<string, { step?: Step; record?: QualityAssessmentRecord }>();
  for (const record of records.values()) {
    rows.set(qualityKey(record.iterationId, record.stepId), { record });
  }
  for (const step of currentSteps) {
    const key = qualityKey(step.iterationId, step.id);
    rows.set(key, { step, record: records.get(key) });
  }
  return [...rows.entries()]
    .sort(([left], [right]) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
    )
    .map(([, row]) => row);
}

function renderQualityRow(step: Step | undefined, record: QualityAssessmentRecord | undefined): string {
  const stepId = step?.id ?? record?.stepId ?? '-';
  const iterationId = step?.iterationId ?? record?.iterationId ?? 'P1';
  const phase = step?.phase ?? record?.phase;
  if (!phase) {
    return `| ${iterationId}/${stepId} | UNKNOWN | NOT ASSESSED | - | - | - |`;
  }
  const policy = record?.policy ?? (step ? resolveQualityGate(step) : undefined);
  if (!policy) {
    return `| ${iterationId}/${stepId} | ${phase} | NOT ASSESSED | - | - | - |`;
  }
  if (!record) {
    return `| ${iterationId}/${stepId} | ${phase} | NOT ASSESSED | - | - | - |`;
  }
  const assessment = record.assessment;
  const source = [
    policy.completionMin === undefined
      ? ''
      : `completion ${formatRatio(assessment.completion)}/${formatRatio(policy.completionMin)}`,
    policy.upstreamAlignmentMin === undefined
      ? ''
      : `alignment ${formatRatio(assessment.upstreamAlignment)}/${formatRatio(policy.upstreamAlignmentMin)}`,
  ].filter(Boolean).join('; ') || '-';
  const metrics = Object.entries(policy.metrics).map(([name, threshold]) =>
    `${name} ${formatRatio(assessment.metrics[name])}/${formatRatio(threshold)}`
  ).join('; ') || '-';
  const tolerance = [
    `failed=${assessment.tolerance.failedTests}/${policy.tolerance.maxFailedTests}`,
    `skipped=${assessment.tolerance.skippedTests}/${policy.tolerance.maxSkippedTests}`,
    `warnings=${assessment.tolerance.warnings}/${policy.tolerance.maxWarnings}`,
    `metric shortfall=${formatRatio(policy.tolerance.metricShortfall)}`,
  ].join('; ');
  return [
    `| ${iterationId}/${stepId}`,
    phase,
    record.evaluation.passed ? 'PASS' : 'FAIL',
    escapeTable(source),
    escapeTable(metrics),
    `${escapeTable(tolerance)} |`,
  ].join(' | ');
}

function renderIterations(plan: Plan, phasePlan?: PhasePlan): string[] {
  const phases = phasePlan?.phases ?? plan.implementationPhases;
  return [
    '| Iteration | Status | Objective | Verification gate |',
    '| --- | --- | --- | --- |',
    ...phases.map((phase) =>
      `| ${phase.id} | ${phase.status} | ${escapeTable(phase.objective)} | ` +
      `${escapeTable(phase.verificationGate?.summary ?? 'not specified')} |`
    ),
  ];
}

function renderUnresolvedTickets(tickets: readonly Ticket[]): string[] {
  if (tickets.length === 0) return [];
  return [
    '### Unresolved Tickets',
    '',
    ...tickets.map((ticket) =>
      `- ${ticket.id} [${ticket.type}/${ticket.status}]: ${ticket.title}`
    ),
    '',
  ];
}

function formatRatio(value: number | undefined): string {
  return value === undefined ? 'missing' : `${(value * 100).toFixed(1)}%`;
}

function escapeTable(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim();
}
