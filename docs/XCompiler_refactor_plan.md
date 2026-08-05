# XCompiler 0.3 Architecture Refactor Plan

Status: review draft  
Target release: v0.3.0  
Scope: architecture, execution governance, testing infrastructure, and release baseline  
Compatibility policy: intentionally breaking; no backward-compatibility layer

## 1. Purpose

This document consolidates the following preliminary proposals into one executable refactor plan:

- `XCompiler_完整重构计划.md`
- `XCompiler_PM治理层重构计划_基于当前项目.md`
- `XCompiler_网络模块与分层测试重构计划_基于当前项目.md`

It is based on the current v0.2.4 repository after the Runtime/Domain/Ticket refactor. It replaces the
three drafts as the planning source for the next major release, while preserving those drafts as design
inputs and historical records.

This refactor has four primary outcomes:

1. Establish one canonical domain model and one state-transition authority.
2. Make the PM role actively drive project progress through Runtime/Application commands.
3. Decompose the execution kernel and planning pipeline into maintainable modules.
4. Introduce structured test outcomes and a generic record/replay facility.

## 2. Decisions

### 2.1 Major release without backward compatibility

The refactor targets v0.3.0 and does not preserve compatibility with earlier internal or persisted formats.

- Remove deprecated schemas, aliases, translation layers, legacy command paths, and compatibility code.
- Do not dual-read or dual-write old and new Project, Phase, Step, Ticket, Plan, Event, or config formats.
- Existing workspaces must be rebuilt from their topic/requirements with v0.3.0.
- Invalid old state must fail fast with a clear version error; it must not be silently upgraded.
- Release notes document breaking changes, but the Runtime does not carry migration logic.
- CLI names may remain where they still match the product design, but their compatibility is not a gate.
- Public Runtime and ACP contracts are redesigned and versioned as 0.3 contracts.

This policy is intended to remove architectural debt rather than move it into permanent adapters.

### 2.2 Runtime remains the only business entry

CLI, ACP, future REST, GUI, and SDK adapters call Runtime only. They do not directly invoke Planner,
Scheduler, Agent, Tool, Sandbox, Repository, Plugin, Memory, or PM internals.

Runtime exposes application use cases and events. It does not own terminal rendering, protocol framing,
or process exit behavior.

### 2.3 PM actively drives progress

PM means Project Manager. It is a first-class application role responsible for project initiation,
planning, scope and schedule baselines, role and resource coordination, Ticket management, risk and
change control, quality gates, stakeholder interaction, delivery, and closure. PM actively drives the
Project, every implementation Phase, and every V-model Step toward delivery.

All executable roles register with PM during Runtime initialization. PM creates only project-context
`Epic` and V-model `Story` Tickets. Every other Ticket is created by the actor or gate that discovered the
work and therefore owns its technical context. The completed Ticket is submitted to PM before it can be
routed or executed. PM registers, routes, assigns, and monitors it without inventing or rewriting its
technical content. Ticket ownership belongs to the assigned processor, while PM retains project-level
monitoring, reassignment, escalation, and administrative closure authority.

PM is not a second workflow engine and is not a second source of truth:

- Domain state machines remain the only authority for valid transitions.
- PM can act only through typed Runtime/Application commands.
- PM cannot directly edit Project, Phase, Step, Ticket, Registry, files, tests, or audit records.
- PM cannot perform requirement, architecture, coding, integration, testing, or Debug work on behalf of
  the registered professional role.
- Deterministic policy is evaluated before optional LLM advice.
- Sensitive or high-risk decisions are routed through persistent human interaction.
- Every PM decision records authority, rationale, evidence, confidence, correlation, and outcome.

### 2.4 PM caches project state as a rebuildable projection

PM maintains a project-state cache to avoid repeatedly loading and reconstructing the full object graph.
The cache is a projection, never canonical state.

- Cache keys include Project ID, object revision, and projection schema version.
- Cache entries include current Phase/Step/Ticket, blockers, quality status, pending interactions, budgets,
  recent failure fingerprints, and available actions.
- Domain commits publish events through an outbox; PM consumes them to update or invalidate projections.
- A revision mismatch invalidates the cache and triggers reconstruction from Repository state.
- Restart recovery rebuilds the cache from persisted objects and the outbox cursor.
- Cache loss must affect performance only, never correctness.
- Cache records must not contain unredacted secrets, full LLM transcripts, or unbounded logs.

### 2.5 Generic record/replay for tests

Record/replay is implemented as a generic infrastructure capability around external-interaction ports,
not as HTTP-specific logic embedded in test steps.

Initial channels are:

- HTTP and external API calls.
- LLM provider requests and responses.
- Tool calls whose results depend on external state.
- Subprocess interactions selected by an explicit test contract.

Recording is an explicit fixture-preparation action. Verification stages replay existing records and must
not silently contact live services or rewrite fixtures.

