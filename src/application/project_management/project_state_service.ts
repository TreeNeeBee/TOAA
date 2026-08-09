import type { PendingReason } from '../../domain/workflow/pending_reason.js';
import { createHash } from 'node:crypto';
import { CheckpointSchema, type Checkpoint } from '../../domain/evidence/evidence.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import { createObjectEnvelope, reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import {
  objectRevisionRef,
  type DomainObjectRepositoryPort,
} from '../../domain/ports/repository.js';
import { transitionPhase, type Phase } from '../../domain/phases/phase.js';
import { ProjectPlanSchema } from '../../domain/planning/plan.js';
import {
  ProjectManagementPlanSchema,
  transitionManagementPlan,
  type DecisionRecord,
  type ProjectManagementPlan,
  type ProjectManagementPlanState,
} from '../../domain/project_management/index.js';
import { ProjectSchema, transitionProject, type Project } from '../../domain/projects/project.js';
import { StepSchema, transitionStep, type Step } from '../../domain/steps/step.js';
import type { Ticket } from '../../domain/tickets/ticket.js';
import type { PersistedDomainObject } from '../../domain/objects/persisted.js';
import { createDomainEvent } from '../observability/domain_event_factory.js';
import { GovernanceService } from './governance_service.js';
import { TicketLifecycleService } from './ticket_lifecycle_service.js';

