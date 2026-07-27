import { z } from 'zod';
import type { Workspace } from '../workspace/workspace.js';
import { assertStateTransition, type StateTransitions } from '../util/state_machine.js';
import { PHASES, ROLES, type Phase, type Step } from './plan.js';

export const CHANGE_REQUEST_VERSION = 1;
export const CHANGE_REQUEST_STATUSES = [
  'open',
  'implementing',
  'verifying',
  'rework',
  'closed',
  'cancelled',
  'failed',
] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];

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

export const EngineeringChangeRequestSchema = z.object({
  version: z.literal(CHANGE_REQUEST_VERSION),
  id: z.string().regex(/^CR-P\d{1,3}-\d{3}$/u),
  iterationId: z.string().regex(/^P\d{1,3}$/u),
  issueId: z.string().min(1),
  relatedIssueIds: z.array(z.string().min(1)).min(1),
  parentChangeRequestId: z.string().min(1).optional(),
  status: z.enum(CHANGE_REQUEST_STATUSES),
  revision: z.number().int().positive(),
  title: z.string().min(1),
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
    checks: z.array(z.string()).min(1),
    failurePolicy: z.string().min(1),
    rollbackTargetStepId: z.string().min(1),
    rollbackTargetPhase: z.enum(PHASES),
  }).strict(),
  execution: z.object({
    currentStepId: z.string().min(1).optional(),
    completedStepIds: z.array(z.string().min(1)),
    blockedBy: z.array(z.string().min(1)),
  }).strict(),
  applications: z.array(ChangeRequestApplicationSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  closedAt: z.string().min(1).optional(),
  cancelledAt: z.string().min(1).optional(),
  failureReason: z.string().min(1).optional(),
}).strict();

export type EngineeringChangeRequest = z.infer<typeof EngineeringChangeRequestSchema>;
export type ChangeRequestApplication = z.infer<typeof ChangeRequestApplicationSchema>;

const CHANGE_REQUEST_TRANSITIONS: StateTransitions<ChangeRequestStatus> = {
  open: ['implementing', 'verifying', 'rework', 'closed', 'cancelled', 'failed'],
  implementing: ['verifying', 'rework', 'closed', 'cancelled', 'failed'],
  verifying: ['implementing', 'rework', 'closed', 'cancelled', 'failed'],
  rework: ['implementing', 'verifying', 'closed', 'cancelled', 'failed'],
  closed: [],
  cancelled: [],
  failed: [],
};

const TERMINAL_STATUSES = new Set<ChangeRequestStatus>(['closed', 'cancelled', 'failed']);

export class ChangeRequestStore {
  private requests: EngineeringChangeRequest[] = [];
  private loaded = false;

  constructor(private readonly workspace: Workspace) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.workspace.readFile('.xcompiler/change-requests/index.json').catch(() => '');
    if (raw.trim()) {
      this.requests = z.array(EngineeringChangeRequestSchema).parse(JSON.parse(raw));
    }
    this.loaded = true;
  }

  async create(
    input: Omit<
      EngineeringChangeRequest,
      'version' | 'id' | 'status' | 'revision' | 'applications' | 'createdAt' | 'updatedAt'
    >,
  ): Promise<EngineeringChangeRequest> {
    await this.load();
    const now = new Date().toISOString();
    const request = EngineeringChangeRequestSchema.parse({
      ...input,
      version: CHANGE_REQUEST_VERSION,
      id: this.nextId(input.iterationId),
      status: 'open',
      revision: 1,
      applications: [],
      createdAt: now,
      updatedAt: now,
    });
    this.requests.push(request);
    await this.persist(request);
    return request;
  }

  find(id: string): EngineeringChangeRequest | undefined {
    return this.requests.find((request) => request.id === id);
  }

  activeRequests(): EngineeringChangeRequest[] {
    return this.requests.filter((request) => !TERMINAL_STATUSES.has(request.status));
  }

  activeForStep(step: Step): EngineeringChangeRequest | undefined {
    const iterationId = step.iterationId ?? 'P1';
    return [...this.requests].reverse().find(
      (request) =>
        request.iterationId === iterationId &&
        !TERMINAL_STATUSES.has(request.status) &&
        (
          request.designSource.stepId === step.id ||
          request.affectedSteps.some((affected) => affected.stepId === step.id)
        ),
    );
  }

  async recordApplication(
    request: EngineeringChangeRequest,
    application: Omit<ChangeRequestApplication, 'revision' | 'appliedAt'>,
  ): Promise<void> {
    const nextStatus: ChangeRequestStatus =
      application.kind === 'verification' ? 'verifying' : 'implementing';
    transitionChangeRequest(request, nextStatus);
    request.applications.push({
      ...application,
      revision: request.revision,
      appliedAt: new Date().toISOString(),
    });
    request.execution.currentStepId = application.stepId;
    request.execution.completedStepIds = dedup([
      ...request.execution.completedStepIds,
      application.stepId,
    ]);
    await this.touch(request);
  }

  async requestRework(
    request: EngineeringChangeRequest,
    issueId: string,
    reason: string,
  ): Promise<void> {
    transitionChangeRequest(request, 'rework');
    request.revision += 1;
    request.relatedIssueIds = dedup([...request.relatedIssueIds, issueId]);
    request.execution.currentStepId = undefined;
    request.failureReason = reason;
    await this.touch(request);
  }

  async blockOnChild(
    request: EngineeringChangeRequest,
    childId: string,
    issueId: string,
    reason: string,
  ): Promise<void> {
    if (!request.relatedIssueIds.includes(issueId)) {
      await this.requestRework(request, issueId, reason);
    } else {
      transitionChangeRequest(request, 'rework');
      request.failureReason = reason;
    }
    request.execution.blockedBy = dedup([...request.execution.blockedBy, childId]);
    await this.touch(request);
  }

  async unblockParent(child: EngineeringChangeRequest): Promise<EngineeringChangeRequest | undefined> {
    if (!child.parentChangeRequestId) return undefined;
    const parent = this.find(child.parentChangeRequestId);
    if (!parent || TERMINAL_STATUSES.has(parent.status)) return parent;
    parent.execution.blockedBy = parent.execution.blockedBy.filter((id) => id !== child.id);
    await this.touch(parent);
    return parent;
  }

  async close(request: EngineeringChangeRequest): Promise<void> {
    transitionChangeRequest(request, 'closed');
    request.closedAt = new Date().toISOString();
    request.failureReason = undefined;
    await this.touch(request, request.closedAt);
  }

  async cancel(request: EngineeringChangeRequest, reason: string): Promise<void> {
    transitionChangeRequest(request, 'cancelled');
    request.cancelledAt = new Date().toISOString();
    request.failureReason = reason;
    await this.touch(request, request.cancelledAt);
  }

  async fail(request: EngineeringChangeRequest, reason: string): Promise<void> {
    transitionChangeRequest(request, 'failed');
    request.failureReason = reason;
    await this.touch(request);
  }

  private nextId(iterationId: string): string {
    const prefix = `CR-${iterationId}-`;
    const max = this.requests.reduce((current, request) => {
      if (!request.id.startsWith(prefix)) return current;
      const value = Number.parseInt(request.id.slice(prefix.length), 10);
      return Number.isFinite(value) ? Math.max(current, value) : current;
    }, 0);
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
  }

  private async touch(request: EngineeringChangeRequest, at = new Date().toISOString()): Promise<void> {
    request.updatedAt = at;
    await this.persist(request);
  }

  private async persist(request: EngineeringChangeRequest): Promise<void> {
    EngineeringChangeRequestSchema.parse(request);
    await this.workspace.writeFile(
      `.xcompiler/change-requests/${request.id}.json`,
      `${JSON.stringify(request, null, 2)}\n`,
    );
    await this.workspace.writeFile(
      `.xcompiler/change-requests/${request.id}.md`,
      renderChangeRequest(request),
    );
    await this.workspace.writeFile(
      '.xcompiler/change-requests/index.json',
      `${JSON.stringify(this.requests, null, 2)}\n`,
    );
  }
}

