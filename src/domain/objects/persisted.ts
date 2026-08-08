import { z } from 'zod';
import { ProjectSchema, type Project } from '../projects/project.js';
import { PhaseSchema, type Phase } from '../phases/phase.js';
import { StepSchema, type Step } from '../steps/step.js';
import { TicketSchema, type Ticket } from '../tickets/ticket.js';
import { KpiSchema, QualityAssessmentSchema, type Kpi, type QualityAssessment } from '../quality/quality.js';
import {
  ChangelistSchema,
  CheckpointSchema,
  DeliverableSchema,
  type Changelist,
  type Checkpoint,
  type Deliverable,
} from '../evidence/evidence.js';
import { PhasePlanSchema, ProjectPlanSchema, type PhasePlan, type ProjectPlan } from '../planning/plan.js';
import {
  DomainAuditEventSchema,
  DomainLogSchema,
  ReportSchema,
  type DomainAuditEvent,
  type DomainLog,
  type Report,
} from '../observability/records.js';
import {
  ActorRegistrationSchema,
  DecisionRecordSchema,
  InteractionRequestSchema,
  ProjectManagementPlanSchema,
  RiskRecordSchema,
  TicketAssignmentSchema,
  TicketTraceEventSchema,
  type ActorRegistration,
  type DecisionRecord,
  type InteractionRequest,
  type ProjectManagementPlan,
  type RiskRecord,
  type TicketAssignment,
  type TicketTraceEvent,
} from '../project_management/index.js';
import {
  TicketChangeSetSchema,
  WorkspaceHandleSchema,
  type TicketChangeSet,
  type WorkspaceHandle,
} from '../workspace/change_set.js';
import {
  MergeGateRunSchema,
  MergeRequestSchema,
  type MergeGateRun,
  type MergeRequest,
} from '../workspace/merge_request.js';
import { ContextRecordSchema, type ContextRecord } from '../context/context_record.js';
import { RoleDefinitionSchema, type RoleDefinition } from '../workflow/role_definition.js';
import { DomainEventSchema, type DomainEvent } from '../observability/domain_event.js';

export type PersistedDomainObject =
  | Project
  | Phase
  | Step
  | Ticket
  | ActorRegistration
  | TicketAssignment
  | TicketTraceEvent
  | WorkspaceHandle
  | TicketChangeSet
  | MergeRequest
  | MergeGateRun
  | ContextRecord
  | RoleDefinition
  | ProjectManagementPlan
  | RiskRecord
  | DecisionRecord
  | InteractionRequest
  | Kpi
  | QualityAssessment
  | Checkpoint
  | Changelist
  | Deliverable
  | ProjectPlan
  | PhasePlan
  | Report
  | DomainLog
  | DomainAuditEvent
  | DomainEvent;

export const PersistedDomainObjectSchema: z.ZodType<PersistedDomainObject> = z.union([
  ProjectSchema,
  PhaseSchema,
  StepSchema,
  TicketSchema,
  ActorRegistrationSchema,
  TicketAssignmentSchema,
  TicketTraceEventSchema,
  WorkspaceHandleSchema,
  TicketChangeSetSchema,
  MergeRequestSchema,
  MergeGateRunSchema,
  ContextRecordSchema,
  RoleDefinitionSchema,
  ProjectManagementPlanSchema,
  RiskRecordSchema,
  DecisionRecordSchema,
  InteractionRequestSchema,
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
  DomainEventSchema,
]);
