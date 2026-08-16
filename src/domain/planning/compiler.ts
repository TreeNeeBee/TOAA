import { createHash } from 'node:crypto';
import type {
  PlanDraftPhase as DraftPhase,
  PlanDraft as DraftPlan,
  PlanDraftStep as DraftStep,
  PlanDraftTask as DraftTask,
} from './plan_draft.js';
import { createObjectEnvelope, extractObjectEnvelope, reviseObjectEnvelope } from '../objects/object_envelope.js';
import type { ObjectId } from '../identity/object_id.js';
import { ProjectSchema, transitionProject, type Project } from '../projects/project.js';
import { PhaseSchema, type Phase } from '../phases/phase.js';
import {
  SOURCE_TO_VERIFICATION_STEP,
  STEP_TYPES,
  StepSchema,
  type Step,
  type StepType,
} from '../steps/step.js';
import {
  TICKET_PRIORITY,
  TicketSchema,
  type Ticket,
  type WorkTicket,
} from '../tickets/ticket.js';
import { KpiSchema, type Kpi } from '../quality/quality.js';
import {
  baselineDeliveryGate,
  phaseDeliveryGate,
  verificationDeliveryGate,
} from '../quality/delivery_gate.js';
import { DeliverableSchema, type Deliverable } from '../evidence/evidence.js';
import {
  PhasePlanSchema,
  ProjectPlanSchema,
  type PhasePlan,
  type ProjectPlan,
} from './plan.js';
import { assertDomainGraph, type DomainGraph } from '../workflow/domain_graph.js';
import { DOMAIN_ROLES, type DomainRole } from '../workflow/role.js';
import { capabilitiesForStep, roleForStepType } from '../workflow/role_profile.js';
import {
  RoleDefinitionSchema,
  seedRoleDefinition,
  type RoleDefinition,
  type RoleTemplateOverlay,
} from '../workflow/role_definition.js';
import {
  ActorRegistrationSchema,
  ProjectManagementPlanSchema,
  reviseManagementPlan,
  type ActorRegistration,
  type ProjectManagementPlan,
} from '../project_management/index.js';

export interface CompiledProjectGraph extends DomainGraph {
  projectPlan: ProjectPlan;
  phasePlans: PhasePlan[];
  kpis: Kpi[];
  deliverables: Deliverable[];
  roleDefinitions: RoleDefinition[];
  actors: ActorRegistration[];
  managementPlan: ProjectManagementPlan;
}

export interface CompileProjectGraphInput {
  draft: DraftPlan;
  topic: string;
  topicSourceRef?: string;
  projectName: string;
  /** Installation-level role identity overrides, read outside the Domain and passed in. */
  roleTemplates?: RoleTemplateOverlay;
}

export interface CompiledPhaseMaterialization {
  phase: Phase;
  phasePlan: PhasePlan;
  epic: WorkTicket;
  steps: Step[];
  tickets: Ticket[];
  kpis: Kpi[];
  deliverables: Deliverable[];
}

export interface CompiledProjectExtension {
  project: Project;
  projectPlan: ProjectPlan;
  phases: Phase[];
  phasePlans: PhasePlan[];
  steps: Step[];
  tickets: Ticket[];
  kpis: Kpi[];
  deliverables: Deliverable[];
  managementPlan: ProjectManagementPlan;
}

export function rebaseDraftPlanPhases(draft: DraftPlan, existingPhaseNames: readonly string[]): DraftPlan {
  const highest = existingPhaseNames.reduce((current, name) => {
    const match = /^P(\d{1,3})$/u.exec(name);
    return match ? Math.max(current, Number.parseInt(match[1]!, 10)) : current;
  }, 0);
  if (highest + draft.implementationPhases.length > 999) {
    throw new Error('Incremental Plan exceeds the supported P1-P999 Phase name range');
  }
  const phaseMap = new Map(
    draft.implementationPhases.map((phase, index) => [phase.id, `P${highest + index + 1}`]),
  );
  const phaseId = phaseMap.get(draft.phaseId);
  if (!phaseId) throw new Error(`Planner active Phase ${draft.phaseId} is missing from implementationPhases`);
  return {
    ...draft,
    phaseId,
    implementationPhases: draft.implementationPhases.map((phase) => ({
      ...phase,
      id: phaseMap.get(phase.id)!,
      dependsOn: phase.dependsOn.map((dependency) => phaseMap.get(dependency) ?? dependency),
    })),
    steps: draft.steps.map((step) => ({ ...step, iterationId: phaseId })),
  };
}

