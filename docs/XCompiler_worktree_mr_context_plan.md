# XCompiler Worktree, Merge Request, and Layered Context Plan

Status: P1–P9 delivered; P10 not started (optional). See §12 for what remains before tagging.
Target release: v0.3.0 — the same release as the architecture refactor, not a follow-on
Builds on: [XCompiler 0.3 Architecture Refactor Plan](./XCompiler_refactor_plan.md) (implemented)
Compatibility policy: intentionally breaking, consistent with 0.3 §2.1

The tag baseline is v0.2.4. Everything in both plans ships as 0.3.0, so there is one breaking step
for users rather than two, and no compatibility is owed to any layout produced along the way.

## 1. Purpose

This plan takes XCompiler from its current model — one workspace, one Git working directory,
attempt-level snapshot rollback on the mainline, and context assembled ad hoc at run time — to:

- a protected mainline that only Merge Requests can update;
- Ticket branches and Ticket worktrees for code development;
- disposable Gate worktrees for merge validation;
- corrective Tickets that reuse the originating branch, worktree, and MR;
- identity-only Roles with persisted, layered, revisioned Context;
- distinct knowledge paths for ordinary Tickets and Bug Tickets, across a platform tier and a
  project tier.

It supersedes `XCompiler_Worktree_MR_分层Context_完整重构计划.md`. That draft was written against an
earlier reading of the repository; this document keeps its architecture, corrects the parts the
current source contradicts, removes work that is already done, and adds gaps it did not cover.

Ticket execution stays serial in 0.3. Three boundaries are drawn now specifically so that
multi-role parallel development is a later configuration change and not another refactor: the
role definition/instance split (§3.3), the shared versus worktree-local state tiers (§4A), and
per-aggregate write ownership (invariant 39).

## 2. Current-State Assessment

Everything in this section was verified against the source tree, not inferred from the draft.

### 2.1 Premises that are correct

**State root is hard-coupled to the workspace root.** `Workspace` holds a single `root`
([workspace.ts:5](../src/workspace/workspace.ts:5)) and every state path is a `.xcompiler/...` string
resolved against it — registry, objects, audit, lock, PM cache, record/replay fixtures. There is no
seam between "where the code is" and "where the project state is". The draft's `ProjectContext` /
`WorkspaceHandle` split is the right correction.

**GitService cannot run inside a linked worktree.** It reads
`ws.abs('.git/info/exclude')` ([git.ts:68](../src/workspace/git.ts:68)), which assumes `.git` is a
directory. In a linked worktree `.git` is a *file* pointing at `<common-dir>/worktrees/<name>`, so
runtime excludes are silently skipped and `.xcompiler` artifacts can be staged. Git internals must be
resolved through `git rev-parse --git-dir | --git-common-dir | --git-path`.

**The rollback model commits to the mainline.** Attempt baselines are real commits on the current
branch ([attempt_runner.ts:212](../src/application/execution/attempt_runner.ts:212)) and failure
rollback is `git reset --hard` ([git.ts:96](../src/workspace/git.ts:96), called from
[attempt_runner.ts:568](../src/application/execution/attempt_runner.ts:568)). On a protected mainline
this is exactly what must be replaced by branch-scoped history.

**Shared state would be mounted into the sandbox.** The Docker sandbox binds
`${ws.root}:/workspace` ([docker.ts:159](../src/sandbox/docker.ts:159)), and `.xcompiler` currently
lives inside `ws.root`. Moving the state root out of the worktree fixes this structurally rather than
by adding mount exclusions.

### 2.2 Work the draft schedules that is already implemented

**Debug Wiki retrieval and feedback (draft Phase 8) is substantially done.**
[debug_wiki.ts](../src/core/debug_wiki.ts) already provides `search()` with Top-K and language
filtering, `recordUse()` and `recordFailure()` for applied/rejected outcomes, `recordResolution()` for
distilling an entry, and `renderDebugWikiMatchesForPrompt()`. The AttemptRunner already runs the whole
loop: build a debug brief, search, inject matches, then record use or failure
([attempt_runner.ts:542-575](../src/application/execution/attempt_runner.ts:542)), and a relevance
floor already exists (`score >= 4`, [debug_wiki.ts:157](../src/core/debug_wiki.ts:157)). Phase 8
shrinks to adding the project tier (§6.2) and wiring retrieval into the Context Assembler.

**Workspace path safety (draft §22) is largely done, at a different layer.**
[path_guard.ts](../src/tools/path_guard.ts) resolves through `fs.realpath` and enforces containment
with `isInside()`, and `write_file` runs it *before* the allowlist check
([fs.ts:144-156](../src/tools/fs.ts:144)). Symlink escape is therefore already covered for
agent-driven writes. The residual gaps are narrower than the draft implies: `Workspace.abs()` itself
is unguarded for internal callers, and there is no `.git` write protection or mainline-worktree write
protection.

**`.xcompiler` is already gitignored** ([.gitignore:12](../.gitignore:12)).

### 2.3 Statements in the draft that are wrong

**The Debug Wiki is installation-scoped, and it already has layers — but no project tier.**
The draft treats the wiki as one per-project store. The implementation is the opposite and is already
layered: `LAYERS = ['system', 'agent', 'external']`
([debug_wiki.ts:102](../src/core/debug_wiki.ts:102)), the root resolves to `XC_PATH` or the XCompiler
installation directory rather than the project ([debug_wiki.ts:105-114](../src/core/debug_wiki.ts:105)),
and `system`/`agent` are shipped read-only platform knowledge copied in from the bundle
([debug_wiki.ts:289-297](../src/core/debug_wiki.ts:289)); only `external` is writable
([debug_wiki.ts:392](../src/core/debug_wiki.ts:392)).

The real defect is neither "per-project" nor "cross-project" — it is that **every project writes its
findings into the same shared `external` layer.** `recordResolution()` always creates entries as
`external` ([debug_wiki.ts:234](../src/core/debug_wiki.ts:234)) in the installation-level root, so
one project's build quirk becomes a retrieval candidate for every unrelated project, and nothing is
scoped to the project that would need it during refactor and later iterations.

