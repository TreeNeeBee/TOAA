import type { Workspace } from '../workspace/workspace.js';
import type { PhasePlan as LegacyPhasePlan } from './phase_plan.js';
import type { Plan } from './plan.js';
import type { ProjectAuditResult } from './project_audit.js';
import type { Phase } from '../domain/phases/phase.js';
import type { QualityAssessment } from '../domain/quality/quality.js';
import type { Step } from '../domain/steps/step.js';
import type { Ticket } from '../domain/tickets/ticket.js';
import { DomainObjectRepository } from '../infrastructure/repository/domain_object_repository.js';
import { createObjectEnvelope, reviseObjectEnvelope } from '../domain/objects/object_envelope.js';
import { ReportSchema } from '../domain/observability/records.js';
import { ProjectSchema } from '../domain/projects/project.js';
import { PhaseSchema } from '../domain/phases/phase.js';
import { TicketFlowMetricsService } from '../application/project_management/ticket_flow_metrics.js';

export const PROJECT_DEVELOPMENT_REPORT_PATH = 'docs/project-development-report.md';

export async function generateProjectDevelopmentReport(input: {
  workspace: Workspace;
  plan: Plan;
  phasePlan?: LegacyPhasePlan;
  projectAudit?: ProjectAuditResult;
  finalDelivery: boolean;
  repository?: DomainObjectRepository;
}): Promise<string> {
  const repository = input.repository ?? new DomainObjectRepository(input.workspace);
  if (!input.repository) await repository.load();
  const project = await repository.findProject();
  if (!project) throw new Error('Cannot generate project report without a canonical Project');
  const objects = await repository.list({ projectId: project.id });
  const phases = objects.filter((object): object is Phase => object.objectType === 'phase');
  const steps = objects.filter((object): object is Step => object.objectType === 'step');
  const tickets = objects.filter((object): object is Ticket => object.objectType === 'ticket');
  const assessments = objects.filter(
    (object): object is QualityAssessment => object.objectType === 'quality-assessment',
  );
  const management = objects.find(
    (object) => object.objectType === 'project-management-plan' && object.id === project.managementPlanId,
  );
  if (!management || management.objectType !== 'project-management-plan') {
    throw new Error(`Project ${project.name} has no Project Management Plan`);
  }
  const actors = objects.filter((object) => object.objectType === 'actor-registration');
  const assignments = objects.filter((object) => object.objectType === 'ticket-assignment');
  const risks = objects.filter((object) => object.objectType === 'risk-record');
  const decisions = objects.filter((object) => object.objectType === 'decision-record');
  const interactions = objects.filter((object) => object.objectType === 'interaction-request');
  const flow = await new TicketFlowMetricsService(repository).calculate(project.id);
  const currentPhase = phases.find((phase) => phase.name === input.plan.phaseId);
  const currentSteps = currentPhase
    ? steps.filter((step) => step.phaseId === currentPhase.id)
    : [];
  const currentTickets = currentPhase
    ? tickets.filter((ticket) => ticket.phaseId === currentPhase.id)
    : [];
  const unresolved = tickets.filter((ticket) => ticket.state !== 'closed' && ticket.state !== 'cancelled');
  const qualityRows = currentSteps.map((step) => ({
    step,
    assessment: step.qualityAssessmentId
      ? assessments.find((assessment) => assessment.id === step.qualityAssessmentId)
      : undefined,
  }));
  const allStepsClosed = currentSteps.length === 8 && currentSteps.every((step) => step.state === 'closed');
  const allQualityPassed = qualityRows.length === 8 && qualityRows.every((row) => row.assessment?.passed);
  const epic = currentPhase
    ? currentTickets.find((ticket) => ticket.id === currentPhase.epicTicketId)
    : undefined;
  const delivery = currentTickets.find(
    (ticket) => ticket.type === 'story' && ticket.workKind === 'delivery',
  );
  const auditPassed = input.projectAudit?.ok ?? false;
  const deliveryPassed =
    allStepsClosed &&
    allQualityPassed &&
    epic?.state === 'closed' &&
    delivery?.state === 'closed' &&
    auditPassed &&
    unresolved.filter((ticket) =>
      ticket.phaseId === currentPhase?.id &&
      (ticket.type === 'bug' || ticket.type === 'enhancement' || ticket.type === 'change-request')
    ).length === 0;
  const verdict = deliveryPassed
    ? input.finalDelivery ? 'DELIVERED' : 'ITERATION PASSED'
    : 'NOT READY';
  const counts = countTickets(tickets);

  const lines = [
    '# Project Development Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Verdict: **${verdict}**`,
    `Project delivery: ${input.finalDelivery ? 'final project delivery' : 'iteration delivery; later phases remain planned'}`,
    '',
    '## Project',
    '',
    `- Project ID: ${project.id}`,
    `- Requirement: ${input.plan.requirementDigest}`,
    `- Language: ${project.language}`,
    `- Project type: ${project.projectType}`,
    `- Complexity: ${input.plan.complexityAssessment.level}`,
    `- Current iteration: ${input.plan.phaseId}`,
    `- V-model Steps closed: ${currentSteps.filter((step) => step.state === 'closed').length}/${currentSteps.length}`,
    `- Quality gates passed: ${qualityRows.filter((row) => row.assessment?.passed).length}/${qualityRows.length}`,
    `- PM plan status: ${management.status}`,
    '',
    '## Iterations',
    '',
    '| Iteration | State | Objective | Verification gate |',
    '| --- | --- | --- | --- |',
    ...phases.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((phase) =>
      `| ${phase.name} | ${phase.state} | ${escapeTable(phase.objective)} | ${escapeTable(phase.verificationGate.join('; '))} |`
    ),
    '',
    '## Stage Quality',
    '',
    '| Step | Stage | State | Score | KPI observations | Gaps |',
    '| --- | --- | --- | --- | --- | --- |',
    ...qualityRows.map(({ step, assessment }) => renderQualityRow(step, assessment)),
    '',
    '## Ticket Summary',
    '',
    `- Total: ${tickets.length}`,
    `- Epics: ${counts.epic}`,
    `- Stories: ${counts.story}`,
    `- Tasks: ${counts.task}`,
    `- Bugs: ${counts.bug}`,
    `- Enhancements: ${counts.enhancement}`,
    `- Change requests: ${counts['change-request']}`,
    `- Unresolved: ${unresolved.length}`,
    '',
    ...renderUnresolvedTickets(unresolved),
    '## Project Governance',
    '',
    `- Registered actors: ${actors.length}`,
    `- Ticket assignments: ${assignments.length}`,
    `- Decisions: ${decisions.length}`,
    `- Open risks: ${risks.filter((risk) => risk.objectType === 'risk-record' && risk.status !== 'closed').length}`,
    `- Pending interactions: ${interactions.filter((request) => request.objectType === 'interaction-request' && request.status === 'pending').length}`,
    `- Routed Tickets: ${flow.routedTicketCount}/${flow.ticketCount}`,
    `- Average routing latency: ${formatDuration(flow.averageRoutingLatencyMs)}`,
    `- Average resolution cycle: ${formatDuration(flow.averageResolutionCycleMs)}`,
    `- Handoffs / reopens / escalations: ${flow.totalHandoffs} / ${flow.totalReopens} / ${flow.totalEscalations}`,
    `- Stalled Tickets: ${flow.stalledTicketIds.length}`,
    '',
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
      ? '- All Step, Ticket, quality, and project audit gates passed.'
      : '- Delivery remains blocked by an incomplete Step, open corrective Ticket, failed quality assessment, or project audit.',
    '',
  ];
  const reportPath = input.finalDelivery || !currentPhase
    ? PROJECT_DEVELOPMENT_REPORT_PATH
    : `docs/project-development-report.${currentPhase.name}.md`;
  await input.workspace.writeFile(reportPath, `${lines.join('\n')}\n`);
  const subject = input.finalDelivery || !currentPhase
    ? { id: project.id, objectType: 'project' as const }
    : { id: currentPhase.id, objectType: 'phase' as const };
  const report = ReportSchema.parse({
    ...createObjectEnvelope({
      name: `${currentPhase?.name ?? project.name}-development-report`,
      objectType: 'report',
      projectId: project.id,
    }),
    subject,
    reportType: input.finalDelivery ? 'delivery' : 'phase',
    path: reportPath,
    title: 'Project Development Report',
    summary: `${verdict}: ${currentSteps.filter((step) => step.state === 'closed').length}/${currentSteps.length} Steps closed.`,
    verdict: deliveryPassed ? 'passed' : 'failed',
    relatedObjectIds: [
      ...currentSteps.map((step) => step.id),
      ...currentTickets.map((ticket) => ticket.id),
      ...qualityRows.flatMap((row) => row.assessment ? [row.assessment.id] : []),
    ],
    generatedAt: new Date().toISOString(),
  });
  if (subject.objectType === 'project') {
    const updated = ProjectSchema.parse({
      ...project,
      ...reviseObjectEnvelope(project),
      reportIds: [...project.reportIds, report.id],
    });
    await repository.commit([report, updated]);
  } else if (currentPhase) {
    const updated = PhaseSchema.parse({
      ...currentPhase,
      ...reviseObjectEnvelope(currentPhase),
      reportIds: [...currentPhase.reportIds, report.id],
    });
    await repository.commit([report, updated]);
  }
  return reportPath;
}