export function compileProjectExtension(input: CompileProjectGraphInput & {
  project: Project;
  projectPlan: ProjectPlan;
  predecessorPhase: Phase;
  predecessorEpic: WorkTicket;
  actors: ActorRegistration[];
  managementPlan: ProjectManagementPlan;
}): CompiledProjectExtension {
  if (input.project.language !== input.draft.language) {
    throw new Error(
      `Incremental Plan language ${input.draft.language} does not match Project language ${input.project.language}`,
    );
  }
  if (input.project.state === 'cancelled') {
    throw new Error(`Cancelled Project ${input.project.name} cannot accept an incremental Phase`);
  }
  if (input.predecessorPhase.state !== 'closed' || input.predecessorEpic.state !== 'closed') {
    throw new Error('Incremental Phase requires a closed predecessor Phase and Epic');
  }
  const generated = compileProjectGraph(input);
  const actorByRole = new Map(input.actors.map((actor) => [actor.role, actor]));
  const firstPhaseId = generated.projectPlan.activePhaseId;
  const phases = generated.phases.map((phase) => PhaseSchema.parse({
    ...phase,
    projectId: input.project.id,
    dependencyPhaseIds: phase.id === firstPhaseId
      ? [...new Set([...phase.dependencyPhaseIds, input.predecessorPhase.id])]
      : phase.dependencyPhaseIds,
  }));
  const phasePlans = generated.phasePlans.map((plan) => PhasePlanSchema.parse({
    ...plan,
    projectId: input.project.id,
    dependencyPhaseIds: plan.phaseId === firstPhaseId
      ? [...new Set([...plan.dependencyPhaseIds, input.predecessorPhase.id])]
      : plan.dependencyPhaseIds,
  }));
  const tickets = generated.tickets.map((ticket) => TicketSchema.parse({
    ...ticket,
    projectId: input.project.id,
    creatorActorId: ticket.type === 'epic' || ticket.type === 'story'
      ? input.project.pmActorId
      : requireActor(actorByRole, ticket.role).id,
    dependencyTicketIds: ticket.type === 'epic' && ticket.phaseId === firstPhaseId
      ? [...new Set([...ticket.dependencyTicketIds, input.predecessorEpic.id])]
      : ticket.dependencyTicketIds,
    source: ticket.type === 'epic'
      ? { ...ticket.source, correlationId: input.projectPlan.id }
      : ticket.source,
  }));
  const steps = generated.steps.map((step) => StepSchema.parse({ ...step, projectId: input.project.id }));
  const kpis = generated.kpis.map((kpi) => KpiSchema.parse({ ...kpi, projectId: input.project.id }));
  const deliverables = generated.deliverables.map((deliverable) =>
    DeliverableSchema.parse({ ...deliverable, projectId: input.project.id }),
  );
  const projectPlan = ProjectPlanSchema.parse({
    ...input.projectPlan,
    ...reviseObjectEnvelope(input.projectPlan),
    requirementDigest: `${input.projectPlan.requirementDigest}\n\n${input.draft.requirementDigest}`,
    complexity: greaterComplexity(input.projectPlan.complexity, generated.projectPlan.complexity),
    phasePlanIds: [...input.projectPlan.phasePlanIds, ...phasePlans.map((plan) => plan.id)],
    activePhaseId: firstPhaseId,
    sourceDigest: generated.projectPlan.sourceDigest,
  });
  const reopened = input.project.state === 'closed' || input.project.state === 'delivered'
    ? transitionProject(input.project, 'planning')
    : input.project;
  const projectEnvelope = reopened.revision === input.project.revision
    ? reviseObjectEnvelope(reopened)
    : extractObjectEnvelope(reopened);
  const topic = `${input.project.topic.text.trim()}\n\n## Incremental requirement (${phases[0]!.name})\n\n${input.topic.trim()}`;
  const project = ProjectSchema.parse({
    ...reopened,
    ...projectEnvelope,
    topic: {
      text: topic,
      sourceRef: input.topicSourceRef,
      digest: createHash('sha256').update(topic).digest('hex'),
    },
    intent: input.draft.intent,
    projectType: input.project.projectType === input.draft.projectType
      ? input.project.projectType
      : 'mixed',
    projectPlanId: projectPlan.id,
    phaseIds: [...input.project.phaseIds, ...phases.map((phase) => phase.id)],
    currentPhaseId: firstPhaseId,
  });
  const managementPlan = reviseManagementPlan(input.managementPlan, {
    milestonePhaseIds: [...input.managementPlan.milestonePhaseIds, ...phases.map((phase) => phase.id)],
    scopeBaseline: [...input.managementPlan.scopeBaseline, input.draft.requirementDigest],
    status: 'baselined',
    baselinedAt: new Date().toISOString(),
  });
  return { project, projectPlan, managementPlan, phases, phasePlans, steps, tickets, kpis, deliverables };
}

