# XCompiler Domain Refactor Plan

> Historical record: this completed v0.2 domain refactor is superseded by
> `docs/XCompiler_refactor_plan.md` for the intentionally breaking 0.3 architecture.

## Objective

Replace the current plan-driven execution projection with one domain model in which:

- `Project`, `Phase`, and `Step` own workflow, quality gates, and delivery state.
- `Ticket` owns work, defects, improvements, and propagated change.
- every persisted object has one globally unique UUIDv7 `id`;
- `name` is a human-readable label such as `P1-S004`, never an identity or foreign key;
- one project object registry maps `id` to `objectType`, `objectRef`, revision, and content hash;
- event logs are the recovery source and registry indexes are rebuildable projections.

The refactor intentionally does not preserve the previous persisted domain schema.

The durable implementation and validation record is [XC-AUDIT-2026-08-01-DOMAIN-001](audit/2026-08-01-runtime-domain-refactor.md).

## Implementation Status

| Iteration | Status | Delivered result |
| --- | --- | --- |
| R1 | Complete | UUIDv7 identity, typed references, append-only registry, rebuild and integrity verification |
| R2 | Complete | Canonical Project/Phase/Step/Ticket aggregates, lifecycle commands and invariants |
| R3 | Complete | Planner compiler, active-Phase materialization and incremental Project extension |
| R4 | Complete | Dependency-driven Story/Task work, Bug/Enhancement routing and nested Change Requests |
| R5 | Complete | Scheduler recovery, phase-boundary recovery, deadlock detection and checkpoint resume |
| R6 | Complete | Runtime-only use cases, CLI/ACP adapters, correlated events, audit/log/report persistence |
| R7 | Complete | Previous engine, ticket store, status projections, retry fields and partial-run switches removed |
| R8 | Complete | 628 tests, typecheck, lint, Node 24 build, native Doctor, CLI smoke test, real provider routing and npm package-content audit passed |

## Ownership Boundaries

| Aggregate | Owns | Must not own |
| --- | --- | --- |
| Project | phase lifecycle, project KPI, final delivery and report | step execution state |
| Phase | one iteration goal, ordered V-model steps, phase gate | ticket resolution logic |
| Step | stage inputs, outputs, dependencies, KPI observations and gate result | issue history or debug knowledge |
| Ticket | work lifecycle, dependencies, solution, changelist and verification evidence | phase or step state |
| Object Registry | identity lookup, object location, revision/hash integrity and tombstones | domain object payload |

## Identity Contract

Every persisted object uses this envelope:

```ts
interface ObjectEnvelope {
  id: ObjectId;          // UUIDv7, immutable and globally unique
  name: string;          // display label, for example P1-S004
  objectType: ObjectType;
  projectId: ObjectId;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

References use typed `{ id, objectType }` values. Persisted relationships use IDs only. Parent IDs are authoritative; child lists and reverse dependencies are derived indexes.

## Domain Types

Ticket types are `epic`, `story`, `task`, `bug`, `enhancement`, and `change-request`.

- `enhancement` records an identified quality, completeness, or capability gap.
- `change-request` carries an approved upstream change into affected downstream Steps.
- `bug` records incorrect behavior and enters the Debug flow. A verified Bug solution is eligible for debug-wiki persistence.

V-model Step types are:

1. `REQUIREMENT_ANALYSIS`
2. `HIGH_LEVEL_DESIGN`
3. `DETAILED_DESIGN`
4. `CODE`
5. `UNIT_TEST`
6. `INTEGRATION_TEST`
7. `MODULE_TEST`
8. `FUNCTIONAL_TEST`

`Phase` means an iteration container and is not another name for a V-model Step.

## State Ownership

Commands are the only state mutation entry points. Aggregate state is never inferred by mutating another aggregate.

Ticket lifecycle:

```text
created -> in_progress | pending | cancelled
pending -> in_progress | cancelled
in_progress -> pending | resolved | cancelled
resolved -> closed | reopened
reopened -> in_progress | cancelled
cancelled -> reopened | closed
```

Step lifecycle:

```text
created -> in_progress | pending
pending -> in_progress
in_progress -> delivered | pending
delivered -> closed | reopened
reopened -> in_progress
```

Quality is derived from immutable KPI observations. Checkpoints are immutable. Reports are projections and can be regenerated.

## Refactor Iterations

### R1: Identity and Registry

- Add UUIDv7 `ObjectId`, `ObjectType`, typed references, and object envelopes.
- Add append-only registry events and an atomic, rebuildable registry index.
- Enforce revision, ownership, parent, tombstone, path, and content-hash integrity.
- Gate: identity, replay, rebuild, corruption, and concurrent-write tests pass.

### R2: Domain Model

- Replace Project, Phase, Step, Ticket, Checkpoint, Deliverable, KPI, Report, and Changelist schemas.
- Remove duplicate Step/Ticket execution states and old ticket categories.
- Add normalized lifecycle commands and transition tests.
- Gate: every aggregate transition and invariant is covered.

### R3: Planning Compiler

- Compile Planner output into Project, Phase, Step, Epic, Story, and Task objects.
- Generate only the active Phase's detailed plan.
- Validate IDs, typed references, V-model pairing, dependencies, and delivery gates.
- Gate: simple and multi-phase plans produce deterministic valid object graphs.

### R4: Ticket Workflow

- Drive work through dependency-ready Tickets while Step remains the stage authority.
- Route Bugs to Debug, Enhancements to scoped completion work, and upstream changes through Change Requests.
- Close Bugs and Change Requests only after all affected verification Steps pass.
- Gate: Bug, Enhancement, and Change Request end-to-end scenarios pass.

### R5: Scheduler and Recovery

- Replace array-position execution with dependency scheduling.
- Restore interrupted work from registry events and checkpoints.
- Detect deadlocks, cycles, stale revisions, and orphaned objects explicitly.
- Gate: crash recovery resumes the exact active Ticket and Step without skipping a gate.

### R6: Runtime Integration

- Make Runtime commands the sole use-case entry points for the new model.
- Keep CLI and ACP as event-driven adapters.
- Emit stable correlation and causation IDs across runtime events, logs, and tickets.
- Gate: build, run, ACP confirmation, permission, cancellation, and reporting pass.

### R7: Legacy Removal

- Delete old ticket schemas, phase/status projections, compatibility readers, and obsolete audit fields.
- Reject unsupported persisted schemas with a precise rebuild instruction.
- Gate: no runtime import or persistence path references the former model.

### R8: Delivery Validation

- Run typecheck, build, complete non-network tests, and controlled real-project scenarios.
- Verify project/phase reports, KPI summaries, registry integrity, audit traceability, and package contents.
- Gate: all supported adapters produce the same Runtime result and no stage can be skipped after failure.
