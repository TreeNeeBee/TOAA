import { z } from 'zod';
import type { Workspace } from '../workspace/workspace.js';
import { assertStateTransition, type StateTransitions } from '../util/state_machine.js';
import type { DebugBrief } from './debug_brief.js';
import {
  PHASES,
  ROLES,
  type Phase,
  type Plan,
  type Step,
} from './plan.js';

export const TICKET_VERSION = 3;
export const TICKET_TYPES = [
  'epic',
  'feature',
  'task',
  'sub-task',
  'change-request',
  'bug',
  'enhance',
] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const WORK_TICKET_KINDS = [
  'iteration',
  'v-model-stage',
  'delivery',
  'planned-work',
] as const;
export type WorkTicketKind = (typeof WORK_TICKET_KINDS)[number];

export const TICKET_STATUSES = [
  'open',
  'triaged',
  'in_progress',
  'in_review',
  'verification',
  'blocked',
  'resolved',
  'closed',
  'cancelled',
  'failed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const ENHANCE_KINDS = ['defect', 'functional-gap', 'test-incomplete'] as const;
export type EnhanceKind = (typeof ENHANCE_KINDS)[number];

export const MODEL_CONTRIBUTIONS = [
  'author',
  'validator',
  'debugger',
  'change-applier',
] as const;
export type ModelContribution = (typeof MODEL_CONTRIBUTIONS)[number];

export const MODEL_OUTCOMES = [
  'produced',
  'detected-gap',
  'attributed-gap',
  'finding-validated',
  'repair-verified',
  'change-applied',
  'change-verified',
] as const;
export type ModelOutcome = (typeof MODEL_OUTCOMES)[number];

export const BUG_KINDS = [
  'phase',
  'architecture-gate',
  'test-gate',
  'functional-gate',
  'iteration-gate',
  'project-audit',
  'infrastructure',
  'exception',
] as const;
export type BugKind = (typeof BUG_KINDS)[number];

export interface TicketSource {
  kind: 'plan' | 'runtime';
  externalId?: string;
  stepId?: string;
  phase?: Phase;
  role?: Step['role'];
}

export interface TicketModelAttribution {
  provider: string;
  role: Step['role'];
  contribution: ModelContribution;
  outcome: ModelOutcome;
  stepId?: string;
  phase?: Phase;
  at: string;
}

export interface TicketBase {
  version: typeof TICKET_VERSION;
  id: string;
  type: TicketType;
  status: TicketStatus;
  priority: TicketPriority;
  title: string;
  description: string;
  iterationId: string;
  parentTicketId?: string;
  rootTicketId?: string;
  relatedTicketIds: string[];
  blockedByTicketIds: string[];
  source: TicketSource;
  acceptance: string[];
  artifacts: string[];
  modelAttributions: TicketModelAttribution[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  closedAt?: string;
  cancelledAt?: string;
  failureReason?: string;
}

export interface WorkTicket extends TicketBase {
  type: 'epic' | 'feature' | 'task' | 'sub-task';
  workKind: WorkTicketKind;
  /** Scheduling dependencies. Array position is never treated as execution order. */
  dependsOnTicketIds: string[];
  /** Left-side V-model Feature points to the right-side verification Feature. */
  verificationTicketId?: string;
  /** Right-side V-model Feature points to the left-side source Feature. */
  pairedSourceTicketId?: string;
  execution: {
    state: 'queued' | 'running' | 'passed' | 'failed';
    attempts: number;
    maxAttempts: number;
  };
}

export interface EnhanceTicket extends TicketBase {
  type: 'enhance';
  kind: EnhanceKind;
  finding: string;
  /** Present when triage originated from a concrete runtime/test failure. */
  sourceBugTicketId?: string;
  /** Present when a completion/alignment/metric quality gate opened the finding directly. */
  sourceQualityGateStepId?: string;
  targetStepId?: string;
  targetPhase?: Phase;
  verificationStepId?: string;
  verificationPhase?: Phase;
  qualityFailures?: string[];
  qualityAssessment?: unknown;
  affectedWorkTicketIds: string[];
  changeRequestTicketIds: string[];
  disposition: 'debug' | 'change-request';
}

export interface BugRepair {
  repairedStepId: string;
  repairedPhase: Phase;
  completedBeforeDebug: boolean;
  mode: 'patch' | 'rewrite' | 'patch-or-rewrite' | 'verification';
  patchPath?: string;
  summaryPath?: string;
  changedFiles?: string[];
  baselineCommit?: string;
  commit?: string;
}

export interface BugTicket extends TicketBase {
  type: 'bug';
  kind: BugKind;
  severity: 'error';
  language: Plan['language'];
  intent: Plan['intent'];
  requirementDigest: string;
  reason: string;
  failureLog: string;
  failureLogBytes?: number;
  rawFailureLogPath?: string;
  debugBrief?: DebugBrief;
  metrics?: unknown;
  evidence?: Record<string, unknown>;
  targetStepId?: string;
  targetPhase?: Phase;
  verificationStepId?: string;
  verificationPhase?: Phase;
  routedAt?: string;
  bugResolutionPlan?: string;
  resolutionPlanHistory?: Array<{
    at: string;
    stepId: string;
    phase: Phase;
    plan: string;
    outcome: 'accepted';
  }>;
  repair?: BugRepair;
  debugWikiEntryIds?: string[];
  enhanceTicketId?: string;
  activeChangeRequestTicketId?: string;
  changeRequestTicketIds: string[];
  causedByChangeRequestTicketId?: string;
}

const ChangeRequestStepSchema = z.object({
  stepId: z.string().min(1),
  phase: z.enum(PHASES),
  role: z.enum(ROLES),
  title: z.string().min(1),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  acceptance: z.string().min(1),
}).strict();

const ChangeRequestApplicationSchema = z.object({
  revision: z.number().int().positive(),
  stepId: z.string().min(1),
  phase: z.enum(PHASES),
  kind: z.enum(['design-change', 'implementation-change', 'verification']),
  commit: z.string().min(1),
  changedFiles: z.array(z.string()),
  summary: z.string().min(1),
  appliedAt: z.string().min(1),
}).strict();

export interface ChangeRequestTicket extends TicketBase {
  type: 'change-request';
  revision: number;
  sourceEnhanceTicketId: string;
  originBugTicketId?: string;
  triggerTicketId: string;
  objective: string;
  scope: {
    in: string[];
    out: string[];
  };
  trigger: {
    failedStepId: string;
    failedPhase: Phase;
    failedAcceptance: string;
    reason: string;
    failureSummary: string;
    failureEvidencePath?: string;
  };
  designSource: {
    stepId: string;
    phase: 'HIGH_LEVEL_DESIGN' | 'DETAILED_DESIGN';
    baselineCommit: string;
    repairCommit: string;
    changedArtifacts: string[];
    patchPath?: string;
  };
  contractChange: {
    summary: string;
    before: string[];
    after: string[];
    interfaces: string[];
    dependencies: string[];
    constraints: string[];
  };
  implementationPlan: string;
  affectedSteps: Array<z.infer<typeof ChangeRequestStepSchema>>;
  affectedArtifacts: string[];
  verification: {
    targetStepId: string;
    targetPhase: Phase;
    testArgs: string[];
    checks: string[];
    failurePolicy: string;
    rollbackTargetStepId: string;
    rollbackTargetPhase: Phase;
  };
  execution: {
    currentStepId?: string;
    completedStepIds: string[];
  };
  applications: Array<z.infer<typeof ChangeRequestApplicationSchema>>;
  revisionReason?: string;
}

export type Ticket = WorkTicket | EnhanceTicket | BugTicket | ChangeRequestTicket;
export type ChangeRequestApplication = ChangeRequestTicket['applications'][number];

export interface TicketSummary {
  version: typeof TICKET_VERSION;
  generatedAt: string;
  total: number;
  byType: Record<TicketType, number>;
  byStatus: Record<TicketStatus, number>;
  enhancementsByKind: Record<EnhanceKind, number>;
  changeRequests: {
    total: number;
    totalRevisions: number;
    open: number;
  };
  modelImpact: Record<string, Record<ModelOutcome, number>>;
}

const TicketSourceSchema = z.object({
  kind: z.enum(['plan', 'runtime']),
  externalId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  phase: z.enum(PHASES).optional(),
  role: z.enum(ROLES).optional(),
}).strict();

const TicketModelAttributionSchema = z.object({
  provider: z.string().min(1),
  role: z.enum(ROLES),
  contribution: z.enum(MODEL_CONTRIBUTIONS),
  outcome: z.enum(MODEL_OUTCOMES),
  stepId: z.string().min(1).optional(),
  phase: z.enum(PHASES).optional(),
  at: z.string().min(1),
}).strict();

const TicketBaseSchema = z.object({
  version: z.literal(TICKET_VERSION),
  id: z.string().regex(/^(?:EPIC|FEATURE|TASK|SUBTASK|CR|BUG|ENHANCE)-P\d{1,3}-\d{3}$/u),
  type: z.enum(TICKET_TYPES),
  status: z.enum(TICKET_STATUSES),
  priority: z.enum(TICKET_PRIORITIES),
  title: z.string().min(1),
  description: z.string().min(1),
  iterationId: z.string().regex(/^P\d{1,3}$/u),
  parentTicketId: z.string().min(1).optional(),
  rootTicketId: z.string().min(1).optional(),
  relatedTicketIds: z.array(z.string().min(1)),
  blockedByTicketIds: z.array(z.string().min(1)),
  source: TicketSourceSchema,
  acceptance: z.array(z.string().min(1)),
  artifacts: z.array(z.string().min(1)),
  modelAttributions: z.array(TicketModelAttributionSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  resolvedAt: z.string().min(1).optional(),
  closedAt: z.string().min(1).optional(),
  cancelledAt: z.string().min(1).optional(),
  failureReason: z.string().min(1).optional(),
});

const WorkTicketSchema = TicketBaseSchema.extend({
  type: z.enum(['epic', 'feature', 'task', 'sub-task']),
  workKind: z.enum(WORK_TICKET_KINDS),
  dependsOnTicketIds: z.array(z.string().min(1)),
  verificationTicketId: z.string().regex(/^FEATURE-P\d{1,3}-\d{3}$/u).optional(),
  pairedSourceTicketId: z.string().regex(/^FEATURE-P\d{1,3}-\d{3}$/u).optional(),
  execution: z.object({
    state: z.enum(['queued', 'running', 'passed', 'failed']),
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
  }).strict(),
}).strict().superRefine((ticket, ctx) => {
  const validKind =
    (ticket.type === 'epic' && ticket.workKind === 'iteration') ||
    (ticket.type === 'feature' &&
      (ticket.workKind === 'v-model-stage' || ticket.workKind === 'delivery')) ||
    ((ticket.type === 'task' || ticket.type === 'sub-task') &&
      ticket.workKind === 'planned-work');
  if (!validKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${ticket.type} cannot use workKind ${ticket.workKind}`,
      path: ['workKind'],
    });
  }
  if (ticket.type === 'epic' && (ticket.parentTicketId || ticket.rootTicketId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'epic tickets cannot have parentTicketId or rootTicketId',
      path: ['parentTicketId'],
    });
  }
  if (ticket.type !== 'epic' && (!ticket.parentTicketId || !ticket.rootTicketId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${ticket.type} tickets require parentTicketId and rootTicketId`,
      path: ['parentTicketId'],
    });
  }
  if (
    ticket.type === 'feature' &&
    ticket.workKind === 'v-model-stage' &&
    !ticket.source.stepId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'v-model-stage features require source.stepId',
      path: ['source', 'stepId'],
    });
  }
  if (
    ticket.type === 'feature' &&
    ticket.workKind === 'delivery' &&
    ticket.source.stepId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'delivery features cannot own a Plan Step',
      path: ['source', 'stepId'],
    });
  }
  if (ticket.type === 'sub-task' && !ticket.parentTicketId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sub-task tickets require parentTicketId',
      path: ['parentTicketId'],
    });
  }
});