export function compilePhaseMaterialization(input: {
  draft: DraftPlan;
  project: Project;
  phase: Phase;
  phasePlan: PhasePlan;
  epic: WorkTicket;
  actors: ActorRegistration[];
}): CompiledPhaseMaterialization {
  if (input.phase.state !== 'created' || input.phase.stepIds.length > 0) {
    throw new Error(`Phase ${input.phase.name} is already materialized or has started`);
  }
  if (input.phasePlan.materialized) throw new Error(`PhasePlan ${input.phasePlan.name} is already materialized`);
  const draftPhase = input.draft.implementationPhases.find((phase) => phase.id === input.phase.name);
  if (!draftPhase) throw new Error(`Planner output does not contain Phase ${input.phase.name}`);
  if (input.draft.phaseId !== draftPhase.id) {
    throw new Error(`Planner output ${input.draft.phaseId} does not materialize ${input.phase.name}`);
  }
  const compiled = compileActivePhase({
    draft: input.draft,
    phase: draftPhase,
    phaseId: input.phase.id,
    projectId: input.project.id,
    epicEnvelope: extractObjectEnvelope(input.epic),
    actorByRole: new Map(input.actors.map((actor) => [actor.role, actor])),
    pmActorId: input.project.pmActorId,
    now: new Date().toISOString(),
  });
  const phase = PhaseSchema.parse({
    ...input.phase,
    ...reviseObjectEnvelope(input.phase),
    description: draftPhase.title,
    objective: draftPhase.objective,
    scope: draftPhase.scope,
    verificationGate: [
      draftPhase.verificationGate?.summary ?? `Phase ${draftPhase.id} verification passes.`,
      ...(draftPhase.verificationGate?.checks ?? []),
    ],
    deliveryGate: draftPhase.deliveryGate ?? phaseDeliveryGate(
      draftPhase.id,
      draftPhase.verificationGate?.checks ?? [],
    ),
    stepIds: compiled.steps.map((step) => step.id),
  });
  const phasePlan = PhasePlanSchema.parse({
    ...input.phasePlan,
    ...reviseObjectEnvelope(input.phasePlan),
    objective: phase.objective,
    scope: phase.scope,
    stepIds: phase.stepIds,
    verificationGate: phase.verificationGate,
    deliveryGate: phase.deliveryGate,
    materialized: true,
  });
  const epic = TicketSchema.parse({
    ...input.epic,
    ...reviseObjectEnvelope(input.epic),
    description: phase.objective,
    acceptance: [phase.deliveryGate!.summary, ...phase.deliveryGate!.checks],
  }) as WorkTicket;
  for (const ticket of compiled.tickets) {
    if (ticket.type === 'story') {
      ticket.rootTicketId = epic.id;
      ticket.parentTicketId = epic.id;
    }
  }
  return { ...compiled, phase, phasePlan, epic };
}

