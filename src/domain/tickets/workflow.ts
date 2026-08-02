import { createObjectEnvelope, reviseObjectEnvelope } from '../objects/object_envelope.js';
import type { ObjectId } from '../identity/object_id.js';
import type { Step, StepType } from '../steps/step.js';
import {
  TICKET_PRIORITY,
  TicketSchema,
  transitionTicket,
  type BugTicket,
  type ChangeRequestTicket,
  type EnhancementTicket,
  type Ticket,
  type TicketSolution,
  type WorkTicket,
} from './ticket.js';
import { ChangelistSchema, type Changelist } from '../evidence/evidence.js';
import type { DomainObjectRepository } from '../../infrastructure/repository/domain_object_repository.js';

export class TicketWorkflow {
  constructor(private readonly repository: DomainObjectRepository) {}

  async list(): Promise<Ticket[]> {
    const tickets: Ticket[] = [];
    for (const entry of this.repository.registry.byType('ticket')) {
      const object = await this.repository.read(entry.id);
      if (object.objectType === 'ticket') tickets.push(object);
    }
    return tickets;
  }

  async storyForStep(stepId: ObjectId): Promise<WorkTicket> {
    const story = (await this.list()).find(
      (ticket): ticket is WorkTicket =>
        ticket.type === 'story' &&
        ticket.workKind === 'v-model-step' &&
        ticket.stepId === stepId,
    );
    if (!story) throw new Error(`V-model Story not found for Step ${stepId}`);
    return story;
  }

  async openBug(input: {
    failedStep: Step;
    targetStep: Step;
    verificationStep: Step;
    kind: BugTicket['bugKind'];
    severity: BugTicket['severity'];
    message: string;
    summary: string;
    rawEvidenceRef?: string;
    tool?: string;
    exitCode?: number;
    statusCode?: number;
    correlationId: ObjectId;
    causationId?: ObjectId;
    parentChangeRequestId?: ObjectId;
  }): Promise<BugTicket> {
    const targetStory = await this.storyForStep(input.targetStep.id);
    const parentChangeRequest = input.parentChangeRequestId
      ? await this.requireTicket(input.parentChangeRequestId)
      : undefined;
    if (parentChangeRequest && parentChangeRequest.type !== 'change-request') {
      throw new Error(`Bug parent ${parentChangeRequest.id} is not a Change Request`);
    }
    const envelope = createObjectEnvelope({
      name: await this.nextName('BUG', input.targetStep.name.split('-')[0] ?? 'P'),
      objectType: 'ticket',
      projectId: input.targetStep.projectId,
    });
    const bug = TicketSchema.parse({
      ...envelope,
      type: 'bug',
      phaseId: input.targetStep.phaseId,
      stepId: input.failedStep.id,
      role: 'developer',
      agent: 'Debugger',
      priority: severityPriority(input.severity),
      parentTicketId: parentChangeRequest?.id ?? targetStory.id,
      rootTicketId: targetStory.rootTicketId,
      description: input.summary,
      acceptance: [
        `Repair ${input.targetStep.name} without unrelated rewrites.`,
        `Pass ${input.verificationStep.name}.`,
        'Persist the verified solution to debug-wiki.',
      ],
      relatedTicketIds: [targetStory.id, ...(parentChangeRequest ? [parentChangeRequest.id] : [])],
      state: 'created',
      source: {
        kind: 'runtime',
        correlationId: input.correlationId,
        causationId: input.causationId,
        externalId: input.failedStep.name,
      },
      bugKind: input.kind,
      maxAttempts: input.targetStep.maxAttempts,
      severity: input.severity,
      failure: {
        message: input.message,
        summary: input.summary,
        rawEvidenceRef: input.rawEvidenceRef,
        failedStepId: input.failedStep.id,
        failedStepType: input.failedStep.type,
        targetStepId: input.targetStep.id,
        targetStepType: input.targetStep.type,
        verificationStepId: input.verificationStep.id,
        verificationStepType: input.verificationStep.type,
        tool: input.tool,
        exitCode: input.exitCode,
        statusCode: input.statusCode,
      },
    }) as BugTicket;
    await this.repository.insert(bug, bug.state);
    await this.blockTicket(targetStory, bug.id, 'defect');
    if (parentChangeRequest) await this.blockTicket(parentChangeRequest, bug.id, 'defect');
    return bug;
  }