export const EnhanceTicketSchema = TicketBaseSchema.extend({
  type: z.literal('enhance'),
  kind: z.enum(ENHANCE_KINDS),
  finding: z.string().min(1),
  sourceBugTicketId: z.string().regex(/^BUG-P\d{1,3}-\d{3}$/u).optional(),
  sourceQualityGateStepId: z.string().min(1).optional(),
  targetStepId: z.string().min(1).optional(),
  targetPhase: z.enum(PHASES).optional(),
  verificationStepId: z.string().min(1).optional(),
  verificationPhase: z.enum(PHASES).optional(),
  qualityFailures: z.array(z.string().min(1)).optional(),
  qualityAssessment: z.unknown().optional(),
  affectedWorkTicketIds: z.array(
    z.string().regex(/^(?:FEATURE|TASK|SUBTASK)-P\d{1,3}-\d{3}$/u),
  ),
  changeRequestTicketIds: z.array(z.string().regex(/^CR-P\d{1,3}-\d{3}$/u)),
  disposition: z.enum(['debug', 'change-request']),
}).strict().superRefine((ticket, ctx) => {
  if (!ticket.sourceBugTicketId && !ticket.sourceQualityGateStepId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'enhance tickets require a source Bug Ticket or quality-gate Step',
      path: ['sourceQualityGateStepId'],
    });
  }
});

