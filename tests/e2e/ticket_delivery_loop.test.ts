import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { compileProjectGraph } from '../../src/domain/planning/compiler.js';
import { ProjectGraphPersistenceService } from '../../src/application/planning/project_graph_persistence_service.js';
import { TicketChangeSetService } from '../../src/application/workspace/ticket_change_set_service.js';
import { MergeIntegrationService } from '../../src/application/workspace/merge_integration_service.js';
import { MergeGateService } from '../../src/application/workspace/merge_gate_service.js';
import { TicketDistillationService } from '../../src/application/context/ticket_distillation_service.js';
import { ContextService } from '../../src/application/context/context_service.js';
import { TicketWorkflow } from '../../src/application/project_management/ticket_workflow.js';
import { GitRepositoryService } from '../../src/infrastructure/git/git_repository_service.js';
import { DomainObjectRepository } from '../../src/infrastructure/repository/domain_object_repository.js';
import { DebugWiki } from '../../src/core/debug_wiki.js';
import { buildDebugBrief } from '../../src/core/debug_brief.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import { createObjectId } from '../../src/domain/identity/object_id.js';
import { TicketSchema, bindTicketWorkspace, type Ticket } from '../../src/domain/tickets/ticket.js';
import type { GateCheckResult } from '../../src/domain/workspace/merge_request.js';
import type { TicketChangeSet } from '../../src/domain/workspace/change_set.js';
import { PLAN_VERSION, type Plan } from '../../src/core/plan.js';
import { STEP_TYPES } from '../../src/domain/steps/step.js';

const FAILED_GATE: GateCheckResult[] = [
  { name: 'lint', ok: true, summary: 'clean', kind: 'execution' },
  { name: 'test', ok: false, summary: '1 failing: parser drops the source field', kind: 'execution' },
];
const PASSED_GATE: GateCheckResult[] = [
  { name: 'lint', ok: true, summary: 'clean', kind: 'execution' },
  { name: 'test', ok: true, summary: 'all green', kind: 'execution' },
];

const FAILURE_BRIEF = buildDebugBrief({
  reason: 'parser drops the source field',
  failureLog: 'AssertionError: expected source to be defined at src/parser.ts:4',
  phase: 'CODE',
  targetPhase: 'CODE',
});

/**
 * The whole 0.3 delivery model in one pass, on real Git.
 *
 * Each step below is cheap on its own and covered by a unit or integration test; what this proves is
 * that they compose — that a gate verdict really does go stale when the repair lands, that the
 * repair shares the original branch rather than opening a second one, and that everything the run
 * learned survives deleting the worktree it was learned in.
 */