  async openEnhancement(input: {
    sourceStep: Step;
    targetStep: Step;
    verificationStep: Step;
    kind: EnhancementTicket['enhancementKind'];
    finding: string;
    sourceQualityAssessmentId?: ObjectId;
    sourceBugTicketId?: ObjectId;
    parentChangeRequestId?: ObjectId;
    correlationId: ObjectId;
    causationId?: ObjectId;
  }): Promise<EnhancementTicket> {
    const targetStory = await this.storyForStep(input.targetStep.id);
    const parentChangeRequest = input.parentChangeRequestId
      ? await this.requireTicket(input.parentChangeRequestId)
      : undefined;
    if (parentChangeRequest && parentChangeRequest.type !== 'change-request') {
      throw new Error(`Enhancement parent ${parentChangeRequest.id} is not a Change Request`);
    }
    const envelope = createObjectEnvelope({
      name: await this.nextName('ENH', input.targetStep.name.split('-')[0] ?? 'P'),
      objectType: 'ticket',
      projectId: input.targetStep.projectId,
    });
    const enhancement = TicketSchema.parse({
      ...envelope,
      type: 'enhancement',
      phaseId: input.targetStep.phaseId,
      stepId: input.sourceStep.id,
      role: input.targetStep.role,
      agent: input.targetStep.agent,
      priority: TICKET_PRIORITY.high,
      parentTicketId: parentChangeRequest?.id ?? targetStory.id,
      rootTicketId: targetStory.rootTicketId,
      description: input.finding,
      acceptance: [input.finding, `Pass ${input.verificationStep.name}.`],
      relatedTicketIds: [targetStory.id, ...(parentChangeRequest ? [parentChangeRequest.id] : [])],
      maxAttempts: input.targetStep.maxAttempts,
      state: 'created',
      source: {
        kind: 'quality-gate',
        correlationId: input.correlationId,
        causationId: input.causationId,
        externalId: input.sourceStep.name,
      },
      enhancementKind: input.kind,
      finding: input.finding,
      sourceQualityAssessmentId: input.sourceQualityAssessmentId,
      sourceBugTicketId: input.sourceBugTicketId,
      targetStepId: input.targetStep.id,
      verificationStepId: input.verificationStep.id,
    }) as EnhancementTicket;
    await this.repository.insert(enhancement, enhancement.state);
    await this.blockTicket(targetStory, enhancement.id, 'quality-gap');
    if (parentChangeRequest) await this.blockTicket(parentChangeRequest, enhancement.id, 'quality-gap');
    return enhancement;
  }