export function compileProjectGraph(input: CompileProjectGraphInput): CompiledProjectGraph {
  const now = new Date().toISOString();
  const projectEnvelope = createObjectEnvelope({
    name: input.projectName,
    objectType: 'project',
    now,
  });
  const projectId = projectEnvelope.id;
  const roleDefinitions = DOMAIN_ROLES.map(
    (role) => createRoleDefinition(projectId, role, now, input.roleTemplates ?? {}),
  );
  const actors = roleDefinitions.map((definition) => createActorRegistration(projectId, definition, now));
  const actorByRole = new Map(actors.map((actor) => [actor.role, actor]));
  const pmActor = requireActor(actorByRole, 'project-manager');
  const projectPlanEnvelope = createObjectEnvelope({
    name: 'phasePlan',
    objectType: 'plan',
    projectId,
    now,
  });
  const managementPlanEnvelope = createObjectEnvelope({
    name: 'project-management-plan',
    objectType: 'project-management-plan',
    projectId,
    now,
  });

  const draftPhases = normalizedDraftPhases(input.draft);
  const phaseEnvelopes = new Map<string, ReturnType<typeof createObjectEnvelope>>();
  const phasePlanEnvelopes = new Map<string, ReturnType<typeof createObjectEnvelope>>();
  const epicEnvelopes = new Map<string, ReturnType<typeof createObjectEnvelope>>();
  for (const draftPhase of draftPhases) {
    phaseEnvelopes.set(draftPhase.id, createObjectEnvelope({
      name: draftPhase.id,
      objectType: 'phase',
      projectId,
      now,
    }));
    phasePlanEnvelopes.set(draftPhase.id, createObjectEnvelope({
      name: `plan.${draftPhase.id}`,
      objectType: 'plan',
      projectId,
      now,
    }));
    epicEnvelopes.set(draftPhase.id, createObjectEnvelope({
      name: `EPIC-${draftPhase.id}`,
      objectType: 'ticket',
      projectId,
      now,
    }));
  }

  const activeDraftPhase = draftPhases.find((phase) => phase.status === 'current') ?? draftPhases[0]!;
  const activePhaseEnvelope = phaseEnvelopes.get(activeDraftPhase.id)!;
  const { steps, tickets: activeTickets, kpis, deliverables } = compileActivePhase({
    draft: input.draft,
    phase: activeDraftPhase,
    phaseId: activePhaseEnvelope.id,
    projectId,
    epicEnvelope: epicEnvelopes.get(activeDraftPhase.id)!,
    actorByRole,
    pmActorId: pmActor.id,
    now,
  });

  const epics = draftPhases.map((draftPhase): WorkTicket => {
    const phase = phaseEnvelopes.get(draftPhase.id)!;
    const epic = epicEnvelopes.get(draftPhase.id)!;
    const dependencies = draftPhase.dependsOn.map((name) => epicEnvelopes.get(name)?.id).filter(isObjectId);
    return TicketSchema.parse({
      ...epic,
      type: 'epic',
      phaseId: phase.id,
      role: 'project-manager',
      agent: 'Planner',
      creatorActorId: pmActor.id,
      requiredCapabilities: ['project-management', 'phase-control'],
      priority: TICKET_PRIORITY.high,
      rootTicketId: epic.id,
      description: draftPhase.objective,
      acceptance: phaseGateAcceptance(draftPhase),
      dependencyTicketIds: dependencies,
      state: 'created',
      source: { kind: 'plan', correlationId: projectPlanEnvelope.id, externalId: draftPhase.id },
      submittedAt: now,
      workKind: 'phase',
    }) as WorkTicket;
  });

  const activeEpic = epics.find((ticket) => ticket.phaseId === activePhaseEnvelope.id)!;
  for (const ticket of activeTickets) {
    if (ticket.type === 'story' && ticket.workKind === 'v-model-step') {
      ticket.rootTicketId = activeEpic.id;
      ticket.parentTicketId = activeEpic.id;
    }
  }
  const tickets: Ticket[] = [
    ...epics,
    ...activeTickets.map((ticket) => TicketSchema.parse(ticket)),
  ];

  const phases = draftPhases.map((draftPhase): Phase => {
    const envelope = phaseEnvelopes.get(draftPhase.id)!;
    const planEnvelope = phasePlanEnvelopes.get(draftPhase.id)!;
    const epic = epics.find((ticket) => ticket.phaseId === envelope.id)!;
    return PhaseSchema.parse({
      ...envelope,
      objective: draftPhase.objective,
      description: draftPhase.title,
      state: 'created',
      priority: phasePriority(draftPhase, draftPhases),
      dependencyPhaseIds: draftPhase.dependsOn.map((name) => phaseEnvelopes.get(name)?.id).filter(isObjectId),
      stepIds: draftPhase.id === activeDraftPhase.id ? steps.map((step) => step.id) : [],
      epicTicketId: epic.id,
      planId: planEnvelope.id,
      scope: draftPhase.scope,
      verificationGate: [
        draftPhase.verificationGate?.summary ?? `Phase ${draftPhase.id} verification passes.`,
        ...(draftPhase.verificationGate?.checks ?? []),
      ],
      deliveryGate: draftPhase.deliveryGate ?? phaseDeliveryGate(
        draftPhase.id,
        draftPhase.verificationGate?.checks ?? [],
      ),
    });
  });

  const phasePlans = draftPhases.map((draftPhase): PhasePlan => {
    const envelope = phasePlanEnvelopes.get(draftPhase.id)!;
    const phase = phases.find((item) => item.name === draftPhase.id)!;
    return PhasePlanSchema.parse({
      ...envelope,
      planKind: 'phase',
      phaseId: phase.id,
      objective: draftPhase.objective,
      scope: draftPhase.scope,
      dependencyPhaseIds: phase.dependencyPhaseIds,
      stepIds: phase.stepIds,
      verificationGate: phase.verificationGate,
      deliveryGate: phase.deliveryGate,
      materialized: phase.stepIds.length > 0,
    });
  });

  const projectPlan = ProjectPlanSchema.parse({
    ...projectPlanEnvelope,
    planKind: 'project',
    requirementDigest: input.draft.requirementDigest,
    complexity: {
      level: input.draft.complexityAssessment.level,
      rationale: input.draft.complexityAssessment.rationale,
    },
    phasePlanIds: phasePlans.map((plan) => plan.id),
    activePhaseId: activePhaseEnvelope.id,
    sourceDigest: createHash('sha256').update(JSON.stringify({
      topic: input.topic,
      requirementDigest: input.draft.requirementDigest,
      phases: draftPhases,
    })).digest('hex'),
  });

  const project: Project = ProjectSchema.parse({
    ...projectEnvelope,
    topic: {
      text: input.topic,
      sourceRef: input.topicSourceRef,
      digest: createHash('sha256').update(input.topic).digest('hex'),
    },
    state: 'planning',
    language: input.draft.language,
    intent: input.draft.intent,
    projectType: input.draft.projectType,
    projectPlanId: projectPlan.id,
    managementPlanId: managementPlanEnvelope.id,
    pmActorId: pmActor.id,
    phaseIds: phases.map((phase) => phase.id),
    currentPhaseId: activePhaseEnvelope.id,
  });

  const managementPlan = ProjectManagementPlanSchema.parse({
    ...managementPlanEnvelope,
    pmActorId: pmActor.id,
    objective: input.draft.requirementDigest,
    scopeBaseline: draftPhases.flatMap((phase) => phase.scope.length > 0 ? phase.scope : [phase.objective]),
    successCriteria: draftPhases.map((phase) => phaseGateAcceptance(phase)[0]!),
    constraints: [],
    stakeholderRefs: input.topicSourceRef ? [input.topicSourceRef] : [],
    milestonePhaseIds: phases.map((phase) => phase.id),
    actorRegistrationIds: actors.map((actor) => actor.id),
    status: 'baselined',
    baselinedAt: now,
  });

  const graph: CompiledProjectGraph = {
    project,
    projectPlan,
    phasePlans,
    phases,
    steps,
    tickets,
    kpis,
    deliverables,
    roleDefinitions,
    actors,
    managementPlan,
  };
  assertDomainGraph(graph);
  return graph;
}

