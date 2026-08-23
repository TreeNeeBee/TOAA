import type { Workspace } from '../workspace/workspace.js';
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
import type { RecordReplayEvidence } from '../application/record_replay/controller.js';
import { RECORD_REPLAY_CHANNELS } from '../application/record_replay/types.js';

export const PROJECT_DEVELOPMENT_REPORT_PATH = 'docs/project-development-report.md';

export async function generateProjectDevelopmentReport(input: {
  workspace: Workspace;
  plan: Plan;
  projectAudit?: ProjectAuditResult;
  finalDelivery: boolean;
  repository?: DomainObjectRepository;
  /** External-interaction evidence: fixture mode and per-channel replay/live accounting. */
  recordReplay?: RecordReplayEvidence;
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
  const reportPhases = input.finalDelivery ? phases : currentPhase ? [currentPhase] : [];
  const reportPhaseIds = new Set(reportPhases.map((phase) => phase.id));
  const reportSteps = steps.filter((step) => reportPhaseIds.has(step.phaseId));
  const reportTickets = tickets.filter((ticket) => reportPhaseIds.has(ticket.phaseId));
  const unresolved = tickets.filter((ticket) => ticket.state !== 'closed' && ticket.state !== 'cancelled');
  const qualityRows = reportSteps.map((step) => ({
    step,
    assessment: step.qualityAssessmentId
      ? assessments.find((assessment) => assessment.id === step.qualityAssessmentId)
      : undefined,
  }));
  const completeVModels = reportPhases.length > 0 && reportPhases.every((phase) => {
    const phaseSteps = reportSteps.filter((step) => step.phaseId === phase.id);
    return phaseSteps.length === 8 && phaseSteps.every((step) => step.state === 'closed');
  });
  const allQualityPassed = qualityRows.length === reportPhases.length * 8 &&
    qualityRows.every((row) => row.assessment?.passed);
  const allPhaseDeliveriesClosed = reportPhases.length > 0 && reportPhases.every((phase) => {
    const phaseTickets = reportTickets.filter((ticket) => ticket.phaseId === phase.id);
    const epic = phaseTickets.find((ticket) => ticket.id === phase.epicTicketId);
    const delivery = phaseTickets.find(
      (ticket) => ticket.type === 'story' && ticket.workKind === 'delivery',
    );
    return phase.state === 'closed' && epic?.state === 'closed' && delivery?.state === 'closed';
  });
  const auditPassed = input.projectAudit?.ok ?? false;
  const unresolvedCorrective = unresolved.filter((ticket) =>
    reportPhaseIds.has(ticket.phaseId) &&
    (ticket.type === 'bug' || ticket.type === 'enhancement' || ticket.type === 'change-request')
  );
  const deliveryPassed =
    completeVModels &&
    allQualityPassed &&
    allPhaseDeliveriesClosed &&
    auditPassed &&
    unresolvedCorrective.length === 0 &&
    (!input.finalDelivery || project.state === 'closed');
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
    `- Report scope: ${input.finalDelivery ? 'all phases' : input.plan.phaseId}`,
    `- V-model Steps closed: ${reportSteps.filter((step) => step.state === 'closed').length}/${reportSteps.length}`,
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
    '| Iteration | Step | Stage | State | Score | KPI observations | Gaps |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...qualityRows.map(({ step, assessment }) =>
      renderQualityRow(reportPhases.find((phase) => phase.id === step.phaseId)?.name ?? step.phaseId, step, assessment)
    ),
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
    '## External Interactions',
    '',
    ...renderRecordReplayEvidence(input.recordReplay),
    '',
    '## Project Audit',
    '',
    ...(input.projectAudit
      ? input.projectAudit.checks.flatMap((check) => [
          `- ${check.ok ? 'PASS' : check.severity.toUpperCase()}: ${check.name} - ${check.summary}`,
          ...(check.scene
            ? [
                `  - Scene: ${check.scene.scenario.operation}`,
                `  - Command: \`${check.scene.command}\` (${check.scene.exitCode}, timeout=${check.scene.timedOut})`,
                `  - Captured: ${check.scene.capturedAt} in ${check.scene.scenario.environment}`,
              ]
            : []),
        ])
      : ['- NOT RUN: no final project audit result was supplied.']),
    '',
    '## Delivery Decision',
    '',
    deliveryPassed
      ? '- All Step, Ticket, quality, and project audit gates passed.'
      : '- Delivery remains blocked by an incomplete Phase/Step, open corrective Ticket, failed quality assessment, PM state, or project audit.',
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
    summary: `${verdict}: ${reportSteps.filter((step) => step.state === 'closed').length}/${reportSteps.length} Steps closed.`,
    verdict: deliveryPassed ? 'passed' : 'failed',
    relatedObjectIds: [
      ...reportPhases.map((phase) => phase.id),
      ...reportSteps.map((step) => step.id),
      ...reportTickets.map((ticket) => ticket.id),
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

function renderQualityRow(phaseName: string, step: Step, assessment?: QualityAssessment): string {
  if (!assessment) {
    return `| ${phaseName} | ${step.name} | ${step.type} | ${step.state} | NOT ASSESSED | - | - |`;
  }
  const observations = assessment.observations.map((item) =>
    `${item.kpiId.slice(0, 8)}=${formatRatio(item.value)} (${item.passed ? 'pass' : 'fail'})`
  ).join('; ') || '-';
  return `| ${phaseName} | ${step.name} | ${step.type} | ${step.state} | ${formatRatio(assessment.score)} | ` +
    `${escapeTable(observations)} | ${escapeTable(assessment.gaps.join('; ') || '-')} |`;
}

/**
 * Delivery evidence for DoD "record/replay use and live dependencies": which external channels this
 * run replayed from fixtures and which it actually reached out to. A reader must be able to tell
 * whether a green delivery was verified against recordings or against live services.
 */
function renderRecordReplayEvidence(evidence: RecordReplayEvidence | undefined): string[] {
  if (!evidence) return ['- NOT RECORDED: this run did not report external-interaction evidence.'];
  const lines = [`- Fixture mode: ${evidence.mode}`];
  // A channel is only counted when it is under fixture control. Silence from an unmanaged channel
  // means "not observed", never "did not happen", so the two must never be reported the same way.
  if (evidence.managedChannels.length === 0) {
    lines.push(
      '- No channel was under fixture control; every external interaction in this run was live.',
      '- Live dependencies: all external interactions (HTTP, LLM, subprocess, tool).',
    );
    return lines;
  }
  const managed = evidence.managedChannels
    .map((channel) => [channel, evidence.usage[channel]] as const)
    .filter(([, usage]) => usage.replayed + usage.recorded + usage.live > 0);
  lines.push(...(managed.length === 0
    ? ['- No external interaction was made on a fixture-controlled channel.']
    : managed.map(([channel, usage]) =>
        `- ${channel}: replayed ${usage.replayed}, recorded ${usage.recorded}, live ${usage.live}`,
      )));
  const liveManaged = managed
    .filter(([, usage]) => usage.recorded + usage.live > 0)
    .map(([channel]) => channel);
  const unmanaged = RECORD_REPLAY_CHANNELS.filter(
    (channel) => !evidence.managedChannels.includes(channel),
  );
  lines.push(
    liveManaged.length === 0 && unmanaged.length === 0
      ? '- Live dependencies: none; every external interaction was replayed from fixtures.'
      : `- Live dependencies: ${[...liveManaged, ...unmanaged.map((c) => `${c} (not fixture-controlled)`)].join(', ')}`,
  );
  return lines;
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
