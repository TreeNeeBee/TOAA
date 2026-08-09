import { describe, expect, it } from 'vitest';
import { ProjectProgressGuard } from '../src/application/project_management/progress_guard.js';
import { createObjectId } from '../src/domain/identity/object_id.js';

describe('ProjectProgressGuard', () => {
  it('stops only after the persisted graph remains semantically unchanged', async () => {
    const projectId = createObjectId();
    const phaseId = createObjectId();
    const ticketId = createObjectId();
    let attempts = 0;
    const repository = {
      list: async () => [{
        id: ticketId,
        objectType: 'ticket',
        projectId,
        phaseId,
        state: 'in_progress',
        attempts,
        maxAttempts: 9,
        blockedByTicketIds: [],
        changelistIds: [],
        solution: undefined,
      }],
    } as never;
    const guard = new ProjectProgressGuard(repository);

    expect((await guard.observe(projectId, phaseId)).stalled).toBe(false);
    expect((await guard.observe(projectId, phaseId)).stalled).toBe(false);
    attempts += 1;
    expect((await guard.observe(projectId, phaseId)).unchangedObservations).toBe(0);
    expect((await guard.observe(projectId, phaseId)).stalled).toBe(false);
    expect((await guard.observe(projectId, phaseId)).stalled).toBe(false);
    expect((await guard.observe(projectId, phaseId)).stalled).toBe(true);
  });
});
