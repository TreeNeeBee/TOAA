# Runtime Domain Refactor Audit Record

## Record Metadata

| Field | Value |
| --- | --- |
| Audit ID | `XC-AUDIT-2026-08-01-DOMAIN-001` |
| Classification | Major architecture refactor |
| Repository | `TreeNeeBee/XCompiler` |
| Branch at audit time | `master` |
| Recorded at | `2026-08-01T15:14:07+08:00` |
| Pre-change baseline commit | `6ac42db1712797757fb69f560c989b42792f65d5` (`fix some bugs`) |
| Final change commit | Pending; the refactor was intentionally left unstaged and uncommitted when this record was written |
| Package version validated | `@xcompiler/cli@0.2.4` |
| Plugin API version | `1` |
| Compatibility policy | No compatibility layer for the removed persisted domain schema |
| Implementation status | Complete |
| Validation status | Complete |

This record is part of the audited change set. After the change is committed, replace the pending final commit field and update the audit index without rewriting the technical history below.

## Executive Summary

XCompiler's plan-driven, monolithic execution engine was replaced by a canonical domain model and dependency scheduler. Runtime remains the only business entry point. CLI and ACP remain adapters. Project, Phase, Step, Ticket, evidence, quality, reports, logs, and audit events are persisted as globally identified domain objects.

The refactor removed the previous `src/core/engine.ts`, its lifecycle helper tree, the old Ticket store/schema, duplicate workflow states, historical retry fields, and partial-run switches. A new `application/domain/infrastructure` structure now owns execution orchestration, business invariants, and persistence respectively.

The implementation was validated through a final run of all 63 test files and 628 tests, followed by Node 24 builds, native-package Doctor and CLI smoke tests, real OpenAI-compatible provider routing, package-content validation, SVG/XML validation, diff whitespace validation, and credential scans.

## Change Drivers

The previous design had accumulated several structural risks:

- `engine.ts` combined scheduling, retries, quality checks, debugging, audit repair, Ticket mutation, Git evidence, and phase transitions.
- Step state existed in both Planner artifacts and execution projections, allowing stale status and skipped-stage behavior.
- Bug, enhancement, and change-request responsibilities were distributed across unrelated helpers.
- Failure rollback could resume the wrong Step or rerun already applied downstream changes.
- Debug Wiki entries could be written before a fix had passed downstream verification.
- Human-readable Step keys such as `P1-S004` were used too close to identity and persistence concerns.
- Multi-Phase plans could materialize too much work at once and overwrite prior Phase history.
- Runtime recovery depended on positional plan state instead of canonical object relationships.

## Approved Architecture

```text
CLI / ACP / future adapters
            |
            v
     XCompiler Runtime
            |
            v
 Application execution services
            |
            v
 Domain model + scheduler + Ticket workflow
            |
            v
 Repository + append-only object registry
            |
            v
 .xcompiler/objects + registry events/index
```

The architectural boundaries are:

- Runtime is the sole use-case entry point.
- Adapters parse, interact, render events, and map errors; they do not schedule domain work.
- Application services orchestrate attempts and translate Planner DTOs into domain commands.
- Domain modules own state transitions, dependency rules, V-model pairing, quality policy, and Ticket behavior.
- Infrastructure modules own object storage, registry replay, revision checks, and integrity validation.
- Planner JSON is an input specification and human projection, not the execution state authority.

## Identity and Persistence Decisions

Every persisted object now carries an immutable UUIDv7 `id`, a human-readable `name`, an `objectType`, a canonical `projectId`, schema/revision data, and timestamps. `name: "P1-S004"` replaced the former `key` convention. Names are display labels and are never foreign keys.

Canonical object types are:

```text
project, phase, step, ticket, plan, kpi, checkpoint, deliverable,
quality-assessment, report, changelist, log, audit-event
```

Persistence layout:

```text
phasePlan.json                         Planner Phase outline
plan.P<N>.json                         active Planner Phase specification
<project>.xc                          project manifest with canonical projectId
.xcompiler/registry/events.jsonl       append-only registry source
.xcompiler/registry/index.json         rebuildable lookup projection
.xcompiler/objects/<type>/<uuid>.json  canonical domain objects
docs/project-development-report.P<N>.md
docs/project-development-report.md
```

