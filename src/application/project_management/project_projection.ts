import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { ProjectState } from '../../domain/projects/project.js';
import type { PhaseState } from '../../domain/phases/phase.js';
import type { TicketState, TicketType } from '../../domain/tickets/ticket.js';
import type { DomainRole } from '../../domain/workflow/role.js';
import { createHash } from 'node:crypto';
import { TicketFlowMetricsService, type TicketFlowMetrics } from './ticket_flow_metrics.js';

export interface ProjectStatusProjection {
  schemaVersion: 1;
  projectId: ObjectId;
  projectName: string;
  projectState: ProjectState;
  managementStatus: string;
  currentPhase?: { id: ObjectId; name: string; state: PhaseState };
  phases: Array<{ id: ObjectId; name: string; state: PhaseState }>;
  ticketCounts: Partial<Record<TicketState, number>>;
  ticketTypeCounts: Partial<Record<TicketType, number>>;
  activeTickets: Array<{
    id: ObjectId;
    name: string;
    type: TicketType;
    state: TicketState;
    role: DomainRole;
    ownerActorId?: ObjectId;
    ownerName?: string;
  }>;
  actors: Array<{
    id: ObjectId;
    name: string;
    role: DomainRole;
    state: string;
    activeAssignments: number;
    capacity: number;
  }>;
  governance: {
    decisionCount: number;
    openRiskCount: number;
    realizedRiskCount: number;
    pendingInteractionCount: number;
  };
  flowMetrics: TicketFlowMetrics;
  sourceRevisions: Record<string, number>;
  sourceChecksum: string;
  registrySequence: number;
  allowedActions: string[];
  activeTicketsTruncated: boolean;
  generatedAt: string;
}

export interface ProjectProjectionWriter {
  write(projection: ProjectStatusProjection): Promise<void>;
  read?(projectId: ObjectId): Promise<ProjectStatusProjection | undefined>;
  remove?(projectId: ObjectId): Promise<void>;
}

