import { createObjectEnvelope, reviseObjectEnvelope } from '../objects/object_envelope.js';
import type { ObjectId } from '../identity/object_id.js';
import type { ObjectRef } from '../objects/object_ref.js';
import { ProjectSchema } from '../projects/project.js';
import { TicketSchema } from '../tickets/ticket.js';
import type { DomainObjectRepository } from '../../infrastructure/repository/domain_object_repository.js';
import {
  DomainAuditEventSchema,
  DomainLogSchema,
  type DomainAuditEvent,
  type DomainLog,
} from './records.js';

interface TraceInput {
  projectId: ObjectId;
  subject?: ObjectRef;
  correlationId: ObjectId;
  causationId?: ObjectId;
}

export class DomainAuditTrail {
  constructor(private readonly repository: DomainObjectRepository) {}

  async recordEvent(input: TraceInput & {
    kind: string;
    actor: string;
    payload?: Record<string, unknown>;
  }): Promise<DomainAuditEvent> {
    await this.assertSubject(input.projectId, input.subject);
    const event = DomainAuditEventSchema.parse({
      ...createObjectEnvelope({
        name: auditName('AUD', input.kind),
        objectType: 'audit-event',
        projectId: input.projectId,
      }),
      subject: input.subject,
      kind: input.kind,
      actor: input.actor,
      correlationId: input.correlationId,
      causationId: input.causationId,
      payload: input.payload ?? {},
      occurredAt: new Date().toISOString(),
    });
    await this.repository.insert(event);
    const projectObject = await this.repository.read(input.projectId);
    if (projectObject.objectType !== 'project') {
      throw new Error(`Audit Project ${input.projectId} does not exist`);
    }
    const project = ProjectSchema.parse({
      ...projectObject,
      ...reviseObjectEnvelope(projectObject),
      auditEventIds: [...projectObject.auditEventIds, event.id],
    });
    await this.repository.update(project, project.state);
    return event;
  }

  async recordLog(input: TraceInput & {
    level: DomainLog['level'];
    message: string;
    data?: Record<string, unknown>;
  }): Promise<DomainLog> {
    await this.assertSubject(input.projectId, input.subject);
    const log = DomainLogSchema.parse({
      ...createObjectEnvelope({
        name: auditName('LOG', input.level),
        objectType: 'log',
        projectId: input.projectId,
      }),
      subject: input.subject,
      level: input.level,
      message: input.message,
      data: input.data ?? {},
      correlationId: input.correlationId,
      causationId: input.causationId,
      occurredAt: new Date().toISOString(),
    });
    await this.repository.insert(log);
    if (input.subject?.objectType === 'ticket') {
      const ticketObject = await this.repository.read(input.subject.id);
      if (ticketObject.objectType !== 'ticket') {
        throw new Error(`Log subject ${input.subject.id} is not a Ticket`);
      }
      const ticket = TicketSchema.parse({
        ...ticketObject,
        ...reviseObjectEnvelope(ticketObject),
        logIds: [...ticketObject.logIds, log.id],
      });
      await this.repository.update(ticket, ticket.state);
    }
    return log;
  }

  private async assertSubject(projectId: ObjectId, subject?: ObjectRef): Promise<void> {
    if (!subject) return;
    const entry = this.repository.registry.require(subject.id, subject.objectType);
    if (entry.projectId !== projectId) {
      throw new Error(`Trace subject ${subject.id} does not belong to Project ${projectId}`);
    }
  }
}

function auditName(prefix: string, kind: string): string {
  const normalized = kind.replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-|-$/gu, '').toUpperCase();
  return `${prefix}-${normalized || 'EVENT'}-${Date.now().toString(36).toUpperCase()}`;
}