## 3. Current Repository Assessment

The latest Domain refactor provides useful foundations:

- UUID-based global object identity and Registry mapping.
- Canonical Project, Phase, Step, Ticket, KPI, assessment, evidence, report, and audit objects.
- Ticket-driven Bug, Enhancement, and Change Request recovery.
- Runtime as the CLI and ACP business entry.
- DomainExecutionEngine, DomainAttemptRunner, DomainScheduler, and DomainObjectRepository.

The next refactor must address the following structural problems before adding enforced PM governance.

### 3.1 Dual V-model terminology

The execution plan uses `CODE`, `MODULE_TEST`, and `FUNCTIONAL_TEST`, while the Domain model uses
`CODING`, `SYSTEM_TEST`, and `ACCEPTANCE_TEST`. Compiler and execution adapters translate between them.
This creates two semantic authorities for routing, KPI names, audit records, prompts, and public events.

Version 0.3 uses one canonical sequence everywhere:

```text
REQUIREMENT_ANALYSIS
HIGH_LEVEL_DESIGN
DETAILED_DESIGN
CODE
UNIT_TEST
INTEGRATION_TEST
MODULE_TEST
FUNCTIONAL_TEST
```

### 3.2 Domain depends on Infrastructure

DomainScheduler, TicketWorkflow, QualityAssessmentService, and DomainAuditTrail directly depend on the
concrete DomainObjectRepository. Persistence-aware orchestration belongs in Application; Domain should
contain pure objects, transitions, invariants, and policies.

### 3.3 Persistence is not an aggregate transaction

Domain objects and Registry entries are committed one by one. A partial write can leave the graph and
registry inconsistent. Version 0.3 requires a UnitOfWork boundary, optimistic revision checks, atomic commit, and
an event outbox committed with the same logical transaction.

### 3.4 Execution and planning modules remain oversized

Executor, Planner, Runtime Build/Run, Scheduler, AttemptRunner, and Router combine policy, parsing,
orchestration, infrastructure calls, and presentation-oriented feedback. Splitting is based on cohesion,
dependency direction, test isolation, and change frequency; fixed line-count limits are not used.

### 3.5 Test and network results are weakly structured

Exit codes and text matching cannot reliably distinguish product failures, test assertion failures,
environment restrictions, unavailable services, denied capabilities, and incomplete evidence. This also
causes restricted local-network environments to look like product regressions.

### 3.6 Current Phase, V-model, and PM control audit

Phase and V-model execution are still present in the current implementation:

- Project stores `phaseIds` and `currentPhaseId`; each Phase stores its plan, Epic, Steps, quality, and
  delivery gate.
- The Domain plan compiler requires one complete eight-Step V-model for the active Phase and creates the
  paired Step/Story graph.
- Step and Ticket dependencies preserve V-model execution order and corrective routing.
- Runtime materializes the current Phase and prepares the next Phase plan after delivery.

They are not currently driven by PM. Runtime constructs DomainExecutionEngine; the engine owns the
project-driving loop; DomainScheduler selects, starts, routes, delivers, and closes work, then directly
updates Project `currentPhaseId` or closes the Project. The existing `project-manager` role is only a
static role value used by generated management/delivery Tickets. There is no PM actor, role registry,
Ticket intake, assignment, project projection, or PM command loop yet.

The 0.3 refactor preserves Phase and the V-model but transfers project-level progression from Runtime,
DomainExecutionEngine, and DomainScheduler to PMOrchestrator. Domain retains transition validation and
readiness calculation.

## 4. Target Architecture

```text
CLI / ACP / Future Adapters
            |
            v
      Runtime Facade
            |
            v
   Application Use Cases
      |       |       |
      |       |       +---- Persistent Interaction Service
      |       +------------ PM Governance / Decision Port
      +-------------------- Build / Run / Inspect / Resume
            |
            v
 Pure Domain Model and Policies
 Project / Phase / Step / Ticket / Quality / V-model / Transition Rules
            ^
            |
 Application Ports
 Repository / UnitOfWork / EventOutbox / LLM / Tool / Sandbox / Clock / ID
            ^
            |
 Infrastructure Adapters
 File Repository / Registry / Providers / Tools / Git / Sandbox / RecordReplay
```

Dependency direction is always inward:

- Adapters depend on Runtime contracts.
- Runtime depends on Application use cases.
- Application depends on Domain and port interfaces.
- Infrastructure implements ports and depends on Domain contracts where necessary.
- Domain does not import Application, Runtime, Infrastructure, CLI, ACP, LLM, Tool, or Sandbox modules.

## 5. Canonical Domain and State Authority

### 5.1 Project hierarchy

```text
Project
  -> Phase[]
      -> Step[]
          -> Ticket[]
```

Project, Phase, Step, and Ticket state can change only through domain transitions invoked by application
commands. Direct object rewrites are forbidden.

Project management follows this control cycle:

