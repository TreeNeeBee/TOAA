import { z } from 'zod';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { STEP_TYPES } from '../steps/step.js';
import { TICKET_TYPES } from '../tickets/ticket.js';
import { DomainRoleSchema, ExecutionAgentSchema, type DomainRole } from './role.js';
import {
  capabilitiesForRole,
  defaultAgentForRole,
  roleForStepType,
  supportedTicketTypesForRole,
} from './role_profile.js';

/**
 * What a role *is*: identity and capability, and nothing else.
 *
 * A Role holds no project, phase, step, ticket, workspace, sandbox, or conversation state — all of
 * that is assembled per execution. Keeping the definition separate from the registered actor is
 * what makes two things expressible that a single fused object cannot: binding a different model to
 * two actors of the same role, and running several of them at once.
 *
 * Registered per project rather than global because the envelope requires a projectId, and because
 * a project may legitimately tighten a prohibition without imposing it on every other project.
 */
export const RoleDefinitionSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('role-definition'),
  role: DomainRoleSchema,
  /** Who this role is and what it is accountable for. */
  rolePrompt: z.string().min(1),
  /** How this role is expected to work: its method, not its assignment. */
  capabilityPrompt: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  supportedStepTypes: z.array(z.enum(STEP_TYPES)).default([]),
  supportedTicketTypes: z.array(z.enum(TICKET_TYPES)).default([]),
  /** The prompt persona used when this role talks to a model. */
  defaultAgent: ExecutionAgentSchema,
  allowedTools: z.array(z.string().min(1)).default([]),
  prohibitions: z.array(z.string().min(1)).default([]),
}).strict();

export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export function reviseRoleDefinition(
  definition: RoleDefinition,
  changes: Partial<Omit<RoleDefinition, 'id' | 'objectType' | 'projectId' | 'createdAt' | 'revision'>>,
  now = new Date().toISOString(),
): RoleDefinition {
  return RoleDefinitionSchema.parse({
    ...definition,
    ...changes,
    ...reviseObjectEnvelope(definition, { now }),
  });
}

const ROLE_PROMPTS: Readonly<Record<DomainRole, { role: string; capability: string; prohibitions: string[] }>> = {
  'project-manager': {
    role: 'You manage the project: scope, schedule, routing, risk, and delivery gates.',
    capability: 'Choose among the commands Domain policy already permits, and record why.',
    prohibitions: [
      'Do not author requirements, design, code, or tests on behalf of a professional role.',
      'Do not declare a failed gate successful.',
    ],
  },
  'requirements-engineer': {
    role: 'You turn a request into verifiable requirements and own the functional baseline tests paired with acceptance.',
    capability: 'State observable behaviour and author executable functional baseline cases from it.',
    prohibitions: ['Do not implement the solution.'],
  },
  'system-engineer': {
    role: 'You design the system and its modules, and the tests paired with each design level.',
    capability: 'Define interfaces, dependencies, and the contracts downstream work must satisfy.',
    prohibitions: ['Do not weaken a contract to make an implementation easier.'],
  },
  integrator: {
    role: 'You verify that independently built parts satisfy their integration contracts.',
    capability: 'Inspect paired tests, add isolated risk supplements, freeze the suite, and exercise real interfaces.',
    prohibitions: ['Do not modify the implementation under verification.'],
  },
  developer: {
    role: 'You implement the design and repair defects found against it.',
    capability: 'Write code and unit tests that satisfy the accepted design and acceptance criteria.',
    prohibitions: [
      'Do not change accepted tests to make an implementation pass.',
      'Do not expand scope beyond the assigned Ticket.',
    ],
  },
  tester: {
    role: 'You verify delivered work against its acceptance criteria and report evidence.',
    capability: 'Inspect paired tests, add isolated risk supplements, freeze the suite, and record measured results.',
    prohibitions: ['Do not rewrite source to make a test pass.'],
  },
};

/**
 * Identity text an installation may substitute for the built-in defaults. Deliberately cannot reach
 * capabilities or supported Step and Ticket types — those are the routing vocabulary, not identity.
 */
export type RoleTemplateOverlay = Partial<Record<DomainRole, {
  rolePrompt?: string;
  capabilityPrompt?: string;
  prohibitions?: readonly string[];
  allowedTools?: readonly string[];
}>>;

/**
 * The definition each project starts from.
 *
 * `role_profile.ts` remains the single source of the capability vocabulary; this reads from it
 * rather than restating it, so the two cannot drift.
 */
export function seedRoleDefinition(
  role: DomainRole,
  overlay: RoleTemplateOverlay = {},
): Omit<RoleDefinition, keyof z.infer<typeof ObjectEnvelopeSchema>> {
  const prompts = ROLE_PROMPTS[role];
  const template = overlay[role] ?? {};
  return {
    role,
    rolePrompt: template.rolePrompt ?? prompts.role,
    capabilityPrompt: template.capabilityPrompt ?? prompts.capability,
    capabilities: capabilitiesForRole(role),
    supportedStepTypes: STEP_TYPES.filter((type) => roleForStepType(type) === role),
    supportedTicketTypes: supportedTicketTypesForRole(role),
    defaultAgent: defaultAgentForRole(role),
    allowedTools: [...(template.allowedTools ?? [])],
    prohibitions: [...(template.prohibitions ?? prompts.prohibitions)],
  };
}