describe('ticket delivery loop', () => {
  it('carries a Ticket from branch through a failed gate and repair to a squash merge', async () => {
    const world = await fixture();
    const { repository, container, git, changeSets, gates, story } = world;

    // 1. A root Ticket gets its own branch and worktree.
    const opened = await changeSets.ensureFor(story, world.coding);
    expect(opened.changeSet.sourceBranch).toBe(`xcompiler/ticket/${story.id}`);

    // 2. Work commits on that branch, never on the mainline.
    const firstRevision = await commit(opened.root, 'src/parser.ts', 'export const parse = () => ({});\n');
    await changeSets.recordRevision(opened.changeSet.id, firstRevision);
    expect(await git.revision('master')).not.toBe(firstRevision);

    // 3. The MR opens and its gate runs in a disposable worktree off the mainline.
    const request = await gates.open(opened.changeSet);
    const failing = await gates.start(request.id);
    expect(failing.root.startsWith(container.root)).toBe(true);
    expect(failing.root).not.toBe(opened.root);
    expect((await fs.stat(failing.root)).isDirectory()).toBe(true);

    // 4. The gate fails, and its exact candidate remains available for corrective routing.
    const failedRun = await gates.complete(failing.run.id, FAILED_GATE);
    expect(failedRun.status).toBe('failed');
    // The Merge Request itself moved: draft → ready → validating → changes-requested. Asserting the
    // state, not just the run, is what catches a lifecycle that silently never advances.
    expect(await mergeRequestState(repository, request.id)).toBe('changes-requested');
    expect((await fs.stat(failing.root)).isDirectory()).toBe(true);
    expect((await gates.currentVerdict(request.id)).ok).toBe(false);

    // 5. The Bug inherits the failing gate candidate. That candidate is promoted into the existing
    //    ChangeSet so both the original source and the merge interaction are visible to Debugger.
    let bug = await openBug(world);
    bug = bindTicketWorkspace(bug, {
      kind: 'gate',
      relativePath: failing.run.worktreePath!,
      branch: `xcompiler/gate/${failing.run.id}`,
      revision: failing.run.candidateRevision!,
      changeSetId: opened.changeSet.id,
      mergeGateRunId: failing.run.id,
      reason: 'merge-gate',
      boundAt: new Date().toISOString(),
    });
    await repository.update(bug, bug.state);
    const repairing = await changeSets.ensureFor(bug, world.coding);
    expect(repairing.changeSet.id).toBe(opened.changeSet.id);
    expect(repairing.root).toBe(failing.root);
    await expect(fs.stat(opened.root)).rejects.toThrow();

    // 6. A first gate that had passed would now be stale, because the source moved under it.
    const repairRevision = await commit(repairing.root, 'src/parser.ts', 'export const parse = () => ({ source: "x" });\n');
    await changeSets.recordRevision(opened.changeSet.id, repairRevision);
    expect(repairRevision).not.toBe(firstRevision);

    // 7. The second gate runs against the repaired source and passes.
    await gates.open(await requireChangeSet(repository, opened.changeSet.id));
    const passing = await gates.start(request.id);
    expect(passing.run.sourceRevision).toBe(repairRevision);
    const passedRun = await gates.complete(passing.run.id, PASSED_GATE);
    expect(passedRun.status).toBe('passed');
    expect(await mergeRequestState(repository, request.id)).toBe('approved');
    const verdict = await gates.currentVerdict(request.id);
    expect(verdict.ok, verdict.reason).toBe(true);

    // 8. A verdict is bound to what it judged: moving the source invalidates it.
    const late = await commit(repairing.root, 'src/late.ts', 'export const late = 1;\n');
    const afterMove = await gates.currentVerdict(request.id);
    expect(afterMove.ok).toBe(false);
    expect(afterMove.reason).toMatch(/moved since the gate passed/u);
    expect(afterMove.run?.status).toBe('stale');

    // 9. Re-gated at the new head, the merge lands as exactly one commit on the mainline.
    await changeSets.recordRevision(opened.changeSet.id, late);
    const finalRun = await gates.complete((await gates.start(request.id)).run.id, PASSED_GATE);
    expect(finalRun.status).toBe('passed');
    const beforeMerge = await git.revision('master');
    const merged = await git.squashMerge({
      targetBranch: 'master',
      sourceBranch: repairing.changeSet.sourceBranch,
      expectedTargetRevision: finalRun.targetRevision,
      message: `[xcompiler] ${story.name}`,
    });
    const log = await simpleGit({ baseDir: world.canonical }).log({ from: beforeMerge, to: merged });
    expect(log.total).toBe(1);
    expect(await fs.readFile(path.join(world.canonical, 'src/parser.ts'), 'utf8'))
      .toContain('source: "x"');

    // 10. What the run learned outlives the worktree it was learned in: the repair goes to the
    //     project wiki tier, the delivered work to Step Context, and the platform tiers are
    //     untouched throughout.
    const platformBefore = await world.platformEntryIds();
    await world.wiki.recordResolution({
      brief: FAILURE_BRIEF,
      solution: 'Return the source field from parse().',
      phase: 'CODE',
      language: 'typescript',
    });
    await new TicketDistillationService(repository).distil(TicketSchema.parse({
      ...story,
      state: 'closed',
      solution: {
        status: 'verified',
        approach: 'Return the source field from parse().',
        rationale: 'Two call sites depended on it.',
        changes: ['src/parser.ts'],
        verification: ['gate passed'],
        updatedAt: new Date().toISOString(),
      },
    }));

    await git.removeWorktree(repairing.root, { force: true });
    await expect(fs.stat(repairing.root)).rejects.toThrow();

    // Read back through fresh instances, so nothing is answered from memory left over from the run.
    const reread = new DomainObjectRepository(container.state);
    await reread.load();
    const changeSet = await reread.read(opened.changeSet.id);
    expect(changeSet.objectType === 'ticket-change-set' && changeSet.currentRevision).toBe(late);
    const stepContext = await new ContextService(reread)
      .find(story.projectId, 'step', story.stepId!);
    expect(stepContext?.findings.some((finding) => finding.text.includes('Return the source field')))
      .toBe(true);

    const freshWiki = new DebugWiki(world.installRoot, { projectPath: container.state.root });
    await freshWiki.load();
    expect((await freshWiki.search(FAILURE_BRIEF, { language: 'typescript', limit: 3 })).length)
      .toBeGreaterThan(0);
    expect(await world.platformEntryIds()).toEqual(platformBefore);
  });

  // The test above drives the gates and the squash directly. What that leaves untested is the seam
  // a real run actually uses: MergeIntegrationService deciding, against the real gate service and a
  // real repository, that a delivered Ticket may land. Only the project's own build and tests are
  // stubbed here — they are the genuinely external part.
  it('lands a delivered Ticket through the integration service, not just through the gates', async () => {
    const world = await fixture();
    const { repository, git, changeSets, gates, story } = world;

    const opened = await changeSets.ensureFor(story, world.coding);
    const revision = await commit(opened.root, 'src/parser.ts', 'export const parse = () => ({ ok: true });\n');
    await changeSets.recordRevision(opened.changeSet.id, revision);

    const beforeMerge = await git.revision('master');
    const integration = new MergeIntegrationService({
      repository,
      gates,
      git,
      targetBranch: 'master',
      mayMerge: true,
      releaseChangeSet: async (changeSetId) => {
        await changeSets.release(changeSetId);
      },
      runChecks: async () => PASSED_GATE,
    });
    const outcome = await integration.integrateTicket(story.projectId, story.id);

    expect(outcome.status, outcome.reason).toBe('merged');
    expect(outcome.mergedRevisions).toHaveLength(1);

    // The mainline gained exactly one commit, and it carries the work — this is what makes the
    // next Step able to read what CODE produced.
    const log = await simpleGit({ baseDir: world.canonical })
      .log({ from: beforeMerge, to: outcome.mergedRevisions[0]! });
    expect(log.total).toBe(1);
    expect(await fs.readFile(path.join(world.canonical, 'src/parser.ts'), 'utf8')).toContain('ok: true');

    // Both objects record that it landed; a merge the graph does not know about would be replayed.
    const changeSet = await repository.read(opened.changeSet.id);
    expect(changeSet.objectType === 'ticket-change-set' && changeSet.state).toBe('merged');
    expect(await fs.stat(opened.root).then(() => true, () => false)).toBe(false);
    const workspace = await repository.read(opened.workspace.id);
    expect(workspace.objectType === 'workspace-handle' && workspace.state).toBe('released');
    const requests = await repository.list({ objectType: 'merge-request', projectId: story.projectId });
    expect(requests.map((object) => object.objectType === 'merge-request' ? object.state : ''))
      .toEqual(['merged']);
  });

  it('lands a downstream Bug as a new ChangeSet generation after the original CODE merge', async () => {
    const world = await fixture();
    const { repository, git, changeSets, gates, story } = world;
    const integration = new MergeIntegrationService({
      repository,
      gates,
      git,
      targetBranch: 'master',
      mayMerge: true,
      releaseChangeSet: async (changeSetId) => {
        await changeSets.release(changeSetId);
      },
      runChecks: async () => PASSED_GATE,
    });

    const original = await changeSets.ensureFor(story, world.coding);
    const firstRevision = await commit(
      original.root,
      'src/parser.ts',
      'export const parse = () => ({ source: "first" });\n',
    );
    await changeSets.recordRevision(original.changeSet.id, firstRevision);
    expect((await integration.integrateTicket(story.projectId, story.id)).status).toBe('merged');

    const bug = await openBug(world);
    const repair = await changeSets.ensureFor(bug, world.coding);
    expect(repair.changeSet.generation).toBe(2);
    expect(repair.changeSet.id).not.toBe(original.changeSet.id);
    const repairRevision = await commit(
      repair.root,
      'src/parser.ts',
      'export const parse = () => ({ source: "repaired" });\n',
    );
    await changeSets.recordRevision(repair.changeSet.id, repairRevision);
    expect((await integration.integrateTicket(story.projectId, bug.id)).status).toBe('merged');

    expect(await fs.readFile(path.join(world.canonical, 'src/parser.ts'), 'utf8'))
      .toContain('source: "repaired"');
    const changeSetObjects = await repository.list({
      objectType: 'ticket-change-set',
      projectId: story.projectId,
    });
    expect(changeSetObjects.map((object) =>
      object.objectType === 'ticket-change-set' ? [object.generation, object.state] : []))
      .toEqual([[1, 'merged'], [2, 'merged']]);
  });
});