function compileActivePhase(input: {
  draft: DraftPlan;
  phase: DraftPhase;
  phaseId: ObjectId;
  projectId: ObjectId;
  epicEnvelope: ReturnType<typeof createObjectEnvelope>;
  actorByRole: Map<DomainRole, ActorRegistration>;
  pmActorId: ObjectId;
  now: string;
}): { steps: Step[]; tickets: Ticket[]; kpis: Kpi[]; deliverables: Deliverable[] } {
  const orderedDraftSteps = STEP_TYPES.map((type) =>
    input.draft.steps.find((step) => normalizeStepType(step.phase) === type),
  );
  if (orderedDraftSteps.some((step) => !step)) {
    throw new Error(`Active Phase ${input.phase.id} does not contain a complete V-model`);
  }
  const stepEnvelopes = new Map<string, ReturnType<typeof createObjectEnvelope>>();
  for (const step of orderedDraftSteps as DraftStep[]) {
    stepEnvelopes.set(step.id, createObjectEnvelope({
      name: `${input.phase.id}-${step.id}`,
      objectType: 'step',
      projectId: input.projectId,
      now: input.now,
    }));
  }

  const steps = (orderedDraftSteps as DraftStep[]).map((draftStep): Step => {
    const envelope = stepEnvelopes.get(draftStep.id)!;
    const type = normalizeStepType(draftStep.phase);
    const verificationType = isDevelopmentStepType(type) ? SOURCE_TO_VERIFICATION_STEP[type] : undefined;
    const pairedDraft = verificationType
      ? (orderedDraftSteps as DraftStep[]).find((step) => normalizeStepType(step.phase) === verificationType)
      : (orderedDraftSteps as DraftStep[]).find((step) => {
          const candidate = normalizeStepType(step.phase);
          return isDevelopmentStepType(candidate) && SOURCE_TO_VERIFICATION_STEP[candidate] === type;
        });
    return StepSchema.parse({
      ...envelope,
      phaseId: input.phaseId,
      type,
      title: draftStep.title,
      description: draftStep.description,
      // The V-model position decides who owns a Step; the planner's agent hint only decides which
      // prompt persona runs it. Deriving the role from the hint instead let a plan hand requirement
      // analysis to a developer, contradicting both the role's supportedStepTypes and the
      // capabilities its Tickets demand.
      role: roleForStepType(type),
      agent: draftStep.role,
      state: 'created',
      dependencyStepIds: draftStep.dependsOn.map((name) => stepEnvelopes.get(name)?.id).filter(isObjectId),
      pairedStepId: pairedDraft ? stepEnvelopes.get(pairedDraft.id)?.id : undefined,
      inputs: draftStep.inputs,
      outputs: draftStep.outputs,
      acceptance: [draftStep.acceptance],
      tolerance: draftStep.qualityGate?.tolerance ?? {},
      // The V-model owns Step gate semantics. Planner text may add acceptance detail elsewhere, but
      // it cannot redefine which validation classes execute or when a baseline becomes executable.
      deliveryGate: isDevelopmentStepType(type)
        ? baselineDeliveryGate(`${input.phase.id}-${draftStep.id}`, type)
        : verificationDeliveryGate(`${input.phase.id}-${draftStep.id}`),
      kpiIds: [],
      systemPrompt: draftStep.systemPrompt,
      tools: draftStep.tools,
      maxAttempts: adaptiveMaxAttempts(input.draft, draftStep.maxAttempts),
    });
  });

  const kpis: Kpi[] = [];
  for (const step of steps) {
    const definitions = defaultKpis(step.type);
    for (const definition of definitions) {
      const kpi = KpiSchema.parse({
        ...createObjectEnvelope({ name: `${step.name}-${definition.metric}`, objectType: 'kpi', projectId: input.projectId, now: input.now }),
        ...definition,
        subjectId: step.id,
      });
      kpis.push(kpi);
      step.kpiIds.push(kpi.id);
    }
  }

  const deliverables = steps.filter((step) => step.outputs.length > 0).map((step): Deliverable =>
    DeliverableSchema.parse({
      ...createObjectEnvelope({ name: `${step.name}-deliverable`, objectType: 'deliverable', projectId: input.projectId, now: input.now }),
      owner: { id: step.id, objectType: 'step' },
      paths: step.outputs,
      acceptance: step.acceptance,
    }),
  );
  for (const step of steps) {
    step.deliverableIds = deliverables.filter((item) => item.owner.id === step.id).map((item) => item.id);
  }

  const storyByStep = new Map<ObjectId, WorkTicket>();
  const tickets: Ticket[] = [];
  for (const step of steps) {
    const storyEnvelope = createObjectEnvelope({
      name: `${step.name}-STORY`,
      objectType: 'ticket',
      projectId: input.projectId,
      now: input.now,
    });
    const story = TicketSchema.parse({
      ...storyEnvelope,
      type: 'story',
      phaseId: input.phaseId,
      stepId: step.id,
      role: step.role,
      agent: step.agent,
      creatorActorId: input.pmActorId,
      requiredCapabilities: capabilitiesForStep(step.type),
      priority: TICKET_PRIORITY.high,
      parentTicketId: input.epicEnvelope.id,
      rootTicketId: input.epicEnvelope.id,
      description: step.description,
      acceptance: step.acceptance,
      dependencyTicketIds: [],
      state: 'created',
      source: { kind: 'plan', correlationId: input.epicEnvelope.id, externalId: step.name },
      submittedAt: input.now,
      workKind: 'v-model-step',
      maxAttempts: step.maxAttempts,
    }) as WorkTicket;
    storyByStep.set(step.id, story);
    tickets.push(story);
    registerTasks(
      step,
      input.draft.steps.find((item) => item.id === step.name.split('-').at(-1))?.subTasks ?? [],
      story,
      input.epicEnvelope.id,
      tickets,
      requireActor(input.actorByRole, step.role).id,
      input.now,
    );
  }
  for (const step of steps) {
    const story = storyByStep.get(step.id)!;
    story.dependencyTicketIds = step.dependencyStepIds.map((id) => storyByStep.get(id)?.id).filter(isObjectId);
    if (step.pairedStepId) {
      const paired = storyByStep.get(step.pairedStepId);
      if (paired && isDevelopmentStepType(step.type)) story.verificationTicketId = paired.id;
      if (paired && !isDevelopmentStepType(step.type)) story.pairedSourceTicketId = paired.id;
    }
  }
  const deliveryEnvelope = createObjectEnvelope({
    name: `${input.phase.id}-DELIVERY`,
    objectType: 'ticket',
    projectId: input.projectId,
    now: input.now,
  });
  tickets.push(TicketSchema.parse({
    ...deliveryEnvelope,
    type: 'story',
    phaseId: input.phaseId,
    role: 'project-manager',
    agent: 'Planner',
    creatorActorId: input.pmActorId,
    requiredCapabilities: ['project-management', 'delivery-control'],
    priority: TICKET_PRIORITY.high,
    parentTicketId: input.epicEnvelope.id,
    rootTicketId: input.epicEnvelope.id,
    description: `Deliver Phase ${input.phase.id}.`,
    acceptance: phaseGateAcceptance(input.phase),
    dependencyTicketIds: steps.map((step) => storyByStep.get(step.id)!.id),
    state: 'created',
    source: { kind: 'plan', correlationId: input.epicEnvelope.id, externalId: `${input.phase.id}:delivery` },
    submittedAt: input.now,
    workKind: 'delivery',
  }));
  return { steps, tickets, kpis, deliverables };
}

