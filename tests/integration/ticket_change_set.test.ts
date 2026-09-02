import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { createObjectId } from '../../src/domain/identity/object_id.js';
import { createObjectEnvelope } from '../../src/domain/objects/object_envelope.js';
import { TicketChangeSetService } from '../../src/application/workspace/ticket_change_set_service.js';
import { GitRepositoryService } from '../../src/infrastructure/git/git_repository_service.js';
import { DomainObjectRepository } from '../../src/infrastructure/repository/domain_object_repository.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import { compileProjectGraph } from '../../src/domain/planning/compiler.js';
import { ProjectGraphPersistenceService } from '../../src/application/planning/project_graph_persistence_service.js';
import { PLAN_VERSION, type Plan } from '../../src/core/plan.js';
import { STEP_TYPES } from '../../src/domain/steps/step.js';
import {
  TicketSchema,
  bindTicketWorkspace,
  type Ticket,
} from '../../src/domain/tickets/ticket.js';
import { transitionChangeSet } from '../../src/domain/workspace/change_set.js';

function samplePlan(): Plan {
  return {
    version: PLAN_VERSION,
    language: 'typescript',
    intent: 'greenfield',
    phaseId: 'P1',
    projectType: 'application',
    requirementDigest: 'changeset fixture',
    complexityAssessment: {
      level: 'simple', rationale: 'fixture', splitRecommended: false, userForcedPhaseSplit: false,
    },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Deliver', status: 'current',
      scope: ['core'], deliverables: ['src/index.ts'], dependsOn: [],
    }],
    architectureModules: [],
    globalPrompt: '', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date(0).toISOString(),
    steps: STEP_TYPES.map((type, index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`,
      iterationId: 'P1',
      phase: type,
      title: `${type} step`,
      description: `${type} work`,
      systemPrompt: `Do the ${type} work.`,
      role: 'Coder' as const,
      tools: ['write_file'],
      inputs: [],
      outputs: [`docs/${type.toLowerCase()}.md`],
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: `${type} accepted`,
      maxAttempts: 3,
    })),
  };
}

async function fixture() {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-changeset-'));
  const canonical = path.join(container, 'worktrees', 'master');
  await fs.mkdir(canonical, { recursive: true });
  const git = simpleGit({ baseDir: canonical });
  await git.init();
  await git.addConfig('user.email', 'test@local');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(canonical, 'README.md'), '# fixture\n');
  await git.add('.');
  await git.commit('init');

  const projectContainer = new ProjectContainer(container);
  const repository = new DomainObjectRepository(projectContainer.state);
  await repository.load();
  const graph = compileProjectGraph({
    draft: samplePlan(),
    topic: 'Build a TypeScript application.',
    projectName: 'fixture',
  });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  const gitRepository = new GitRepositoryService(canonical);
  const service = new TicketChangeSetService(
    repository,
    projectContainer,
    gitRepository,
  );
  // CODE is the only Step that develops in isolation, so it is the only one with a ChangeSet.
  const coding = graph.steps.find((step) => step.type === 'CODE')!;
  const story = graph.tickets.find(
    (candidate): candidate is Ticket =>
      candidate.type === 'story' && candidate.stepId === coding.id,
  )!;
  const design = graph.steps.find((step) => step.type === 'HIGH_LEVEL_DESIGN')!;
  const designStory = graph.tickets.find(
    (candidate): candidate is Ticket =>
      candidate.type === 'story' &&
      candidate.stepId === design.id,
  )!;
  return {
    container, canonical, repository, service, projectContainer, gitRepository,
    graph, story, coding, design, designStory,
  };
}

describe('TicketChangeSetService', () => {
  it('leaves every Step but CODE in the canonical copy', async () => {
    // V-model Steps are sequentially dependent: DETAILED_DESIGN reads the high-level design, CODE
    // reads both and the manifest. Isolating each one branched them all from the same mainline
    // commit, so every Step worked blind and none could see what the previous produced.
    const { service, canonical, designStory, design, repository } = await fixture();
    const resolved = await service.ensureFor(designStory, design);

    expect(resolved.root).toBe(canonical);
    expect(resolved.changeSet).toBeUndefined();
    expect(await repository.list({ objectType: 'ticket-change-set' })).toEqual([]);
  });

  it('promotes a rejected canonical commit into the corrective worktree before mainline rollback', async () => {
    const {
      service, canonical, repository, gitRepository, design, designStory,
    } = await fixture();
    const baseRevision = await gitRepository.head();
    const canonicalGit = simpleGit({ baseDir: canonical });
    const rejectedPath = path.join(canonical, 'docs', 'high-level-design.md');
    await fs.mkdir(path.dirname(rejectedPath), { recursive: true });
    await fs.writeFile(rejectedPath, '# rejected candidate\n');
    await canonicalGit.add('.');
    await canonicalGit.commit('[xcompiler] rejected candidate');
    const candidateRevision = await gitRepository.head();

    const promoted = await service.preserveRejectedCandidate({
      ticketId: designStory.id,
      candidateRevision,
      baseRevision,
    });
    await canonicalGit.raw(['reset', '--hard', baseRevision]);

    expect(promoted.changeSet).toMatchObject({
      rootTicketId: designStory.id,
      baseRevision,
      currentRevision: candidateRevision,
      state: 'developing',
    });
    expect(promoted.ticket.workspaceBinding).toMatchObject({
      kind: 'ticket',
      revision: candidateRevision,
      changeSetId: promoted.changeSet?.id,
    });
    expect(await fs.readFile(path.join(promoted.root, 'docs', 'high-level-design.md'), 'utf8'))
      .toBe('# rejected candidate\n');
    await expect(fs.stat(rejectedPath)).rejects.toThrow();

    const correction = await registerChangeRequest(repository, promoted.ticket);
    const inherited = await service.ensureFor(correction, design);
    expect(inherited.changeSet?.id).toBe(promoted.changeSet?.id);
    expect(inherited.root).toBe(promoted.root);
  });

  it('creates one branch and worktree for a root Ticket', async () => {
    const { service, container, story, coding } = await fixture();
    const result = await service.ensureFor(story, coding);

    expect(result.changeSet.sourceBranch).toBe(`xcompiler/ticket/${story.id}`);
    expect(result.root).toBe(path.join(container, 'worktrees', 'tickets', story.id));
    expect((await fs.stat(result.root)).isDirectory()).toBe(true);
    expect(result.changeSet.state).toBe('developing');
    expect(result.changeSet.baseRevision).toBe(result.changeSet.currentRevision);
  });

  it('gives a corrective Ticket the same branch, worktree, and ChangeSet as the work it repairs', async () => {
    const { service, repository, story, coding } = await fixture();
    const first = await service.ensureFor(story, coding);

    const bug = await registerBug(repository, story);
    const second = await service.ensureFor(bug, coding);

    // Splitting the repair onto its own branch would put a half-finished change on the mainline.
    expect(second.changeSet.id).toBe(first.changeSet.id);
    expect(second.root).toBe(first.root);
    expect(second.changeSet.correctiveTicketIds).toContain(bug.id);
  });

  it('puts a Change Request writing product code on the CODE Story branch', async () => {
    // A CR propagates across downstream Steps, so the same Ticket writes design one moment and
    // product code the next. Its root stays where it was opened — a design Story with no branch —
    // and says nothing about the work in hand, so the executing Step has to decide.
    const { service, repository, story, coding, design, designStory } = await fixture();
    const owner = await service.ensureFor(story, coding);
    const request = await registerChangeRequest(repository, designStory);

    // Applied to the design Step it stays canonical; applied to CODE it joins the Story's branch.
    expect((await service.ensureFor(request, design)).changeSet).toBeUndefined();
    const applied = await service.ensureFor(request, coding);
    expect(applied.changeSet?.id).toBe(owner.changeSet!.id);
    expect(applied.root).toBe(owner.root);
    expect(applied.changeSet?.correctiveTicketIds).toContain(request.id);

    const all = await repository.list({ objectType: 'ticket-change-set', projectId: story.projectId });
    expect(all).toHaveLength(1);
  });

  it('keeps a correction in its discovery worktree when PM routes it back to design', async () => {
    const { service, repository, story, coding, design } = await fixture();
    const candidate = await service.ensureFor(story, coding);
    // Shape of a Ticket persisted before workspace binding existed: its CR source still points to
    // the CODE Story, but the Ticket itself carries no workspace fields yet.
    const request = await registerChangeRequest(repository, story);

    const rollback = await service.ensureFor(request, design);

    expect(rollback.root).toBe(candidate.root);
    expect(rollback.changeSet?.id).toBe(candidate.changeSet?.id);
    expect(rollback.ticket.workspaceBinding?.relativePath)
      .toBe(candidate.ticket.workspaceBinding?.relativePath);
    expect(rollback.ticket.workspaceBindingHistory).toHaveLength(1);
  });

  it('promotes a failed gate candidate into the ChangeSet correction worktree', async () => {
    const {
      service, repository, projectContainer, gitRepository, story, coding, design,
    } = await fixture();
    const original = await service.ensureFor(story, coding);
    const runId = createObjectId();
    const gateBranch = `xcompiler/gate/${runId}`;
    const gate = projectContainer.gate(createObjectId(), runId, gateBranch);
    await gitRepository.addWorktree({
      path: gate.workspace.root,
      branch: gateBranch,
      startPoint: original.changeSet!.currentRevision,
    });
    const candidateRevision = await new GitRepositoryService(gate.workspace.root).head();
    const boundStory = await repository.read(story.id);
    if (boundStory.objectType !== 'ticket') throw new Error('fixture Story is missing');
    const queuedBeforePromotion = await registerChangeRequest(repository, boundStory);
    let bug = await registerBug(repository, boundStory);
    bug = bindTicketWorkspace(bug, {
      kind: 'gate',
      relativePath: path.relative(projectContainer.root, gate.workspace.root).split(path.sep).join('/'),
      branch: gateBranch,
      revision: candidateRevision,
      changeSetId: original.changeSet!.id,
      mergeGateRunId: runId,
      reason: 'merge-gate',
      boundAt: new Date().toISOString(),
    });
    await repository.update(bug, bug.state);

    const promoted = await service.ensureFor(bug, coding);

    expect(promoted.root).toBe(gate.workspace.root);
    expect(promoted.workspace?.kind).toBe('gate');
    expect(promoted.changeSet?.sourceBranch).toBe(gateBranch);
    expect(promoted.changeSet?.workspaceId).toBe(promoted.workspace?.id);
    expect(promoted.ticket.workspaceBinding?.workspaceId).toBe(promoted.workspace?.id);
    await expect(fs.stat(original.root)).rejects.toThrow();

    const recovered = await service.ensureFor(queuedBeforePromotion, design);
    expect(recovered.root).toBe(gate.workspace.root);
    expect(recovered.ticket.workspaceBinding).toMatchObject({
      kind: 'gate',
      workspaceId: promoted.workspace?.id,
      changeSetId: promoted.changeSet?.id,
    });
  });

  it('is idempotent, so an interrupted run does not open a second branch', async () => {
    const { service, repository, story, coding } = await fixture();
    const first = await service.ensureFor(story, coding);
    const again = await service.ensureFor(story, coding);

    expect(again.changeSet.id).toBe(first.changeSet.id);
    const all = await repository.list({ objectType: 'ticket-change-set', projectId: story.projectId });
    expect(all).toHaveLength(1);
  });

  it('opens a new generation when a downstream Bug repairs an already merged CODE Story', async () => {
    const { service, repository, story, coding } = await fixture();
    const first = await service.ensureFor(story, coding);
    let merged = transitionChangeSet(first.changeSet!, 'reviewing');
    await repository.update(merged, merged.state);
    merged = transitionChangeSet(merged, 'gate-passed');
    await repository.update(merged, merged.state);
    merged = transitionChangeSet(merged, 'merged', { mergedRevision: merged.currentRevision });
    await repository.update(merged, merged.state);
    await service.release(merged.id);

    const bug = await registerBug(repository, story);
    const repair = await service.ensureFor(bug, coding);

    expect(repair.changeSet?.id).not.toBe(first.changeSet?.id);
    expect(repair.changeSet?.generation).toBe(2);
    expect(repair.changeSet?.sourceBranch).toBe(`xcompiler/ticket/${story.id}-r2`);
    expect(repair.changeSet?.correctiveTicketIds).toContain(bug.id);
    expect(repair.changeSet?.baseRevision).toBe(merged.currentRevision);
  });

  // The same deletion, with git reporting the path exactly as computed — which is what Linux does,
  // and what macOS never does because the container root reaches through a symlink. The registration
  // check matched there, returned early, and the branch content never arrived; the platform that ran
  // the suite locally could not see it. Stubbing the listing removes the platform from the question.
  it('recreates a deleted worktree even when git still reports it as registered', async () => {
    const { service, repository, projectContainer, story, coding } = await fixture();
    const first = await service.ensureFor(story, coding);
    const worktreeGit = simpleGit({ baseDir: first.root });
    await fs.writeFile(path.join(first.root, 'work.txt'), 'ticket work\n');
    await worktreeGit.add('.');
    await worktreeGit.commit('[xcompiler] ticket work');
    await service.recordRevision(first.changeSet.id, (await worktreeGit.revparse(['HEAD'])).trim());
    await fs.rm(first.root, { recursive: true, force: true });

    const git = (service as unknown as { git: { listWorktrees(): Promise<Array<{ path: string }>> } }).git;
    const realList = git.listWorktrees.bind(git);
    git.listWorktrees = async () => {
      const entries = await realList();
      // Report the deleted worktree at the uncanonicalized path the service computes.
      return [...entries, { path: first.root } as never];
    };
    const recovered = await new TicketChangeSetService(
      repository, projectContainer, git as never,
    ).ensureFor(story, coding);

    expect(await fs.readFile(path.join(recovered.root, 'work.txt'), 'utf8')).toBe('ticket work\n');
  });

  it('recreates a worktree deleted underneath it, without losing the branch commits', async () => {
    const { service, canonical, story, coding } = await fixture();
    const first = await service.ensureFor(story, coding);

    const worktreeGit = simpleGit({ baseDir: first.root });
    await fs.writeFile(path.join(first.root, 'work.txt'), 'ticket work\n');
    await worktreeGit.add('.');
    await worktreeGit.commit('[xcompiler] ticket work');
    const head = (await worktreeGit.revparse(['HEAD'])).trim();
    await service.recordRevision(first.changeSet.id, head);

    await fs.rm(first.root, { recursive: true, force: true });
    const recovered = await service.ensureFor(story, coding);

    expect(recovered.root).toBe(first.root);
    expect(await fs.readFile(path.join(recovered.root, 'work.txt'), 'utf8')).toBe('ticket work\n');
    // The branch holds the commits; the worktree is only a checkout of them.
    expect((await simpleGit({ baseDir: canonical })
      .revparse([first.changeSet.sourceBranch])).trim()).toBe(head);
  });
});

/** A Bug created by the discovering actor against the Story it repairs. */
async function registerBug(
  repository: DomainObjectRepository,
  story: Ticket,
): Promise<Ticket> {
  const { workKind: _workKind, verificationTicketId: _v, pairedSourceTicketId: _p, ...base } =
    story as Ticket & Record<string, unknown>;
  const bug = TicketSchema.parse({
    ...base,
    id: createObjectId(),
    name: 'BUG-P1-001',
    type: 'bug',
    parentTicketId: story.id,
    revision: 1,
    bugKind: 'test-failure',
    severity: 'high',
    failure: {
      category: 'test',
      code: 'test_failed',
      message: 'fixture failure',
      summary: 'fixture failure',
      retryable: true,
      switchProvider: false,
      failedStepId: story.stepId!,
      failedStepType: 'UNIT_TEST',
      targetStepId: story.stepId!,
      targetStepType: 'CODE',
      verificationStepId: story.stepId!,
      verificationStepType: 'UNIT_TEST',
      identity: {
        version: 1,
        category: 'test',
        code: 'test_failed',
        failedStepId: story.stepId!,
        targetStepId: story.stepId!,
        verificationStepId: story.stepId!,
        testSelectors: [],
        artifactTargets: [],
      },
    },
    verificationContract: {
      kind: 'test-gate',
      verificationStepId: story.stepId!,
      verificationStepType: 'UNIT_TEST',
      testSelectors: [],
      artifactTargets: [],
    },
  });
  await repository.insert(bug, bug.state);
  return bug;
}

/** A Change Request opened against a design Story, as CR propagation produces. */
async function registerChangeRequest(
  repository: DomainObjectRepository,
  parent: Ticket,
): Promise<Ticket> {
  const { workKind: _w, verificationTicketId: _v, pairedSourceTicketId: _p, ...base } =
    parent as Ticket & Record<string, unknown>;
  const request = TicketSchema.parse({
    ...base,
    ...createObjectEnvelope({
      name: 'CR-P1-001',
      objectType: 'ticket',
      projectId: parent.projectId,
      now: new Date().toISOString(),
    }),
    type: 'change-request',
    changeKind: 'contract-change',
    parentTicketId: parent.id,
    state: 'created',
    assignmentIds: [],
    activeAssignmentId: undefined,
    contractDelta: {
      summary: 'align the parser contract',
      before: ['no source'],
      after: ['source present'],
      affectedArtifacts: ['src/parser.ts'],
    },
    implementationPlan: ['apply the delta'],
    verificationGate: ['downstream gates pass'],
    sourceTicketIds: [parent.id],
    triggerStepId: parent.stepId,
    sourceStepId: parent.stepId,
    targetStepId: parent.stepId,
    propagationStepIds: [parent.stepId],
  });
  await repository.insert(request, request.state);
  return request;
}