```text
initiate -> baseline -> authorize Phase -> receive/route Tickets -> monitor/control
         -> verify Phase gate -> advance Phase -> deliver -> close and review
```

Monitoring and control run continuously; they are not a second sequential workflow state machine.

### 5.2 Ticket semantics

- `epic`: owns a Phase and completes when all required V-model work and delivery work close.
- `story`: represents one canonical V-model Step.
- `task`: a bounded unit under an Epic or Story.
- `bug`: a reproducible execution or verification defect routed through Debug.
- `enhancement`: missing functionality, incomplete tests, or a quality/KPI shortfall.
- `change-request`: carries an accepted upstream change through affected downstream Steps.

Bug, Enhancement, and Change Request retain separate impact statistics and model-scoring effects.

Ticket creation authority follows context:

- PM creates Phase `Epic` and V-model `Story` Tickets from the approved Project/Phase plan.
- A professional role creates a `Task` when it discovers bounded work inside its assigned context.
- An execution or verification actor creates a `Bug` from the failure context and evidence it observed.
- A quality/alignment gate creates an `Enhancement` from the measured gap it observed.
- The actor accepting an upstream contract delta creates a `Change Request` with affected artifacts,
  downstream Steps, implementation guidance, and verification gates.

An executing role never receives an unregistered Ticket directly. The discovering source creates the
canonical Ticket and submits it in a `TicketSubmission` envelope to PM. PM validates that routing fields,
dependencies, evidence, acceptance, and creator identity are complete, registers it in the PM projection,
selects an eligible actor, and creates a `TicketAssignment`. PM may reject an incomplete or duplicate
submission back to its creator, but it cannot silently merge, reclassify, or manufacture missing technical
context. The assignment preserves claim, decline, release, reassignment, completion, and escalation history.

Ticket work state and assignment state are separate. A Ticket cannot enter `in_progress` without an
accepted active assignment. The assignee may start, pause, and propose resolution; PM may route,
reassign, escalate, cancel, and close after the required verification gate passes.

### 5.3 Append-only Ticket trace chain

Every Ticket owns a typed append-only trace stream. The stream records who discovered, submitted,
registered, routed, accepted, processed, handed off, verified, reopened, and closed the Ticket. It is the
canonical history for ownership and flow analysis; mutable Ticket summaries and PM cache entries are only
projections.

Each immutable `TicketTraceEvent` contains:

- Ticket, Project, Phase, Step, correlation, causation, and assignment IDs.
- Monotonic per-Ticket sequence number.
- Event type and reason code.
- Initiating actor and role.
- Previous and next owner/processor when ownership changes.
- Previous and next Ticket/assignment state when applicable.
- Evidence references and routing/decision references, without embedding unbounded raw logs.
- Occurrence time, previous event ID/hash, and the current event hash.

Initial event types include `created`, `submitted`, `registration_rejected`, `registered`, `routed`,
`assignment_proposed`, `accepted`, `declined`, `started`, `pending`, `resumed`, `handed_off`, `reassigned`,
`escalated`, `resolution_proposed`, `verified`, `resolved`, `closed`, `reopened`, `cancelled`, and
`correction`.

Append rules:

- Trace events support insert/append only; Repository update and delete operations reject them.
- Append uses an expected last sequence/hash to prevent concurrent forks or overwritten history.
- Sequence numbers are contiguous for each Ticket.
- A correction appends a new event referencing the incorrect event; it never edits history.
- Ticket/assignment state transitions and their trace append commit in one UnitOfWork.
- Chain integrity is verified during load, PM cache rebuild, project delivery, and audit.
- Secrets, credentials, full prompts, and raw external responses are forbidden; use redacted evidence refs.

Ticket stores only bounded trace metadata such as first/last event ID, event count, and chain hash. The
full event IDs are indexed by `TicketTraceStore`, avoiding an unbounded mutable array inside Ticket.

`TicketFlowMetrics` is rebuilt from this stream and may include:

- Submission-to-routing and routing-to-acceptance latency.
- Queue time, active handling time, blocked time by reason, cycle time, and delivery lead time.
- Handoff/reassignment/decline count and first-assignment success rate.
- Reopen, failed-verification, escaped-defect, and Change Request propagation rates.
- Mean time to acknowledge, repair, verify, and close Bugs.
- Actor capacity, concurrent load, throughput, aging work, and SLA breach count.
- Phase bottlenecks, forecast variance, and routing confidence.

Optimization must combine speed, complexity, severity, quality, reopen rate, and blocked-time attribution.
Raw speed or Ticket count alone must not change an actor/model score. Small samples carry low confidence,
and only verified/closed outcomes may affect routing quality or LLM scoring.

### 5.4 Failure routing

