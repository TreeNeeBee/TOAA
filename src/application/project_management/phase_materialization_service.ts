import type { Plan } from '../../core/plan.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import { reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import { compilePhaseMaterialization } from '../../domain/planning/compiler.js';
import { ProjectPlanSchema } from '../../domain/planning/plan.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { TicketRegistrationService } from './ticket_registration_service.js';

export class PhaseMaterializationService {
  constructor(private readonly repository: DomainObjectRepositoryPort) {}

  async materialize(input: {
    projectId: ObjectId;
    phaseId: ObjectId;
    plan: Plan;
  }): Promise<void> {
    const project = await this.repository.read(input.projectId);
    const phase = await this.repository.read(input.phaseId);
    if (project.objectType !== 'project') {
      throw new Error(`Object ${input.projectId} is not a Project`);
    }
    if (phase.objectType !== 'phase') {
      throw new Error(`Object ${input.phaseId} is not a Phase`);
    }

    const phasePlan = await this.repository.read(phase.planId);
    const epic = await this.repository.read(phase.epicTicketId);
    if (phasePlan.objectType !== 'plan' || phasePlan.planKind !== 'phase') {
      throw new Error(`Phase ${phase.name} does not reference a PhasePlan`);
    }
    if (epic.objectType !== 'ticket' || epic.type !== 'epic') {
      throw new Error(`Phase ${phase.name} does not reference an Epic Ticket`);
    }

    const actors = (await this.repository.list({
      objectType: 'actor-registration',
      projectId: project.id,
    })).filter((object) => object.objectType === 'actor-registration');
    const materialization = compilePhaseMaterialization({
      draft: input.plan,
      project,
      phase,
      phasePlan,
      epic,
      actors,
    });

    const currentProjectPlan = await this.repository.read(project.projectPlanId);
    if (currentProjectPlan.objectType !== 'plan' || currentProjectPlan.planKind !== 'project') {
      throw new Error(`Project ${project.name} does not reference a ProjectPlan`);
    }
    const projectPlan = ProjectPlanSchema.parse({
      ...currentProjectPlan,
      ...reviseObjectEnvelope(currentProjectPlan),
      activePhaseId: phase.id,
    });

    await this.repository.commit([
      materialization.epic,
      ...materialization.steps,
      ...materialization.tickets,
      ...materialization.kpis,
      ...materialization.deliverables,
      materialization.phasePlan,
      materialization.phase,
      projectPlan,
    ]);
    const registration = new TicketRegistrationService(this.repository);
    for (const ticket of materialization.tickets) {
      await registration.register(ticket.id);
    }
  }
}