function registerTasks(
  step: Step,
  draftTasks: readonly DraftTask[],
  parent: WorkTicket,
  epicId: ObjectId,
  tickets: Ticket[],
  creatorActorId: ObjectId,
  now: string,
  depth = 1,
): void {
  if (depth > 2 && draftTasks.length > 0) {
    throw new Error(`Step ${step.name} exceeds the two-level task hierarchy`);
  }
  for (const [index, draftTask] of draftTasks.entries()) {
    const envelope = createObjectEnvelope({
      // A subtask is numbered within its own parent, so naming it after the Step alone gave every
      // parent's first subtask the same name — three `P1-S004-T01S` in one Phase, pointing at three
      // different Tickets. Names are the identity every log line, audit entry, and evidence bundle
      // shows, so deriving the child's from the parent's makes it unique by construction rather than
      // by a counter someone has to remember to make global.
      name: depth === 1
        ? `${step.name}-T${String(index + 1).padStart(2, '0')}`
        : `${parent.name}S${String(index + 1).padStart(2, '0')}`,
      objectType: 'ticket',
      projectId: step.projectId,
      now,
    });
    const task = TicketSchema.parse({
      ...envelope,
      type: 'task',
      phaseId: step.phaseId,
      stepId: step.id,
      role: step.role,
      agent: step.agent,
      creatorActorId,
      requiredCapabilities: capabilitiesForStep(step.type),
      priority: TICKET_PRIORITY.normal,
      parentTicketId: parent.id,
      rootTicketId: epicId,
      description: draftTask.description,
      acceptance: [draftTask.acceptance ?? step.acceptance[0]!],
      state: 'created',
      source: { kind: 'plan', correlationId: epicId, externalId: draftTask.id },
      submittedAt: now,
      workKind: 'planned-work',
      maxAttempts: parent.maxAttempts,
    }) as WorkTicket;
    tickets.push(task);
    registerTasks(step, draftTask.subTasks ?? [], task, epicId, tickets, creatorActorId, now, depth + 1);
  }
}

