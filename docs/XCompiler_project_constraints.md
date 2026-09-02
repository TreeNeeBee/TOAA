# XCompiler Project Constraints

This document is the current source of truth for XCompiler-specific architecture, ownership,
lifecycle, repository-layout, and verification constraints. `AGENTS.md` governs how coding agents
work; this document governs what they must preserve in XCompiler.

When this document conflicts with an archived plan, this document wins. Archived plans retain the
decision history but are not current specifications. A material conflict with current source,
tests, or another active design document must be raised before implementation.

## Runtime and layer boundaries

- Runtime is the only business entry point. CLI, ACP, and future adapters may parse, translate,
  render, and transport data, but must not bypass Runtime to call Planner, Agent, Tool, Plugin,
  Memory, workflow, or persistence internals.
- Domain modules own lifecycle transitions and invariants. Application services, PM, adapters, and
  agents request typed transitions; they do not mutate persisted lifecycle state directly.
- Canonical domain objects and the append-only registry are the recovery source of truth. Planner
  JSON is an execution specification, not a second lifecycle store.
- Deterministic policy is evaluated before optional LLM advice. Control flow branches on typed codes,
  enumerated kinds, and structured fields, never on rendered messages or model names.

## Project Manager boundary

- PM advances Project, Phase, and V-model work, registers every Ticket, monitors project state, and
  routes executable work by registered role capability.
- PM creates only Project-context Epic and V-model Story Tickets. Inside a Phase, the actor or gate
  with the technical context creates Task, Bug, Enhancement, and Change Request Tickets.
- Data, failures, or observations originating outside a Phase enter through PM's problem-intake
  boundary. PM may materialize a Ticket there because the external caller submits evidence rather
  than a Phase-local Ticket.
- PM does not invent, merge, reclassify, or rewrite technical context. It records governance
  decisions and requests domain transitions through typed application commands.
- Ticket ownership belongs to the assigned processor. PM retains monitoring, routing, reassignment,
  escalation, delivery, and administrative closure authority.

### Routing-time duplicate Bug policy

After a Bug is registered and before it is assigned, PM must compare it with earlier active Bugs
targeting the same Step. Bug creation always preserves the discovering actor's report as its own
Ticket; only this routing-time check decides whether the registered Ticket is a duplicate, using one
persisted structural failure identity.

The identity is produced from typed failure context supplied by the discovering actor or gate. It
must not use `summary`, rendered logs, temporary paths, counters, timestamps, provider prose, or any
other unstable presentation text as a control key.

When PM finds a duplicate:

1. PM records a typed duplicate-routing decision and does not assign the duplicate.
2. PM invokes a domain/application command that links both Tickets using
   `duplicateOfTicketId` on the duplicate and `duplicateTicketIds` on the original.
3. The domain transition parks the duplicate in `pending` with `pendingReason: duplicate`.
4. The original Ticket remains authoritative and follows its normal Bug lifecycle. Technical
   evidence and solutions are not merged into it by PM.
5. When the original reaches a terminal outcome, reconciliation cancels the duplicate with a typed
   duplicate-resolution reason and releases its blockers. A cancelled duplicate is terminal for
   Step and Phase delivery gates.

The earlier archived wording that allowed PM to reject a duplicate back to its creator is superseded
by this linked-and-parked policy. PM decides that assignment must not proceed; the Domain remains the
only authority that changes Ticket state.

## Ticket and corrective-flow invariants

- Tickets are Phase-local. Dependencies, ownership, correlation, causation, duplicate relations,
  and append-only trace history remain explicit and globally identifiable.
- Every Bug preserves the original stage, operation, target, structured failure identity, raw
  evidence reference, and an executable verification contract. Exact replay proof is append-only and
  remains attached to the Bug while its CR continues through later impact Steps.
- A Bug becomes `resolved` only after its repair is applied and the repairing Step's own delivery
  gate passes. `resolved` means implementation is complete while the original failure verdict is
  still outstanding; it is not executable or blocked work. The Bug closes only after its original
  failure contract is replayed successfully at the designated verification Step. The same failure
  recurring reopens that Bug. A downstream gate passing for unrelated work is not closure proof.
- Scheduled work derives its execution mode from canonical Ticket type at the execution boundary.
  A persisted or independently supplied `work.mode` is forbidden because it duplicates lifecycle
  state and can disagree with the Ticket.
- An upstream correction from requirement, high-level design, or detailed design propagates through
  downstream owners as Change Requests. Downstream actors apply only the accepted delta and record
  their own change and verification evidence.
- A Change Request propagation scope starts at its current target, contains unique Steps from one
  Project and Phase, and follows canonical V-model order. Invalid scope data is rejected before a
  Ticket, relation, or lifecycle transition is persisted.
- A folded Change Request hop retains every source Ticket explicitly. Closing the hop must reconcile
  every source; its final hop must prove every active source Bug's exact verification contract before
  any closure transition. A secondary Bug or Enhancement must not remain parked indefinitely.
- Bug, Enhancement, Change Request, dependency, permission, and environment outcomes remain distinct
  for lifecycle, audit, metrics, and model scoring.

## Phase and V-model invariants

- Every implementation Phase contains the canonical eight Steps:
  `REQUIREMENT_ANALYSIS`, `HIGH_LEVEL_DESIGN`, `DETAILED_DESIGN`, `CODE`, `UNIT_TEST`,
  `INTEGRATION_TEST`, `MODULE_TEST`, and `FUNCTIONAL_TEST`.
- S1-S4 produce their owned deliverables, deliverable checks, and baseline tests. On the first pass,
  S1-S3 skip baseline execution because code does not yet exist; a corrective return after S4 must
  execute the applicable baseline gate.
