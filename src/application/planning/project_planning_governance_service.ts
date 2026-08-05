import type { Plan } from '../../core/plan.js';
import type { Project } from '../../domain/projects/project.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { GovernanceService } from '../project_management/governance_service.js';
import {
  ProjectStatusProjectionService,
  type ProjectProjectionWriter,
} from '../project_management/project_projection.js';
import { TicketRegistrationService } from '../project_management/ticket_registration_service.js';

export class ProjectPlanningGovernanceService {
  private readonly governance: GovernanceService;
  private readonly tickets: TicketRegistrationService;
  private readonly projection: ProjectStatusProjectionService;

  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    projectionWriter?: ProjectProjectionWriter,
  ) {
    this.governance = new GovernanceService(repository);
    this.tickets = new TicketRegistrationService(repository);
    this.projection = new ProjectStatusProjectionService(repository, projectionWriter);
  }

  async baseline(input: {
    project: Project;
    plan: Plan;
    clarifications?: Array<{ question: string; answer: string; why?: string; options?: string[] }>;
  }): Promise<void> {
    const { project, plan } = input;
    await this.tickets.registerProjectTickets(project.id);
    for (const clarification of input.clarifications ?? []) {
      const request = await this.governance.requestInteraction({
        projectId: project.id,
        requestedByActorId: project.pmActorId,
        interactionType: 'clarification',
        prompt: clarification.question,
        choices: clarification.options,
        risk: clarification.why ?? 'Clarification affects the baselined project scope and acceptance criteria.',
        correlationId: project.projectPlanId,
      });
      await this.governance.answerInteraction(request.id, clarification.answer);
    }
    const phaseObjects = await Promise.all(project.phaseIds.map((id) => this.repository.read(id)));
    const phases = phaseObjects.map((object) => {
      if (object.objectType !== 'phase') {
        throw new Error(`Project ${project.name} references non-Phase object ${object.id}`);
      }
      return object;
    });
    const active = phases.find((phase) => phase.id === project.currentPhaseId);
    if (!active) throw new Error(`Project ${project.name} has no active Phase for PM baselining`);
    await this.governance.recordDecision({
      projectId: project.id,
      decisionType: 'phase',
      decidedByActorId: project.pmActorId,
      authority: 'project-manager',
      options: phases.map((phase) => phase.name),
      selected: active.name,
      rationale:
        `Selected ${active.name} from ${phases.length} Phase(s) using the Planner complexity assessment ` +
        `${plan.complexityAssessment?.level ?? 'unspecified'} and declared priority order.`,
      confidence: plan.complexityAssessment ? 1 : 0.7,
      evidenceRefs: [project.projectPlanId, active.planId],
      correlationId: project.projectPlanId,
      causationId: active.id,
    });
    await this.projection.refresh(project.id);
  }
}
