import type { Phase } from '../phases/phase.js';
import type { Project } from '../projects/project.js';
import {
  STEP_TYPES,
  type Step,
} from '../steps/step.js';
import type { Ticket } from '../tickets/ticket.js';
import type { ObjectId } from '../identity/object_id.js';

export interface DomainGraph {
  project: Project;
  phases: Phase[];
  steps: Step[];
  tickets: Ticket[];
}

export interface DomainGraphIssue {
  code:
    | 'duplicate-id'
    | 'foreign-project'
    | 'missing-reference'
    | 'dependency-cycle'
    | 'invalid-v-model'
    | 'invalid-ticket-hierarchy';
  objectId: ObjectId;
  message: string;
}

export function validateDomainGraph(graph: DomainGraph): DomainGraphIssue[] {
  const issues: DomainGraphIssue[] = [];
  const objects = [graph.project, ...graph.phases, ...graph.steps, ...graph.tickets];
  const seen = new Set<ObjectId>();
  for (const object of objects) {
    if (seen.has(object.id)) {
      issues.push({ code: 'duplicate-id', objectId: object.id, message: `Duplicate object id ${object.id}` });
    }
    seen.add(object.id);
    if (object.projectId !== graph.project.id) {
      issues.push({
        code: 'foreign-project',
        objectId: object.id,
        message: `${object.objectType} ${object.id} belongs to project ${object.projectId}`,
      });
    }
  }

  const phases = new Map(graph.phases.map((phase) => [phase.id, phase]));
  const steps = new Map(graph.steps.map((step) => [step.id, step]));
  const tickets = new Map(graph.tickets.map((ticket) => [ticket.id, ticket]));

  validateExactReferences(graph.project.id, graph.project.phaseIds, phases, 'phase', issues);
  validateDependencyGraph(graph.phases, (phase) => phase.dependencyPhaseIds, issues);
  validateDependencyGraph(graph.steps, (step) => step.dependencyStepIds, issues);
  validateDependencyGraph(graph.tickets, (ticket) => ticket.dependencyTicketIds, issues);

  for (const phase of graph.phases) {
    validateExactReferences(phase.id, phase.stepIds, steps, 'step', issues);
    const phaseSteps = phase.stepIds.map((id) => steps.get(id)).filter((step): step is Step => !!step);
    if (phase.stepIds.length > 0) {
      const actualTypes = phaseSteps.map((step) => step.type);
      if (
        actualTypes.length !== STEP_TYPES.length ||
        STEP_TYPES.some((type, index) => actualTypes[index] !== type)
      ) {
        issues.push({
          code: 'invalid-v-model',
          objectId: phase.id,
          message: `Phase ${phase.name} must contain exactly ${STEP_TYPES.join(' -> ')}`,
        });
      }
      for (const step of phaseSteps) {
        if (step.phaseId !== phase.id) {
          issues.push({
            code: 'missing-reference',
            objectId: step.id,
            message: `Step ${step.name} does not reference containing phase ${phase.id}`,
          });
        }
        if (step.pairedStepId && !steps.has(step.pairedStepId)) {
          issues.push({
            code: 'missing-reference',
            objectId: step.id,
            message: `Step ${step.name} references missing paired Step ${step.pairedStepId}`,
          });
        }
      }
    }
    const epic = tickets.get(phase.epicTicketId);
    if (!epic || epic.type !== 'epic' || epic.phaseId !== phase.id) {
      issues.push({
        code: 'missing-reference',
        objectId: phase.id,
        message: `Phase ${phase.name} references an invalid Epic ${phase.epicTicketId}`,
      });
    }
  }

  for (const ticket of graph.tickets) {
    if (ticket.type === 'epic') {
      if (ticket.parentTicketId || ticket.rootTicketId !== ticket.id) {
        issues.push({
          code: 'invalid-ticket-hierarchy',
          objectId: ticket.id,
          message: `Epic ${ticket.name} must be its own root and cannot have a parent`,
        });
      }
      continue;
    }
    const parent = ticket.parentTicketId ? tickets.get(ticket.parentTicketId) : undefined;
    if (!parent) {
      issues.push({
        code: 'missing-reference',
        objectId: ticket.id,
        message: `Ticket ${ticket.name} has no registered parent`,
      });
      continue;
    }
    if (ticket.type === 'story' && parent.type !== 'epic') {
      issues.push({
        code: 'invalid-ticket-hierarchy',
        objectId: ticket.id,
        message: `Story ${ticket.name} must be a direct child of an Epic`,
      });
    }
    if (ticket.type === 'task') {
      const depth = taskDepth(ticket, tickets);
      if ((parent.type !== 'story' && parent.type !== 'task') || depth > 2) {
        issues.push({
          code: 'invalid-ticket-hierarchy',
          objectId: ticket.id,
          message: `Task ${ticket.name} exceeds the two-level task hierarchy`,
        });
      }
    }
    const root = tickets.get(ticket.rootTicketId);
    if (!root || root.type !== 'epic') {
      issues.push({
        code: 'missing-reference',
        objectId: ticket.id,
        message: `Ticket ${ticket.name} references invalid root Epic ${ticket.rootTicketId}`,
      });
    }
  }
  return issues;
}

export function assertDomainGraph(graph: DomainGraph): void {
  const issues = validateDomainGraph(graph);
  if (issues.length === 0) return;
  throw new Error(`Invalid domain graph:\n${issues.map((issue) => `- ${issue.code}: ${issue.message}`).join('\n')}`);
}

function validateExactReferences<T extends { id: ObjectId }>(
  ownerId: ObjectId,
  ids: readonly ObjectId[],
  objects: ReadonlyMap<ObjectId, T>,
  type: string,
  issues: DomainGraphIssue[],
): void {
  for (const id of ids) {
    if (!objects.has(id)) {
      issues.push({
        code: 'missing-reference',
        objectId: ownerId,
        message: `Missing ${type} reference ${id}`,
      });
    }
  }
}

function validateDependencyGraph<T extends { id: ObjectId }>(
  objects: readonly T[],
  dependencies: (object: T) => readonly ObjectId[],
  issues: DomainGraphIssue[],
): void {
  const byId = new Map(objects.map((object) => [object.id, object]));
  for (const object of objects) {
    for (const dependency of dependencies(object)) {
      if (!byId.has(dependency)) {
        issues.push({
          code: 'missing-reference',
          objectId: object.id,
          message: `Missing dependency ${dependency}`,
        });
      }
    }
  }
  const visiting = new Set<ObjectId>();
  const visited = new Set<ObjectId>();
  const visit = (object: T): boolean => {
    if (visiting.has(object.id)) return true;
    if (visited.has(object.id)) return false;
    visiting.add(object.id);
    for (const dependencyId of dependencies(object)) {
      const dependency = byId.get(dependencyId);
      if (dependency && visit(dependency)) return true;
    }
    visiting.delete(object.id);
    visited.add(object.id);
    return false;
  };
  for (const object of objects) {
    if (visit(object)) {
      issues.push({
        code: 'dependency-cycle',
        objectId: object.id,
        message: `Dependency cycle includes ${object.id}`,
      });
      break;
    }
  }
}

function taskDepth(ticket: Ticket, tickets: ReadonlyMap<ObjectId, Ticket>): number {
  let depth = 0;
  let current: Ticket | undefined = ticket;
  const seen = new Set<ObjectId>();
  while (current?.type === 'task') {
    if (seen.has(current.id)) return Number.POSITIVE_INFINITY;
    seen.add(current.id);
    depth += 1;
    current = current.parentTicketId ? tickets.get(current.parentTicketId) : undefined;
  }
  return depth;
}
