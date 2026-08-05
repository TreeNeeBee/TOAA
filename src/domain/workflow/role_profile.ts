import type { StepType } from '../steps/step.js';
import type { TicketType } from '../tickets/ticket.js';
import type { DomainRole, ExecutionAgent } from './role.js';

const ROLE_CAPABILITIES: Readonly<Record<DomainRole, readonly string[]>> = {
  'project-manager': ['project-management', 'phase-control', 'ticket-routing', 'delivery-control'],
  'requirements-engineer': ['requirement-analysis', 'functional-test-design'],
  'system-engineer': ['high-level-design', 'detailed-design', 'module-test-design', 'integration-test-design'],
  integrator: ['integration-verification', 'contract-verification'],
  developer: ['code', 'unit-test-design', 'debug', 'change-implementation'],
  tester: ['unit-verification', 'module-verification', 'functional-verification'],
};

export function capabilitiesForRole(role: DomainRole): string[] {
  return [...ROLE_CAPABILITIES[role]];
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