export function transitionChangeRequest(
  request: EngineeringChangeRequest,
  next: ChangeRequestStatus,
): boolean {
  const changed = assertStateTransition(
    'change request',
    request.id,
    request.status,
    next,
    CHANGE_REQUEST_TRANSITIONS,
  );
  if (!changed) return false;
  request.status = next;
  return true;
}

export function affectedStepContract(step: Step): EngineeringChangeRequest['affectedSteps'][number] {
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

function renderChangeRequest(request: EngineeringChangeRequest): string {
  const lines = [
    `# ${request.id}: ${request.title}`,
    '',
    `- Status: ${request.status}`,
    `- Revision: ${request.revision}`,
    `- Primary issue: ${request.issueId}`,
    `- Related issues: ${request.relatedIssueIds.join(', ')}`,
    `- Iteration: ${request.iterationId}`,
    `- Design source: ${request.designSource.stepId} ${request.designSource.phase}`,
    `- Trigger: ${request.trigger.failedStepId} ${request.trigger.failedPhase}`,
    request.parentChangeRequestId ? `- Parent CR: ${request.parentChangeRequestId}` : '',
    '',
    '## Objective',
    request.objective,
    '',
    '## Scope',
    ...request.scope.in.map((item) => `- In: ${item}`),
    ...request.scope.out.map((item) => `- Out: ${item}`),
    '',
    '## Contract Change',
    request.contractChange.summary,
    ...request.contractChange.before.map((item) => `- Before: ${item}`),
    ...request.contractChange.after.map((item) => `- After: ${item}`),
    '',
    '## Implementation Plan',
    request.implementationPlan,
    '',
    '## Affected Steps',
    ...request.affectedSteps.map(
      (step) => `- ${step.stepId} ${step.phase}: ${step.title}; outputs=${step.outputs.join(', ') || 'none'}`,
    ),
    '',
    '## Verification',
    ...request.verification.checks.map((check) => `- ${check}`),
    `- Failure policy: ${request.verification.failurePolicy}`,
    `- Rollback target: ${request.verification.rollbackTargetStepId} ${request.verification.rollbackTargetPhase}`,
    '',
    '## Execution',
    `- Current step: ${request.execution.currentStepId ?? 'pending'}`,
    `- Completed steps: ${request.execution.completedStepIds.join(', ') || 'none'}`,
    `- Blocked by: ${request.execution.blockedBy.join(', ') || 'none'}`,
    '',
    '## Applications',
    ...(request.applications.length > 0
      ? request.applications.map(
          (application) =>
            `- r${application.revision} ${application.stepId} ${application.kind}: ` +
            `${application.commit} (${application.changedFiles.join(', ') || 'no file change'})`,
        )
      : ['- Pending']),
    '',
  ];
  return `${lines.filter((line) => line !== '').join('\n')}\n`;
}