**Decision — two tiers, see §6.2.** `system` and `agent` stay installation-scoped and read-only:
platform and agent-level knowledge, shared across all projects. A new `project` layer lives in the
project container and holds findings specific to that codebase. Retrieval reads all tiers and ranks
them together; writes are routed by classification, defaulting to `project`.

**`.xcompiler` does enter Git today, deliberately.** `ensureRepo()` writes and commits
`.xcompiler/.gitkeep` ([git.ts:44-45](../src/workspace/git.ts:44)) so the initial commit is non-empty,
and `isRuntimeArtifactPath()` explicitly exempts it. The invariant ".xcompiler never enters Git"
cannot be asserted without removing that behaviour; once the state root moves out of the worktree the
`.gitkeep` has no purpose and should be deleted.

**Runtime excludes are not `.gitignore`.** Exclusion is written to `.git/info/exclude`, which is not
committed and is per-repository. Any statement about `.gitignore` must say which mechanism is meant.

### 2.4 Prior art already in the repository

The draft — and the first revision of this document — treated worktrees and revision-locked merging
as entirely new. They are not. `src/runtime/bootstrap.ts` already implements both for the
self-bootstrap flow, and this work should generalize it rather than build beside it.

`prepareBootstrapWorkspace` ([bootstrap.ts:214](../src/runtime/bootstrap.ts:214)) requires an existing
clean repository, resolves the top level through `git rev-parse --show-toplevel`, creates a branch
`xcompiler/bootstrap/<runId>`, and adds a worktree for it.

`promoteBootstrapCandidate` ([bootstrap.ts:371](../src/runtime/bootstrap.ts:371)) is a working merge
gate with exactly the revision locking §7.1 specifies:

| §7.1 requirement | Already implemented |
|---|---|
| Source revision lock | Candidate HEAD and branch head must both equal the expected commit |
| Target revision lock | Host HEAD must still equal `baseCommit` and the tree must be clean |
| Staleness detection | Either mismatch aborts with a typed error |
| Base ancestry | `merge-base --is-ancestor` |
| Verified merge | `merge --ff-only` followed by a HEAD re-check |

Two consequences:

1. **P2 and P4 generalize this code**, extending the branch/worktree lifecycle from one bootstrap run
   to per-Ticket ChangeSets, and lifting the promote checks into `MergeGateRun`. The branch naming
   convention `xcompiler/<purpose>/<id>` is already established.
2. **It contradicts the layout below.** Bootstrap places its worktree at
   `<root>/.xcompiler/bootstrap/worktrees/<runId>` — inside the state directory. §5 puts worktrees
   beside it. Bootstrap moves to the §5 layout as part of P2; until then the two conventions must not
   both be live.

Bootstrap also merges with `--ff-only` while §2.2 specifies squash. See §4 decision 5.

### 2.5 Gaps the draft does not cover

**Sandbox environments would be rebuilt per worktree.** The subprocess sandbox roots itself at
`ws.abs('.sandbox')` and names the venv after the worktree directory
([subprocess.ts:66-71](../src/sandbox/subprocess.ts:66)). With `worktrees/master`,
`worktrees/tickets/<id>`, and `worktrees/gates/<mr>/<run>` each being a distinct `ws.root`, every
Ticket and *every Gate run* would build its own Python venv or `node_modules` from scratch and then
throw it away. This is the single largest practical cost of the worktree model and the draft does not
mention it. The sandbox root must move to the shared container and be keyed by an environment
fingerprint (language, manifest hash), not by directory name.

**Capability routing was tautological.** Every Ticket's `requiredCapabilities` was the full
capability set of its role, and each actor registered that same full set. Since eligibility already
requires `actor.role === ticket.role`, the capability check could never reject an actor the role
check accepted, and the routing order (eligibility, required capability, readiness, capacity,
quality) collapsed to "match the role".

Resolved in P9: `capabilitiesForStep(type, ticketType)` gives each Ticket the capability its Step
actually needs — a `DETAILED_DESIGN` Story asks for detailed design and integration test design, not
all four system-engineer capabilities — with a corrective Ticket adding its working mode (`debug`,
`change-implementation`) only where the owning role declares one. The narrow set is always a subset
of the owning role's declared capabilities, asserted in `tests/role_capabilities.test.ts`; without
that, narrowing would silently make Tickets unroutable.

