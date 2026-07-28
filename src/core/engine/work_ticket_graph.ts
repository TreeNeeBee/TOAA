import {
  PHASE_ORDER,
  V_MODEL_PAIRS,
  type Plan,
  type Step,
  type StepSubtask,
} from '../plan.js';
import {
  TicketStore,
  type WorkTicket,
} from '../ticket.js';

export interface NewStageFeature {
  step: Step;
  feature: WorkTicket;
}

/**
 * Compiles declarative Plan structure into the persistent Work Ticket graph.
 * It does not advance runtime state or decide whether work may execute.
 */
export class WorkTicketGraphCompiler {
  constructor(private readonly store: TicketStore) {}

  async compile(plan: Plan): Promise<NewStageFeature[]> {
    await this.store.load();
    const iterationIds = [...new Set(
      plan.steps.map((step) => step.iterationId ?? 'P1'),
    )];
    this.validateReferences(plan, iterationIds);
    const epics = new Map<string, WorkTicket>();
    const created: NewStageFeature[] = [];

    for (const iterationId of iterationIds) {
      epics.set(iterationId, await this.ensureEpic(plan, iterationId));
    }
    await this.connectEpicDependencies(plan, epics);

    for (const iterationId of iterationIds) {
      const epic = epics.get(iterationId)!;
      const steps = plan.steps
        .filter((step) => (step.iterationId ?? 'P1') === iterationId)
        .sort((left, right) => PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase]);
      const features = new Map<string, WorkTicket>();

      for (const step of steps) {
        const existing = this.store.featureForStep(step.id, iterationId);
        const feature = existing ?? await this.ensureStageFeature(step, epic);
        features.set(step.id, feature);
        await this.registerTasks(step, feature, epic);
        if (!existing) created.push({ step, feature });
      }
      await this.connectStageGraph(steps, features, epic);
      await this.ensureDeliveryFeature(plan, iterationId, epic, [...features.values()]);
      await this.linkChildren(epic);
    }
    return created;
  }

  private validateReferences(plan: Plan, iterationIds: readonly string[]): void {
    const availableIterations = new Set([
      ...iterationIds,
      ...this.store.all()
        .filter((ticket) => ticket.type === 'epic')
        .map((ticket) => ticket.iterationId),
    ]);
    for (const iterationId of iterationIds) {
      const phase = plan.implementationPhases.find((item) => item.id === iterationId);
      if (!phase) {
        throw new Error(
          `cannot compile iteration ${iterationId}: implementation phase definition is missing`,
        );
      }
      const missingEpics = phase.dependsOn.filter(
        (dependency) => !availableIterations.has(dependency),
      );
      if (missingEpics.length > 0) {
        throw new Error(
          `cannot compile iteration ${iterationId}: prerequisite Epic(s) missing for ` +
          missingEpics.join(', '),
        );
      }
      const steps = plan.steps.filter(
        (step) => (step.iterationId ?? 'P1') === iterationId,
      );
      const stepIds = new Set(steps.map((step) => step.id));
      if (stepIds.size !== steps.length) {
        throw new Error(
          `cannot compile iteration ${iterationId}: duplicate Step IDs are not allowed`,
        );
      }
      for (const step of steps) {
        const missingSteps = step.dependsOn.filter((dependency) => !stepIds.has(dependency));
        if (missingSteps.length > 0) {
          throw new Error(
            `cannot compile ${iterationId}/${step.id}: dependency Step(s) missing for ` +
            missingSteps.join(', '),
          );
        }
      }
    }
  }

  private async ensureEpic(plan: Plan, iterationId: string): Promise<WorkTicket> {
    const externalId = `${plan.requirementDigest}:${iterationId}`;
    const existing = this.store.all().find(
      (ticket): ticket is WorkTicket =>
        ticket.type === 'epic' &&
        ticket.iterationId === iterationId &&
        ticket.source.externalId === externalId,
    );
    if (existing) return existing;
    const phase = plan.implementationPhases.find((item) => item.id === iterationId);
    return this.store.createWork({
      type: 'epic',
      workKind: 'iteration',
      iterationId,
      title: `${iterationId} ${phase?.title ?? plan.intent}`,
      description: phase?.objective ?? plan.requirementDigest,
      priority: 'high',
      dependsOnTicketIds: [],
      source: { kind: 'plan', externalId },
      acceptance: [
        'All V-model stage Features are closed.',
        'The delivery Feature is closed after the iteration gate passes.',
        'No active Bug, Enhance, or Change Request blocks this iteration.',
      ],
      artifacts: phase?.deliverables ?? [],
      maxAttempts: 1,
    });
  }

  private async connectEpicDependencies(
    plan: Plan,
    epics: ReadonlyMap<string, WorkTicket>,
  ): Promise<void> {
    for (const [iterationId, epic] of epics) {
      const phase = plan.implementationPhases.find((item) => item.id === iterationId);
      const dependencyIds = phase?.dependsOn ?? [];
      const dependencies = dependencyIds.map(
        (dependency) => epics.get(dependency) ?? this.store.epicForIteration(dependency),
      );
      const missing = dependencyIds.filter((_, index) => !dependencies[index]);
      if (missing.length > 0) {
        throw new Error(
          `cannot compile iteration ${iterationId}: prerequisite Epic(s) missing for ` +
          missing.join(', '),
        );
      }
      epic.dependsOnTicketIds = dedup(
        dependencies.map((ticket) => ticket!.id),
      );
      await this.store.persist(epic, 'iteration-epic-graph-linked', {
        dependsOnTicketIds: epic.dependsOnTicketIds,
      });
    }
  }

  private async ensureStageFeature(step: Step, epic: WorkTicket): Promise<WorkTicket> {
    return this.store.createWork({
      type: 'feature',
      workKind: 'v-model-stage',
      iterationId: step.iterationId ?? 'P1',
      title: `${step.id} ${step.title}`,
      description: step.description,
      priority: 'high',
      parentTicketId: epic.id,
      rootTicketId: epic.id,
      source: {
        kind: 'plan',
        externalId: `${step.iterationId ?? 'P1'}:${step.id}`,
        stepId: step.id,
        phase: step.phase,
        role: step.role,
      },
      acceptance: [step.acceptance],
      artifacts: [...step.outputs],
      maxAttempts: step.maxRetries,
    });
  }

  private async connectStageGraph(
    steps: readonly Step[],
    features: ReadonlyMap<string, WorkTicket>,
    epic: WorkTicket,
  ): Promise<void> {
    for (const [index, step] of steps.entries()) {
      const feature = features.get(step.id)!;
      const missing = step.dependsOn.filter((stepId) => !features.has(stepId));
      if (missing.length > 0) {
        throw new Error(
          `cannot compile ${step.iterationId ?? 'P1'}/${step.id}: ` +
          `dependency Step(s) missing for ${missing.join(', ')}`,
        );
      }
      const explicit = step.dependsOn
        .map((stepId) => features.get(stepId)?.id)
        .filter((id): id is string => !!id);
      const previous = index > 0 ? features.get(steps[index - 1]!.id)?.id : undefined;
      const priorIterations = index === 0 ? epic.dependsOnTicketIds : [];
      feature.dependsOnTicketIds = dedup([
        ...explicit,
        previous ?? '',
        ...priorIterations,
      ]);
    }
    for (const [sourcePhase, testPhase] of V_MODEL_PAIRS) {
      const sourceStep = steps.find((step) => step.phase === sourcePhase);
      const testStep = steps.find((step) => step.phase === testPhase);
      if (!sourceStep || !testStep) continue;
      const source = features.get(sourceStep.id)!;
      const verification = features.get(testStep.id)!;
      source.verificationTicketId = verification.id;
      verification.pairedSourceTicketId = source.id;
    }
    for (const feature of features.values()) {
      await this.store.persist(feature, 'stage-feature-graph-linked', {
        dependsOnTicketIds: feature.dependsOnTicketIds,
        verificationTicketId: feature.verificationTicketId,
        pairedSourceTicketId: feature.pairedSourceTicketId,
      });
    }
  }

  private async ensureDeliveryFeature(
    plan: Plan,
    iterationId: string,
    epic: WorkTicket,
    stageFeatures: WorkTicket[],
  ): Promise<WorkTicket> {
    const existing = this.store.deliveryForIteration(iterationId);
    if (existing) {
      existing.dependsOnTicketIds = stageFeatures.map((feature) => feature.id);
      await this.store.persist(existing, 'delivery-feature-graph-linked', {
        dependsOnTicketIds: existing.dependsOnTicketIds,
      });
      return existing;
    }
    const phase = plan.implementationPhases.find((item) => item.id === iterationId);
    return this.store.createWork({
      type: 'feature',
      workKind: 'delivery',
      iterationId,
      title: `${iterationId} delivery`,
      description: `Verify and deliver iteration ${iterationId}: ${phase?.objective ?? plan.requirementDigest}`,
      priority: 'high',
      parentTicketId: epic.id,
      rootTicketId: epic.id,
      dependsOnTicketIds: stageFeatures.map((feature) => feature.id),
      source: {
        kind: 'plan',
        externalId: `${plan.requirementDigest}:${iterationId}:delivery`,
      },
      acceptance: [
        phase?.verificationGate?.summary ?? 'The iteration verification gate passes.',
        'No active Bug, Enhance, or Change Request remains.',
      ],
      artifacts: phase?.deliverables ?? [],
      maxAttempts: 1,
    });
  }

  private async registerTasks(
    step: Step,
    feature: WorkTicket,
    epic: WorkTicket,
  ): Promise<void> {
    for (const [index, task] of (step.subTasks ?? []).entries()) {
      await this.registerTask(step, task, feature, epic, [index + 1], 1);
    }
  }

  private async registerTask(
    step: Step,
    task: StepSubtask,
    parent: WorkTicket,
    epic: WorkTicket,
    path: number[],
    depth: 1 | 2,
  ): Promise<void> {
    const externalId =
      `${step.iterationId ?? 'P1'}:${step.id}/${path.join('.')}/${task.id}`;
    let ticket = this.store.all().find(
      (candidate): candidate is WorkTicket =>
        (candidate.type === 'task' || candidate.type === 'sub-task') &&
        candidate.source.externalId === externalId,
    );
    if (!ticket) {
      ticket = await this.store.createWork({
        type: depth === 1 ? 'task' : 'sub-task',
        workKind: 'planned-work',
        iterationId: step.iterationId ?? 'P1',
        title: `${task.id} ${task.title}`,
        description: task.description,
        parentTicketId: parent.id,
        rootTicketId: epic.id,
        source: {
          kind: 'plan',
          externalId,
          stepId: step.id,
          phase: step.phase,
          role: step.role,
        },
        acceptance: task.acceptance ? [task.acceptance] : [],
        artifacts: task.outputs ?? [],
        maxAttempts: step.maxRetries,
      });
    }
    if (!parent.relatedTicketIds.includes(ticket.id)) {
      parent.relatedTicketIds = dedup([...parent.relatedTicketIds, ticket.id]);
      await this.store.persist(parent, 'work-child-linked', {
        childTicketId: ticket.id,
      });
    }
    if (depth === 2 && (task.subTasks?.length ?? 0) > 0) {
      throw new Error(`Plan Step ${step.id} exceeds the two-level Ticket task hierarchy`);
    }
    for (const [index, child] of (task.subTasks ?? []).entries()) {
      await this.registerTask(step, child, ticket, epic, [...path, index + 1], 2);
    }
  }

  private async linkChildren(parent: WorkTicket): Promise<void> {
    const children = this.store.all()
      .filter((ticket) => ticket.parentTicketId === parent.id)
      .map((ticket) => ticket.id);
    const related = dedup([...parent.relatedTicketIds, ...children]);
    if (related.length === parent.relatedTicketIds.length) return;
    parent.relatedTicketIds = related;
    await this.store.persist(parent, 'work-children-linked', { childTicketIds: children });
  }
}

function dedup(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
