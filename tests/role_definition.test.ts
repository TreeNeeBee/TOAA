import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import { RoleRegistry } from '../src/application/project_management/role_registry.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { ProjectContainer } from '../src/workspace/project_container.js';
import { DOMAIN_ROLES } from '../src/domain/workflow/role.js';
import { RoleDefinitionSchema, reviseRoleDefinition } from '../src/domain/workflow/role_definition.js';
import { reviseActor } from '../src/domain/project_management/index.js';
import { TicketSchema, type Ticket } from '../src/domain/tickets/ticket.js';
import { createObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { PLAN_VERSION, type Plan } from '../src/core/plan.js';
import { STEP_TYPES } from '../src/domain/steps/step.js';

async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-role-'));
  const repository = new DomainObjectRepository(new ProjectContainer(root).state);
  await repository.load();
  const graph = compileProjectGraph({ draft: plan(), topic: 't', projectName: 'p' });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  return { repository, graph, roles: new RoleRegistry(repository) };
}

describe('role definition', () => {
  it('registers one definition per domain role and points every actor at its own', async () => {
    const { graph, roles } = await project();
    expect(graph.roleDefinitions.map((definition) => definition.role).sort())
      .toEqual([...DOMAIN_ROLES].sort());
    for (const { actor, definition } of await roles.routingActors(graph.project.id)) {
      expect(definition.role).toBe(actor.role);
      expect(actor.roleDefinitionId).toBe(definition.id);
      // The capability vocabulary lives on the definition alone — an actor carrying its own copy is
      // exactly the drift this split exists to prevent.
      expect(actor).not.toHaveProperty('capabilities');
      expect(actor).not.toHaveProperty('supportedTicketTypes');
      expect(actor).not.toHaveProperty('supportedStepTypes');
    }
  });

  it('routes against the stored definition, not a copy taken at registration', async () => {
    const { repository, graph, roles } = await project();
    const ticket = developerTicket(graph);
    expect((await roles.route(ticket)).role).toBe('developer');

    // Narrow the definition after the actor was registered. If routing read a copy, this would be
    // invisible and the actor would still qualify.
    const definition = graph.roleDefinitions.find((item) => item.role === 'developer')!;
    await repository.update(reviseRoleDefinition(definition, { supportedTicketTypes: ['bug'] }));

    await expect(roles.route(ticket)).rejects.toThrow(/does not support ticket type task/u);
  });

  it('carries identity only, and rejects any attempt to attach state to it', async () => {
    const { graph } = await project();
    const definition = graph.roleDefinitions[0]!;
    // Invariant 29: a Role holds no project, phase, step, ticket, workspace, sandbox, or
    // conversation state. `.strict()` is what enforces it, so this asserts the schema rejects each
    // rather than trusting that nobody will add one.
    const stateFields = {
      phaseId: definition.projectId,
      stepId: definition.projectId,
      ticketId: definition.projectId,
      activeAssignmentIds: [],
      workspaceRoot: '/tmp/x',
      sandboxId: 'sbx',
      conversation: [],
      context: 'anything',
    };
    for (const [field, value] of Object.entries(stateFields)) {
      expect(() => RoleDefinitionSchema.parse({ ...definition, [field]: value }), field).toThrow();
    }
    // projectId is the envelope's own scoping field, not carried state: the definition says which
    // project may tighten it, never what that project is currently doing.
    expect(RoleDefinitionSchema.parse(definition)).toEqual(definition);
  });

  it('refuses an actor whose definition describes a different role', async () => {
    const { repository, graph, roles } = await project();
    const actor = graph.actors.find((item) => item.role === 'developer')!;
    const testerDefinition = graph.roleDefinitions.find((item) => item.role === 'tester')!;
    await repository.update(reviseActor(actor, { roleDefinitionId: testerDefinition.id }));
    await expect(roles.resolve(actor.id)).rejects.toThrow(/claims role developer but its definition is tester/u);
  });
});

function developerTicket(graph: Awaited<ReturnType<typeof project>>['graph']): Ticket {
  const codeStep = graph.steps.find((item) => item.type === 'CODE')!;
  const story = graph.tickets.find((item) => item.stepId === codeStep.id)!;
  return TicketSchema.parse({
    ...story,
    ...createObjectEnvelope({
      name: 'ROLE-TASK',
      objectType: 'ticket',
      projectId: graph.project.id,
      now: new Date().toISOString(),
    }),
    type: 'task',
    role: 'developer',
    state: 'created',
    assignmentIds: [],
    activeAssignmentId: undefined,
  });
}

function plan(): Plan {
  return {
    version: PLAN_VERSION, language: 'typescript', intent: 'greenfield', phaseId: 'P1',
    projectType: 'application', requirementDigest: 'rt',
    complexityAssessment: { level: 'simple', rationale: 'x', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{ id: 'P1', title: 'C', objective: 'D', status: 'current', scope: ['c'], deliverables: ['a'], dependsOn: [] }],
    architectureModules: [], globalPrompt: '', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date(0).toISOString(),
    steps: STEP_TYPES.map((t, i) => ({
      id: `S${String(i + 1).padStart(3, '0')}`, iterationId: 'P1', phase: t, title: t, description: t,
      systemPrompt: t, role: 'Coder' as const, tools: ['write_file'], inputs: [], outputs: [`docs/${i}.md`],
      dependsOn: i === 0 ? [] : [`S${String(i).padStart(3, '0')}`], acceptance: 'a', maxAttempts: 3,
    })),
  };
}