export class ProjectStateService {
  private readonly governance: GovernanceService;
  private readonly lifecycle: TicketLifecycleService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.governance = new GovernanceService(repository);
    this.lifecycle = new TicketLifecycleService(repository);
  }

  async requirePhase(id: ObjectId): Promise<Phase> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'phase') throw new Error(`Object ${id} is not a Phase`);
    return object;
  }

  async requireProject(id: ObjectId): Promise<Project> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'project') throw new Error(`Object ${id} is not a Project`);
    return object;
  }

  async requireStep(id: ObjectId): Promise<Step> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'step') throw new Error(`Object ${id} is not a Step`);
    return object;
  }

  async requireTicket(id: ObjectId): Promise<Ticket> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'ticket') throw new Error(`Object ${id} is not a Ticket`);
    return object;
  }

  async ticketOwnerActorId(ticketId: ObjectId): Promise<ObjectId> {
    const ticket = await this.requireTicket(ticketId);
    if (!ticket.activeAssignmentId) {
      throw new Error(`Ticket ${ticket.name} has no active owner assignment`);
    }
    const assignment = await this.repository.read(ticket.activeAssignmentId);
    if (assignment.objectType !== 'ticket-assignment' || assignment.state !== 'accepted') {
      throw new Error(`Ticket ${ticket.name} active assignment is not accepted`);
    }
    return assignment.assigneeActorId;
  }

  async requirePassingQualityAssessment(step: Step, id: ObjectId): Promise<void> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'quality-assessment') {
      throw new Error(`Object ${id} is not a Quality Assessment`);
    }
    if (object.subject.objectType !== 'step' || object.subject.id !== step.id) {
      throw new Error(`Quality Assessment ${object.name} does not assess Step ${step.name}`);
    }
    if (!object.passed) {
      throw new Error(`Quality Assessment ${object.name} did not pass: ${object.gaps.join('; ')}`);
    }
  }

  async attachQuality(step: Step, qualityAssessmentId: ObjectId): Promise<Step> {
    const updated = reviseStep(step, { qualityAssessmentId });
    await this.repository.update(updated, updated.state);
    return updated;
  }

  async checkpoint(step: Step, reason: string): Promise<Checkpoint> {
    const current = await this.requireStep(step.id);
    const entry = this.repository.registry.require(current.id, 'step');
    const snapshotRefs = [objectRevisionRef(entry)];
    const checkpoint = CheckpointSchema.parse({
      ...createObjectEnvelope({
        name: `${current.name}-CP${String(current.checkpointIds.length + 1).padStart(3, '0')}`,
        objectType: 'checkpoint',
        projectId: current.projectId,
      }),
      subject: { id: current.id, objectType: 'step' },
      eventSequence: this.repository.registry.currentEventSequence(),
      snapshotRefs,
      contentHash: `sha256:${createHash('sha256').update(JSON.stringify(snapshotRefs)).digest('hex')}`,
      reason,
    });
    const updated = reviseStep(current, {
      checkpointIds: [...current.checkpointIds, checkpoint.id],
    });
    await this.repository.commit([checkpoint, updated]);
    return checkpoint;
  }

  async moveStepPending(step: Step, reason: 'defect' | 'quality-gap' | 'dependency'): Promise<Step> {
    let current = step;
    if (current.state === 'delivered' || current.state === 'closed') {
      current = await this.transitionStep(current, 'reopened');
    }
    if (current.state === 'created' || current.state === 'reopened') {
      current = await this.transitionStep(current, 'in_progress');
    }
    if (current.state === 'in_progress') {
      current = await this.transitionStep(current, 'pending', reason);
    }
    return current;
  }

  /**
   * Builds the Step side of a corrective route without committing it.
   *
   * TicketWorkflow commits these revisions together with the discovered Bug/Enhancement and its
   * blocker edges. Keeping this as a prepared batch prevents a crash from leaving a pending source
   * Step or reopened target Step with no corrective Ticket for PM to schedule.
   */
  prepareCorrectiveRouting(
    source: Step,
    target: Step,
    reason: 'defect' | 'quality-gap',
  ): { source: Step; target: Step; objects: PersistedDomainObject[] } {
    const pending = this.prepareStepPending(source, reason);
    const objects: PersistedDomainObject[] = [...pending.objects];
    const preparedSource = pending.step;
    const advance = (step: Step, next: Parameters<typeof transitionStep>[1], pendingReason?: PendingReason) => {
      const updated = transitionStep(step, next, { pendingReason });
      objects.push(updated, stepTransitionEvent(step, updated, pendingReason));
      return updated;
    };

    let preparedTarget = target.id === source.id ? preparedSource : target;
    if (
      preparedTarget.id !== preparedSource.id &&
      (preparedTarget.state === 'delivered' || preparedTarget.state === 'closed')
    ) {
      preparedTarget = advance(preparedTarget, 'reopened');
    }
    return { source: preparedSource, target: preparedTarget, objects };
  }

  /** Prepares an additional discovering Step to wait on the corrective Ticket atomically. */
  prepareStepPending(
    source: Step,
    reason: 'defect' | 'quality-gap' | 'dependency',
  ): { step: Step; objects: PersistedDomainObject[] } {
    const objects: PersistedDomainObject[] = [];
    let step = source;
    const advance = (next: Parameters<typeof transitionStep>[1], pendingReason?: PendingReason) => {
      const updated = transitionStep(step, next, { pendingReason });
      objects.push(updated, stepTransitionEvent(step, updated, pendingReason));
      step = updated;
    };
    if (step.state === 'delivered' || step.state === 'closed') advance('reopened');
    if (step.state === 'created' || step.state === 'reopened') advance('in_progress');
    if (step.state === 'in_progress') advance('pending', reason);
    return { step, objects };
  }

  async transitionStep(
    step: Step,
    next: Parameters<typeof transitionStep>[1],
    pendingReason?: PendingReason,
  ): Promise<Step> {
    if (step.state === next) return step;
    const updated = transitionStep(step, next, { pendingReason });
    await this.repository.commit([updated, stepTransitionEvent(step, updated, pendingReason)]);
    return updated;
  }

  async transitionPhase(
    phase: Phase,
    next: Parameters<typeof transitionPhase>[1],
  ): Promise<Phase> {
    if (phase.state === next) return phase;
    const updated = transitionPhase(phase, next);
    const project = await this.requireProject(phase.projectId);
    const decision = await this.governance.prepareDecision({
      projectId: project.id,
      decisionType: 'phase',
      decidedByActorId: project.pmActorId,
      authority: 'project-manager',
      options: [`remain:${phase.state}`, `transition:${next}`],
      selected: `transition:${next}`,
      rationale: `Advance Phase ${phase.name} from ${phase.state} to ${next} under its delivery gates.`,
      confidence: 1,
      evidenceRefs: [phase.name],
      correlationId: phase.id,
      causationId: project.id,
    });
    await this.repository.commit([
      decision.decision,
      decision.managementPlan,
      updated,
      decisionRecordedEvent(decision.decision),
      createDomainEvent({
        projectId: phase.projectId,
        aggregate: { id: phase.id, objectType: 'phase' },
        eventType: `phase.${next}`,
        payload: { fromState: phase.state, toState: next, decisionId: decision.decision.id },
        phaseId: phase.id,
        correlationId: phase.id,
        causationId: project.id,
        objectRevision: updated.revision,
      }),
    ]);
    return updated;
  }

  async transitionProject(
    project: Project,
    next: Parameters<typeof transitionProject>[1],
  ): Promise<Project> {
    if (project.state === next) return project;
    const updated = transitionProject(project, next);
    const planObject = await this.repository.read(project.managementPlanId);
    if (planObject.objectType !== 'project-management-plan') {
      throw new Error(`Project ${project.name} does not reference a Project Management Plan`);
    }
    const decision = await this.governance.buildDecision({
      projectId: project.id,
      decisionType: next === 'delivered' || next === 'closed' ? 'delivery' : 'phase',
      decidedByActorId: project.pmActorId,
      authority: 'project-manager',
      options: [`remain:${project.state}`, `transition:${next}`],
      selected: `transition:${next}`,
      rationale: `Advance Project ${project.name} from ${project.state} to ${next}.`,
      confidence: 1,
      evidenceRefs: [project.name],
      correlationId: project.id,
      causationId: project.currentPhaseId,
    });
    const managementPlan = updateManagementPlanForProject(planObject, updated, decision.id);
    await this.repository.commit([
      decision,
      managementPlan,
      updated,
      decisionRecordedEvent(decision),
      createDomainEvent({
        projectId: project.id,
        aggregate: { id: project.id, objectType: 'project' },
        eventType: `project.${next}`,
        payload: {
          fromState: project.state,
          toState: next,
          managementStatus: managementPlan.status,
          decisionId: decision.id,
        },
        correlationId: project.id,
        causationId: project.currentPhaseId,
        objectRevision: updated.revision,
      }),
    ]);
    return updated;
  }

  async selectCurrentPhase(project: Project, phase: Phase): Promise<Project> {
    if (phase.projectId !== project.id || !project.phaseIds.includes(phase.id)) {
      throw new Error(`Phase ${phase.name} does not belong to Project ${project.name}`);
    }
    const planObject = await this.repository.read(project.projectPlanId);
    if (planObject.objectType !== 'plan' || planObject.planKind !== 'project') {
      throw new Error(`Project ${project.name} does not reference a Project Plan`);
    }
    const prepared = await this.governance.prepareDecision({
      projectId: project.id,
      decisionType: 'phase',
      decidedByActorId: project.pmActorId,
      authority: 'project-manager',
      options: project.phaseIds.map((id) => `phase:${id}`),
      selected: `phase:${phase.id}`,
      rationale: `Select ${phase.name} as the next dependency-ready Phase.`,
      confidence: 1,
      evidenceRefs: [...phase.dependencyPhaseIds],
      correlationId: phase.id,
      causationId: project.currentPhaseId,
    });
    const updatedProject = ProjectSchema.parse({
      ...project,
      ...reviseObjectEnvelope(project),
      currentPhaseId: phase.id,
    });
    const projectPlan = ProjectPlanSchema.parse({
      ...planObject,
      ...reviseObjectEnvelope(planObject),
      activePhaseId: phase.id,
    });
    await this.repository.commit([
      prepared.decision,
      prepared.managementPlan,
      updatedProject,
      projectPlan,
      decisionRecordedEvent(prepared.decision),
      createDomainEvent({
        projectId: project.id,
        aggregate: { id: project.id, objectType: 'project' },
        eventType: 'project.phase_selected',
        payload: { phaseId: phase.id, previousPhaseId: project.currentPhaseId },
        phaseId: phase.id,
        correlationId: phase.id,
        causationId: project.currentPhaseId,
        objectRevision: updatedProject.revision,
      }),
    ]);
    return updatedProject;
  }

  async transitionTicket(
    ticket: Ticket,
    next: Parameters<TicketLifecycleService['transition']>[1],
    pendingReason?: 'defect' | 'quality-gap',
  ): Promise<Ticket> {
    return this.lifecycle.transition(ticket, next, { pendingReason });
  }

  async transitionTicketPath(
    ticket: Ticket,
    path: readonly Parameters<TicketLifecycleService['transition']>[1][],
    pendingReason?: 'defect' | 'quality-gap',
  ): Promise<Ticket> {
    return this.lifecycle.transitionPath(ticket, path, { pendingReason });
  }
}

