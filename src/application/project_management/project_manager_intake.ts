import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { DeliveryGateFinding } from '../../domain/quality/delivery_gate.js';
import { STEP_TYPE_ORDER, type Step } from '../../domain/steps/step.js';
import type { Ticket } from '../../domain/tickets/ticket.js';
import { CorrectiveWorkflowService } from './corrective_workflow_service.js';
import { TicketRegistrationService } from './ticket_registration_service.js';

export const PROJECT_MANAGER_PROBLEM_ORIGINS = [
  'phase-delivery-gate',
  // Reserved for the post-delivery Runtime boundary. It still requires a selected/reopened Phase.
  'external-usage',
] as const;

export type ProjectManagerProblemOrigin = (typeof PROJECT_MANAGER_PROBLEM_ORIGINS)[number];

/**
 * A Phase-external observation submitted to PM. It deliberately contains no Ticket fields: outside
 * callers report facts and evidence; only PM decides how those facts enter the Phase workflow.
 */
export interface ProjectManagerProblemIntake {
  projectId: ObjectId;
  phaseId: ObjectId;
  origin: ProjectManagerProblemOrigin;
  reports: readonly DeliveryGateFinding[];
  correlationId: ObjectId;
}

export class ProjectManagerIntakeService {
  private readonly corrective: CorrectiveWorkflowService;
  private readonly registration: TicketRegistrationService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.corrective = new CorrectiveWorkflowService(repository);
    this.registration = new TicketRegistrationService(repository);
  }

  async accept(input: ProjectManagerProblemIntake): Promise<Ticket[]> {
    if (input.origin === 'external-usage') {
      throw new Error(
        'Post-delivery PM intake is reserved until Project/Phase reactivation is implemented; no Ticket was created',
      );
    }
    const phase = await this.repository.read(input.phaseId);
    if (phase.objectType !== 'phase' || phase.projectId !== input.projectId) {
      throw new Error(`PM intake phase ${input.phaseId} does not belong to Project ${input.projectId}`);
    }
    if (input.reports.length === 0) return [];
    const stepObjects = await Promise.all(phase.stepIds.map((id) => this.repository.read(id)));
    const steps = stepObjects.map((object) => {
      if (object.objectType !== 'step' || object.phaseId !== phase.id) {
        throw new Error(`PM intake found a non-Phase Step in ${phase.name}`);
      }
      return object;
    });
    const acceptance = steps.find((step) => step.type === 'FUNCTIONAL_TEST');
    if (!acceptance) throw new Error(`PM intake requires a complete V-model Phase: ${phase.name}`);

    const creatorActorId = await this.registration.projectManagerActorId(input.projectId);
    const queued: Array<{ ticket: Ticket; order: number }> = [];
    for (const report of deduplicateReports(input.reports)) {
      const target = reportTarget(steps, acceptance, report);
      const reportText = renderProblemReport(input.origin, report);
      let ticket: Ticket;
      if (report.category === 'dependency') {
        ticket = await this.corrective.routeDependencyChange({
          requestingStepId: acceptance.id,
          packages: report.dependencyPackages,
          reason: reportText,
          creatorActorId,
          correlationId: input.correlationId,
          sourceKind: 'pm-intake',
          sourceExternalId: `${input.origin}:${phase.name}`,
        });
        queued.push({ ticket, order: Number.MAX_SAFE_INTEGER });
        continue;
      }
      if (report.category === 'test-defect' || report.category === 'product-defect') {
        ticket = await this.corrective.routeFailure({
          creatorActorId,
          failedStepId: target.id,
          targetStepId: target.id,
          message: reportText,
          summary: report.summary,
          bugKind: 'delivery-gate',
          failure: {
            kind: 'execution',
            category: report.category === 'test-defect' ? 'contract' : 'test',
            code: `phase_delivery_${report.category.replaceAll('-', '_')}`,
            message: reportText,
            retryable: true,
            switchProvider: false,
            details: {
              reportOrigin: input.origin,
              findingTarget: report.target,
              evidence: report.evidence,
              scene: report.scene,
            },
          },
          correlationId: input.correlationId,
          sourceKind: 'pm-intake',
          sourceExternalId: `${input.origin}:${phase.name}`,
        });
      } else {
        ticket = await this.corrective.routeQualityGap({
          creatorActorId,
          sourceStepId: target.id,
          targetStepId: target.id,
          finding: reportText,
          kind: report.category === 'test-incomplete'
            ? 'test-incomplete'
            : report.category === 'deliverable-defect'
              ? 'functional-gap'
              : 'quality-shortfall',
          correlationId: input.correlationId,
          sourceKind: 'pm-intake',
          sourceExternalId: `${input.origin}:${phase.name}`,
        });
      }
      queued.push({ ticket, order: STEP_TYPE_ORDER[target.type] });
    }

    const registered = await this.registration.registerGateBatch(
      queued.sort((left, right) => left.order - right.order).map(({ ticket }) => ticket.id),
    );
    return registered;
  }
}

function reportTarget(
  steps: readonly Step[],
  acceptance: Step,
  report: DeliveryGateFinding,
): Step {
  if (report.target === 'current-step') return acceptance;
  if (report.target === 'paired-source') {
    const paired = acceptance.pairedStepId
      ? steps.find((step) => step.id === acceptance.pairedStepId)
      : undefined;
    if (!paired) throw new Error(`PM intake cannot resolve paired source for ${acceptance.name}`);
    return paired;
  }
  const type = report.target === 'requirement-analysis'
    ? 'REQUIREMENT_ANALYSIS'
    : report.target === 'high-level-design'
      ? 'HIGH_LEVEL_DESIGN'
      : report.target === 'detailed-design'
        ? 'DETAILED_DESIGN'
        : 'CODE';
  const target = steps.find((step) => step.type === type);
  if (!target) throw new Error(`PM intake cannot route report to missing ${type} Step`);
  return target;
}

function renderProblemReport(origin: ProjectManagerProblemOrigin, report: DeliveryGateFinding): string {
  return [
    `origin=${origin}`,
    report.summary,
    ...report.evidence,
  ].join('\n');
}

function deduplicateReports(reports: readonly DeliveryGateFinding[]): DeliveryGateFinding[] {
  const seen = new Set<string>();
  return reports.filter((report) => {
    const key = JSON.stringify({
      category: report.category,
      summary: report.summary,
      target: report.target,
      packages: [...report.dependencyPackages].sort(),
      scenario: report.scene?.scenario.name,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
