import type { StepType } from '../steps/step.js';
import type { TicketType } from '../tickets/ticket.js';
import type { DomainRole, ExecutionAgent } from './role.js';

const ROLE_CAPABILITIES: Readonly<Record<DomainRole, readonly string[]>> = {
  'project-manager': ['project-management', 'phase-control', 'ticket-routing', 'delivery-control'],
  'requirements-engineer': ['requirement-analysis', 'functional-test-design'],
  'system-engineer': ['high-level-design', 'detailed-design', 'module-test-design', 'integration-test-design'],
  integrator: ['integration-verification', 'contract-verification', 'risk-test-supplement'],
  developer: ['code', 'unit-test-design', 'debug', 'change-implementation'],
  tester: ['unit-verification', 'module-verification', 'functional-verification', 'risk-test-supplement'],
};

/**
 * What each Step actually demands, as opposed to everything its role can do.
 *
 * A development Step authors both its own artifact and the tests of the Step it is paired with in
 * the V-model, so it demands the design capability of that pair. Routing can only discriminate
 * between two actors of one role if Tickets ask for the narrow set.
 */
const STEP_CAPABILITIES: Readonly<Record<StepType, readonly string[]>> = {
  REQUIREMENT_ANALYSIS: ['requirement-analysis', 'functional-test-design'],
  HIGH_LEVEL_DESIGN: ['high-level-design', 'module-test-design'],
  DETAILED_DESIGN: ['detailed-design', 'integration-test-design'],
  CODE: ['code', 'unit-test-design'],
  FUNCTIONAL_TEST: ['functional-verification', 'risk-test-supplement'],
  MODULE_TEST: ['module-verification', 'risk-test-supplement'],
  INTEGRATION_TEST: ['integration-verification', 'contract-verification', 'risk-test-supplement'],
  UNIT_TEST: ['unit-verification', 'risk-test-supplement'],
};

/** The working mode a corrective Ticket adds on top of the Step's own capabilities. */
const TICKET_TYPE_CAPABILITY: Partial<Readonly<Record<TicketType, string>>> = {
  bug: 'debug',
  'change-request': 'change-implementation',
};

export function capabilitiesForRole(role: DomainRole): string[] {
  return [...ROLE_CAPABILITIES[role]];
}

/**
 * The capabilities a Ticket against `type` must demand of its assignee.
 *
 * Always a subset of the owning role's declared capabilities, so narrowing can never make a Ticket
 * unroutable to the role that owns its Step.
 */
export function capabilitiesForStep(type: StepType, ticketType?: TicketType): string[] {
  const declared = ROLE_CAPABILITIES[roleForStepType(type)];
  const mode = ticketType ? TICKET_TYPE_CAPABILITY[ticketType] : undefined;
  // A mode capability applies only where the role declares it: a Change Request propagates into
  // Steps whose roles have no separate change-implementation capability.
  const extra = mode && declared.includes(mode) ? [mode] : [];
  return [...STEP_CAPABILITIES[type], ...extra];
}

export function roleForStepType(type: StepType): DomainRole {
  switch (type) {
    case 'REQUIREMENT_ANALYSIS': return 'requirements-engineer';
    case 'HIGH_LEVEL_DESIGN':
    case 'DETAILED_DESIGN': return 'system-engineer';
    case 'CODE': return 'developer';
    case 'INTEGRATION_TEST': return 'integrator';
    case 'UNIT_TEST':
    case 'MODULE_TEST':
    case 'FUNCTIONAL_TEST': return 'tester';
  }
}

export function defaultAgentForRole(role: DomainRole): ExecutionAgent {
  if (role === 'system-engineer') return 'Architect';
  if (role === 'developer') return 'Coder';
  if (role === 'integrator' || role === 'tester') return 'Tester';
  return 'Planner';
}

export function supportedTicketTypesForRole(role: DomainRole): TicketType[] {
  return role === 'project-manager'
    ? ['epic', 'story']
    : ['story', 'task', 'bug', 'enhancement', 'change-request'];
}
