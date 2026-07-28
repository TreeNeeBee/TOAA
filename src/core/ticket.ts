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
  type StepSubtask,
} from './plan.js';

export const TICKET_VERSION = 2;
export const TICKET_TYPES = [
  'task',
  'sub-task',
  'change-request',
  'bug',
  'enhance',
  'feature',
] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

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
  type: 'task' | 'sub-task' | 'feature';
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
  affectedTaskTicketIds: string[];
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
  id: z.string().regex(/^(?:TASK|SUBTASK|CR|BUG|ENHANCE|FEATURE)-P\d{1,3}-\d{3}$/u),
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
  type: z.enum(['task', 'sub-task', 'feature']),
}).strict().superRefine((ticket, ctx) => {
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
  affectedTaskTicketIds: z.array(z.string().regex(/^TASK-P\d{1,3}-\d{3}$/u)),
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
  failed: ['triaged', 'in_progress', 'cancelled'],
};

const TYPE_PREFIX: Record<TicketType, string> = {
  task: 'TASK',
  'sub-task': 'SUBTASK',
  'change-request': 'CR',
  bug: 'BUG',
  enhance: 'ENHANCE',
  feature: 'FEATURE',
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

export class TicketStore {
  private tickets: Ticket[] = [];
  private loaded = false;

  constructor(private readonly workspace: Workspace) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.workspace.readFile('.xcompiler/tickets/index.json').catch(() => '');
    if (raw.trim()) {
      this.tickets = z.array(TicketSchema).parse(JSON.parse(raw));
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

  activeQualityEnhanceForStep(stepId: string): EnhanceTicket | undefined {
    return [...this.tickets].reverse().find(
      (ticket): ticket is EnhanceTicket =>
        ticket.type === 'enhance' &&
        ticket.sourceQualityGateStepId === stepId &&
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

  workForStep(stepId: string): WorkTicket | undefined {
    return this.tickets.find(
      (ticket): ticket is WorkTicket =>
        ticket.type === 'task' && ticket.source.stepId === stepId,
    );
  }

  async registerPlan(plan: Plan): Promise<void> {
    await this.load();
    const iterationIds = [...new Set(plan.steps.map((step) => step.iterationId ?? 'P1'))];
    for (const iterationId of iterationIds) {
      let root = this.tickets.find(
        (ticket): ticket is WorkTicket =>
          ticket.type === 'feature' &&
          ticket.iterationId === iterationId &&
          ticket.source.externalId === `${plan.requirementDigest}:${iterationId}`,
      );
      if (!root) {
        root = await this.createWork({
          type: 'feature',
          iterationId,
          title: `${iterationId} ${plan.intent}`,
          description: plan.requirementDigest,
          priority: 'high',
          source: { kind: 'plan', externalId: `${plan.requirementDigest}:${iterationId}` },
          acceptance: ['All V-model tasks and verification gates in this iteration are complete.'],
          artifacts: [],
        });
      }

      for (const step of plan.steps.filter((candidate) => (candidate.iterationId ?? 'P1') === iterationId)) {
        let task = this.workForStep(step.id);
        if (!task) {
          task = await this.createWork({
            type: 'task',
            iterationId,
            title: `${step.id} ${step.title}`,
            description: step.description,
            priority: 'high',
            parentTicketId: root.id,
            rootTicketId: root.id,
            source: {
              kind: 'plan',
              externalId: step.id,
              stepId: step.id,
              phase: step.phase,
              role: step.role,
            },
            acceptance: [step.acceptance],
            artifacts: [...step.outputs],
          });
          root.relatedTicketIds = dedup([...root.relatedTicketIds, task.id]);
          await this.persist(root, 'linked', { relatedTicketId: task.id });
        }
        await this.registerSubTasks(step, step.subTasks ?? [], task, root, []);
        if (step.status === 'DONE' && task.status !== 'closed') {
          await this.syncStepCompleted(step);
        } else if (step.status === 'RUNNING' && task.status !== 'in_progress') {
          await this.syncStepStarted(step);
        }
      }
    }
  }

  async createWork(input: {
    type: WorkTicket['type'];
    iterationId: string;
    title: string;
    description: string;
    priority?: TicketPriority;
    parentTicketId?: string;
    rootTicketId?: string;
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
    await this.reopenAncestors(ticket, 'enhancement-opened', {
      enhanceTicketId: ticket.id,
      sourceBugTicketId: ticket.sourceBugTicketId,
      sourceQualityGateStepId: ticket.sourceQualityGateStepId,
    });
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

  async linkEnhanceToChange(
    ticket: EnhanceTicket,
    changeRequestTicketId: string,
  ): Promise<void> {
    ticket.changeRequestTicketIds = dedup([
      ...ticket.changeRequestTicketIds,
      changeRequestTicketId,
    ]);
    ticket.relatedTicketIds = dedup([
      ...ticket.relatedTicketIds,
      changeRequestTicketId,
    ]);
    ticket.disposition = 'change-request';
    if (ticket.status === 'open' || ticket.status === 'triaged') {
      transitionTicket(ticket, 'in_progress');
    }
    await this.persist(ticket, 'change-request-linked', { changeRequestTicketId });
  }

  async closeEnhance(ticket: EnhanceTicket): Promise<void> {
    await this.resolveAndClose(ticket, 'enhancement-verified');
    await this.maybeCloseParent(ticket);
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
    await this.persist(ticket, 'unblocked', { blockerId });
  }

  async syncStepStarted(step: Step): Promise<void> {
    const ticket = this.workForStep(step.id);
    if (!ticket) return;
    await this.reopenAncestors(ticket, 'child-work-started', {
      childTicketId: ticket.id,
      stepId: step.id,
      phase: step.phase,
    });
    if (ticket.status !== 'blocked') {
      transitionTicket(ticket, 'in_progress');
    }
    await this.persist(
      ticket,
      ticket.status === 'blocked' ? 'blocked-work-repair-started' : 'work-started',
      { stepId: step.id, phase: step.phase },
    );
    for (const child of this.descendantsOf(ticket.id)) {
      transitionTicket(child, 'in_progress');
      await this.persist(child, 'work-started', { stepId: step.id, phase: step.phase });
    }
  }

  async syncStepFailed(step: Step, bugTicketId: string): Promise<void> {
    const ticket = this.workForStep(step.id);
    if (!ticket) return;
    await this.link(ticket, bugTicketId, 'bug-linked');
    await this.block(ticket, bugTicketId, `${step.id} is blocked by ${bugTicketId}`);
  }

  async syncStepCompleted(step: Step): Promise<void> {
    const ticket = this.workForStep(step.id);
    if (!ticket) return;
    for (const child of this.descendantsOf(ticket.id).reverse()) {
      await this.resolveAndClose(child, 'work-completed', { stepId: step.id });
    }
    await this.resolveAndClose(ticket, 'work-completed', { stepId: step.id, phase: step.phase });
    await this.maybeCloseParent(ticket);
  }

  async syncStepReset(step: Step, reason: string): Promise<void> {
    const ticket = this.workForStep(step.id);
    if (!ticket) return;
    if (ticket.status !== 'open') transitionTicket(ticket, 'in_progress');
    ticket.failureReason = reason;
    await this.persist(ticket, 'work-reopened', { stepId: step.id, reason });
    for (const child of this.descendantsOf(ticket.id)) {
      if (child.status !== 'open') transitionTicket(child, 'in_progress');
      await this.persist(child, 'work-reopened', { stepId: step.id, reason });
    }
    await this.reopenAncestors(ticket, 'child-work-reopened', {
      childTicketId: ticket.id,
      stepId: step.id,
      reason,
    });
  }

  async recordApplication(
    ticket: ChangeRequestTicket,
    application: Omit<ChangeRequestApplication, 'revision' | 'appliedAt'>,
  ): Promise<void> {
    transitionTicket(ticket, application.kind === 'verification' ? 'verification' : 'in_progress');
    ticket.applications.push({
      ...application,
      revision: ticket.revision,
      appliedAt: new Date().toISOString(),
    });
    ticket.execution.currentStepId = application.stepId;
    ticket.execution.completedStepIds = dedup([
      ...ticket.execution.completedStepIds,
      application.stepId,
    ]);
    await this.persist(ticket, 'application-recorded', { application });
  }

  async requestChangeRework(
    ticket: ChangeRequestTicket,
    triggerTicketId: string,
    reason: string,
  ): Promise<void> {
    transitionTicket(ticket, 'in_progress');
    ticket.revision += 1;
    ticket.relatedTicketIds = dedup([...ticket.relatedTicketIds, triggerTicketId]);
    ticket.execution.currentStepId = undefined;
    ticket.revisionReason = reason;
    await this.persist(ticket, 'rework-requested', { triggerTicketId, reason });
  }

  async blockChangeOnChild(
    ticket: ChangeRequestTicket,
    childTicketId: string,
    bugTicketId: string,
    reason: string,
  ): Promise<void> {
    if (!ticket.relatedTicketIds.includes(bugTicketId)) {
      await this.requestChangeRework(ticket, bugTicketId, reason);
    }
    await this.block(ticket, childTicketId, reason);
  }

  async closeChange(ticket: ChangeRequestTicket): Promise<void> {
    ticket.revisionReason = undefined;
    await this.resolveAndClose(ticket, 'change-completed');
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
        stepId: ticket.source.stepId,
        phase: ticket.source.phase,
        modelProviders: dedup(ticket.modelAttributions.map((attribution) => attribution.provider)),
        ...(ticket.type === 'enhance'
          ? {
              enhanceKind: ticket.kind,
              sourceBugTicketId: ticket.sourceBugTicketId,
              affectedTaskTicketIds: ticket.affectedTaskTicketIds,
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

  private async registerSubTasks(
    step: Step,
    subTasks: StepSubtask[],
    parent: WorkTicket,
    root: WorkTicket,
    ancestry: number[],
  ): Promise<void> {
    for (const [index, subTask] of subTasks.entries()) {
      const path = [...ancestry, index + 1];
      const externalId = `${step.id}/${path.join('.')}/${subTask.id}`;
      let ticket = this.tickets.find(
        (candidate): candidate is WorkTicket =>
          candidate.type === 'sub-task' &&
          candidate.source.externalId === externalId,
      );
      if (!ticket) {
        ticket = await this.createWork({
          type: 'sub-task',
          iterationId: step.iterationId ?? 'P1',
          title: `${subTask.id} ${subTask.title}`,
          description: subTask.description,
          parentTicketId: parent.id,
          rootTicketId: root.id,
          source: {
            kind: 'plan',
            externalId,
            stepId: step.id,
            phase: step.phase,
            role: step.role,
          },
          acceptance: subTask.acceptance ? [subTask.acceptance] : [],
          artifacts: subTask.outputs ?? [],
        });
        parent.relatedTicketIds = dedup([...parent.relatedTicketIds, ticket.id]);
        await this.persist(parent, 'linked', { relatedTicketId: ticket.id });
      }
      await this.registerSubTasks(step, subTask.subTasks ?? [], ticket, root, path);
    }
  }

  private descendantsOf(parentId: string): WorkTicket[] {
    const direct = this.tickets.filter(
      (ticket): ticket is WorkTicket =>
        ticket.type === 'sub-task' && ticket.parentTicketId === parentId,
    );
    return direct.flatMap((ticket) => [ticket, ...this.descendantsOf(ticket.id)]);
  }

  private async resolveAndClose(
    ticket: Ticket,
    event: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (ticket.status === 'open' || ticket.status === 'triaged' || ticket.status === 'failed') {
      transitionTicket(ticket, 'in_progress');
      await this.persist(ticket, `${event}:started`, extra);
    }
    if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
      transitionTicket(ticket, 'resolved');
      await this.persist(ticket, `${event}:resolved`, extra);
    }
    if (ticket.status !== 'closed') {
      transitionTicket(ticket, 'closed');
      await this.persist(ticket, `${event}:closed`, extra);
    }
  }

  private async maybeCloseParent(ticket: Ticket): Promise<void> {
    if (!ticket.parentTicketId) return;
    const parent = this.find(ticket.parentTicketId);
    if (!parent || parent.type !== 'feature') return;
    const children = this.tickets.filter((candidate) => candidate.parentTicketId === parent.id);
    if (children.length > 0 && children.every((candidate) => candidate.status === 'closed')) {
      await this.resolveAndClose(parent, 'all-child-work-completed');
    }
  }

  private async reopenAncestors(
    ticket: Ticket,
    event: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    let child = ticket;
    while (child.parentTicketId) {
      const parent = this.find(child.parentTicketId);
      if (!parent) return;
      if (parent.status === 'resolved' || parent.status === 'closed') {
        transitionTicket(parent, 'in_progress');
        await this.persist(parent, event, {
          ...extra,
          directChildTicketId: child.id,
        });
      }
      child = parent;
    }
  }

  private nextId(type: TicketType, iterationId: string): string {
    const prefix = `${TYPE_PREFIX[type]}-${iterationId}-`;
    const max = this.tickets.reduce((current, ticket) => {
      if (!ticket.id.startsWith(prefix)) return current;
      const value = Number.parseInt(ticket.id.slice(prefix.length), 10);
      return Number.isFinite(value) ? Math.max(current, value) : current;
    }, 0);
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
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
      `- Affected Tasks: ${ticket.affectedTaskTicketIds.join(', ') || 'none'}`,
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