async function mergeRequestState(
  repository: DomainObjectRepository,
  id: string,
): Promise<string | undefined> {
  const object = await repository.read(id as never);
  return object.objectType === 'merge-request' ? object.state : undefined;
}

async function commit(root: string, file: string, content: string): Promise<string> {
  const git = simpleGit({ baseDir: root });
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
  await git.add('.');
  await git.commit(`[xcompiler] ${file}`);
  return (await git.revparse(['HEAD'])).trim();
}

async function openBug(world: Awaited<ReturnType<typeof fixture>>): Promise<Ticket> {
  const unit = world.graph.steps.find((step) => step.type === 'UNIT_TEST')!;
  return new TicketWorkflow(world.repository).openBug({
    creatorActorId: world.graph.actors.find((actor) => actor.role === 'tester')!.id,
    failedStep: unit,
    targetStep: world.coding,
    verificationStep: unit,
    kind: 'test-failure',
    severity: 'high',
    message: 'expected source',
    summary: 'parser drops the source field',
    category: 'test',
    code: 'parser_drops_source',
    retryable: true,
    switchProvider: false,
    rawEvidenceRef: '.xcompiler/failures/unit.log',
    correlationId: createObjectId(),
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loop-'));
  const canonical = path.join(root, 'worktrees', 'master');
  await fs.mkdir(canonical, { recursive: true });
  const seed = simpleGit({ baseDir: canonical });
  await seed.init(['--initial-branch=master']);
  await seed.addConfig('user.email', 'test@local');
  await seed.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(canonical, 'README.md'), '# loop\n');
  await seed.add('.');
  await seed.commit('init');

  // A shipped installation tier, so the test can prove a run never writes into it.
  const installRoot = path.join(root, 'install', 'debug-wiki');
  await fs.mkdir(path.join(installRoot, 'system'), { recursive: true });
  await fs.writeFile(
    path.join(installRoot, 'system', 'PLATFORM-1.md'),
    '# PLATFORM-1\n\nShipped platform knowledge.\n',
  );

  const container = new ProjectContainer(root);
  const repository = new DomainObjectRepository(container.state);
  await repository.load();
  const graph = compileProjectGraph({ draft: plan(), topic: 'loop', projectName: 'loop' });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  const git = new GitRepositoryService(canonical);
  const coding = graph.steps.find((step) => step.type === 'CODE')!;
  const story = graph.tickets.find(
    (ticket) => ticket.stepId === coding.id && ticket.type === 'story',
  )!;
  const wiki = new DebugWiki(installRoot, { projectPath: container.state.root });
  await wiki.load();

  return {
    root,
    canonical,
    installRoot,
    container,
    repository,
    git,
    graph,
    coding,
    story,
    wiki,
    changeSets: new TicketChangeSetService(repository, container, git),
    gates: new MergeGateService(repository, container, git, 'master'),
    async platformEntryIds(): Promise<string[]> {
      return (await fs.readdir(path.join(installRoot, 'system'))).sort();
    },
  };
}

async function requireChangeSet(
  repository: DomainObjectRepository,
  id: TicketChangeSet['id'],
): Promise<TicketChangeSet> {
  const object = await repository.read(id);
  if (object.objectType !== 'ticket-change-set') throw new Error(`Object ${id} is not a ChangeSet`);
  return object;
}

function plan(): Plan {
  return {
    version: PLAN_VERSION, language: 'typescript', intent: 'greenfield', phaseId: 'P1',
    projectType: 'application', requirementDigest: 'delivery loop fixture',
    complexityAssessment: { level: 'simple', rationale: 'x', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Deliver', status: 'current',
      scope: ['core'], deliverables: ['src/parser.ts'], dependsOn: [],
    }],
    architectureModules: [], globalPrompt: '', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date(0).toISOString(),
    steps: STEP_TYPES.map((type, index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase: type,
      title: `${type} step`, description: `${type} work`, systemPrompt: `Do the ${type} work.`,
      role: 'Coder' as const, tools: ['write_file'], inputs: [], outputs: [`docs/${type.toLowerCase()}.md`],
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: `${type} accepted`, maxAttempts: 3,
    })),
  };
}