const BugRepairSchema = z.object({
  repairedStepId: z.string().min(1),
  repairedPhase: z.enum(PHASES),
  completedBeforeDebug: z.boolean(),
  mode: z.enum(['patch', 'rewrite', 'patch-or-rewrite', 'verification']),
  patchPath: z.string().min(1).optional(),
  summaryPath: z.string().min(1).optional(),
  changedFiles: z.array(z.string()).optional(),
  baselineCommit: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
}).strict();

const BugTicketSchema = TicketBaseSchema.extend({
  type: z.literal('bug'),
  kind: z.enum(BUG_KINDS),
  severity: z.literal('error'),
  language: z.enum(['python', 'typescript']),
  intent: z.enum(['greenfield', 'feature', 'refactor', 'self']),
  requirementDigest: z.string().min(1),
  reason: z.string().min(1),
  failureLog: z.string(),
  failureLogBytes: z.number().int().nonnegative().optional(),
  rawFailureLogPath: z.string().min(1).optional(),
  debugBrief: z.custom<DebugBrief>().optional(),
  metrics: z.unknown().optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  targetStepId: z.string().min(1).optional(),
  targetPhase: z.enum(PHASES).optional(),
  verificationStepId: z.string().min(1).optional(),
  verificationPhase: z.enum(PHASES).optional(),
  routedAt: z.string().min(1).optional(),
  bugResolutionPlan: z.string().min(1).optional(),
  resolutionPlanHistory: z.array(z.object({
    at: z.string().min(1),
    stepId: z.string().min(1),
    phase: z.enum(PHASES),
    plan: z.string().min(1),
    outcome: z.literal('accepted'),
  }).strict()).optional(),
  repair: BugRepairSchema.optional(),
  debugWikiEntryIds: z.array(z.string().min(1)).optional(),
  enhanceTicketId: z.string().regex(/^ENHANCE-P\d{1,3}-\d{3}$/u).optional(),
  activeChangeRequestTicketId: z.string().min(1).optional(),
  changeRequestTicketIds: z.array(z.string().min(1)),
  causedByChangeRequestTicketId: z.string().min(1).optional(),
}).strict();