function normalizedDraftPhases(plan: DraftPlan): readonly DraftPhase[] {
  const phases = plan.implementationPhases;
  if (phases.length === 0) throw new Error('Project plan must contain at least one Phase');
  const current = phases.filter((phase) => phase.status === 'current');
  if (current.length !== 1) throw new Error('Project plan must contain exactly one current Phase');
  return phases;
}

function normalizeStepType(type: DraftStep['phase']): StepType {
  return type;
}

function isDevelopmentStepType(type: StepType): type is keyof typeof SOURCE_TO_VERIFICATION_STEP {
  return Object.hasOwn(SOURCE_TO_VERIFICATION_STEP, type);
}

function createRoleDefinition(
  projectId: ObjectId,
  role: DomainRole,
  now: string,
  templates: RoleTemplateOverlay,
): RoleDefinition {
  return RoleDefinitionSchema.parse({
    ...createObjectEnvelope({
      name: `role-${role}`,
      objectType: 'role-definition',
      projectId,
      now,
    }),
    ...seedRoleDefinition(role, templates),
  });
}

function createActorRegistration(
  projectId: ObjectId,
  definition: RoleDefinition,
  now: string,
): ActorRegistration {
  const role = definition.role;
  return ActorRegistrationSchema.parse({
    ...createObjectEnvelope({ name: `actor-${role}`, objectType: 'actor-registration', projectId, now }),
    actorKind: 'llm-agent',
    role,
    roleDefinitionId: definition.id,
    agent: definition.defaultAgent,
    state: 'active',
    capacity: role === 'project-manager' ? 255 : 1,
    activeAssignmentIds: [],
    registeredAt: now,
  });
}