  async openChangeRequest(input: {
    sourceTicketId: ObjectId;
    triggerStepId: ObjectId;
    sourceStepId: ObjectId;
    affectedStepIds: ObjectId[];
    contractDelta: ChangeRequestTicket['contractDelta'];
    implementationPlan: string[];
    verificationGate: string[];
    parentChangeRequestId?: ObjectId;
  }): Promise<ChangeRequestTicket> {
    const source = await this.requireTicket(input.sourceTicketId);
    if (source.type !== 'bug' && source.type !== 'enhancement') {
      throw new Error('Change Request source must be a Bug or Enhancement Ticket');
    }
    const parent = source.parentTicketId
      ? await this.requireTicket(source.parentTicketId)
      : undefined;
    if (!parent || !['story', 'task', 'change-request'].includes(parent.type)) {
      throw new Error(`Source Ticket ${source.id} does not belong to executable work`);
    }
    const envelope = createObjectEnvelope({
      name: await this.nextName('CR', parent.name.split('-')[0] ?? 'P'),
      objectType: 'ticket',
      projectId: source.projectId,
    });
    const request = TicketSchema.parse({
      ...envelope,
      type: 'change-request',
      phaseId: source.phaseId,
      stepId: input.sourceStepId,
      role: parent.role,
      agent: parent.agent,
      priority: source.priority,
      parentTicketId: parent.id,
      rootTicketId: source.rootTicketId,
      description: input.contractDelta.summary,
      acceptance: input.verificationGate,
      /** Source linkage is causal, not a scheduling dependency: the source waits for this CR. */
      dependencyTicketIds: [],
      relatedTicketIds: [source.id],
      state: 'created',
      source: {
        kind: 'runtime',
        correlationId: source.source.correlationId,
        causationId: source.id,
      },
      sourceTicketId: source.id,
      maxAttempts: source.maxAttempts * Math.max(1, new Set(input.affectedStepIds).size),
      parentChangeRequestId: input.parentChangeRequestId,
      triggerStepId: input.triggerStepId,
      sourceStepId: input.sourceStepId,
      affectedStepIds: [...new Set(input.affectedStepIds)],
      contractDelta: input.contractDelta,
      implementationPlan: input.implementationPlan,
      verificationGate: input.verificationGate,
    }) as ChangeRequestTicket;
    await this.repository.insert(request, request.state);
    await this.linkChangeRequest(source, request.id);
    await this.persistTransition(source, 'pending', source.type === 'bug' ? 'defect' : 'quality-gap');
    return request;
  }

  async setSolution(ticketId: ObjectId, solution: TicketSolution): Promise<Ticket> {
    let ticket = await this.requireTicket(ticketId);
    if (ticket.state === 'created' || ticket.state === 'reopened') {
      ticket = await this.saveTransition(ticket, 'in_progress');
    } else if (ticket.state === 'pending') {
      ticket = await this.saveTransition(ticket, 'in_progress');
    }
    const updated = TicketSchema.parse({
      ...ticket,
      ...reviseObjectEnvelope(ticket),
      solution,
    });
    await this.repository.update(updated, updated.state);
    return updated;
  }

