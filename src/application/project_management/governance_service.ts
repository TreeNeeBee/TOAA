import { createObjectEnvelope, reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  DecisionRecordSchema,
  InteractionRequestSchema,
  ProjectManagementPlanSchema,
  RiskRecordSchema,
  transitionInteractionRequest,
  transitionRiskRecord,
  type DecisionRecord,
  type InteractionRequest,
  type ProjectManagementPlan,
  type RiskRecord,
} from '../../domain/project_management/index.js';
import { createDomainEvent } from '../observability/domain_event_factory.js';

export interface DecisionInput {
  projectId: ObjectId;
  decisionType: DecisionRecord['decisionType'];
  decidedByActorId: ObjectId;
  authority: DecisionRecord['authority'];
  options: string[];
  selected: string;
  rationale: string;
  confidence: number;
  evidenceRefs?: string[];
  correlationId: ObjectId;
  causationId?: ObjectId;
  now?: string;
}

export interface PreparedDecision {
  decision: DecisionRecord;
  managementPlan: ProjectManagementPlan;
}

export class GovernanceService {
  constructor(private readonly repository: DomainObjectRepositoryPort) {}

  async buildDecision(input: DecisionInput): Promise<DecisionRecord> {
    const actor = await this.repository.read(input.decidedByActorId);
    if (actor.objectType !== 'actor-registration' || actor.projectId !== input.projectId) {
      throw new Error(`Decision actor ${input.decidedByActorId} is not registered to Project ${input.projectId}`);
    }
    const now = input.now ?? new Date().toISOString();
    return DecisionRecordSchema.parse({
      ...createObjectEnvelope({
        name: `DEC-${input.decisionType}-${Date.now()}`,
        objectType: 'decision-record',
        projectId: input.projectId,
        now,
      }),
      decisionType: input.decisionType,
      decidedByActorId: input.decidedByActorId,
      authority: input.authority,
      options: input.options,
      selected: input.selected,
      rationale: input.rationale,
      confidence: input.confidence,
      evidenceRefs: input.evidenceRefs ?? [],
      correlationId: input.correlationId,
      causationId: input.causationId,
      decidedAt: now,
    });
  }

  async prepareDecision(input: DecisionInput): Promise<PreparedDecision> {
    const decision = await this.buildDecision(input);
    const plan = await this.requirePlan(input.projectId);
    const now = input.now ?? decision.decidedAt;
    return {
      decision,
      managementPlan: ProjectManagementPlanSchema.parse({
        ...plan,
        ...reviseObjectEnvelope(plan, { now }),
        decisionRecordIds: [...plan.decisionRecordIds, decision.id],
      }),
    };
  }

  async recordDecision(input: DecisionInput): Promise<DecisionRecord> {
    const prepared = await this.prepareDecision(input);
    await this.repository.commit([
      prepared.decision,
      prepared.managementPlan,
      createDomainEvent({
        projectId: input.projectId,
        aggregate: { id: prepared.decision.id, objectType: 'decision-record' },
        eventType: 'governance.decision_recorded',
        payload: { decisionType: input.decisionType, selected: input.selected },
        correlationId: input.correlationId,
        causationId: input.causationId,
        now: input.now,
      }),
    ]);
    return prepared.decision;
  }

  async identifyRisk(input: {
    projectId: ObjectId;
    ownerActorId: ObjectId;
    category: RiskRecord['category'];
    description: string;
    probability: number;
    impact: number;
    mitigation: string[];
    trigger?: string;
    relatedTicketIds?: ObjectId[];
    correlationId: ObjectId;
    causationId?: ObjectId;
  }): Promise<RiskRecord> {
    const plan = await this.requirePlan(input.projectId);
    const risk = RiskRecordSchema.parse({
      ...createObjectEnvelope({
        name: `RISK-${input.category}-${Date.now()}`,
        objectType: 'risk-record',
        projectId: input.projectId,
      }),
      ownerActorId: input.ownerActorId,
      category: input.category,
      description: input.description,
      probability: input.probability,
      impact: input.impact,
      status: 'identified',
      mitigation: input.mitigation,
      trigger: input.trigger,
      relatedTicketIds: input.relatedTicketIds ?? [],
    });
    const updatedPlan = ProjectManagementPlanSchema.parse({
      ...plan,
      ...reviseObjectEnvelope(plan),
      riskRecordIds: [...plan.riskRecordIds, risk.id],
    });
    await this.repository.commit([
      risk,
      updatedPlan,
      createDomainEvent({
        projectId: input.projectId,
        aggregate: { id: risk.id, objectType: 'risk-record' },
        eventType: 'governance.risk_identified',
        payload: { category: risk.category, exposure: risk.probability * risk.impact },
        correlationId: input.correlationId,
        causationId: input.causationId,
      }),
    ]);
    return risk;
  }