- Infrastructure/provider failure: keep the current Ticket active or pending; do not create a Bug.
- Reproducible product/test failure: the discovering actor creates a Bug and PM routes it to the paired source role.
- Completion, alignment, or tolerance shortfall: the detecting gate creates an Enhancement and PM routes it.
- Accepted upstream correction affecting downstream contracts: the accepting actor creates or extends a
  Change Request and PM routes each affected application.
- A failed Change Request creates a linked Bug or Enhancement; it does not restart full development.
- Bug solutions enter Debug Wiki only after verification and Ticket closure.

### 5.5 Versioned events

Domain and Runtime events use a common envelope:

```text
eventId
eventVersion
eventType
occurredAt
projectId
phaseId?
stepId?
ticketId?
correlationId
causationId?
objectRevision?
payload
```

Domain events are persisted through the outbox. Runtime events are stable projections for adapters.

## 6. PM Project Management Design

### 6.1 Project management lifecycle

Build covers project initiation and planning. Run covers execution, monitoring/control, delivery, and
closure. PM owns the management cycle across both commands:

1. Establish the project charter, objective, scope, success criteria, constraints, and stakeholders.
2. Baseline implementation Phases, milestones, dependencies, quality gates, resources, and budgets.
3. Register professional roles and verify that required capabilities are available.
4. Authorize the current Phase and its Epic after dependency and readiness checks.
5. Receive each source-created Ticket, validate its registration data, and route it to an eligible processor.
6. Monitor progress, blockers, risk, quality, cost, retries, and schedule variance.
7. Control changes, escalation, replanning, and persistent user decisions.
8. Verify the Phase gate, close its Epic, and authorize the next Phase.
9. Verify final delivery, produce the project report, close the Project, and record lessons learned.

### 6.2 Role registration and capability routing

Each Runtime role registers an actor instance with PM before project execution. Registration contains:

- Actor ID, role type, execution Agent/model route, and registration revision.
- Structured capabilities and supported Step/Ticket types.
- Availability, capacity, concurrency, and current assignments.
- Quality, reliability, cost, and latency observations used as bounded routing signals.
- Constraints, required permissions, and temporary unavailability reason.

Routing uses structured Ticket requirements, not keyword matching. The deterministic order is eligibility,
required capability, dependency readiness, availability/capacity, project priority, quality/reliability,
cost, and a stable tie-breaker. PM records every candidate set, routing reason, and assignment result.

### 6.3 Ticket registration, routing, ownership, and control

Every source Phase, V-model Step, test gate, quality gate, Debug result, and Change Request submits its
already-created Ticket to one PM registration port. PM creates only Project/Phase Epic and V-model Story
Tickets. PM is the only application service allowed to register a submitted Ticket for dispatch and to
assign it to an actor.

```text
Discovering actor/gate creates canonical Ticket with context and evidence
  -> TicketSubmission to PM
  -> validate creator, routing data, dependencies, acceptance, and evidence
  -> register Ticket in PM projection
  -> link dependencies and acceptance gates
  -> select eligible actor
  -> create TicketAssignment
  -> actor accepts and owns execution
  -> PM monitors, reroutes, escalates, or closes
```

The discovering actor owns the submitted context until acceptance; the assigned actor owns execution and
the technical result. PM owns registration, routing, assignment, monitoring, escalation, and administrative
closure. Verification roles own technical verification; PM cannot declare a failed gate successful.

PM must not change a submitted Ticket's type, failure evidence, finding, contract delta, implementation
intent, or verification gate. A required correction is returned to the creator as a rejected registration
with structured reasons.

### 6.4 PM-driven Phase and V-model progression

PM is the only project-level component allowed to request these commands:

- Authorize or resume a Phase.
- Materialize the active Phase plan.
- Dispatch the next dependency-ready V-model Ticket.
- Hold or resume work for a blocker, risk, permission, or interaction.
- Route a Bug, Enhancement, or Change Request to its required role.
- Request a retry-budget extension or replan.
- Submit a Phase for its verification gate.
- Close a Phase Epic and authorize the next Phase.
- Submit the Project for delivery and closure.

Domain policies calculate legal transitions, ready work, pairing, dependencies, and gates. PM selects
among the legal commands and drives the sequence; Executor runs only the Ticket already assigned to it.

### 6.5 PM control records

Standard project management records are persisted and exposed through the PM projection:

- Project charter and management plan.
- Scope, schedule/milestone, quality, and resource/budget baselines.
- Actor registry and responsibility/assignment matrix.
- RAID register: risks, assumptions, issues, and dependencies.
- Change, decision, interaction, and escalation records.
- Status reports, variance, forecast, delivery evidence, and lessons learned.

### 6.6 PM execution loop

PM performs the following continuous loop:

1. Load or rebuild the current project projection.
2. Evaluate blockers, quality, budget, retries, pending interactions, and dependency readiness.
3. Ask deterministic policy for the allowed action set.
4. Optionally ask PM Advisor for a ranked recommendation.
5. Resolve authority, confidence, and risk.
6. Execute one typed Application command or create a persistent interaction request.
7. Observe committed events and update the state cache.
8. Continue until delivered, cancelled, or waiting for an external decision.

