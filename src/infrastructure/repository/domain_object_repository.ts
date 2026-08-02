import { z } from 'zod';
import type { Workspace } from '../../workspace/workspace.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { ObjectType } from '../../domain/objects/object_type.js';
import type { ObjectEnvelope } from '../../domain/objects/object_envelope.js';
import { ProjectSchema, type Project } from '../../domain/projects/project.js';
import { PhaseSchema, type Phase } from '../../domain/phases/phase.js';
import { StepSchema, type Step } from '../../domain/steps/step.js';
import { TicketSchema, type Ticket } from '../../domain/tickets/ticket.js';
import { KpiSchema, QualityAssessmentSchema, type Kpi, type QualityAssessment } from '../../domain/quality/quality.js';
import {
  ChangelistSchema,
  CheckpointSchema,
  DeliverableSchema,
  type Changelist,
  type Checkpoint,
  type Deliverable,
} from '../../domain/evidence/evidence.js';
import {
  PhasePlanSchema,
  ProjectPlanSchema,
  type PhasePlan,
  type ProjectPlan,
} from '../../domain/planning/plan.js';
import type {
  CompiledPhaseMaterialization,
  CompiledProjectGraph,
  CompiledProjectExtension,
} from '../../domain/planning/compiler.js';
import {
  DomainAuditEventSchema,
  DomainLogSchema,
  ReportSchema,
  type DomainAuditEvent,
  type DomainLog,
  type Report,
} from '../../domain/observability/records.js';
import { assertDomainGraph } from '../../domain/workflow/domain_graph.js';
import { ObjectRegistry, sha256Content } from '../registry/object_registry.js';

export type PersistedDomainObject =
  | Project
  | Phase
  | Step
  | Ticket
  | Kpi
  | QualityAssessment
  | Checkpoint
  | Changelist
  | Deliverable
  | ProjectPlan
  | PhasePlan
  | Report
  | DomainLog
  | DomainAuditEvent;

const PersistedDomainObjectSchema = z.union([
  ProjectSchema,
  PhaseSchema,
  StepSchema,
  TicketSchema,
  KpiSchema,
  QualityAssessmentSchema,
  CheckpointSchema,
  ChangelistSchema,
  DeliverableSchema,
  ProjectPlanSchema,
  PhasePlanSchema,
  ReportSchema,
  DomainLogSchema,
  DomainAuditEventSchema,
]);

export class DomainObjectRepository {
  readonly registry: ObjectRegistry;

  constructor(private readonly workspace: Workspace) {
    this.registry = new ObjectRegistry(workspace);
  }

  async load(): Promise<void> {
    await this.registry.load();
  }

  async insert(object: PersistedDomainObject, state?: string): Promise<void> {
    const parsed = PersistedDomainObjectSchema.parse(object);
    const objectRef = domainObjectPath(parsed);
    const content = `${JSON.stringify(parsed, null, 2)}\n`;
    await this.workspace.writeFileAtomic(objectRef, content);
    await this.registry.register({
      envelope: parsed,
      objectRef,
      contentHash: sha256Content(content),
      parentId: registryParentId(parsed),
      state,
    });
  }

  async update(object: PersistedDomainObject, state?: string): Promise<void> {
    const parsed = PersistedDomainObjectSchema.parse(object);
    if (parsed.objectType === 'checkpoint') {
      throw new Error(`Checkpoint ${parsed.id} is immutable and cannot be updated`);
    }
    const current = this.registry.require(parsed.id, parsed.objectType);
    const objectRef = current.objectRef;
    const content = `${JSON.stringify(parsed, null, 2)}\n`;
    await this.workspace.writeFileAtomic(objectRef, content);
    await this.registry.update({
      envelope: parsed,
      objectRef,
      contentHash: sha256Content(content),
      parentId: registryParentId(parsed),
      state,
    });
  }

  async read(id: ObjectId): Promise<PersistedDomainObject> {
    const entry = this.registry.require(id);
    const object = PersistedDomainObjectSchema.parse(
      JSON.parse(await this.workspace.readFile(entry.objectRef)),
    );
    if (object.id !== id || object.objectType !== entry.objectType) {
      throw new Error(`Domain object ${id} does not match its registry entry`);
    }
    return object;
  }