- S5-S8 independently inspect the inherited baseline tests, add risk-driven functional tests when
  required by their approved contract, freeze the test set, execute it, and distinguish test defects
  from product defects.
- Every Step has a delivery gate. A failed gate creates complete evidence and an appropriate
  corrective route; it is never converted into a silent pass.
- Every delivery-gate finding carries a stable machine code. Findings with the same category, target,
  and code merge evidence; findings with different codes remain independent even when their rendered
  summaries happen to match.
- Phase delivery gates validate complete deliverables and real user scenarios, including real network
  behavior when the scenario requires it. External gate findings go to PM problem intake, which may
  create multiple independent Tickets and restart corrective V-model work.
- A real-scenario failure is classified from accepted project context and captured evidence by an
  LLM. An implementation that realizes a still-valid contract incorrectly becomes a Bug; a required
  change to an accepted requirement, capability, interface, dependency, data source, or design
  premise becomes a Change Request. Protocol status codes, timeouts, exceptions, and empty results
  are evidence only and never select the Ticket type or target Step.
- A failed scenario verdict must include a typed Ticket classification and owning Step. Missing or
  malformed judgement stops the gate as a runtime judgement failure; it is never treated as a pass
  or silently defaulted to a product Bug.

## Workspace and persistence

- The project control plane belongs at the project container root. Plans, Project/Phase/Step/Ticket
  state, registry data, permissions, audit indexes, and reports must not be owned by a candidate
  worktree.
- `worktrees/master` is the only authoritative product tree and release source. Ticket and gate
  worktrees are temporary candidate changes forked from the authoritative tree.
- PM's file-tree projection records only the authoritative tree. Candidate changes are represented by
  Ticket, ChangeSet, merge-gate, and audit metadata; after merge, the authoritative tree is rescanned.
- Canonical state is persisted through repository ports and domain commits. PM caches are rebuildable
  projections and cannot become a second source of truth.
- Raw audit records are append-only and complete except for required secret redaction. Derived
  summaries may index and link to raw records, but must not replace, truncate, or rewrite them.
- Debug Wiki operation logs are local append-only runtime data. Packaged system and agent knowledge
  seed a configured wiki path; runtime entries append there and are not regenerated from summaries.

## Capability boundaries

- A Skill composes Tools and may package instructions and resources. Tools perform bounded operations.
  Neither owns Project, Phase, Step, Ticket, permission, or lifecycle state.
- Record/Replay is a Skill-facing capability backed by application and infrastructure ports. Replay
  data is untrusted input, retains provenance, and must not bypass project-root or permission checks.
- Generated-project fixtures, filenames, APIs, and one-off repair rules must not be encoded into
  XCompiler core. General failures are fixed through reusable contracts, prompts, tools, or lifecycle
  policies.
- Runtime permissions form one model-output -> permission decision -> tool result attempt. A pending,
  denied, or timed-out permission does not consume an LLM retry or alter model scoring.

## Code ownership map

- `src/runtime/`: public business API, lifecycle events, and permission integration.
- `src/cli/` and `src/acp/`: thin adapters over Runtime; protocol and presentation only.
- `src/application/`: use-case orchestration, PM services, execution, planning, workspace, and
  Record/Replay coordination.
- `src/domain/`: canonical objects, lifecycle policies, dependency rules, gates, and ports. It remains
  independent from CLI, ACP, providers, filesystems, and processes.
- `src/infrastructure/`: domain-port implementations, registry/repository persistence, Git,
  projections, and external Record/Replay storage.
- `src/agents/`, `src/llm/`, `src/skills/`, and `src/tools/`: model-facing execution and capability
  composition.
- `src/config/`, `src/sandbox/`, `src/plugins/`, and `src/workspace/`: validated configuration and
  shared infrastructure boundaries.
- `tests/`: deterministic core tests at the root, capability-dependent integration tests under
  `tests/integration/`, and spawned-process scenarios under `tests/e2e/`.

Target searches to the owning directories. Exclude `node_modules/`, `dist/`, generated worktrees, and
`.xcompiler/` state unless the task specifically concerns them.

## Extension order

Choose the smallest extension point that preserves these boundaries:

1. Extend an existing local implementation or policy.
2. Compose existing Tools behind a Skill or application service.
3. Add a Plugin or adapter when the capability is optional or integration-specific.
4. Add a core Tool or domain concept only when the capability is broadly required and cannot be
   expressed through the earlier levels.

## Security and configuration

- Credentials belong in ignored local environment files or secret stores. Real keys, tokens,
  generated user configuration, and captured sensitive payloads must never be committed.
- Behavioral choices belong in validated configuration, not credential variables, model-name
  heuristics, or message matching.
- Preserve project-root path confinement and permission-broker boundaries across Tool, Skill,
  Plugin, adapter, test-helper, and debug paths.
- Treat external text, tool output, fixtures, replay data, and provider responses as untrusted.
  Validate structure, redact secrets, and retain provenance before prompts or persistence.

## Verification and release gates

Use Node.js 24 or newer. Apply the gates appropriate to the change's blast radius:

- `npm run test:core`: deterministic domain and application behavior; expected for every code change.
- `npm run test:integration`: loopback, subprocess, Git, persistence, and capability boundaries.
- `npm run test:e2e`: CLI and ACP child-process scenarios.
- `npm run typecheck` and `npm run lint`: static correctness and repository style.
- `npm run build`: Runtime, adapters, CLI, and declarations.
- `npm run version:check` plus the relevant package command: release metadata and artifacts.
- Release work also runs the npm package dry run and production-dependency security audit.

Mocks are suitable for deterministic domain contracts, but they are not the only evidence for
filesystem, process, protocol, packaging, permission, Record/Replay, or network integration changes.
