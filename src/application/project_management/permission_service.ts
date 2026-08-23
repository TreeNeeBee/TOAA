import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { Project } from '../../domain/projects/project.js';
import type { Ticket } from '../../domain/tickets/ticket.js';
import type {
  ToolPermissionDecision,
  ToolPermissionRequest,
  ToolPermissionRequester,
} from '../../tools/types.js';
import { GovernanceService } from './governance_service.js';
import path from 'node:path';
import type { AuditLogger } from '../../audit/audit.js';

export type PermissionStatus = 'requested' | 'approved' | 'denied';

export class ProjectPermissionService {
  private readonly governance: GovernanceService;
  private readonly cache = new Map<string, ToolPermissionDecision>();
  private readonly pending = new Map<string, Promise<ToolPermissionDecision>>();

  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    private readonly project: Project,
    private readonly options: {
      projectRoot: string;
      timeoutMs?: number;
      mode?: 'request' | 'auto' | 'deny';
      audit?: AuditLogger;
    },
  ) {
    this.governance = new GovernanceService(repository);
  }

  async request(
    request: ToolPermissionRequest,
    authorize: ToolPermissionRequester,
    onStatus?: (status: PermissionStatus) => void | Promise<void>,
  ): Promise<ToolPermissionDecision> {
    const classified = classifyPermission(request, this.options.projectRoot);
    if (classified.kind === 'internal') {
      const approved: ToolPermissionDecision = {
        approved: true,
        outcome: 'approved',
        capability: classified.capability,
        reason: 'Project-internal operation is governed by its Step, Tool, sandbox, and Git gate.',
      };
      await this.recordAudit(request, approved, false);
      return approved;
    }
    if (classified.kind === 'hard-denied') {
      const denied: ToolPermissionDecision = {
        approved: false,
        outcome: 'hard_denied',
        capability: classified.capability,
        reason: 'Access outside the project container is prohibited and cannot be authorized.',
      };
      await onStatus?.('denied');
      await this.recordAudit(request, denied, false);
      return denied;
    }
    const key = `${this.project.id}:${classified.capability}`;
    const cached = this.cache.get(key);
    if (cached) {
      await this.options.audit?.event('note', `permission cache hit: ${classified.capability}`, {
        messageId: 'runtime.permission_cache_hit',
        projectId: this.project.id,
        capability: classified.capability,
        approved: cached.approved,
      });
      return { ...cached, cached: true };
    }
    const active = this.pending.get(key);
    if (active) return { ...await active, cached: true };
    const decision = this.requestExternal(request, authorize, onStatus, classified.capability)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, decision);
    const resolved = await decision;
    this.cache.set(key, resolved);
    await this.recordAudit(request, resolved, false);
    return resolved;
  }

  private async requestExternal(
    request: ToolPermissionRequest,
    authorize: ToolPermissionRequester,
    onStatus: ((status: PermissionStatus) => void | Promise<void>) | undefined,
    capability: string,
  ): Promise<ToolPermissionDecision> {
    const relatedTicket = await this.relatedTicket(request.stepId);
    const interactive = (this.options.mode ?? 'request') === 'request';
    const interaction = interactive
      ? await this.governance.requestInteraction({
          projectId: this.project.id,
          requestedByActorId: this.project.pmActorId,
          interactionType: 'permission',
          prompt: `${request.operationType}: ${request.target}\n${request.reason}`,
          choices: ['approve', 'deny'],
          risk: request.risk,
          relatedTicketId: relatedTicket?.id,
          correlationId: relatedTicket?.source.correlationId ?? this.project.id,
        })
      : undefined;
    if (interactive) await onStatus?.('requested');
    const decision = await withPermissionTimeout(
      authorize(request),
      this.options.timeoutMs ?? 0,
      capability,
    );
    if (interaction) {
      await this.governance.answerInteraction(
        interaction.id,
        decision.approved ? 'approved' : `denied${decision.reason ? `: ${decision.reason}` : ''}`,
      );
    }
    await this.governance.recordDecision({
      projectId: this.project.id,
      decisionType: 'permission',
      decidedByActorId: this.project.pmActorId,
      authority: 'user',
      options: ['approve', 'deny'],
      selected: decision.approved ? 'approve' : decision.outcome === 'timed_out' ? 'timeout' : 'deny',
      rationale: decision.reason ?? (decision.approved ? request.reason : request.denyBehavior),
      confidence: 1,
      evidenceRefs: [...(interaction ? [interaction.id] : []), ...(relatedTicket ? [relatedTicket.id] : [])],
      correlationId: relatedTicket?.source.correlationId ?? this.project.id,
      causationId: interaction?.id,
    });
    if (interactive) await onStatus?.(decision.approved ? 'approved' : 'denied');
    return { ...decision, capability };
  }

  private async relatedTicket(stepId?: string): Promise<Ticket | undefined> {
    if (!stepId) return undefined;
    const tickets = await this.repository.list({ objectType: 'ticket', projectId: this.project.id });
    return tickets.find((candidate): candidate is Ticket =>
      candidate.objectType === 'ticket' &&
      candidate.stepId === stepId as ObjectId &&
      candidate.state !== 'closed' &&
      candidate.state !== 'cancelled',
    );
  }

  private async recordAudit(
    request: ToolPermissionRequest,
    decision: ToolPermissionDecision,
    cached: boolean,
  ): Promise<void> {
    await this.options.audit?.event('note', `permission ${decision.outcome ?? (decision.approved ? 'approved' : 'denied')}: ${decision.capability}`, {
      messageId: 'runtime.permission_decision',
      projectId: this.project.id,
      operationType: request.operationType,
      target: request.target,
      capability: decision.capability,
      outcome: decision.outcome,
      approved: decision.approved,
      cached,
      reason: decision.reason,
    });
  }
}