Registry writes validate global ID uniqueness, object type, project ownership, revision, location, content hash, and tombstones. The index can be rebuilt from registry events. Parent IDs are authoritative; reverse relationships are projections.

## Canonical Domain Model

### Project

Project owns the topic digest, language, intent, project type, ProjectPlan reference, ordered Phase IDs, active Phase, project KPI/quality, deliverables, checkpoints, reports, and AuditEvent IDs.

Project states:

```text
created -> planning -> in_progress -> delivered -> closed
                         |               |
                         v               v
                       pending         planning
```

Cancelled or delivered Projects can re-enter planning only through explicit transitions. Incremental development preserves the existing Project and ProjectPlan UUIDs and appends newly rebased Phases.

### Phase

Phase is one iteration, not a synonym for a V-model Step. It owns an objective, dependencies, one Epic, its Plan, the ordered Step IDs, Phase KPI/quality, deliverables, checkpoints, reports, scope, and verification gate.

Future Phases remain skeletal. Only the active Phase is materialized. A Phase cannot enter execution or delivery states without its eight Steps.

### Step

Each materialized Phase contains exactly this V-model sequence:

1. `REQUIREMENT_ANALYSIS`
2. `HIGH_LEVEL_DESIGN`
3. `DETAILED_DESIGN`
4. `CODING`
5. `UNIT_TEST`
6. `INTEGRATION_TEST`
7. `SYSTEM_TEST`
8. `ACCEPTANCE_TEST`

Paired verification routes are:

```text
CODING              <-> UNIT_TEST
DETAILED_DESIGN     <-> INTEGRATION_TEST
HIGH_LEVEL_DESIGN   <-> SYSTEM_TEST
REQUIREMENT_ANALYSIS <-> ACCEPTANCE_TEST
```

Step states are `created`, `in_progress`, `pending`, `delivered`, `reopened`, and `closed`. A verified upstream Change Request may explicitly reopen a closed Step. Completion is based on persisted quality evidence and delivery state, not array position.

Step attempts use `attempts` and adaptive `maxAttempts`. Planner input was renamed from `maxRetries` to `maxAttempts`. Complexity provides the lower bound: simple work starts at 3 attempts, moderate at 5, complex at 8, with a bounded multi-Phase increment. Inner LLM tool-loop limits remain separate configuration.

### Ticket

Ticket types are:

- `epic`: owns one Phase outcome.
- `story`: owns one V-model Step or delivery outcome.
- `task`: planned work below a Story, with at most two task levels.
- `bug`: incorrect behavior or failed execution/test/gate; enters Debug.
- `enhancement`: missing capability, incomplete tests, or quality shortfall.
- `change-request`: carries a verified upstream change through affected downstream Steps.

Ticket priority is an integer from 0 through 255. Ticket states are `created`, `in_progress`, `pending`, `resolved`, `reopened`, `cancelled`, and `closed`. Bug, Enhancement, and Change Request Tickets require a verified solution before resolution.

## Planning and Iteration Flow

1. Build clarifies the topic, including project type and language when the LLM cannot infer them.
2. Planner assesses complexity and decides whether one or multiple Phases are required.
3. Planner writes the high-level `phasePlan.json` first.
4. Only the dependency-ready active Phase is decomposed into `plan.P<N>.json`.
5. The planning compiler creates the Project graph, Phase Epic, eight Step Stories, Tasks, KPI, deliverables, and V-model pairings.
6. Runtime executes the active Phase through the domain scheduler.
7. A closed Phase advances both `Project.currentPhaseId` and `ProjectPlan.activePhaseId` atomically at the workflow level.
8. The next dependency-ready skeletal Phase is materialized only when execution reaches it.
9. Incremental build requires a closed Project and closed predecessor Phase/Epic, preserves IDs, and appends Phase history instead of replacing it.

Crash recovery also handles the boundary where a previous Phase closed but the next Planner Phase had not yet been materialized. Runtime first persists the new Phase plan, then updates canonical references, preventing a manifest from pointing to a missing plan.

## Failure, Debug, and Change Propagation

### Bug Flow

