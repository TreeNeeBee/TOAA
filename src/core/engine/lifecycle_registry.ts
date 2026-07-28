import type { TicketType } from '../ticket.js';

export const TICKET_LIFECYCLE_OWNERS = {
  feature: 'work',
  task: 'work',
  'sub-task': 'work',
  bug: 'bug',
  enhance: 'enhancement',
  'change-request': 'change-request',
} as const satisfies Record<
  TicketType,
  'work' | 'bug' | 'enhancement' | 'change-request'
>;

export type TicketLifecycleOwner =
  (typeof TICKET_LIFECYCLE_OWNERS)[TicketType];
