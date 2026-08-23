import { z } from 'zod';

export const DOMAIN_ROLES = [
  'project-manager',
  'requirements-engineer',
  'system-engineer',
  'integrator',
  'developer',
  'tester',
] as const;

export type DomainRole = (typeof DOMAIN_ROLES)[number];
export const DomainRoleSchema = z.enum(DOMAIN_ROLES);

/**
 * Every role a model can be configured for. There is one list of roles, and this is it.
 *
 * Each role is configured with one or more providers in `llm.roles`; how the router schedules
 * between them is its own business and nothing here depends on it.
 */
export const ROLES = [
  'Planner',
  'Architect',
  'Coder',
  'Tester',
  'Debugger',
  'ProjectManager',
] as const;

export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

/**
 * The roles a V-model Step may be handed to — every role except PM.
 *
 * Derived rather than listed: a second hand-maintained array is where "these are the same roles
 * minus one" quietly stops being true. PM judges delivery and speaks to the user on the project's
 * behalf; assigning it a Step would put the judge in the position of doing the work it later
 * assesses.
 */
export const ExecutingRoleSchema = RoleSchema.exclude(['ProjectManager']);
export type ExecutingRole = z.infer<typeof ExecutingRoleSchema>;