1. A stage error or failing test/gate creates a Bug with the full phase/step identity, concise failure summary, raw evidence reference, tool/exit/status information, target source Step, and verification Step.
2. The Bug blocks the affected Story and routes to the paired source Step.
3. Debugger must provide a repair approach before or with the repair.
4. The source repair records a Changelist, commit/evidence, verification result, and proposed solution.
5. For requirement, high-level design, or detailed design changes, the repair opens a Change Request instead of restarting full downstream development.
6. The Bug remains active while the Change Request is implemented.
7. Only after every affected downstream Step passes does the Change Request close, the Bug solution become verified, and the Bug close.

### Nested Change Request Failure

If a Change Request fails in a downstream Step:

- a child Bug is created with the parent Change Request as causation and parent context;
- the parent Change Request and target Story are blocked;
- the child Bug routes to the paired source Step;
- the source repair opens a child Change Request linked through `parentChangeRequestId`;
- the child repair is verified first;
- the parent Change Request resumes only affected Steps not already recorded in `applications`.

This prevents both silent retry loops and duplicate downstream implementation.

### Enhancement Flow

Completeness, upstream alignment, test completeness, or KPI/tolerance shortfalls create Enhancement Tickets. Enhancements add only the missing scope and retain their source quality assessment or Bug relationship. They are not used to carry an upstream contract change; that remains the responsibility of Change Request.

### Debug Wiki Flow

Debug Wiki candidates may be retrieved during Debug, but no positive solution is persisted at source-patch time. Candidate IDs remain on the Bug. A verified resolution is written or updated only after all affected Change Request Steps pass and the source Bug closes. Failed reused entries receive negative feedback. A startup synchronizer repairs the narrow crash window between Bug closure and Wiki persistence.

## Quality and Delivery Gates

- Development Steps validate completion and alignment with upstream artifacts.
- Verification Steps validate test artifacts before execution, then run their corresponding gates.
- Unit Test supports line/branch coverage KPI.
- Integration Test supports interface and dependency integration coverage.
- System Test supports module/system scenario coverage.
- Acceptance Test supports requirement and functional coverage.
- KPI observations are immutable; quality assessments are persisted first-class objects.
- A failed test creates a Bug. A shortfall without incorrect behavior creates an Enhancement.
- Phase and Project delivery reports are persisted as Report objects and linked back to their owner.
- A Phase closes only after all eight Step gates and delivery Tickets close.

## Runtime and Adapter Integration

- `runCompile` and `runExecute` use the canonical repository and domain execution engine.
- Runtime lifecycle events include project, Phase, Step, and Ticket IDs plus correlation/causation IDs.
- CLI no longer contains partial-run state controls.
- ACP request-to-Runtime mapping remains adapter-only; ACP session IDs do not enter the domain model.
- Runtime writes no terminal output directly. CLI and ACP map Runtime events to their own presentation/protocol forms.
- Runtime errors, file changes, patch proposals, tool calls, permissions, and results remain observable by adapters.

## Removed Legacy Implementation

The following production implementation was removed rather than retained behind compatibility branches:

- `src/core/engine.ts`
- `src/core/ticket.ts`
- `src/core/debug_cache.ts`
- `src/core/debug_policy.ts`
- all previous `src/core/engine/*` lifecycle modules, including attempt policy/environment, Bug, Enhancement and Change Request helpers, work-ticket graph/lifecycle, audit repair, debug prompt/Wiki feedback, repair artifacts, failure presentation, and old validators

The obsolete engine-, ticket-, debug-cache-, debug-policy-, workflow-state-, and old runtime-recovery-focused tests were removed. Replacement coverage lives in the domain model, registry, compiler, scheduler, Ticket workflow, and domain execution engine test suites.

Removed public behavior/configuration:

- `run --from`
- `run --phase`
- `run --reset`
- old force-reset semantics; `--force` is now lock handling only
- `agent.max_steps`
- `agent.max_debug_retries`
- `agent.max_debug_retries_cap`
- Planner `retries` and `maxRetries` execution projections
- obsolete Engine internationalization messages without active callers

## New Source Ownership

New application modules:

```text
src/application/execution/domain_engine.ts
src/application/execution/attempt_runner.ts
src/application/execution/execution_context.ts
src/application/execution/execution_adapter.ts
src/application/execution/test_phase_validator.ts
src/application/execution/v_model_policy.ts
```