  async setDebugWikiCandidates(ticketId: ObjectId, entryIds: readonly string[]): Promise<BugTicket> {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.type !== 'bug') throw new Error(`Ticket ${ticketId} is not a Bug`);
    const updated = TicketSchema.parse({
      ...ticket,
      ...reviseObjectEnvelope(ticket),
      debugWikiCandidateEntryIds: [...new Set(entryIds)],
    }) as BugTicket;
    await this.repository.update(updated, updated.state);
    return updated;
  }

  async recordChange(input: {
    ticketId: ObjectId;
    stepId: ObjectId;
    summary: string;
    entries: Changelist['entries'];
    commit?: string;
    verification?: string[];
    verificationAssessmentId?: ObjectId;
  }): Promise<Changelist> {
    const ticket = await this.requireTicket(input.ticketId);
    if (input.verificationAssessmentId) {
      const assessment = await this.repository.read(input.verificationAssessmentId);
      if (
        assessment.objectType !== 'quality-assessment' ||
        assessment.subject.objectType !== 'step' ||
        assessment.subject.id !== input.stepId ||
        !assessment.passed
      ) {
        throw new Error('Changelist verificationAssessmentId must reference a passing assessment for the same Step');
      }
    }
    const envelope = createObjectEnvelope({
      name: `${ticket.name}-CL${String(ticket.changelistIds.length + 1).padStart(2, '0')}`,
      objectType: 'changelist',
      projectId: ticket.projectId,
    });
    const changelist = ChangelistSchema.parse({
      ...envelope,
      ticketId: ticket.id,
      stepId: input.stepId,
      entries: input.entries,
      commit: input.commit,
      summary: input.summary,
      verification: input.verification ?? [],
    });
    await this.repository.insert(changelist);
    let updated = TicketSchema.parse({
      ...ticket,
      ...reviseObjectEnvelope(ticket),
      changelistIds: [...ticket.changelistIds, changelist.id],
    });
    if (updated.type === 'change-request') {
      updated = TicketSchema.parse({
        ...updated,
        applications: [
          ...updated.applications,
          {
            stepId: input.stepId,
            changelistId: changelist.id,
            verificationAssessmentId: input.verificationAssessmentId,
            appliedAt: new Date().toISOString(),
          },
        ],
      });
    }
    await this.repository.update(updated, updated.state);
    return changelist;
  }

  async closeVerified(ticketId: ObjectId): Promise<Ticket> {
    let ticket = await this.requireTicket(ticketId);
    if (ticket.type === 'change-request') {
      const applied = new Set(ticket.applications
        .filter((application) => application.verificationAssessmentId)
        .map((application) => application.stepId));
      const missing = ticket.affectedStepIds.filter((stepId) => !applied.has(stepId));
      if (missing.length > 0) {
        throw new Error(`Change Request ${ticket.name} is missing verified applications for ${missing.join(', ')}`);
      }
    }
    if (ticket.solution?.status !== 'verified') {
      throw new Error(`Ticket ${ticket.name} cannot close without a verified solution`);
    }
    if (ticket.state === 'created' || ticket.state === 'pending' || ticket.state === 'reopened') {
      ticket = await this.saveTransition(ticket, 'in_progress');
    }
    if (ticket.state === 'in_progress') ticket = await this.saveTransition(ticket, 'resolved');
    if (ticket.state === 'resolved') ticket = await this.saveTransition(ticket, 'closed');

    if (ticket.type === 'change-request') {
      let source = await this.requireTicket(ticket.sourceTicketId);
      const openSibling = (await this.list()).some((candidate) =>
        candidate.type === 'change-request' &&
        candidate.sourceTicketId === source.id &&
        candidate.id !== ticket.id &&
        candidate.state !== 'closed' &&
        candidate.state !== 'cancelled',
      );
      if (!openSibling) {
        if (!source.solution) {
          throw new Error(`Source Ticket ${source.name} has no implementation solution`);
        }
        if (source.solution.status !== 'verified') {
          const updatedSource = TicketSchema.parse({
            ...source,
            ...reviseObjectEnvelope(source),
            solution: {
              ...source.solution,
              status: 'verified',
              verification: [
                ...source.solution.verification,
                `Change Request ${ticket.name} completed all affected Step gates.`,
              ],
              updatedAt: new Date().toISOString(),
            },
          });
          await this.repository.update(updatedSource, updatedSource.state);
          source = updatedSource;
        }
        await this.closeVerified(source.id);
      }
    }
    await this.unblockParent(ticket);
    if (ticket.type === 'bug' || ticket.type === 'enhancement') {
      for (const relatedId of ticket.relatedTicketIds.filter((id) => id !== ticket.parentTicketId)) {
        const related = await this.requireTicket(relatedId);
        if (related.type === 'story' || related.type === 'task') {
          await this.unblockTicket(related, ticket.id);
        }
      }
    }
    return ticket;
  }

  async cancelUnresolved(ticketId: ObjectId): Promise<Ticket> {
    let ticket = await this.requireTicket(ticketId);
    if (ticket.state === 'cancelled' || ticket.state === 'closed') return ticket;
    if (ticket.solution || ticket.changelistIds.length > 0) {
      throw new Error(`Ticket ${ticket.name} has implementation evidence and cannot be cancelled as unresolved`);
    }
    if (ticket.state === 'resolved') {
      throw new Error(`Resolved Ticket ${ticket.name} cannot be cancelled as unresolved`);
    }
    ticket = await this.saveTransition(ticket, 'cancelled');
    await this.unblockParent(ticket);
    for (const relatedId of ticket.relatedTicketIds.filter((id) => id !== ticket.parentTicketId)) {
      const related = await this.requireTicket(relatedId);
      if (related.type === 'story' || related.type === 'task') {
        await this.unblockTicket(related, ticket.id);
      }
    }
    return ticket;
  }

  private async requireTicket(id: ObjectId): Promise<Ticket> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'ticket') throw new Error(`Object ${id} is not a Ticket`);
    return object;
  }

  private async blockTicket(
    work: Ticket,
    blockerId: ObjectId,
    pendingReason: 'defect' | 'quality-gap',
  ): Promise<void> {
    let updated: Ticket = work;
    if (work.state === 'resolved') updated = await this.saveTransition(work, 'reopened');
    if (updated.state === 'reopened') updated = await this.saveTransition(updated, 'in_progress');
    if (updated.state === 'created' || updated.state === 'in_progress') {
      updated = await this.saveTransition(updated, 'pending', pendingReason);
    }
    updated = TicketSchema.parse({
      ...updated,
      ...reviseObjectEnvelope(updated),
      blockedByTicketIds: [...new Set([...updated.blockedByTicketIds, blockerId])],
    });
    await this.repository.update(updated, updated.state);
  }

  private async unblockParent(ticket: Ticket): Promise<void> {
    if (!ticket.parentTicketId) return;
    const parent = await this.requireTicket(ticket.parentTicketId);
    await this.unblockTicket(parent, ticket.id);
  }

  private async unblockTicket(parent: Ticket, blockerId: ObjectId): Promise<void> {
    const blockers = parent.blockedByTicketIds.filter((id) => id !== blockerId);
    const updated = TicketSchema.parse({
      ...parent,
      ...reviseObjectEnvelope(parent),
      blockedByTicketIds: blockers,
    });
    await this.repository.update(updated, updated.state);
    if (blockers.length === 0 && updated.state === 'pending') {
      await this.saveTransition(updated, 'in_progress');
    }
  }

  private async linkChangeRequest(
    source: BugTicket | EnhancementTicket,
    requestId: ObjectId,
  ): Promise<void> {
    const updated = TicketSchema.parse({
      ...source,
      ...reviseObjectEnvelope(source),
      changeRequestTicketIds: [...new Set([...source.changeRequestTicketIds, requestId])],
      relatedTicketIds: [...new Set([...source.relatedTicketIds, requestId])],
    });
    await this.repository.update(updated, updated.state);
  }

  private async persistTransition(
    ticket: Ticket,
    next: 'pending',
    pendingReason: 'defect' | 'quality-gap',
  ): Promise<void> {
    let current = await this.requireTicket(ticket.id);
    if (current.state === 'created' || current.state === 'reopened') {
      current = await this.saveTransition(current, 'in_progress');
    }
    if (current.state === 'in_progress') {
      await this.saveTransition(current, next, pendingReason);
    }
  }

  private async saveTransition(
    ticket: Ticket,
    next: Parameters<typeof transitionTicket>[1],
    pendingReason?: 'defect' | 'quality-gap',
  ): Promise<Ticket> {
    const updated = transitionTicket(ticket, next, { pendingReason });
    await this.repository.update(updated, updated.state);
    return updated;
  }

  private async nextName(prefix: string, phaseName: string): Promise<string> {
    const expression = new RegExp(`^${escapeRegExp(prefix)}-${escapeRegExp(phaseName)}-(\\d+)$`, 'u');
    const used = this.repository.registry.byType('ticket').map((entry) => {
      const match = expression.exec(entry.name);
      return match ? Number.parseInt(match[1]!, 10) : 0;
    });
    return `${prefix}-${phaseName}-${String(Math.max(0, ...used) + 1).padStart(3, '0')}`;
  }
}

function severityPriority(severity: BugTicket['severity']): number {
  if (severity === 'critical') return TICKET_PRIORITY.critical;
  if (severity === 'high') return TICKET_PRIORITY.high;
  if (severity === 'medium') return TICKET_PRIORITY.normal;
  return TICKET_PRIORITY.low;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function verificationStepTypeForFailure(type: StepType): StepType {
  return type;
}