### 6.7 Decision ports

Decision points are explicit and limited to:

- Before dispatching the next Ticket.
- After an attempt result is classified.
- Before a state transition with multiple valid routes.
- Before a retry-budget extension or replan.
- Before a sensitive operation or external interaction.
- Before final project delivery.

### 6.8 Decision authority

Decision resolution order:

1. Domain invariant.
2. Deterministic governance policy.
3. User-approved project policy.
4. PM Advisor recommendation.
5. Persistent human approval when required.

An LLM recommendation can never override a domain invariant, denied capability, or failed required gate.

### 6.9 Governance modes

- `disabled`: existing Runtime behavior without PM decisions.
- `observe`: PM computes and records decisions but cannot change execution.
- `advisory`: PM recommends; Runtime or user confirms actions.
- `enforced`: PM may execute explicitly authorized low-risk actions.

Implementation progresses through these modes in order. Enforced mode is not the initial 0.3 default.

### 6.10 Persistent interaction

Long-running PM decisions use a persisted Interaction object with revision, status, request, choices,
risk, expiry policy, response, and correlation IDs. CLI and ACP are adapters over the same service.
Restarting XCompiler must preserve pending approvals and allow safe continuation.

### 6.11 PM capability boundary

PM owns:

- Project initiation, charter, baselines, Phase authorization, and closure.
- Role registration, capacity monitoring, Ticket registration, routing, assignment, and escalation.
- Progress, dependency, schedule, resource/budget, RAID, change, quality-gate, and delivery monitoring.
- Selection among commands already permitted by Domain policy.
- Persistent stakeholder decisions, status reports, forecasts, and lessons learned.

Domain owns:

- Project, Phase, Step, Ticket, assignment, quality, and management-record invariants.
- Legal state transitions, dependency readiness, V-model pairing, gate requirements, and ownership checks.
- Rejection of commands that violate lifecycle, assignment, evidence, or quality rules.

Professional roles own:

- Requirements Engineer: requirement analysis and acceptance-test assets.
- System Engineer/Architect: system and detailed design plus paired module/integration assets.
- Developer/Debugger: code, unit-test assets, and verified corrective implementation.
- Integrator: integration execution and integration evidence.
- Tester: unit/module/functional verification and independent quality evidence.

PM must not author or rewrite those technical artifacts, execute their tools, falsify evidence, mark a
failed gate as passed, bypass permissions, or route a Ticket to an unregistered/ineligible actor.

## 7. Project State Cache

### 7.1 Projection model

The PM projection contains bounded summaries:

- Project and current Phase status.
- Current and ready Steps.
- Active, blocked, and corrective Tickets.
- Dependency readiness and delivery progress.
- KPI and tolerance summaries.
- Pending interactions and permissions.
- Retry budgets and recent failure fingerprints.
- Ticket trace heads, integrity status, flow metrics, aging, handoff count, and routing confidence.
- Last applied outbox sequence and object revisions.
- Allowed next commands derived by deterministic policy.

### 7.2 Cache consistency

- Repository commit and outbox append form one UnitOfWork.
- Projection updates are idempotent by event ID.
- Events are applied only when the expected object revision matches.
- Gaps or conflicts trigger a complete projection rebuild.
- The projection stores a checksum of its source revisions.
- PM verifies the checksum before executing a command.
- Cache writes are atomic and recoverable after interruption.

### 7.3 Cache storage

The default implementation may use workspace-local persisted projections under `.xcompiler/cache/pm/`.
The location is infrastructure configuration and does not leak into Domain types. An in-memory adapter is
used by unit tests.

## 8. Generic Record/Replay

### 8.1 Port contract

External interactions pass through a `RecordReplayPort` with these logical operations:

```text
execute(channel, request, policy) -> response
lookup(channel, fingerprint) -> record?
record(channel, sanitizedRequest, sanitizedResponse, metadata)
verify(record) -> integrity result
```

Channels use pluggable canonicalizers and serializers. Business code does not read cassette files.

### 8.2 Modes

- `off`: execute normally without recording or replay.
- `record`: execute the real interaction and write a sanitized record.
- `replay`: forbid real interaction and require a matching record.
- `auto`: replay a match; live fallback is allowed only when the test contract explicitly permits it.

Test gates default to `replay` or `off`, never implicit `record`.

### 8.3 Record format

Each record contains:

- Schema version and channel.
- Canonical request fingerprint.
- Sanitized request and response.
- Status, error category, timing, and deterministic metadata.
- Contract and fixture identifiers.
- Created/updated timestamps and source phase.
- Content hash and optional parent record for corrected fixtures.

Headers, keys, tokens, credentials, cookies, and configured secret fields are redacted before persistence.
A fixture containing a secret fails the fixture gate.