New domain modules cover identity, envelopes/references, Project, Phase, Step, Plan, Ticket/workflow, quality, evidence, observability, graph validation, scheduler, role, and pending reason under `src/domain/`.

New infrastructure modules provide the canonical object repository and append-only registry under `src/infrastructure/`. The new architecture contains 5,372 source lines across `application`, `domain`, and `infrastructure` at audit time.

## Compatibility Boundary

This was explicitly approved as a clean refactor without legacy persistence compatibility.

- Existing CLI command names `build` and `run` remain.
- Existing configuration and terminal behavior are preserved where they do not contradict the canonical model.
- Old `.toaa` files and `.toaa` audit directories remain unsupported from earlier migrations.
- Old persisted Ticket/Engine state is not read or migrated.
- A project containing an unsupported old `.xc`/`.xcompiler` domain schema must be rebuilt from its topic and supported source artifacts.
- Old state must never be merged into the new object registry.

## Validation Evidence

### Final Successful Regression

| Gate | Result |
| --- | --- |
| `npm run version:check` | Passed; core `0.2.4`, plugin API `1` |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | Passed; 63 files, 628 tests |
| `npm run build` | Passed; Node 24 CLI, Runtime, ACP, Plugin JavaScript and declarations |
| Built CLI smoke test | Passed; reported `0.2.4` |
| `npm pack --dry-run --json` | Passed; 41 files, 3,792,510 bytes packed, 14,428,769 bytes unpacked |
| SVG/XML validation | Passed for both architecture diagrams |
| Git whitespace validation | Passed |
| Credential scan | Passed; only the intentional OpenRouter redaction regex matched |

The package preview included Runtime, ACP, CLI, Plugin outputs, system/Agent Debug Wiki seeds, configuration examples, README files, architecture assets, and user documentation. It did not include local configuration, generated-project audit state, or credentials.

### Failed Validation Attempts and Resolution

The first complete test run in the restricted filesystem/network sandbox reported 36 failures across four files:

- `tests/cli_arguments.test.ts` contained two real obsolete assertions for removed `parsePhase` and `parseStepId` functions. The assertions and imports were deleted; the current CLI argument test then passed.
- `tests/net.test.ts`, `tests/ollama_stream.test.ts`, and `tests/openai_stream.test.ts` could not bind `127.0.0.1` and failed with `listen EPERM`. This was classified as an execution-environment restriction, not hidden or skipped.
- The three local HTTP suites were rerun outside that restriction and all 39 tests passed.
- The entire suite was then rerun once in the same valid environment and all 623 tests passed.

During implementation, targeted tests also exposed and fixed:

- a Change Request Step being executed again after an application Changelist already existed;
- a Story remaining blocked after a child Bug of a Change Request closed;
- Debug Wiki persistence happening before downstream verification;
- Phase transition recovery not advancing Project and ProjectPlan together;
- incremental PhasePlan output replacing prior completed Phase rows;
- CR-mode failure retrying without producing a linked Bug and child Change Request;
- missing first-class Ticket-to-Log persistence coverage.

Native package qualification subsequently exposed and fixed two additional Doctor defects:

- OpenAI-compatible endpoint failures were not retained for role coverage, so a failed provider probe could still be displayed as a live role candidate. Doctor now carries the probe result into every role decision and reports no live provider when all candidates fail.
- The macOS `pkg` executable could fail a bare `spawn("node")` even when Node was installed, while Doctor collapsed every non-zero result into a misleading "not found on PATH" message. Host commands are now resolved to absolute executable paths before spawning, and failures preserve bounded stderr/stdout or exit details.

Real clarification traffic exposed two related provider-routing defects:

- A provider response that reached the service but failed the Planner output contract was immediately scored down and routed to the next model. The router now gives the same provider one bounded correction attempt with the exact validation error and its prior response before fallback.
- Project-shape validation inspected only the question and rationale while ignoring the prioritized answers. A valid generic question whose answers explicitly offered CLI, API library, and mixed delivery was therefore rejected. The validator now evaluates the question, rationale, and all option answers consistently.

