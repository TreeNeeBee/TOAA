import { describe, expect, it } from 'vitest';
import { STEP_TYPES, type StepType } from '../src/domain/steps/step.js';
import { TICKET_TYPES } from '../src/domain/tickets/ticket.js';
import { DOMAIN_ROLES } from '../src/domain/workflow/role.js';
import {
  capabilitiesForRole,
  capabilitiesForStep,
  roleForStepType,
} from '../src/domain/workflow/role_profile.js';

describe('capability vocabulary', () => {
  it('never asks a Step for a capability its owning role does not declare', () => {
    // Without this, narrowing a Ticket's requiredCapabilities would silently make it unroutable:
    // eligibility already fixes the role, so an out-of-vocabulary capability can never be met.
    for (const type of STEP_TYPES) {
      const declared = capabilitiesForRole(roleForStepType(type));
      for (const ticketType of [undefined, ...TICKET_TYPES] as const) {
        const required = capabilitiesForStep(type, ticketType);
        expect(required.length, `${type}/${ticketType}`).toBeGreaterThan(0);
        expect(declared, `${type}/${ticketType}`).toEqual(expect.arrayContaining(required));
      }
    }
  });

  it('demands strictly less than the whole role wherever the role does more than one Step', () => {
    // The point of narrowing: a system-engineer Ticket asks for detailed design, not for every
    // system-engineer capability, so two actors of that role can differ.
    const multiStepRoles = DOMAIN_ROLES.filter(
      (role) => STEP_TYPES.filter((type) => roleForStepType(type) === role).length > 1,
    );
    expect(multiStepRoles).toContain('system-engineer');
    expect(multiStepRoles).toContain('tester');
    for (const role of multiStepRoles) {
      for (const type of STEP_TYPES.filter((candidate) => roleForStepType(candidate) === role)) {
        expect(capabilitiesForStep(type).length, type)
          .toBeLessThan(capabilitiesForRole(role).length);
      }
    }
  });

  it('leaves no declared capability that no Ticket can ever ask for', () => {
    const reachable = new Set<string>();
    for (const type of STEP_TYPES) {
      for (const ticketType of [undefined, ...TICKET_TYPES] as const) {
        for (const capability of capabilitiesForStep(type, ticketType)) reachable.add(capability);
      }
    }
    const orphaned = DOMAIN_ROLES
      .filter((role) => role !== 'project-manager')
      .flatMap((role) => capabilitiesForRole(role).filter((capability) => !reachable.has(capability)));
    expect(orphaned).toEqual([]);
  });

  it('adds a debug capability to a Bug only where the owning role declares one', () => {
    const codeBug = capabilitiesForStep('CODE', 'bug');
    expect(codeBug).toContain('debug');
    // A Bug against a design Step is repaired by redoing the design; there is no separate debug
    // capability to demand, and demanding one would make the Ticket unroutable.
    const designTypes: StepType[] = ['REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN'];
    for (const type of designTypes) {
      expect(capabilitiesForStep(type, 'bug'), type).toEqual(capabilitiesForStep(type));
    }
  });
});
