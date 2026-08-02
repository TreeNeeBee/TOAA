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

export const EXECUTION_AGENTS = [
  'Planner',
  'Architect',
  'Coder',
  'Tester',
  'Debugger',
] as const;

export type ExecutionAgent = (typeof EXECUTION_AGENTS)[number];
export const ExecutionAgentSchema = z.enum(EXECUTION_AGENTS);