The rebuilt macOS ARM64 package was exercised against the configured OpenRouter route. DeepSeek took approximately 81 seconds to produce its first token, then returned ten valid clarification questions and remained the selected Planner provider; no Qwen request or fallback occurred. This confirms that slow first-token latency, provider availability, and response-contract validity are now handled as separate concerns.

Terminal qualification also found that Executor progress labels rendered the canonical Step UUIDv7 after the domain migration. Runtime execution now passes the human-readable Step `name` separately to Executor and outward tool events. CLI model/tool progress and ACP tool titles use that display name, while audit, permission, and protocol correlation continue to retain the canonical UUID in `stepId`.

The repaired macOS ARM64 package was rebuilt and ad-hoc signed. Its formal Doctor run passed all configured OpenRouter providers, including `deepseek/deepseek-v4-flash`, all five role routes, Python, Node 24, npm, npx, and Skill checks with exit code 0. The release archive was separately inspected and contains only `config.example.yaml` and `.env.example`; local `config.yaml` and `.env` were restored to the validation directory only after archive creation.

## Security and Data Handling

- No API key, token, private endpoint, or generated-project content was written to this audit.
- Repository credential scanning found no secret value.
- Local provider credentials remain environment/local-config responsibilities and are excluded from the package.
- Object registry paths are fixed beneath `.xcompiler/objects`; workspace tool path gates remain independent of the domain refactor.
- AuditEvent and DomainLog payloads carry structured summaries and references; raw high-volume evidence remains external to concise Ticket context.

## Recovery and Backup Procedure

### Restore the pre-refactor implementation

Use the baseline commit `6ac42db1712797757fb69f560c989b42792f65d5` in a separate checkout or worktree. Do not point that binary at a workspace already converted to the new canonical registry.

### Restore the refactored implementation

After the final commit is recorded above, restore that commit, install dependencies, run the version/type/lint/test/build gates, and load the project through its `.xc` manifest. Registry index loss can be repaired by replaying `.xcompiler/registry/events.jsonl`; canonical objects remain under `.xcompiler/objects/`.

### Restore a generated project

- Preserve the topic/source requirements, `.xc` manifest, `phasePlan.json`, `plan.P<N>.json`, registry events, canonical objects, Debug Wiki, project reports, and source-control history together.
- Verify registry content hashes before resuming.
- If only the registry index is missing, rebuild it from events.
- If canonical objects or event history are inconsistent, stop and restore the full project snapshot; do not infer missing state from human-readable plan status.
- Rebuild projects using unsupported legacy schemas rather than partially importing them.

## Residual Risks and Follow-up Controls

- Cross-Phase crash recovery has static checks and surrounding runtime coverage, but should remain part of future real-project qualification.
- Debug Wiki persistence has startup compensation; storage failures still surface as Runtime errors and must remain visible.
- Registry and canonical object files should be backed up as one consistency unit.
- Future adapters must call Runtime and preserve correlation/causation IDs.
- Any new Ticket type must define schema, lifecycle, scheduler readiness, reporting, audit impact, and tests together.
- Any future state shortcut or partial-run feature requires a separate architecture decision and must not bypass domain gates.

## Acceptance Checklist

- [x] Runtime is the sole business entry point.
- [x] IDs are globally unique UUIDv7 values; `name` is display-only.
- [x] Project, Phase, Step, Ticket, and evidence objects have single state owners.
- [x] Each active Phase executes all eight V-model Steps.
- [x] Bug, Enhancement, and Change Request semantics are distinct.
- [x] Bugs remain open until downstream Change Request verification completes.
- [x] Nested Change Request failure is traceable and resumable.
- [x] Debug Wiki only receives verified resolutions.
- [x] Incremental development preserves canonical Project identity and Phase history.
- [x] Registry replay and integrity verification are covered.
- [x] Old persistence and execution compatibility paths were removed.
- [x] Full regression, build, package preview, and security checks passed.
- [ ] Final refactor commit hash recorded after maintainer commit.

## Related Evidence

- [Domain refactor plan](../archive/domain-refactor-plan.md)
- [Current architecture design](../XCompiler_design.md)
- [Runtime architecture diagram](../assets/system-architecture.svg)
- [Iterative V-model diagram](../assets/iterative-v-model-pipeline.svg)
- [Deployment and recovery guide](../deploy.md)
- [Plugin API guide](../plugin_api.md)