  async list(options: {
    objectType?: ObjectType;
    projectId?: ObjectId;
  } = {}): Promise<PersistedDomainObject[]> {
    const entries = options.objectType
      ? this.registry.byType(options.objectType)
      : this.registry.all();
    const selected = entries.filter((entry) =>
      !options.projectId || entry.projectId === options.projectId,
    );
    return Promise.all(selected.map((entry) => this.read(entry.id)));
  }

  async findProject(): Promise<Project | undefined> {
    const projects = await this.list({ objectType: 'project' });
    if (projects.length > 1) {
      throw new Error(`Workspace contains multiple active Projects: ${projects.map((item) => item.id).join(', ')}`);
    }
    const project = projects[0];
    if (!project) return undefined;
    if (project.objectType !== 'project') throw new Error(`Object ${project.id} is not a Project`);
    return project;
  }

  async persistCompiledGraph(graph: CompiledProjectGraph): Promise<void> {
    assertDomainGraph(graph);
    await this.insert(graph.project, graph.project.state);
    const remaining: PersistedDomainObject[] = [
      graph.projectPlan,
      ...graph.phases,
      ...graph.phasePlans,
      ...graph.steps,
      ...graph.tickets,
      ...graph.kpis,
      ...graph.deliverables,
    ];
    for (const object of remaining) {
      await this.insert(object, objectState(object));
    }
  }

  async persistPhaseMaterialization(materialization: CompiledPhaseMaterialization): Promise<void> {
    await this.update(materialization.epic, materialization.epic.state);
    for (const object of [
      ...materialization.steps,
      ...materialization.tickets,
      ...materialization.kpis,
      ...materialization.deliverables,
    ]) {
      await this.insert(object, objectState(object));
    }
    await this.update(materialization.phasePlan, 'materialized');
    await this.update(materialization.phase, materialization.phase.state);
  }

  async persistProjectExtension(extension: CompiledProjectExtension): Promise<void> {
    for (const object of [
      ...extension.phases,
      ...extension.phasePlans,
      ...extension.tickets,
      ...extension.steps,
      ...extension.kpis,
      ...extension.deliverables,
    ]) {
      await this.insert(object, objectState(object));
    }
    await this.update(extension.projectPlan, 'materialized');
    await this.update(extension.project, extension.project.state);
  }

  async retireProject(projectId: ObjectId): Promise<void> {
    const active = this.registry.all().filter((entry) => entry.projectId === projectId);
    if (active.length === 0) return;
    const remaining = new Map(active.map((entry) => [entry.id, entry]));
    while (remaining.size > 0) {
      const leaves = [...remaining.values()].filter((candidate) =>
        ![...remaining.values()].some((entry) => entry.parentId === candidate.id),
      );
      if (leaves.length === 0) {
        throw new Error(`Cannot retire Project ${projectId}: registry parent cycle detected`);
      }
      for (const entry of leaves) {
        await this.registry.tombstone(entry.id, entry.revision);
        remaining.delete(entry.id);
      }
    }
  }
}

export function domainObjectPath(object: ObjectEnvelope): string {
  return `.xcompiler/objects/${object.objectType}/${object.id}.json`;
}

function registryParentId(object: PersistedDomainObject): ObjectId | undefined {
  switch (object.objectType) {
    case 'project':
      return undefined;
    case 'phase':
      return object.projectId;
    case 'step':
      return object.phaseId;
    case 'ticket':
      return object.parentTicketId ?? object.phaseId;
    case 'kpi':
      return object.subjectId;
    case 'quality-assessment':
      return object.subject.id;
    case 'checkpoint':
      return object.subject.id;
    case 'changelist':
      return object.ticketId;
    case 'deliverable':
      return object.owner.id;
    case 'plan':
      return object.planKind === 'phase' ? object.phaseId : object.projectId;
    case 'report':
      return object.subject.id;
    case 'log':
    case 'audit-event':
      return object.subject?.id ?? object.projectId;
  }
}

function objectState(object: PersistedDomainObject): string | undefined {
  if ('state' in object && typeof object.state === 'string') return object.state;
  if (object.objectType === 'plan') return object.planKind === 'phase' && !object.materialized
    ? 'planned'
    : 'materialized';
  return undefined;
}