export class ProjectStatusProjectionService {
  private readonly flowMetrics: TicketFlowMetricsService;

  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    private readonly writer?: ProjectProjectionWriter,
  ) {
    this.flowMetrics = new TicketFlowMetricsService(repository);
  }

  async current(projectId: ObjectId): Promise<ProjectStatusProjection> {
    const cached = await this.writer?.read?.(projectId);
    if (
      cached?.schemaVersion === 1 &&
      cached.projectId === projectId &&
      cached.registrySequence === this.repository.registry.currentEventSequence() &&
      cached.sourceChecksum === checksumRevisions(cached.sourceRevisions)
    ) return cached;
    return this.refresh(projectId);
  }

  async refresh(projectId: ObjectId): Promise<ProjectStatusProjection> {
    const projectObject = await this.repository.read(projectId);
    if (projectObject.objectType !== 'project') throw new Error(`Object ${projectId} is not a Project`);
    const objects = await this.repository.list({ projectId });
    const phases = objects.filter((object) => object.objectType === 'phase');
    const tickets = objects.filter((object) => object.objectType === 'ticket');
    const actors = objects.filter((object) => object.objectType === 'actor-registration');
    const assignments = new Map(objects
      .filter((object) => object.objectType === 'ticket-assignment')
      .map((assignment) => [assignment.id, assignment]));
    const actorById = new Map(actors.map((actor) => [actor.id, actor]));
    const management = objects.find(
      (object) => object.objectType === 'project-management-plan' && object.id === projectObject.managementPlanId,
    );
    if (!management || management.objectType !== 'project-management-plan') {
      throw new Error(`Project ${projectObject.name} has no Project Management Plan`);
    }
    const risks = objects.filter((object) => object.objectType === 'risk-record');
    const decisions = objects.filter((object) => object.objectType === 'decision-record');
    const interactions = objects.filter((object) => object.objectType === 'interaction-request');
    const sourceRevisions = Object.fromEntries(
      objects
        .map((object) => [object.id, object.revision] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    const activeTickets = tickets.filter((ticket) =>
      ticket.objectType === 'ticket' && ticket.state !== 'closed' && ticket.state !== 'cancelled',
    );
    const projection: ProjectStatusProjection = {
      schemaVersion: 1,
      projectId,
      projectName: projectObject.name,
      projectState: projectObject.state,
      managementStatus: management.status,
      currentPhase: projectObject.currentPhaseId
        ? phases.filter((phase) => phase.objectType === 'phase')
          .filter((phase) => phase.id === projectObject.currentPhaseId)
          .map((phase) => ({ id: phase.id, name: phase.name, state: phase.state }))[0]
        : undefined,
      phases: phases.filter((phase) => phase.objectType === 'phase')
        .map((phase) => ({ id: phase.id, name: phase.name, state: phase.state })),
      ticketCounts: countBy(tickets.filter((ticket) => ticket.objectType === 'ticket'), (ticket) => ticket.state),
      ticketTypeCounts: countBy(tickets.filter((ticket) => ticket.objectType === 'ticket'), (ticket) => ticket.type),
      activeTickets: activeTickets.slice(0, 200).map((ticket) => {
        if (ticket.objectType !== 'ticket') throw new Error('Ticket projection narrowed incorrectly');
        const assignment = ticket.activeAssignmentId ? assignments.get(ticket.activeAssignmentId) : undefined;
        const owner = assignment ? actorById.get(assignment.assigneeActorId) : undefined;
        return {
          id: ticket.id,
          name: ticket.name,
          type: ticket.type,
          state: ticket.state,
          role: ticket.role,
          ownerActorId: owner?.id,
          ownerName: owner?.name,
        };
      }),
      actors: actors.filter((actor) => actor.objectType === 'actor-registration').map((actor) => ({
        id: actor.id,
        name: actor.name,
        role: actor.role,
        state: actor.state,
        activeAssignments: actor.activeAssignmentIds.length,
        capacity: actor.capacity,
      })),
      governance: {
        decisionCount: decisions.length,
        openRiskCount: risks.filter((risk) => risk.objectType === 'risk-record' && risk.status !== 'closed').length,
        realizedRiskCount: risks.filter((risk) => risk.objectType === 'risk-record' && risk.status === 'realized').length,
        pendingInteractionCount: interactions.filter(
          (request) => request.objectType === 'interaction-request' && request.status === 'pending',
        ).length,
      },
      flowMetrics: await this.flowMetrics.calculate(projectId),
      sourceRevisions,
      sourceChecksum: checksumRevisions(sourceRevisions),
      registrySequence: this.repository.registry.currentEventSequence(),
      allowedActions: allowedProjectActions(projectObject.state, projectObject.currentPhaseId),
      activeTicketsTruncated: activeTickets.length > 200,
      generatedAt: new Date().toISOString(),
    };
    await this.writer?.write(projection);
    return projection;
  }
}

function checksumRevisions(revisions: Readonly<Record<string, number>>): string {
  const content = Object.entries(revisions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, revision]) => `${id}:${revision}`)
    .join('\n');
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function allowedProjectActions(state: ProjectState, currentPhaseId?: ObjectId): string[] {
  if (state === 'created') return ['baseline-project'];
  if (state === 'planning') return currentPhaseId ? ['authorize-phase'] : ['select-phase'];
  if (state === 'in_progress') return ['dispatch-ready-ticket', 'monitor-control', 'evaluate-phase-gate'];
  if (state === 'pending') return ['resolve-blocker', 'resume-project'];
  if (state === 'delivered') return ['close-project', 'reopen-project'];
  if (state === 'cancelled') return ['close-project', 'reopen-project'];
  return [];
}

function countBy<T, K extends string>(
  values: readonly T[],
  keyOf: (value: T) => K,
): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  for (const value of values) {
    const key = keyOf(value);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}