function requireActor(
  actors: ReadonlyMap<DomainRole, ActorRegistration>,
  role: DomainRole,
): ActorRegistration {
  const actor = actors.get(role);
  if (!actor) throw new Error(`Project role ${role} has not registered an actor`);
  return actor;
}

function defaultKpis(type: StepType): Array<{
  description: string;
  metric: string;
  comparator: 'gte' | 'lte' | 'eq';
  target: number;
  tolerance: number;
  weight: number;
}> {
  if (type === 'REQUIREMENT_ANALYSIS' || type === 'HIGH_LEVEL_DESIGN' || type === 'DETAILED_DESIGN' || type === 'CODE') {
    return [
      { description: `${type} completion`, metric: 'completion', comparator: 'gte', target: 0.95, tolerance: 0.02, weight: 0.5 },
      { description: `${type} upstream alignment`, metric: 'upstreamAlignment', comparator: 'gte', target: type === 'REQUIREMENT_ANALYSIS' ? 0.95 : 0.9, tolerance: 0.02, weight: 0.5 },
    ];
  }
  const metrics: Record<string, Array<[string, number]>> = {
    UNIT_TEST: [['lineCoverage', 0.8], ['branchCoverage', 0.7], ['testCasePassRate', 1]],
    INTEGRATION_TEST: [['interfaceCoverage', 0.85], ['integrationScenarioCoverage', 0.85], ['testCasePassRate', 1]],
    MODULE_TEST: [['moduleCoverage', 0.9], ['contractCoverage', 0.9], ['testCasePassRate', 1]],
    FUNCTIONAL_TEST: [['functionalCoverage', 0.95], ['requirementCoverage', 0.95], ['endToEndPassRate', 1]],
  };
  return metrics[type]!.map(([metric, target]) => ({
    description: `${type} ${metric}`,
    metric,
    comparator: 'gte' as const,
    target,
    // The recorded band is the floor. Whether a structural metric gets more room is decided when
    // the KPI is evaluated, so the policy applies to workspaces planned before it existed.
    tolerance: 0.02,
    weight: 1 / metrics[type]!.length,
  }));
}

function phasePriority(phase: DraftPhase, all: readonly DraftPhase[]): number {
  const index = all.findIndex((item) => item.id === phase.id);
  return Math.max(1, TICKET_PRIORITY.high - index * 8);
}

function phaseGateAcceptance(phase: DraftPhase): string[] {
  const gate = phase.deliveryGate ?? phaseDeliveryGate(
    phase.id,
    phase.verificationGate?.checks ?? [],
  );
  return [gate.summary, ...gate.checks];
}

function isObjectId(value: ObjectId | undefined): value is ObjectId {
  return !!value;
}

function greaterComplexity(
  left: ProjectPlan['complexity'],
  right: ProjectPlan['complexity'],
): ProjectPlan['complexity'] {
  const rank = { simple: 0, moderate: 1, complex: 2 } as const;
  return rank[right.level] > rank[left.level] ? right : left;
}

function adaptiveMaxAttempts(draft: DraftPlan, requested: number): number {
  const complexityBase = { simple: 3, moderate: 5, complex: 8 } as const;
  const phaseBonus = Math.min(4, Math.max(0, draft.implementationPhases.length - 1));
  return Math.max(requested, complexityBase[draft.complexityAssessment.level] + phaseBonus);
}