export const ChangeRequestTicketSchema = TicketBaseSchema.extend({
  type: z.literal('change-request'),
  revision: z.number().int().positive(),
  sourceEnhanceTicketId: z.string().regex(/^ENHANCE-P\d{1,3}-\d{3}$/u),
  originBugTicketId: z.string().regex(/^BUG-P\d{1,3}-\d{3}$/u).optional(),
  triggerTicketId: z.string().regex(/^ENHANCE-P\d{1,3}-\d{3}$/u),
  objective: z.string().min(1),
  scope: z.object({
    in: z.array(z.string().min(1)).min(1),
    out: z.array(z.string().min(1)),
  }).strict(),
  trigger: z.object({
    failedStepId: z.string().min(1),
    failedPhase: z.enum(PHASES),
    failedAcceptance: z.string().min(1),
    reason: z.string().min(1),
    failureSummary: z.string().min(1),
    failureEvidencePath: z.string().min(1).optional(),
  }).strict(),
  designSource: z.object({
    stepId: z.string().min(1),
    phase: z.enum(['HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN']),
    baselineCommit: z.string().min(1),
    repairCommit: z.string().min(1),
    changedArtifacts: z.array(z.string()).min(1),
    patchPath: z.string().min(1).optional(),
  }).strict(),
  contractChange: z.object({
    summary: z.string().min(1),
    before: z.array(z.string().min(1)).min(1),
    after: z.array(z.string().min(1)).min(1),
    interfaces: z.array(z.string()),
    dependencies: z.array(z.string()),
    constraints: z.array(z.string()),
  }).strict(),
  implementationPlan: z.string().min(1),
  affectedSteps: z.array(ChangeRequestStepSchema).min(1),
  affectedArtifacts: z.array(z.string()).min(1),
  verification: z.object({
    targetStepId: z.string().min(1),
    targetPhase: z.enum(PHASES),
    testArgs: z.array(z.string()),
    checks: z.array(z.string().min(1)).min(1),
    failurePolicy: z.string().min(1),
    rollbackTargetStepId: z.string().min(1),
    rollbackTargetPhase: z.enum(PHASES),
  }).strict(),
  execution: z.object({
    currentStepId: z.string().min(1).optional(),
    completedStepIds: z.array(z.string().min(1)),
  }).strict(),
  applications: z.array(ChangeRequestApplicationSchema),
  revisionReason: z.string().min(1).optional(),
}).strict().superRefine((ticket, ctx) => {
  if (ticket.triggerTicketId !== ticket.sourceEnhanceTicketId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'change-request triggerTicketId must reference sourceEnhanceTicketId',
      path: ['triggerTicketId'],
    });
  }
  if (!ticket.relatedTicketIds.includes(ticket.sourceEnhanceTicketId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'change-request must relate its source Enhance Ticket',
      path: ['relatedTicketIds'],
    });
  }
  if (
    ticket.originBugTicketId &&
    !ticket.relatedTicketIds.includes(ticket.originBugTicketId)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'change-request must relate its origin Bug Ticket',
      path: ['relatedTicketIds'],
    });
  }
});

export const TicketSchema = z.discriminatedUnion('type', [
  WorkTicketSchema,
  EnhanceTicketSchema,
  BugTicketSchema,
  ChangeRequestTicketSchema,
]);

const TICKET_TRANSITIONS: StateTransitions<TicketStatus> = {
  open: ['triaged', 'in_progress', 'blocked', 'cancelled', 'failed'],
  triaged: ['in_progress', 'blocked', 'cancelled', 'failed'],
  in_progress: ['in_review', 'verification', 'blocked', 'resolved', 'cancelled', 'failed'],
  in_review: ['in_progress', 'verification', 'blocked', 'resolved', 'cancelled', 'failed'],
  verification: ['in_progress', 'blocked', 'resolved', 'cancelled', 'failed'],
  blocked: ['triaged', 'in_progress', 'verification', 'cancelled', 'failed'],
  resolved: ['closed', 'in_progress'],
  closed: ['in_progress'],
  cancelled: [],
  failed: ['triaged', 'in_progress', 'blocked', 'cancelled'],
};

const TYPE_PREFIX: Record<TicketType, string> = {
  epic: 'EPIC',
  feature: 'FEATURE',
  task: 'TASK',
  'sub-task': 'SUBTASK',
  'change-request': 'CR',
  bug: 'BUG',
  enhance: 'ENHANCE',
};

export function transitionTicket(
  ticket: Ticket,
  next: TicketStatus,
  at = new Date().toISOString(),
): boolean {
  const changed = assertStateTransition(
    'ticket',
    ticket.id,
    ticket.status,
    next,
    TICKET_TRANSITIONS,
  );
  if (!changed) return false;
  ticket.status = next;
  ticket.updatedAt = at;
  if (next === 'resolved') ticket.resolvedAt = at;
  if (next === 'closed') ticket.closedAt = at;
  if (next === 'cancelled') ticket.cancelledAt = at;
  return true;
}

export function projectWorkStatusToStepStatus(
  ticket: WorkTicket,
): Step['status'] {
  if (ticket.execution.state === 'passed') return 'DONE';
  if (ticket.execution.state === 'failed' || ticket.status === 'blocked') return 'FAILED';
  return ticket.execution.state === 'running' ? 'RUNNING' : 'PENDING';
}

export class TicketStore {
  private tickets: Ticket[] = [];
  private readonly idHighWaterMarks = new Map<string, number>();
  private loaded = false;