### 8.4 Matching and determinism

- Match stable semantic fields, not raw timestamps or random IDs.
- Support configured normalizers for volatile values.
- Detect ambiguous multiple matches and fail explicitly.
- Replay preserves response order and optional deterministic timing.
- A replay miss is `blocked` or `failed` according to the declared contract, never silently skipped.
- Correcting an invalid record creates a new revision and preserves history.

### 8.5 V-model ownership

- S1 Requirement Analysis defines external behavior and live-service expectations.
- S2 High-Level Design selects external APIs/libraries and defines test contracts.
- S3 Detailed Design defines canonicalization, fixtures, stubs, and expected failures.
- S4 Code creates tests and may perform explicit recording through a dedicated preparation command.
- S5-S8 validate and replay existing fixtures; they do not record or mutate fixtures.

## 9. Test and Network Model

### 9.1 Structured test outcome

All test execution returns a structured result:

```text
passed | failed | skipped | inconclusive | blocked | incomplete | denied
```

The result includes command, scope, parsed test counts, coverage/KPI values, evidence references,
capabilities, network mode, record/replay mode, and classified failures.

### 9.2 Network test contract

Each external dependency declares one of:

- `offline`
- `replay`
- `local-stub`
- `live-optional`
- `live-required`

It also declares credentials, endpoint selection policy, readiness checks, fallback behavior, tolerance,
and the verification Steps allowed to use it.

### 9.3 Stage rules

- UNIT_TEST: network off; deterministic local tests only.
- INTEGRATION_TEST: local stub or replay by default.
- MODULE_TEST: replay/local contract tests; live only when explicitly required.
- FUNCTIONAL_TEST: contract-governed end-to-end validation; required live failure blocks delivery.

### 9.4 Sandbox and secrets

Sandbox network policy becomes per execution rather than only per configured instance. Commands receive
an explicit capability set and environment allowlist. Secrets are injected through named bindings and
are never inherited wholesale, written to fixtures, prompts, events, audit logs, or PM cache.

## 10. Module Refactor

### 10.1 Application use cases

Introduce focused use cases for:

- BuildProject
- MaterializePhase
- RunProject
- ResumeProject
- AppendRequirement
- InspectProject
- RespondInteraction
- CancelProject
- RegisterActor
- SubmitTicket
- AssignTicket
- ReassignTicket
- AdvancePhase
- CloseProject
- PrepareFixtures
- ReplayVerification

Runtime composes these use cases and exposes stable 0.3 contracts.

### 10.2 Executor decomposition

Split StepExecutor into:

- Turn schema and parser.
- Prompt/context builder.
- Conversation controller.
- Tool dispatcher and permission boundary.
- Progress and failure ledger.
- Completion and output verifier.
- Tool-result feedback renderer.

StepExecutor remains a small coordinator over these components.

### 10.3 Planner decomposition

Split Planner into:

- Requirement clarifier.
- Project-shape and language resolver.
- Complexity and Phase assessor.
- Phase-plan generator.
- Active-Phase V-model planner.
- Plan validator and structured repairer.
- Domain-plan compiler input adapter.

The planner emits a planning DTO; only the Domain compiler creates canonical objects.

### 10.4 Application orchestration

Move persistence-aware Scheduler, Ticket workflow, quality application service, and audit application
service out of Domain. Replace project-driving loops in Runtime and DomainExecutionEngine with a
`PMOrchestrator`. Keep pure transition, readiness, pairing, and routing-eligibility policies in Domain.

Add focused PM services:

- ProjectInitiationService and ProjectBaselineService.
- RoleRegistry and ResponsibilityMatrix.
- TicketRegistrationService, AssignmentService, and RoutingPolicy.
- ProjectControlService for Phase/V-model progression.
- RiskChangeControlService and InteractionService.
- ProjectProjectionBuilder and StatusReportService.

Keep Ticket creation with its context owner:

- `ProjectWorkTicketFactory` under PM creates only Phase Epic and V-model Story Tickets.
- `TaskTicketFactory` is used by the planning or executing professional role that discovers bounded work.
- `BugTicketFactory` is used by the execution/verification source with raw failure evidence.
- `EnhancementTicketFactory` is used by the quality/alignment gate with measured gaps.
- `ChangeRequestTicketFactory` is used by the actor accepting the upstream contract delta.
- `TicketRegistrationService` validates and routes these completed Tickets without rewriting them.

DomainExecutionEngine becomes an assigned-Ticket executor. DomainScheduler becomes a pure readiness
policy or Application query and no longer advances Project or Phase state by itself.

### 10.5 Infrastructure ports

Add explicit ports for:

- DomainRepository and UnitOfWork.
- DomainEventOutbox.
- ProjectProjectionStore.
- ActorRegistryStore and TicketAssignmentStore.
- TicketTraceStore and TicketFlowMetricsStore.
- ProjectManagementPlanStore and RAIDRecordStore.
- InteractionStore.
- RecordReplayStore.
- LLM client/router.
- Tool, sandbox, file, Git, clock, and ID providers.