  async transitionRisk(
    riskId: ObjectId,
    next: RiskRecord['status'],
    changes: { mitigation?: string[] } = {},
    context: { correlationId?: ObjectId; causationId?: ObjectId } = {},
  ): Promise<RiskRecord> {
    const object = await this.repository.read(riskId);
    if (object.objectType !== 'risk-record') throw new Error(`Object ${riskId} is not a Risk Record`);
    const updated = transitionRiskRecord(object, next, changes);
    if (updated === object) return object;
    await this.repository.commit([
      updated,
      createDomainEvent({
        projectId: updated.projectId,
        aggregate: { id: updated.id, objectType: 'risk-record' },
        eventType: `governance.risk_${next}`,
        payload: { previousStatus: object.status, status: next },
        correlationId: context.correlationId ?? updated.id,
        causationId: context.causationId ?? object.id,
        objectRevision: updated.revision,
      }),
    ]);
    return updated;
  }

  async requestInteraction(input: {
    projectId: ObjectId;
    requestedByActorId: ObjectId;
    interactionType: InteractionRequest['interactionType'];
    prompt: string;
    choices?: string[];
    risk: string;
    relatedTicketId?: ObjectId;
    correlationId: ObjectId;
  }): Promise<InteractionRequest> {
    const plan = await this.requirePlan(input.projectId);
    const now = new Date().toISOString();
    const request = InteractionRequestSchema.parse({
      ...createObjectEnvelope({
        name: `INTERACTION-${input.interactionType}-${Date.now()}`,
        objectType: 'interaction-request',
        projectId: input.projectId,
        now,
      }),
      requestedByActorId: input.requestedByActorId,
      interactionType: input.interactionType,
      status: 'pending',
      prompt: input.prompt,
      choices: input.choices ?? [],
      risk: input.risk,
      relatedTicketId: input.relatedTicketId,
      correlationId: input.correlationId,
      requestedAt: now,
    });
    const updatedPlan = ProjectManagementPlanSchema.parse({
      ...plan,
      ...reviseObjectEnvelope(plan, { now }),
      interactionRequestIds: [...plan.interactionRequestIds, request.id],
    });
    await this.repository.commit([
      request,
      updatedPlan,
      createDomainEvent({
        projectId: input.projectId,
        aggregate: { id: request.id, objectType: 'interaction-request' },
        eventType: 'governance.interaction_requested',
        payload: { interactionType: request.interactionType, relatedTicketId: request.relatedTicketId },
        correlationId: input.correlationId,
        causationId: input.relatedTicketId,
        now,
      }),
    ]);
    return request;
  }

  async answerInteraction(requestId: ObjectId, response: string): Promise<InteractionRequest> {
    const object = await this.repository.read(requestId);
    if (object.objectType !== 'interaction-request') {
      throw new Error(`Object ${requestId} is not an Interaction Request`);
    }
    const updated = transitionInteractionRequest(object, 'answered', { response });
    await this.repository.commit([
      updated,
      createDomainEvent({
        projectId: updated.projectId,
        aggregate: { id: updated.id, objectType: 'interaction-request' },
        eventType: 'governance.interaction_answered',
        payload: { interactionType: updated.interactionType },
        correlationId: updated.correlationId,
        causationId: updated.id,
      }),
    ]);
    return updated;
  }

  private async requirePlan(projectId: ObjectId): Promise<ProjectManagementPlan> {
    const project = await this.repository.read(projectId);
    if (project.objectType !== 'project') throw new Error(`Object ${projectId} is not a Project`);
    const plan = await this.repository.read(project.managementPlanId);
    if (plan.objectType !== 'project-management-plan') {
      throw new Error(`Project ${project.name} has no Project Management Plan`);
    }
    return plan;
  }
}