function renderQualityRow(step: Step, assessment?: QualityAssessment): string {
  if (!assessment) {
    return `| ${step.name} | ${step.type} | ${step.state} | NOT ASSESSED | - | - |`;
  }
  const observations = assessment.observations.map((item) =>
    `${item.kpiId.slice(0, 8)}=${formatRatio(item.value)} (${item.passed ? 'pass' : 'fail'})`
  ).join('; ') || '-';
  return `| ${step.name} | ${step.type} | ${step.state} | ${formatRatio(assessment.score)} | ` +
    `${escapeTable(observations)} | ${escapeTable(assessment.gaps.join('; ') || '-')} |`;
}

function renderUnresolvedTickets(tickets: readonly Ticket[]): string[] {
  if (tickets.length === 0) return [];
  return [
    '### Unresolved Tickets',
    '',
    ...tickets.map((ticket) =>
      `- ${ticket.name} (${ticket.id}) [${ticket.type}/${ticket.state}]: ${ticket.description}`
    ),
    '',
  ];
}

function countTickets(tickets: readonly Ticket[]): Record<Ticket['type'], number> {
  return tickets.reduce<Record<Ticket['type'], number>>((counts, ticket) => {
    counts[ticket.type] += 1;
    return counts;
  }, { epic: 0, story: 0, task: 0, bug: 0, enhancement: 0, 'change-request': 0 });
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return 'N/A';
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function escapeTable(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim();
}