type PermissionClass = { kind: 'internal' | 'external' | 'hard-denied'; capability: string };

function classifyPermission(request: ToolPermissionRequest, projectRoot: string): PermissionClass {
  if (request.operationType === 'external_read' || request.operationType === 'external_write') {
    return { kind: 'hard-denied', capability: `${request.operationType}:outside-project` };
  }
  if (request.operationType === 'file_write' || request.operationType === 'file_delete' ||
      request.operationType === 'config_change') {
    const targets = request.target.split(',').map((value) => value.trim()).filter(Boolean);
    const outside = targets.some((target) => path.isAbsolute(target) && !isWithin(projectRoot, target));
    return outside
      ? { kind: 'hard-denied', capability: `${request.operationType}:outside-project` }
      : { kind: 'internal', capability: `${request.operationType}:project` };
  }
  if (
    request.operationType === 'git_operation' &&
    request.metadata?.requiresExternalAuthorization === true
  ) {
    return {
      kind: 'external',
      capability: `protected-git:${request.scope}:${request.target}`,
    };
  }
  if (['shell_command', 'test_command', 'build_command', 'git_operation'].includes(request.operationType)) {
    return { kind: 'internal', capability: `${request.operationType}:project` };
  }
  if (request.operationType === 'network_access') {
    return { kind: 'external', capability: `network:${networkOrigin(request.target)}` };
  }
  if (request.operationType === 'install_dependency') {
    return { kind: 'external', capability: `dependency-registry:${request.scope}` };
  }
  return { kind: 'external', capability: `${request.operationType}:${request.scope}` };
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function networkOrigin(target: string): string {
  try {
    return new URL(target).origin;
  } catch {
    return target;
  }
}

async function withPermissionTimeout(
  decision: Promise<ToolPermissionDecision>,
  timeoutMs: number,
  capability: string,
): Promise<ToolPermissionDecision> {
  if (timeoutMs === 0) return decision;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      decision,
      new Promise<ToolPermissionDecision>((resolve) => {
        timer = setTimeout(() => resolve({
          approved: false,
          outcome: 'timed_out',
          capability,
          reason: `Permission request timed out after ${timeoutMs}ms.`,
        }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