function stepTransitionEvent(
  previous: Step,
  updated: Step,
  pendingReason?: PendingReason,
): PersistedDomainObject {
  return createDomainEvent({
    projectId: previous.projectId,
    aggregate: { id: previous.id, objectType: 'step' },
    eventType: `step.${updated.state}`,
    payload: {
      stepType: previous.type,
      fromState: previous.state,
      toState: updated.state,
      pendingReason,
    },
    phaseId: previous.phaseId,
    stepId: previous.id,
    correlationId: previous.id,
    causationId: previous.phaseId,
    objectRevision: updated.revision,
  });
}

function reviseStep(
  step: Step,
  changes: Partial<Pick<Step, 'qualityAssessmentId' | 'checkpointIds' | 'attempts'>>,
): Step {
  return StepSchema.parse({
    ...step,
    ...reviseObjectEnvelope(step),
    ...changes,
  });
}

function updateManagementPlanForProject(
  plan: ProjectManagementPlan,
  project: Project,
  decisionId: ObjectId,
): ProjectManagementPlan {
  const targetStatus = managementStatusForProject(project.state);
  const revised = targetStatus && targetStatus !== plan.status
    ? transitionManagementPlan(plan, targetStatus)
    : ProjectManagementPlanSchema.parse({ ...plan, ...reviseObjectEnvelope(plan) });
  return ProjectManagementPlanSchema.parse({
    ...revised,
    decisionRecordIds: [...revised.decisionRecordIds, decisionId],
  });
}

function managementStatusForProject(
  state: Project['state'],
): ProjectManagementPlanState | undefined {
  if (state === 'in_progress') return 'active';
  if (state === 'delivered') return 'delivered';
  if (state === 'closed') return 'closed';
  return undefined;
}

function decisionRecordedEvent(decision: DecisionRecord) {
  return createDomainEvent({
    projectId: decision.projectId,
    aggregate: { id: decision.id, objectType: 'decision-record' },
    eventType: 'governance.decision_recorded',
    payload: { decisionType: decision.decisionType, selected: decision.selected },
    correlationId: decision.correlationId,
    causationId: decision.causationId,
    now: decision.decidedAt,
  });
}