  constructor(private readonly workspace: Workspace) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.workspace.readFile('.xcompiler/tickets/index.json').catch(() => '');
    if (raw.trim()) {
      this.tickets = z.array(TicketSchema).parse(JSON.parse(raw));
    }
    for (const ticket of this.tickets) this.observeTicketId(ticket.id);
    const eventLog = await this.workspace
      .readFile('.xcompiler/tickets/events.jsonl')
      .catch(() => '');
    for (const line of eventLog.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { ticketId?: unknown };
        if (typeof event.ticketId === 'string') this.observeTicketId(event.ticketId);
      } catch {
        // A partial final audit line must not make the current Ticket index unreadable.
      }
    }
    this.loaded = true;
  }

  all(): readonly Ticket[] {
    return this.tickets;
  }

  summary(): TicketSummary {
    const byType = Object.fromEntries(TICKET_TYPES.map((type) => [
      type,
      this.tickets.filter((ticket) => ticket.type === type).length,
    ])) as Record<TicketType, number>;
    const byStatus = Object.fromEntries(TICKET_STATUSES.map((status) => [
      status,
      this.tickets.filter((ticket) => ticket.status === status).length,
    ])) as Record<TicketStatus, number>;
    const enhancementsByKind = Object.fromEntries(ENHANCE_KINDS.map((kind) => [
      kind,
      this.tickets.filter((ticket) => ticket.type === 'enhance' && ticket.kind === kind).length,
    ])) as Record<EnhanceKind, number>;
    const modelImpact: Record<string, Record<ModelOutcome, number>> = {};
    for (const ticket of this.tickets) {
      for (const attribution of ticket.modelAttributions) {
        modelImpact[attribution.provider] ??= Object.fromEntries(
          MODEL_OUTCOMES.map((outcome) => [outcome, 0]),
        ) as Record<ModelOutcome, number>;
        modelImpact[attribution.provider]![attribution.outcome] += 1;
      }
    }
    const changeRequests = this.tickets.filter(
      (ticket): ticket is ChangeRequestTicket => ticket.type === 'change-request',
    );
    return {
      version: TICKET_VERSION,
      generatedAt: new Date().toISOString(),
      total: this.tickets.length,
      byType,
      byStatus,
      enhancementsByKind,
      changeRequests: {
        total: changeRequests.length,
        totalRevisions: changeRequests.reduce((sum, ticket) => sum + ticket.revision, 0),
        open: changeRequests.filter((ticket) =>
          !['closed', 'cancelled', 'failed'].includes(ticket.status)
        ).length,
      },
      modelImpact,
    };
  }

  find(id: string): Ticket | undefined {
    return this.tickets.find((ticket) => ticket.id === id);
  }

  findBug(id: string): BugTicket | undefined {
    const ticket = this.find(id);
    return ticket?.type === 'bug' ? ticket : undefined;
  }

  findEnhance(id: string): EnhanceTicket | undefined {
    const ticket = this.find(id);
    return ticket?.type === 'enhance' ? ticket : undefined;
  }

  activeQualityEnhanceForStep(
    stepId: string,
    iterationId: string,
  ): EnhanceTicket | undefined {
    return [...this.tickets].reverse().find(
      (ticket): ticket is EnhanceTicket =>
        ticket.type === 'enhance' &&
        ticket.iterationId === iterationId &&
        ticket.sourceQualityGateStepId === stepId &&
        !['closed', 'cancelled', 'failed'].includes(ticket.status),
    );
  }

  activeQualityEnhanceTargetingStep(
    stepId: string,
    iterationId: string,
  ): EnhanceTicket | undefined {
    return [...this.tickets].reverse().find(
      (ticket): ticket is EnhanceTicket =>
        ticket.type === 'enhance' &&
        ticket.iterationId === iterationId &&
        ticket.targetStepId === stepId &&
        !['closed', 'cancelled', 'failed'].includes(ticket.status),
    );
  }

  activeChangeRequests(): ChangeRequestTicket[] {
    return this.tickets.filter(
      (ticket): ticket is ChangeRequestTicket =>
        ticket.type === 'change-request' &&
        !['closed', 'cancelled', 'failed'].includes(ticket.status),
    );
  }

  activeChangeRequestForStep(step: Step): ChangeRequestTicket | undefined {
    const iterationId = step.iterationId ?? 'P1';
    return [...this.activeChangeRequests()].reverse().find(
      (ticket) =>
        ticket.iterationId === iterationId &&
        (
          ticket.designSource.stepId === step.id ||
          ticket.affectedSteps.some((affected) => affected.stepId === step.id)
        ),
    );
  }

  featureForStep(stepId: string, iterationId: string): WorkTicket | undefined {
    return this.tickets.find(
      (ticket): ticket is WorkTicket =>
        ticket.type === 'feature' &&
        ticket.workKind === 'v-model-stage' &&
        ticket.iterationId === iterationId &&
        ticket.source.stepId === stepId,
    );
  }

  epicForIteration(iterationId: string): WorkTicket | undefined {
    return this.tickets.find(
      (ticket): ticket is WorkTicket =>
        ticket.type === 'epic' && ticket.iterationId === iterationId,
    );
  }

  deliveryForIteration(iterationId: string): WorkTicket | undefined {
    return this.tickets.find(
      (ticket): ticket is WorkTicket =>
        ticket.type === 'feature' &&
        ticket.workKind === 'delivery' &&
        ticket.iterationId === iterationId,
    );
  }

  async createWork(input: {
    type: WorkTicket['type'];
    iterationId: string;
    title: string;
    description: string;
    priority?: TicketPriority;
    parentTicketId?: string;
    rootTicketId?: string;
    workKind: WorkTicketKind;
    dependsOnTicketIds?: string[];
    verificationTicketId?: string;
    pairedSourceTicketId?: string;
    maxAttempts?: number;
    source: TicketSource;
    acceptance?: string[];
    artifacts?: string[];
  }): Promise<WorkTicket> {
    await this.load();
    const now = new Date().toISOString();
    const ticket = TicketSchema.parse({
      version: TICKET_VERSION,
      id: this.nextId(input.type, input.iterationId),
      type: input.type,
      status: 'open',
      priority: input.priority ?? 'medium',
      title: input.title,
      description: input.description,
      iterationId: input.iterationId,
      parentTicketId: input.parentTicketId,
      rootTicketId: input.rootTicketId,
      workKind: input.workKind,
      dependsOnTicketIds: input.dependsOnTicketIds ?? [],
      verificationTicketId: input.verificationTicketId,
      pairedSourceTicketId: input.pairedSourceTicketId,
      execution: {
        state: 'queued',
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
      },
      relatedTicketIds: [],
      blockedByTicketIds: [],
      source: input.source,
      acceptance: input.acceptance ?? [],
      artifacts: input.artifacts ?? [],
      modelAttributions: [],
      createdAt: now,
      updatedAt: now,
    }) as WorkTicket;
    this.tickets.push(ticket);
    await this.persist(ticket, 'created');
    return ticket;
  }

  async createBug(
    input: Omit<
      BugTicket,
      | 'version'
      | 'id'
      | 'type'
      | 'status'
      | 'createdAt'
      | 'updatedAt'
      | 'resolvedAt'
      | 'closedAt'
      | 'cancelledAt'
      | 'changeRequestTicketIds'
      | 'modelAttributions'
    >,
  ): Promise<BugTicket> {
    await this.load();
    const now = new Date().toISOString();
    const ticket = TicketSchema.parse({
      ...input,
      version: TICKET_VERSION,
      id: this.nextId('bug', input.iterationId),
      type: 'bug',
      status: 'open',
      changeRequestTicketIds: [],
      modelAttributions: [],
      createdAt: now,
      updatedAt: now,
    }) as BugTicket;
    this.tickets.push(ticket);
    await this.persist(ticket, 'created');
    return ticket;
  }

  async createEnhance(
    input: Omit<
      EnhanceTicket,
      | 'version'
      | 'id'
      | 'type'
      | 'status'
      | 'createdAt'
      | 'updatedAt'
      | 'resolvedAt'
      | 'closedAt'
      | 'cancelledAt'
      | 'modelAttributions'
    >,
  ): Promise<EnhanceTicket> {
    await this.load();
    const now = new Date().toISOString();
    const ticket = TicketSchema.parse({
      ...input,
      version: TICKET_VERSION,
      id: this.nextId('enhance', input.iterationId),
      type: 'enhance',
      status: 'open',
      modelAttributions: [],
      createdAt: now,
      updatedAt: now,
    }) as EnhanceTicket;
    this.tickets.push(ticket);
    await this.persist(ticket, 'created');
    return ticket;
  }

  async createChangeRequest(
    input: Omit<
      ChangeRequestTicket,
      | 'version'
      | 'id'
      | 'type'
      | 'status'
      | 'revision'
      | 'applications'
      | 'createdAt'
      | 'updatedAt'
      | 'resolvedAt'
      | 'closedAt'
      | 'cancelledAt'
      | 'modelAttributions'
    >,
  ): Promise<ChangeRequestTicket> {
    await this.load();
    if (!this.findEnhance(input.sourceEnhanceTicketId)) {
      throw new Error(
        `change-request source Enhance Ticket does not exist: ${input.sourceEnhanceTicketId}`,
      );
    }
    if (input.originBugTicketId && !this.findBug(input.originBugTicketId)) {
      throw new Error(
        `change-request origin Bug Ticket does not exist: ${input.originBugTicketId}`,
      );
    }
    const now = new Date().toISOString();
    const ticket = TicketSchema.parse({
      ...input,
      version: TICKET_VERSION,
      id: this.nextId('change-request', input.iterationId),
      type: 'change-request',
      status: 'open',
      revision: 1,
      applications: [],
      modelAttributions: [],
      createdAt: now,
      updatedAt: now,
    }) as ChangeRequestTicket;
    this.tickets.push(ticket);
    await this.persist(ticket, 'created');
    return ticket;
  }

  async transition(
    ticket: Ticket,
    next: TicketStatus,
    event: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    transitionTicket(ticket, next);
    await this.persist(ticket, event, extra);
  }

  async link(ticket: Ticket, relatedTicketId: string, event = 'linked'): Promise<void> {
    ticket.relatedTicketIds = dedup([...ticket.relatedTicketIds, relatedTicketId]);
    ticket.updatedAt = new Date().toISOString();
    await this.persist(ticket, event, { relatedTicketId });
  }

  async recordModelAttribution(
    ticket: Ticket,
    input: {
      providers: string[];
      role: Step['role'];
      contribution: ModelContribution;
      outcome: ModelOutcome;
      stepId?: string;
      phase?: Phase;
    },
  ): Promise<void> {
    const at = new Date().toISOString();
    const additions = dedup(input.providers).filter((provider) =>
      !ticket.modelAttributions.some((attribution) =>
        attribution.provider === provider &&
        attribution.role === input.role &&
        attribution.contribution === input.contribution &&
        attribution.outcome === input.outcome &&
        attribution.stepId === input.stepId &&
        attribution.phase === input.phase,
      ),
    ).map((provider): TicketModelAttribution => ({
      provider,
      role: input.role,
      contribution: input.contribution,
      outcome: input.outcome,
      stepId: input.stepId,
      phase: input.phase,
      at,
    }));
    if (additions.length === 0) return;
    ticket.modelAttributions.push(...additions);
    await this.persist(ticket, 'model-attribution-recorded', {
      providers: additions.map((attribution) => attribution.provider),
      role: input.role,
      contribution: input.contribution,
      outcome: input.outcome,
      stepId: input.stepId,
      phase: input.phase,
    });
  }

  async block(ticket: Ticket, blockerId: string, reason: string): Promise<void> {
    ticket.blockedByTicketIds = dedup([...ticket.blockedByTicketIds, blockerId]);
    ticket.failureReason = reason;
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      transitionTicket(ticket, 'in_progress');
    }
    transitionTicket(ticket, 'blocked');
    await this.persist(ticket, 'blocked', { blockerId, reason });
  }

  async unblock(ticket: Ticket, blockerId: string): Promise<void> {
    ticket.blockedByTicketIds = ticket.blockedByTicketIds.filter((id) => id !== blockerId);
    if (ticket.blockedByTicketIds.length === 0 && ticket.status === 'blocked') {
      transitionTicket(ticket, 'in_progress');
    }
    if (
      ticket.blockedByTicketIds.length === 0 &&
      isWorkTicket(ticket) &&
      ticket.execution.state === 'passed' &&
      ticket.status !== 'closed'
    ) {
      if (ticket.status !== 'resolved') transitionTicket(ticket, 'resolved');
      transitionTicket(ticket, 'closed');
    }
    await this.persist(ticket, 'unblocked', { blockerId });
  }

  async persist(
    ticket: Ticket,
    event: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    TicketSchema.parse(ticket);
    await this.workspace.writeFile(
      `.xcompiler/tickets/${ticket.id}.json`,
      `${JSON.stringify(ticket, null, 2)}\n`,
    );
    await this.workspace.writeFile(
      `.xcompiler/tickets/${ticket.id}.md`,
      renderTicket(ticket),
    );
    await this.workspace.writeFile(
      '.xcompiler/tickets/index.json',
      `${JSON.stringify(this.tickets, null, 2)}\n`,
    );
    await this.workspace.appendFile(
      '.xcompiler/tickets/events.jsonl',
      `${JSON.stringify({
        event,
        at: new Date().toISOString(),
        ticketId: ticket.id,
        ticketType: ticket.type,
        status: ticket.status,
        iterationId: ticket.iterationId,
        parentTicketId: ticket.parentTicketId,
        relatedTicketIds: ticket.relatedTicketIds,
        blockedByTicketIds: ticket.blockedByTicketIds,
        ...(ticket.type === 'epic' ||
        ticket.type === 'feature' ||
        ticket.type === 'task' ||
        ticket.type === 'sub-task'
          ? {
              workKind: ticket.workKind,
              dependsOnTicketIds: ticket.dependsOnTicketIds,
              verificationTicketId: ticket.verificationTicketId,
              pairedSourceTicketId: ticket.pairedSourceTicketId,
              executionState: ticket.execution.state,
              attempts: ticket.execution.attempts,
              maxAttempts: ticket.execution.maxAttempts,
            }
          : {}),
        stepId: ticket.source.stepId,
        phase: ticket.source.phase,
        modelProviders: dedup(ticket.modelAttributions.map((attribution) => attribution.provider)),
        ...(ticket.type === 'enhance'
          ? {
              enhanceKind: ticket.kind,
              sourceBugTicketId: ticket.sourceBugTicketId,
              affectedWorkTicketIds: ticket.affectedWorkTicketIds,
              changeRequestTicketIds: ticket.changeRequestTicketIds,
              disposition: ticket.disposition,
            }
          : {}),
        ...(ticket.type === 'bug'
          ? {
              bugKind: ticket.kind,
              reason: ticket.reason,
              targetStepId: ticket.targetStepId,
              targetPhase: ticket.targetPhase,
              verificationStepId: ticket.verificationStepId,
              verificationPhase: ticket.verificationPhase,
              bugResolutionPlan: ticket.bugResolutionPlan,
              enhanceTicketId: ticket.enhanceTicketId,
              changeRequestTicketIds: ticket.changeRequestTicketIds,
              activeChangeRequestTicketId: ticket.activeChangeRequestTicketId,
            }
          : {}),
        ...(ticket.type === 'change-request'
          ? {
              revision: ticket.revision,
              triggerTicketId: ticket.triggerTicketId,
              sourceEnhanceTicketId: ticket.sourceEnhanceTicketId,
              originBugTicketId: ticket.originBugTicketId,
              currentStepId: ticket.execution.currentStepId,
            }
          : {}),
        ...extra,
      })}\n`,
    );
    await this.writeSummary();
  }

  private async writeSummary(): Promise<void> {
    await this.workspace.writeFile(
      '.xcompiler/tickets/summary.json',
      `${JSON.stringify(this.summary(), null, 2)}\n`,
    );
  }

  private nextId(type: TicketType, iterationId: string): string {
    const prefix = `${TYPE_PREFIX[type]}-${iterationId}-`;
    const next = (this.idHighWaterMarks.get(prefix) ?? 0) + 1;
    this.idHighWaterMarks.set(prefix, next);
    return `${prefix}${String(next).padStart(3, '0')}`;
  }

  private observeTicketId(id: string): void {
    const match = /^(.+-P\d{1,3}-)(\d+)$/u.exec(id);
    if (!match) return;
    const value = Number.parseInt(match[2]!, 10);
    if (!Number.isFinite(value)) return;
    const prefix = match[1]!;
    this.idHighWaterMarks.set(
      prefix,
      Math.max(this.idHighWaterMarks.get(prefix) ?? 0, value),
    );
  }
}