Narrowing exposed a second defect: `Step.role` was derived from the planner's agent hint, so a plan
that marked requirement analysis as `Coder` produced a Step owned by a developer, contradicting both
`roleForStepType` (which derives the same role's `supportedStepTypes`) and the capabilities its
Tickets demand. The V-model position now decides ownership; the agent hint only decides which prompt
persona runs the Step.

**Where the plan files live is unspecified.** `phasePlan.json`, the per-phase plan, and the `XXX.xc`
project file are workspace-relative today. Under a container/worktree split the plan must state
whether they are project state (container) or versioned artifacts (repository). They are project
state and belong in the container.

**Crash recovery for worktrees.** `git worktree prune` is mentioned, but not reconciliation: a run
killed mid-gate leaves an orphaned worktree and a `running` gate row. 0.3 already established
idempotent recovery for corrective workflows; worktrees and gate runs need the same treatment.

**The repository read cache assumes a single writer.** 0.3 caches domain objects by their
revision-immutable path. That is sound only while one process owns the state root. A shared container
state root plus multiple worktrees makes concurrent access *look* available. Single-writer must stay
an explicit invariant until the cache is made invalidation-aware.

**Windows.** Linked worktrees are fine, but the draft's compatibility symlink into each worktree
requires privileges on Windows. Since the symlink is dropped (§3), this resolves itself, but it must
not be reintroduced.

## 3. Conflicts With 0.3 Decisions

The 0.3 refactor is implemented and its invariants are enforced by tests. Where the draft disagrees,
0.3 wins unless there is a reason to revisit it.

### 3.1 Compatibility

The draft's §26 asks for a compatibility symlink, a read-only compatibility period for old paths, and
continued recognition of old attempt baselines. 0.3 §2.1 is explicit: intentionally breaking, no
dual-read, fail fast with a clear version error and rebuild guidance.

**Resolution:** no compatibility layer. A workspace laid out for 0.3 fails with a typed error naming
the expected container layout and telling the user to re-initialize. The config loader already sets
the precedent for how that diagnostic should read
([config.ts](../src/config/config.ts) `describeConfigFailure`).

### 3.2 Ticket creation authority

The draft says "Gate failed → create a Corrective Ticket". 0.3 DoD item 7 is stricter: PM creates only
`Epic` and `Story`; whichever actor or gate *observed* the problem creates the Bug with its evidence,
and PM only registers, routes, and assigns it.

**Resolution:** the Gate is a discovering actor. It creates the Bug from the failing check with its
own evidence, then submits it to `TicketRegistrationService`. PM never authors the technical content.

**Landed in `88dc5c8`.** Until then the code returned `failed` and the orchestrator halted the run,
so the most informative finding in the system — the merged project does not build or its tests do not
pass — had nowhere to go. A live run reaching the gate is what exposed the gap between this
resolution and the code.

Two things the implementation settled that this section did not say:

- The repair goes through `routeFailure`, the path every other discovered defect already takes. A
  second decision point for "which corrective Ticket does this failure deserve" is how the two drift
  apart.
- `infrastructure-failed` is not a defect and does not become a Bug. The gate could not run, so
  nothing about the project was shown to be wrong and there is nobody to ask for a repair. It still
  halts.

### 3.3 Role model — definition versus instance

A Role must carry identity only: what the role is, what it is capable of, what it may not do. It must
hold no project, phase, step, ticket, workspace, sandbox, or conversation state; context is assembled
per execution. Later, an LLM is bound per role, and several roles run in parallel.

Today those concerns are fused. `ActorRegistration`
([actor.ts](../src/domain/project_management/actor.ts)) mixes identity (`role`, `capabilities`,
`supportedStepTypes`, `supportedTicketTypes`) with runtime instance state (`state`, `capacity`,
`activeAssignmentIds`, `qualityScore`). Prompt material lives in the agents layer, and LLM selection
is global config keyed by `ExecutionAgent` — `llm.roles` maps `Planner|Architect|Coder|Tester|Debugger`
to a provider pool ([config.ts:175](../src/config/config.ts:175)) — not per registered actor. So a
model cannot be bound to a role instance, and two actors of the same role cannot use different models.

**Resolution — a type/instance split, which is not the duplication 0.3 removed.**

| | `RoleDefinition` (new) | `ActorRegistration` (existing) |
|---|---|---|
| Nature | Template, static, project-independent | Instance, per project, stateful |
| Holds | Role prompt, capability prompt, capabilities, supported work types, tool permissions and prohibitions | Reference to a definition, LLM binding, capacity, availability, assignments, quality scores |
| Count | One per role | Many per role |

`role_profile.ts` becomes the seed data for `RoleDefinition` rather than a parallel table, so there is
still exactly one capability vocabulary. `ActorRegistration` gains an explicit `llmBinding` and drops
nothing. One definition with many actors is what makes per-actor model binding and multi-role
parallelism expressible at all — a single fused object cannot represent either.

Prompt assembly then becomes: `RoleDefinition` (identity) + `AssembledContext` (§7) + current task +
tool capability. The Role contributes no state to that sum.

### 3.4 ChangeSet versus the existing Changelist

0.3 already has a `changelist` domain object recording the file entries, commit, and verification of
one application ([evidence.ts:24](../src/domain/evidence/evidence.ts:24)). The draft's `ChangeSet` is
a different, coarser concept.

**Resolution:** keep both but name them so they cannot be confused. `Changelist` stays per-application
evidence. The new aggregate is named **`TicketChangeSet`** and represents one delivery generation for
one CODE root Ticket: one branch, one worktree, one MR, and many Changelists. A downstream defect
found after a generation merged opens the next generation from the current mainline.

### 3.5 Context must not become a third source of truth

0.3 already persists three overlapping things: domain objects (canonical state), the PM
`ProjectProjection` (a rebuildable cache under `.xcompiler/cache/pm/`), and `project_memory.json`.

**Resolution:** a strict split, enforced in review.

| Store | Role | Rebuildable |
|---|---|---|
| Domain objects | Canonical state and lifecycle | No — the source of truth |
| Context records | Authored knowledge: objectives, decisions, findings, constraints | No — versioned, audited |
| PM projection | Derived read model for scheduling | Yes — delete and rebuild |
| Project memory | Derived read model of the codebase for planning | Yes — delete and rebuild |

**Correction, made during P6.** An earlier draft of this plan had Project Context supersede
`project_memory.json`. It does not. Context records hold what a role *authored* — objectives,
decisions, findings; project memory is *scanned* from the workspace on every run: the module map,
key files, and extracted contracts the planner needs to write an incremental Phase. Nothing authors
it, so it is not a fourth source of truth, and Context cannot produce it.

Its real defect was its location. It was written to `.xcompiler/project_memory.json` inside the code
workspace, which under the container split is inside a worktree — so each parallel worktree would
keep a divergent copy and pruning one would lose it. It moves to `cache/project-memory.json` in the
container state root, beside the PM projection, in the same rebuildable tier.

### 3.6 Layering

The draft proposes `src/adapters/scm/`. 0.3 enforces layer direction in
`tests/architecture_dependencies.test.ts` over `domain`, `application`, `infrastructure`, `runtime`,
`cli`, `acp`.

**Resolution:** SCM providers live in `src/infrastructure/scm/`. No new top-level layer. `MergeRequest`
and `TicketChangeSet` are domain objects and must not import infrastructure — the existing test will
enforce this for free.

### 3.7 Gate runs and record/replay

0.3 forces verification stages into `replay` and forbids them from recording fixtures. Gate checks are
verification.

**Resolution:** a Gate run executes inside the record/replay `replay` scope. A replay miss is a typed
gate failure, never a silent live call. This is a hard constraint the draft omits.

### 3.8 Reuse structured failure classification

The draft's `infrastructure-failed` gate status is the same distinction 0.3 already makes with
`AttemptFailure.kind === 'infrastructure'`, together with the rule that infrastructure failures never
open a Bug.

**Resolution:** gate checks classify through `classifyFailure()`
([failure_classification.ts](../src/application/execution/failure_classification.ts)). No second
classifier.

### 3.9 Ticket history

0.3 gives every Ticket an append-only, hash-linked trace. Branch creation, worktree creation, MR
submission, gate results, and merges are ownership/flow events.

**Resolution:** they append `TicketTraceEvent`s. No parallel history table.

## 4. Revised Decisions

1. Git is the source of truth for versioned artifacts; the container state root is the source of truth
   for project state. Neither is layered on top of the other.
2. **The container owns the layout.** `-w <dir>` becomes the project container; the canonical working
   copy moves to `<dir>/worktrees/master/` and shared state stays at `<dir>/.xcompiler/`. This is the
   only arrangement in which the sandbox mount contains no project state by construction, rather than
   by remembering to exclude it. It is breaking: existing workspaces and `.xc` references must be
   rebuilt, and bootstrap's current in-state-directory worktree path (§2.4) moves with it.
3. **Mainline protection applies only to repositories XCompiler created.** `ensureRepo()` may
   `git init` a repository, and there XCompiler owns branch policy fully. When pointed at a repository
   that already exists — exactly the self-bootstrap case — XCompiler works only on its own
   `xcompiler/*` branches, never changes the default branch or its protection, and merges only on
   explicit authorization. Ownership is decided once at container initialization and recorded, so the
   rule cannot drift per command.
4. The mainline is protected. Agents never commit to it; only a merge from an approved MR updates it.
5. One CODE root Ticket owns at most one active `TicketChangeSet` generation, branch, worktree, and MR.
6. Corrective Tickets reuse the active generation before it merges; downstream corrections after a
   merge open a new generation and preserve the previous terminal record.
7. Gate runs happen in disposable worktrees, bound to a source and a target revision, and go stale
   when either moves.
8. **Merging is squash, uniformly.** One ChangeSet leaves one mainline commit, so a Ticket can be
   reverted as a unit and the mainline is not filled with per-attempt `[xcompiler]` commits; the
   attempt history stays on the Ticket branch. Bootstrap's `--ff-only` promote (§2.4) converges on
   this path in P5 rather than remaining a second merge strategy.
9. A Role is identity only; Context is persisted, layered, and revisioned, and assembled per execution.
10. Role definitions are templates; registered actors are instances, and an LLM binds to an actor.
11. Context is written only through a command API with optimistic concurrency.
12. The Debug Wiki has an installation tier and a project tier; run-time writes default to the project.
13. Project state is shared in the container; execution state is worktree-local and disposable.
14. Sandbox environments are shared per project and keyed by environment fingerprint, never by
    worktree directory.
15. Execution stays serial in 0.3, but write ownership is defined per aggregate so parallelism does
    not require redesign.

## 4A. State Tiers: Shared Versus Worktree-Local

Worktrees exist to isolate code, but they also have to isolate *execution*. Splitting state into one
shared tier and one per-worktree tier is what lets parallel Ticket execution be switched on later
without a second redesign: parallel actors contend only on the shared tier, and the shared tier is
exactly the part that already has revisions, an outbox, and a lock.

| | Shared (container) | Worktree-local |
|---|---|---|
| Location | `.xcompiler/` | `worktrees/<id>/.xcw/` |
| Lifetime | Project | The worktree |
| Contents | Domain objects, registry, Context, MR / gate / change sets, audit, PM projection, project Debug Wiki tier, plans, sandbox environments | Current attempt scratch, tool and run logs, per-run record/replay session, resolved sandbox session env, run lock, gate artifacts |
| On delete | Never deleted while the project lives | Disposable; losing it costs at most one in-flight attempt |
| Concurrency | Contended — revision checks and an outbox already govern it | Uncontended by construction |

Three rules follow.

1. **Nothing in the worktree-local tier is canonical.** Anything that must survive worktree removal is
   committed to the shared tier first. A gate worktree can be deleted at any moment without consulting
   it.
2. **`.xcw/` is not `.xcompiler/`.** A distinct name prevents a worktree-local directory from ever
   being mistaken for the state root. It needs its own ignore entry: `.gitignore` currently lists
   `.xcompiler/` only ([.gitignore:12](../.gitignore:12)), and the runtime exclude list in
   `GitService` is a separate mechanism that must be updated with it.
3. **The shared tier keeps one writer per aggregate, not one writer overall.** This is the concurrency
   boundary that has to be right before parallelism, and it is stricter today than it needs to be:

   - Domain object writes already use optimistic revisions, so distinct aggregates are safe in
     parallel; the registry commit is the serialization point and needs a container-level lock rather
     than the current per-workspace one ([lock.ts:31](../src/core/lock.ts:31)).
   - The 0.3 repository read cache is keyed by revision-immutable object paths, which is sound for
     concurrent *readers* but assumes no other process advanced the registry. Before parallel
     execution it must consult the registry cursor on read.
   - Sandbox environments are shared (§8 P3), so environment preparation needs a per-fingerprint lock,
     not a per-worktree one.

Serial execution remains the 0.3 default. These rules are what make the later switch a configuration
change rather than another refactor.

## 5. Target Layout

Two roots, matching the two state tiers of §4A.

```text
<xcompiler-install-or-XC_PATH>/
└── .xcompiler/debug-wiki/
    └── wiki/{system,agent,external}/   # platform tier, shared by every project

project-container/
├── .xcompiler/                  # SHARED project state, never in Git
│   ├── context/{project,phases,steps,tickets}/
│   ├── objects/  registry/  audit/
│   ├── cache/pm/                # rebuildable projection
│   ├── record-replay/
│   ├── sandboxes/               # shared, fingerprint-keyed environments
│   ├── workspaces/              # worktree registry
│   ├── merge-requests/  gates/  artifacts/
│   ├── plans/                   # phasePlan.json, phase plans, XXX.xc
│   ├── debug-wiki/wiki/project/ # project tier only
│   ├── roles/                   # RoleDefinition seed templates (objects live in the registry)
│   └── .lock                    # container-level registry lock
│
└── worktrees/
    ├── master/                  # canonical worktree
    │   └── .xcw/                # WORKTREE-LOCAL execution state
    ├── tickets/<root-ticket-id>/
    │   └── .xcw/
    └── gates/<mr-id>/<gate-run-id>/
        └── .xcw/
```

Changes from the draft: no `.xcompiler` symlink inside worktrees; the Debug Wiki is split across both
roots rather than living only in the project (§6.2); `.xcw/` carries worktree-local execution state;
`sandboxes/`, `plans/`, and `roles/` are added. `docs/`, `tests/`, and `examples/` stay inside each
worktree because they are versioned repository content.

## 6. Domain Model

Reconciled with the 0.3 objects rather than layered beside them.

```ts
interface ProjectContainer {
  projectId: ObjectId;
  containerRoot: string;
  repositoryRoot: string;
  canonicalBranch: string;
  stateRoot: string;
  worktreesRoot: string;
}

interface WorkspaceHandle {
  id: ObjectId;
  projectId: ObjectId;
  kind: 'canonical' | 'ticket' | 'gate';
  root: string;
  localStateRoot: string;         // <root>/.xcw — worktree-local tier, §4A
  branch: string;
  revision: string;
  ownerTicketId?: ObjectId;
  sandboxFingerprint: string;
}

/**
 * Identity only: no assignment, no workspace, no conversation. A registered domain object like every
 * other — `ObjectEnvelope` supplies id, projectId, revision, and timestamps (§6.1).
 */
interface RoleDefinition extends ObjectEnvelope {
  objectType: 'role-definition';
  role: DomainRole;
  rolePrompt: string;
  capabilityPrompt: string;
  capabilities: string[];
  supportedStepTypes: StepType[];
  supportedTicketTypes: TicketType[];
  allowedTools: string[];
  prohibitions: string[];
}

/**
 * Per-actor model binding, replacing the global agent-keyed llm.roles pool. A value object embedded
 * in ActorRegistration, not an entity: it has no independent lifecycle and nothing references it,
 * which is the same treatment TicketSource and ChangelistEntry already get.
 */
interface LlmBinding {
  providerPool: string[];         // ordered; existing router fallback semantics
  executionAgent: ExecutionAgent; // prompt persona
  temperature?: number;
}

interface TicketChangeSet {
  id: ObjectId;
  projectId: ObjectId;
  rootTicketId: ObjectId;
  generation: number;
  correctiveTicketIds: ObjectId[];
  changelistIds: ObjectId[];      // existing 0.3 evidence objects
  sourceBranch: string;
  workspaceId: ObjectId;
  mergeRequestId: ObjectId;
  baseRevision: string;
  currentRevision: string;
  mergedRevision?: string;
  state: 'developing' | 'reviewing' | 'changes-requested'
       | 'gate-passed' | 'merged' | 'abandoned';
}

interface MergeRequest {
  id: ObjectId;
  projectId: ObjectId;
  rootTicketId: ObjectId;
  sourceBranch: string;
  targetBranch: string;
  baseRevision: string;
  sourceRevision: string;
  targetRevision?: string;
  state: 'draft' | 'ready' | 'validating' | 'changes-requested'
       | 'approved' | 'mergeable' | 'merged' | 'closed';
  gateRunIds: ObjectId[];
}

interface MergeGateRun {
  id: ObjectId;
  mergeRequestId: ObjectId;
  sourceRevision: string;
  targetRevision: string;
  candidateRevision: string;
  status: 'running' | 'passed' | 'failed' | 'stale' | 'blocked' | 'infrastructure-failed';
  checkResults: GateCheckResult[];
}

interface ContextRecord {
  id: ObjectId;
  scope: 'project' | 'phase' | 'step' | 'ticket';
  ownerId: ObjectId;
  summary: string;
  facts: ContextFact[];
  decisions: ContextDecision[];
  constraints: ContextConstraint[];
  openQuestions: ContextQuestion[];
  artifacts: ArtifactReference[];
  revision: number;              // optimistic lock
  updatedBy: ActorReference;
  updatedAt: string;
}
```

A gate result is valid only while `sourceRevision` and `targetRevision` both match the current heads;
otherwise the run is `stale`.

### 6.1 Every entity is a registered object

There are no exceptions to the identity rule. Every entity above carries `ObjectEnvelope` — a UUIDv7
`id`, `objectType`, `projectId`, `revision`, and timestamps — and is committed through
`DomainObjectRepository`, inheriting atomic commits, optimistic revision checks, and the event
outbox. Nothing invents its own storage or its own id scheme.

`OBJECT_TYPES` therefore gains: `role-definition`, `workspace-handle`, `ticket-change-set`,
`merge-request`, `merge-gate-run`, `context-record`.

**Role definitions are materialized per project, exactly like actors.** The envelope requires a
`projectId`, and the compiler already creates one `ActorRegistration` per role per project
([compiler.ts:702](../src/domain/planning/compiler.ts:702)). Role definitions follow that path:
installation-level files under `.xcompiler/roles/` are *seed templates*, and the registered
`RoleDefinition` objects are created from them when the project graph is compiled. A project can then
revise a prohibition or a prompt without touching any other project, and every such change is a
tracked revision rather than an untracked config edit.

This also removes a duplication rather than adding one. `createActorRegistration` currently copies
`capabilitiesForRole(role)`, `supportedTicketTypesForRole(role)`, and the derived step types onto
every actor ([compiler.ts:708](../src/domain/planning/compiler.ts:708)). Once a `RoleDefinition`
object exists, `ActorRegistration` holds `roleDefinitionId` as a real foreign key and stops carrying
its own copy; `role_profile.ts` becomes the seed data for one object instead of a parallel table
consulted at three call sites.

**What is deliberately not a registered object.** Value objects embedded in an entity —
`LlmBinding`, `TicketSource`, `ChangelistEntry` — have no independent lifecycle and no incoming
references, so they carry no id. External artifacts are also not domain objects: Git commits and
Debug Wiki entries live in their own stores and are referenced from registered objects by their
native stable id (a SHA, a `DW-045`). The boundary is ownership: if XCompiler owns the lifecycle, it
is a registered object; if XCompiler only points at it, it is a reference.

### 6.2 Debug Wiki tiers

The layer vocabulary already exists; what is missing is a project tier and a multi-source read.

| Layer | Lives in | Writable | Holds |
|---|---|---|---|
| `system` | Installation | No (shipped) | Platform behaviour, toolchain, runtime, sandbox |
| `agent` | Installation | No (shipped) | Agent and LLM interaction failure modes |
| `external` | Installation | Yes | Third-party ecosystem issues, generalized from projects |
| `project` | Project container | Yes | This codebase: its architecture, conventions, recurring defects |

Two mechanics change:

**Read.** `DebugWiki` gains a second source and ranks all four layers together instead of one root.
`copyBundledLayers()` — which physically copies the shipped `system` and `agent` directories into the
active root ([debug_wiki.ts:289-297](../src/core/debug_wiki.ts:289)) — is replaced by a multi-source
read. Copy-merge cannot express two tiers: it would either duplicate the platform wiki into every
project or let project entries leak upward.

**Write.** `recordResolution()` currently hardcodes `external`
([debug_wiki.ts:234](../src/core/debug_wiki.ts:234)). It becomes classified, defaulting to `project`:

```text
Root cause is in the generated codebase        -> project
Root cause is XCompiler, sandbox, or toolchain -> external (candidate for promotion)
system / agent                                 -> never written at run time
```

Defaulting to `project` is the safe direction: a misfiled project entry is noise in one project, while
a misfiled platform entry is noise in all of them. Promotion from `project` to `external` is an
explicit, reviewed action, never automatic.

Retrieval prefers the project tier on ties, because a finding from this codebase outranks a generic
one at equal relevance. The existing `score >= 4` floor and Top-K limit still apply across the merged
result.

## 7. Context Assembly

Assembly order is Project → Phase → Step → Ticket chain (root to current) → Debug Wiki.

Rules:

1. No Ticket in scope means no Ticket Context and no Debug Wiki lookup.
2. A Ticket in scope loads its full parent chain, root first, with cycle detection, a depth cap, and a
   cross-project parent check.
3. Parent Tickets contribute a bounded view — objective, constraints, acceptance, accepted decisions,
   handoff — never full logs or failed attempts.
4. Only a Bug Ticket triggers Debug Wiki retrieval, Top-K with a relevance floor.
5. Every assembly emits a `ContextSnapshot` recording each source revision and the wiki entry ids, so
   any execution can be replayed against the exact context it saw.

Knowledge settles differently by Ticket type: an ordinary Ticket distils into Step Context on
verified closure; a Bug distils into the Debug Wiki, leaving only a one-line conclusion and a wiki
reference in Step Context.

## 8. Phased Plan

Each phase ends green on `npm run typecheck`, `npm run lint`, and `npm run test:core`.

### P1 — Container and state-tier split

Introduce `ProjectContainer` and `WorkspaceHandle`; derive shared state paths from `stateRoot` and
execution-local paths from `WorkspaceHandle.localStateRoot` (§4A); move plan files into
`.xcompiler/plans/`; move the lock from per-workspace to container level; delete the
`.xcompiler/.gitkeep` commit behaviour; add a typed "workspace is not a project container" error.

Done when a container with a canonical worktree runs build and run end to end, no state path is
derived from a worktree root, and every write is classifiable as shared or worktree-local.

### P2 — Worktree-safe Git

Split `GitService` into `GitRepositoryService` (branches, worktrees, prune) and `GitWorkingCopy`
(status, commit, diff, reset). Resolve all Git internals via `rev-parse --git-dir/--git-common-dir/
--git-path`. Add a worktree registry with crash reconciliation. Lift bootstrap's branch and worktree
creation (§2.4) into `GitRepositoryService` so there is one implementation, and move its worktree
path onto the §5 layout. Record repository ownership (decision 3) at container initialization.

Done when every operation works identically in the canonical worktree and a linked worktree, an
orphaned worktree is detected and pruned on startup, and bootstrap creates its worktree through the
same service as Tickets.

### P3 — Shared sandbox environments

Move the sandbox root to `.xcompiler/sandboxes/` and key environments by fingerprint (language plus
manifest hash) instead of directory name. Bind a sandbox to a `WorkspaceHandle` at execution time.

Done when a Ticket worktree and a Gate worktree with identical dependencies share one prepared
environment, and deleting a worktree never invalidates it. **This phase must precede P4** — without
it every gate run pays a full dependency install.

### P4 — Ticket branch, worktree, and TicketChangeSet

Root Tickets create generation 1 at `xcompiler/ticket/<id>` plus a worktree; corrective Tickets reuse
the active generation. A downstream correction after merge creates `xcompiler/ticket/<id>-r<N>` from
the current mainline. Attempt baselines become branch-scoped commits; mainline repair resets are
restricted to transactional rollback after a failed squash merge.

Done when a Bug from a failed check is repaired in the originating worktree, and the mainline has no
agent commit.

### P5 — Local Merge Request and Merge Gate

Add `MergeRequest` and `MergeGateRun`, gate worktrees, revision locking and staleness, squash merge,
and mainline write protection. The revision checks already exist in `promoteBootstrapCandidate`
(§2.4) and move into `MergeGateRun` rather than being rewritten; bootstrap's promote becomes a caller
of the shared gate and switches from `--ff-only` to squash (decision 8). Mainline write protection is
enforced only for XCompiler-created repositories (decision 3). Gate checks run in the record/replay
`replay` scope and classify failures through `classifyFailure()`. A failing check creates its Bug as
the discovering actor and submits it to PM.

Done when a source or target move marks a gate stale, infrastructure failures block the MR without
opening a Bug, and only a passed gate can merge.

### P6 — Layered Context persistence and the update API

Add `ContextRecord` for all four scopes with JSON plus Markdown, the `context_*` command surface, and
optimistic concurrency. Roles lose direct write access to `.xcompiler/context/**`. Move
`project_memory.json` into the container's rebuildable cache tier (§3.5) rather than retiring it.

Done when two roles cannot overwrite each other's context and every update carries an expected
revision.

### P7 — Context Assembler

Implement assembly, the parent-chain view, budgeting, and `ContextSnapshot`.

Done when a Step with no Ticket loads no Ticket Context, a parent cycle is rejected, and each
execution records the context revisions it used.

### P8 — Knowledge distillation and Debug Wiki tiers

Ordinary Ticket → Step Context; Bug → Debug Wiki. Add the `project` layer, replace `copyBundledLayers()`
with a multi-source read across installation and project tiers, and classify writes with a `project`
default (§6.2). Wire retrieval into the assembler. Failed or cancelled Tickets do not distil.

Retrieval, feedback, and the relevance floor already exist — see §2.2.

Done when a project-specific finding is retrievable in that project and invisible to others, the
shipped platform layers are never written at run time, and deleting the project container loses no
platform knowledge.

### P9 — Role definitions and per-actor LLM binding

Add `role-definition` to `OBJECT_TYPES` and materialize one registered `RoleDefinition` per role
per project in the compiler, seeded from installation templates under `.xcompiler/roles/`. Point
`ActorRegistration.roleDefinitionId` at it and drop the copied capability fields. Add `llmBinding` to
`ActorRegistration` and migrate `llm.roles` from a global agent-keyed pool to a per-actor binding
with the same router fallback semantics. Narrow Ticket
`requiredCapabilities` to the capability the work actually needs, so routing can discriminate
between two actors of one role (§2.4). Reconcile the capacity reservation edge noted in
`holdsCapacity` before capacity gates parallel dispatch.

Done when two actors of the same role can run different models, and a Role object carries no project,
ticket, workspace, or conversation state.

This phase is deliberately late: it is the precondition for multi-role parallelism, not for the
worktree and MR model, and it should land on a settled Context Assembler.

**Delivered, with three points settled during implementation.**

*The binding overrides the pool; it does not replace it.* Config remains where providers are
declared — the compiler generates actors and cannot know provider names — so `llm.roles` stays the
default per-agent pool and `ActorRegistration.llmBinding` overrides it for one actor. A bound actor
does **not** inherit the global fallback chain, matching `role_fallbacks` semantics: binding a model
to one of several parallel actors is meaningless if the run may silently substitute another.

*Installation templates override identity only.* `.xcompiler/roles/<role>.json` may substitute
`rolePrompt`, `capabilityPrompt`, `prohibitions`, and `allowedTools`. It may not reach capabilities
or supported Step and Ticket types: routing narrows a Ticket's `requiredCapabilities` against that
same vocabulary, so an installation able to shrink it would only make its own Tickets unroutable. A
missing directory means no overrides; a malformed or misnamed file is an error rather than a silent
fallback to the built-in text.

*Narrowing exposed a defect in Step role derivation.* `Step.role` was taken from the planner's agent
hint, so a plan could hand `REQUIREMENT_ANALYSIS` to a developer — contradicting both the role's
`supportedStepTypes` and the capabilities its Tickets demand. The V-model position now decides who
owns a Step (`roleForStepType`); the agent hint still decides which prompt persona runs it.

Three decisions taken while implementing it:

- **Templates override identity only.** `.xcompiler/roles/<role>.json` may replace `rolePrompt`,
  `capabilityPrompt`, `prohibitions`, and `allowedTools`. It cannot reach capabilities or supported
  Step and Ticket types: routing narrows Tickets against that same vocabulary, so an installation
  able to shrink it would make its own Tickets unroutable rather than customize anything. Templates
  are read in `infrastructure/roles/`, not in the Domain compiler, and passed in — a malformed or
  misnamed file is an error rather than a silent fallback to the built-in text.
- **A per-actor binding is authoritative, not additive.** It replaces `llm.roles`, `role_fallbacks`,
  and the global fallback chain for that actor. Binding a specific model to one of several parallel
  actors is meaningless if the run may silently substitute another. `llm.roles` remains the default
  for unbound actors and the only place providers are declared, since the compiler generates actors
  with no access to configuration.
- **Capacity is released when a Ticket is parked before it starts.** Routing reserves capacity at
  assignment time, while the Ticket is still `created`; blocking it records a blocker without a
  state transition, so nothing reconciled the reservation. A resumed Ticket re-reserves on its
  `in_progress` transition and cannot overcommit, because routing re-checks capacity excluding its
  own assignment.

Not in this phase: provisioning more than one actor per role. The object model now expresses it —
one shared definition, N actors with independent bindings, capacity, and assignments — but deciding
how many developers a Phase gets belongs with S4 parallel execution.

### P10 — Remote SCM adapters (optional)

`infrastructure/scm/` providers for GitHub, GitLab, Gitea. The local MergeRequest stays canonical.

## 9. Invariants

These extend the 0.3 invariants; they do not replace them.

```text
21. Only CODE develops in isolation. Every other Step works in the canonical copy and commits to
    the mainline directly; a CODE Ticket forks from the mainline when it is created and reaches the
    mainline only through an approved MR merge.
22. One TicketChangeSet = one CODE root Ticket delivery generation, one branch, one worktree, one MR.
23. Corrective Tickets reuse the active generation; corrections discovered after merge open the next
    generation from current mainline and never mutate a terminal ChangeSet.
24. Gate runs execute in a disposable worktree, in replay scope.
25. A gate result is bound to a source and target revision and goes stale when either moves.
25a. A ChangeSet merges when its Ticket delivers, not when its Phase does. V-model Steps are
    sequentially dependent, so a change still on its own branch is invisible to every Step that
    follows it in the same Phase.
26. A failing gate check creates its own Bug as the discovering actor; PM only routes it.
27. Infrastructure failure blocks the MR and never opens a Bug.
28. Every entity XCompiler owns is a registered object with a UUIDv7 id and an ObjectEnvelope,
    committed through the repository. Embedded value objects and external artifacts are referenced,
    never invented as a parallel id scheme.
29. A Role carries identity only: prompt, capability, permitted tools, prohibitions. It holds no
    project, phase, step, ticket, workspace, sandbox, or conversation state.
30. A RoleDefinition is a template; an ActorRegistration is an instance. One definition, many actors.
31. An LLM binds to an actor, not to a global agent pool; two actors of one role may differ.
32. Context is written only through the context command API, under optimistic concurrency.
33. No Ticket in scope means no Ticket Context and no Debug Wiki lookup.
34. Ordinary Tickets distil to Step Context; Bugs distil to the Debug Wiki.
35. The Debug Wiki has an installation tier (system, agent, external) and a project tier. Shipped
    layers are never written at run time; run-time writes default to the project tier.
36. Project state is shared in the container; execution state is worktree-local in `.xcw/`.
    Nothing worktree-local is canonical, so any worktree may be deleted at any time.
37. State root and workspace root are distinct; shared state never lives inside a worktree.
38. Sandbox environments are keyed by fingerprint and shared across worktrees.
39. Shared state allows one writer per aggregate. Registry commits serialize on the container lock;
    the read cache must consult the registry cursor before any parallel execution is enabled.
```

## 10. Testing

Mapped onto the 0.3 capability profiles (§12 of the 0.3 plan), so nothing here requires a new runner.

**`core`** — deterministic: parent-chain recursion and cycle detection; context revision conflicts;
assembly inclusion rules; distillation routing by ticket type; wiki tier selection on write and tier
preference on read; gate staleness; `TicketChangeSet` transitions; path containment; sandbox
fingerprinting; shared-versus-local state classification; a `RoleDefinition` carrying no state.

**`integration`** — real Git: worktree create, resolve, prune, and crash reconciliation; `.git`
resolution as file and as directory; branch-scoped attempt commit and rollback; squash merge; gate
candidate conflict against a moved mainline.

**`e2e`** — the full loop: root Ticket → branch and worktree → commits → MR → gate worktree → gate
failure → Bug in the original worktree → new commit makes the old gate stale → new gate passes →
squash merge → distillation into the project wiki tier → worktree removal → state still recoverable,
and the platform tier unchanged throughout.

Built as `tests/e2e/ticket_delivery_loop.test.ts`. Writing it was worth more than the coverage: every
previous test stubbed `MergeGateService`, so it had never run against a real repository and carried
three defects behind a green suite — a merge request linked through a stale ChangeSet, two revision
increments where the registry accepts one, and a gate that stopped at `ready` and so could never
record its own outcome. A composed path is the only thing that finds this class of defect.

## 11. Risks

**Gate cost.** Every gate run creates a worktree and runs the full check set. Mitigated by P3 sharing
sandbox environments; without P3 this model is too slow to use.

**Context bloat.** Layered context grows until prompts blow the window. Mitigated by bounded parent
views, budgeting in the assembler, and distillation that discards transcripts.

**A fourth source of truth.** Context could drift from domain state. Mitigated by §3.5: context holds
authored knowledge only, and never lifecycle state.

**Worktree and state divergence.** A deleted or manually moved worktree desynchronizes the registry.
Mitigated by startup reconciliation and by never storing project state inside a worktree.

**Concurrency creep.** Worktrees make parallelism look free, but the read cache and the lock assume a
single writer. Invariant 35 holds until the cache is invalidation-aware.

## 12. Remaining before the 0.3.0 tag

**Live-model validation.** Every gate here is deterministic or stubbed. Generating a real Python and
a real TypeScript project end to end needs live provider credentials and is the one item that cannot
be closed from the test suite.

*In progress against OpenRouter (qwen3.7-plus for planning and design, deepseek-v4-flash for code
and test).* The plan compiles and the container, registry, worktree, and sandbox layout all behave
as designed. Seven defects surfaced that no deterministic gate could have found, because each one
needed either a real filesystem layout or a real model's output:

| Defect | Why the suite missed it |
|---|---|
| Manifest read project state from the worktree, not the container | The fixture used the flat pre-container layout, so the wrong root still held a registry |
| `--name` discarded; every project named `master` | The name was recovered by parsing a path, and no test compiled a graph through the CLI options |
| Manifest filename derived from the working copy, disagreeing with the Project inside it | Nothing asserted the two agreed |
| `-w` assumed which path it was given | Only the container form was exercised |
| Permission prompts during an already-confirmed plan | Confirmation state was not modelled in tests |
| A created repository lacked the branch and HEAD the model assumes | Fixtures always seeded a commit first |
| `isAllowedWrite` compared globs literally | No Step fixture declared a glob output, though real plans do routinely |
| TypeScript tests declared as `test_*.ts`, which `vitest run` cannot collect | Only a real planner produces the name; the profile knew the rule but never told it |

The pattern worth carrying forward: every one of these sat between two components that each looked
correct alone — a path producer and a path consumer, a guard and the prompt describing that guard, a
naming convention and the role that chooses names. Composed tests find these; unit tests do not.

**P10 is optional** and not started; the local Merge Request stays canonical without it.

## 13. Out of Scope

Not built in 0.3: multi-Ticket and multi-role parallel execution; worktree pools; distributed
workspace leases; Kubernetes or OverlayFS workspaces; automatic semantic conflict resolution;
unbounded concurrent gates; mandatory remote MR; automatic promotion of project wiki entries to the
platform tier.

Parallelism is the one item deliberately *prepared for* rather than merely deferred. Enabling it
later requires exactly three things, all scoped by this plan: a registry-cursor-aware read cache
(invariant 39), a per-fingerprint sandbox preparation lock (§4A), and actor-level LLM binding (P9).
No domain invariant changes.

## 14. Sandbox dependency install (resolved)

Live validation originally stopped at `npm install` because the isolated HOME discarded the host's
registry endpoint. The current implementation keeps credentials isolated while accepting an
explicit registry endpoint, shares a project download cache, and refreshes the idle timer whenever
the environment or cache grows. Merge-gate validation has since reached and passed this boundary.

Measured, not inferred:

| Environment | `npm install --dry-run` |
|---|---|
| Host shell, with `~/.npmrc` | 181 ms |
| Clean `HOME`, default registry — what the sandbox does | still running past 5 min |

`baseEnvironment()` still redirects `HOME` to an empty sandbox directory so host credentials never
reach generated code. `sandbox.*.registry` supplies only the selected endpoint through
`NPM_CONFIG_REGISTRY`; tokens and the rest of the host npm configuration remain unavailable.

The manifest remains owned by HIGH_LEVEL_DESIGN. A need discovered elsewhere becomes a dependency
Change Request, is checked against the accepted dependency set, and returns through the normal CR
chain. Direct manifest writes and `add_dependency` both synchronize the appropriate isolated
environment; incompatible requests do not silently replace accepted versions.
