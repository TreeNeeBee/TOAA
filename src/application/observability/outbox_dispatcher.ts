import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainEvent } from '../../domain/observability/domain_event.js';
import { markDomainEventPublished } from '../../domain/observability/domain_event.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';

export interface DomainEventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export class OutboxDispatcher {
  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    private readonly publisher: DomainEventPublisher,
  ) {}

  async dispatchPending(projectId: ObjectId): Promise<number> {
    const objects = await this.repository.list({ objectType: 'domain-event', projectId });
    const pending = objects.filter(
      (object): object is DomainEvent => object.objectType === 'domain-event' && object.status === 'pending',
    ).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
    let published = 0;
    for (const event of pending) {
      await this.publisher.publish(event);
      await this.repository.update(markDomainEventPublished(event), 'published');
      published += 1;
    }
    return published;
  }
}