export function affectedStepContract(step: Step): ChangeRequestTicket['affectedSteps'][number] {
  return {
    stepId: step.id,
    phase: step.phase,
    role: step.role,
    title: step.title,
    inputs: [...step.inputs],
    outputs: [...step.outputs],
    acceptance: step.acceptance,
  };
}

export function isDesignChangeRequestPhase(
  phase: Phase,
): phase is 'HIGH_LEVEL_DESIGN' | 'DETAILED_DESIGN' {
  return phase === 'HIGH_LEVEL_DESIGN' || phase === 'DETAILED_DESIGN';
}

function dedup(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isWorkTicket(ticket: Ticket): ticket is WorkTicket {
  return ticket.type === 'epic' ||
    ticket.type === 'feature' ||
    ticket.type === 'task' ||
    ticket.type === 'sub-task';
}

function renderTicket(ticket: Ticket): string {
  const lines = [
    `# ${ticket.id}: ${ticket.title}`,
    '',
    `- Type: ${ticket.type}`,
    `- Status: ${ticket.status}`,
    `- Priority: ${ticket.priority}`,
    `- Iteration: ${ticket.iterationId}`,
    ticket.parentTicketId ? `- Parent: ${ticket.parentTicketId}` : '',
    ticket.relatedTicketIds.length > 0 ? `- Related: ${ticket.relatedTicketIds.join(', ')}` : '',
    ticket.blockedByTicketIds.length > 0 ? `- Blocked by: ${ticket.blockedByTicketIds.join(', ')}` : '',
    '',
    '## Description',
    ticket.description,
    '',
    '## Acceptance',
    ...(ticket.acceptance.length > 0 ? ticket.acceptance.map((item) => `- ${item}`) : ['- Not specified']),
    '',
  ];
  if (
    ticket.type === 'epic' ||
    ticket.type === 'feature' ||
    ticket.type === 'task' ||
    ticket.type === 'sub-task'
  ) {
    lines.push(
      '## Work Graph',
      `- Kind: ${ticket.workKind}`,
      `- Depends on: ${ticket.dependsOnTicketIds.join(', ') || 'none'}`,
      ticket.verificationTicketId
        ? `- Verification Feature: ${ticket.verificationTicketId}`
        : '',
      ticket.pairedSourceTicketId
        ? `- Paired source Feature: ${ticket.pairedSourceTicketId}`
        : '',
      `- Attempts: ${ticket.execution.attempts}/${ticket.execution.maxAttempts}`,
      '',
    );
  }
  if (ticket.type === 'bug') {
    lines.push(
      '## Bug',
      `- Kind: ${ticket.kind}`,
      `- Reason: ${ticket.reason}`,
      ticket.targetStepId ? `- Debug target: ${ticket.targetStepId} ${ticket.targetPhase ?? ''}` : '',
      ticket.verificationStepId
        ? `- Verification: ${ticket.verificationStepId} ${ticket.verificationPhase ?? ''}`
        : '',
      ticket.bugResolutionPlan ? `- Resolution plan: ${ticket.bugResolutionPlan}` : '',
      '',
    );
  }
  if (ticket.type === 'enhance') {
    lines.push(
      '## Enhancement Finding',
      `- Kind: ${ticket.kind}`,
      ticket.sourceBugTicketId ? `- Source Bug: ${ticket.sourceBugTicketId}` : '',
      ticket.sourceQualityGateStepId
        ? `- Source quality gate: ${ticket.sourceQualityGateStepId}`
        : '',
      ticket.targetStepId ? `- Remediation target: ${ticket.targetStepId} ${ticket.targetPhase ?? ''}` : '',
      ticket.verificationStepId
        ? `- Verification: ${ticket.verificationStepId} ${ticket.verificationPhase ?? ''}`
        : '',
      ...(ticket.qualityFailures ?? []).map((failure) => `- Quality gap: ${failure}`),
      `- Affected work: ${ticket.affectedWorkTicketIds.join(', ') || 'none'}`,
      `- Change Requests: ${ticket.changeRequestTicketIds.join(', ') || 'none'}`,
      `- Disposition: ${ticket.disposition}`,
      '',
      ticket.finding,
      '',
    );
  }
  if (ticket.type === 'change-request') {
    lines.push(
      '## Change Request',
      `- Revision: ${ticket.revision}`,
      `- Trigger ticket: ${ticket.triggerTicketId}`,
      `- Source enhancement: ${ticket.sourceEnhanceTicketId}`,
      ticket.originBugTicketId ? `- Origin Bug: ${ticket.originBugTicketId}` : '',
      `- Contract delta: ${ticket.contractChange.summary}`,
      `- Current step: ${ticket.execution.currentStepId ?? 'pending'}`,
      `- Completed steps: ${ticket.execution.completedStepIds.join(', ') || 'none'}`,
      '',
      '## Implementation Plan',
      ticket.implementationPlan,
      '',
      '## Applications',
      ...(ticket.applications.length > 0
        ? ticket.applications.map(
            (application) =>
              `- r${application.revision} ${application.stepId} ${application.kind}: ` +
              `${application.commit} (${application.changedFiles.join(', ') || 'no file change'})`,
          )
        : ['- Pending']),
      '',
    );
  }
  if (ticket.modelAttributions.length > 0) {
    lines.push(
      '## Model Attribution',
      ...ticket.modelAttributions.map((attribution) =>
        `- ${attribution.provider} / ${attribution.role}: ` +
        `${attribution.contribution} -> ${attribution.outcome}` +
        `${attribution.stepId ? ` (${attribution.stepId})` : ''}`
      ),
      '',
    );
  }
  return `${lines.filter((line) => line !== '').join('\n')}\n`;
}