## 11. Implementation Roadmap

### R0: Baseline and architecture decisions

Work:

- Approve this plan and write ADRs for compatibility, canonical terminology, PM authority, event model,
  persistence, and record/replay.
- Capture v0.2.4 behavior only as refactor evidence, not as a compatibility promise.
- Add architecture dependency tests and 0.3 contract fixtures.
- Establish full CI with loopback-enabled integration tests and restricted-environment test profiles.

Gate:

- Current typecheck and lint pass.
- Existing failures are classified as product, test, or environment failures.
- All 0.3 design decisions have one authoritative ADR.

### R1: Canonical Domain 0.3

Work:

- Rename Domain Step types to the canonical V-model vocabulary.
- Remove execution/domain translation functions and old aliases.
- Finalize 0.3 Project, Phase, Step, Ticket, Plan, Event, Interaction, and quality schemas.
- Add ProjectManagementPlan, ActorRegistration, TicketAssignment, immutable TicketTraceEvent, Risk,
  Decision, flow-metric, and status projection contracts.
- Remove legacy schema loaders and compatibility paths.

Gate:

- One Step type union is used by planner, domain, execution, tickets, audit, Runtime, and ACP.
- No earlier schema is accepted.
- Invalid state produces a clear 0.3 rebuild error.

### R2: Dependency inversion and transactional state

Work:

- Introduce repository and UnitOfWork ports.
- Move persistence-aware services to Application.
- Add atomic graph commits, optimistic revisions, outbox, and recovery checks.
- Add append-only Ticket trace storage, sequence/hash compare-and-swap, and chain-integrity recovery.
- Add in-memory adapters and failure-injection tests.

Gate:

- Domain has no outward infrastructure imports.
- Interrupted commits cannot expose partial graph state.
- Registry, objects, and outbox remain revision-consistent.

### R3: Execution and planning decomposition

Work:

- Split Executor, Planner, AttemptRunner, Scheduler, Runtime Build/Run, and Router by responsibility.
- Preserve approved 0.3 behavior through contract tests while moving code.
- Centralize prompt policies, failure feedback, and context-window calculations.

Gate:

- Coordinators contain orchestration rather than parsing or infrastructure details.
- Components can be unit-tested with ports and deterministic clocks/IDs.
- No duplicate retry, completion, or failure-routing policy remains.

### R4: Structured failures, tickets, and test outcomes

Work:

- Introduce ExecutionFailure, FailureFingerprint, ProgressSignal, and TestOutcome.
- Consolidate Bug, Enhancement, Change Request, retry, and Debug Wiki behavior.
- Parse Vitest/Pytest reports and coverage into structured evidence.
- Keep regex classification only as a bounded fallback for unstructured tools.

Gate:

- Every failed gate has a typed cause and evidence reference.
- Environment restrictions do not become product Bugs.
- Ticket closure requires verified solution evidence.

### R5: Record/replay and network capability

Work:

- Implement RecordReplayPort, store, serializers, canonicalizers, redaction, and integrity checks.
- Add HTTP and LLM channels first; add selected Tool/Subprocess channels through the same interface.
- Introduce per-execution sandbox/network/secret capabilities.
- Add explicit fixture prepare, inspect, verify, and refresh commands.

Gate:

- S5-S8 cannot record or rewrite fixtures.
- Replay succeeds without network access.
- Replay miss, ambiguity, corruption, or secret leakage fails with a typed result.
- Live API use is traceable to an approved test contract.

### R6: PM projection and observe mode

Work:

- Add project projection store and outbox consumer.
- Implement project charter/baselines, actor registration, capability routing, Ticket registration/assignment,
  deterministic PM policy, and Decision Port.
- Add persistent interactions and read-only PM status/decision inspection.
- Create Epic/Story Tickets through PM and route every source-created Task/Bug/Enhancement/Change Request
  through PM while initially comparing project progression in observe mode.

Gate:

- PM cache can be deleted and rebuilt without changing behavior.
- Observe mode produces no state differences from PM-disabled execution.
- Every recommendation points to current object revisions and allowed commands.
- Every Ticket is registered in the PM projection and has at most one accepted active assignment.
- Every required role is registered before its first Phase is authorized.
- Every Ticket state/ownership transition has one transactionally committed trace event.

### R7: PM advisory and enforced low-risk actions

Work:

- Add PM Advisor LLM role with structured recommendation output.
- Resolve recommendations by authority, confidence, risk, and capability.
- Make PM the active driver for Project, Phase, V-model Step, Ticket routing, retry, wait, fallback, and
  interaction commands.
- Persist decisions and recover pending actions after restart.

Gate:

- PM cannot bypass Domain transitions or required test gates.
- Runtime, DomainExecutionEngine, and DomainScheduler contain no competing project-driving loop.
- A professional role cannot receive or execute a Ticket that PM has not registered and assigned.
- Denied or expired interactions terminate or reroute explicitly.
- Repeated unproductive decisions are detected through shared failure fingerprints.

### R8: Replan, delivery, and 0.3 release

Work:

- Add controlled PM replan and high-risk approval paths.
- Complete Runtime/CLI/ACP 0.3 documentation and examples.
- Run Python and TypeScript real-project validation, offline replay, controlled live tests, packaging, and
  installation verification.
- Remove remaining earlier-version code, fixtures, docs, and exports.

Gate:

- All required Project/Phase/Step/Ticket and quality gates close.
- PM project report includes decisions, interactions, cache recovery, tickets, KPI, record/replay use,
  live dependencies, known limitations, and delivery evidence.
- The 0.3 package contains only 0.3 contracts and documentation.

## 12. Test Topology

Tests are reorganized by architectural responsibility:

- `tests/unit/domain`: objects, transitions, invariants, policies, fingerprints.
- `tests/unit/application`: use cases, PM decisions, cache projection, ticket routing.
- `tests/contract`: Repository, Runtime, ACP, events, record/replay channel contracts.
- `tests/integration`: filesystem, Registry, UnitOfWork, sandbox, local HTTP, provider streams.
- `tests/e2e`: CLI/ACP workflows and real Python/TypeScript generated projects.

CI profiles:

- `core`: deterministic, no network, required for every change.
- `integration`: loopback and process capabilities, required before merge.
- `replay`: external integrations with network disabled, required before release.
- `live`: explicitly authorized credentials and endpoints, scheduled or release-only.
- `package`: npm/native package installation and executable smoke tests.

Skipped, blocked, and inconclusive results are visible and governed by the active gate. They are never
silently converted to success.

## 13. Delivery Strategy

- Each roadmap stage is split into reviewable PRs with one architectural purpose.
- Behavioral extraction and semantic changes are not mixed in the same PR when avoidable.
- Every PR adds or moves tests with the changed responsibility.
- Architecture dependency tests prevent old import directions from returning.
- Real-project fixtures are external validation inputs; generated-project rules are not hardcoded into
  XCompiler production logic.
- Major decisions and completed stages are recorded under `docs/audit/`.
- No package split is attempted until Runtime, ports, and public 0.3 contracts are stable.

## 14. Principal Risks and Controls

### PM becomes a second workflow engine

Control: PM emits typed commands; Domain transitions remain authoritative; observe mode proves parity.

### PM cache becomes stale or canonical

Control: revision checks, event IDs, outbox cursor, checksum, invalidation, and full rebuild tests.

### Record/replay leaks secrets

Control: mandatory redaction, allowlisted fields, fixture scanning, content hashes, and release gates.

### Replay hides real integration failures

Control: explicit live-required contracts and separate controlled live CI; replay never satisfies a
required-live gate by itself.

### Refactor changes too many behaviors at once

Control: baseline first, dependency inversion before governance, observe before enforced, and stage-level
acceptance gates.

### No compatibility makes failure confusing

Control: explicit schema/version diagnostics and rebuild guidance, without retaining migration code.

## 15. Version 0.3 Definition of Done

The refactor is complete only when all of the following are true:

1. Runtime is the only business entry for CLI and ACP.
2. Domain has no dependency on Application or Infrastructure.
3. One canonical V-model vocabulary is used end to end.
4. Project state commits and events are transactionally consistent.
5. PM actively drives progress through allowed commands and persistent decisions.
6. PM cache is bounded, revision-safe, and fully rebuildable.
7. PM creates only project Epic/Story Tickets; context-owning sources create all other Ticket types. PM
   registers every role and submitted Ticket, assigns one eligible processor, and preserves ownership and
   reassignment history.
8. Project, Phase, and V-model progression is requested by PM and validated by Domain policy.
9. Every Ticket has an immutable, hash-linked, append-only ownership and flow trace; corrections append
   evidence rather than rewriting history.
10. Flow metrics are reproducible from the trace and use quality/complexity-aware confidence before they
    influence PM routing, capacity forecasts, or model scores.
11. Bug, Enhancement, and Change Request lifecycles remain distinct and auditable.
12. Test outcomes and failures are structured rather than inferred primarily from text.
13. Generic record/replay supports HTTP, LLM, and extensible external-interaction channels.
14. Verification stages cannot silently record, mutate fixtures, or fall back to live services.
15. Python and TypeScript real-project workflows pass required offline, replay, integration, and delivery
    gates.
16. Earlier compatibility code, schemas, aliases, exports, and documentation are removed.
17. Runtime, ACP, package, architecture, and security documentation match the implemented 0.3 behavior.
18. The final project report contains complete quality, ticket assignment/trace, PM, RAID, record/replay, and
    delivery evidence.
