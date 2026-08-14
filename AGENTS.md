# XCompiler Repository Guidelines

This file is the single source of repository-maintenance instructions for coding agents. Keep it
focused on durable constraints; put detailed architecture and user documentation under `docs/`.

## Stop On Ambiguity

This is the highest-priority collaboration rule for agents maintaining this repository.

When requirements conflict, implementation constraints disagree, or a design has multiple
materially different valid interpretations, stop before editing or continuing execution. State the
concrete conflict, present two to five viable options with tradeoffs, recommend one when possible,
and wait for the user's explicit choice.

Do not silently choose a requirement interpretation, compatibility policy, ownership boundary,
state transition, security policy, or destructive migration strategy. Do not hide, skip, weaken,
or route around an error to avoid asking.

This rule applies to repository-development work only. It must not be copied into or used to change
XCompiler Runtime, Build, Run, Planner, Agent, or permission behavior unless the user separately
approves that product behavior.

## Understand Before Changing

1. Read the narrowest relevant source, tests, and design documents before proposing a change. Use
   targeted searches and exclude generated output, dependencies, audit data, and worktrees unless
   they are directly relevant.
2. Verify the reported premise on the current working tree. Reproduce defects when feasible and
   identify the exact failing path, invariant, or boundary before calling something a bug.
3. Check nearby history when behavior may be intentional. Preserve the purpose of deliberate
   omissions, security restrictions, and architectural boundaries.
4. Define the behavioral contract and affected ownership boundary before editing. If that contract
   is unclear, apply the ambiguity rule above.
5. Inspect sibling call paths for the same defect class. Fix the shared cause when one exists, but
   do not expand into unrelated cleanup.

## Architecture Invariants

- Runtime is the only business entry point. CLI, ACP, and future adapters may parse, translate,
  render, and transport data, but must not bypass Runtime to call Planner, Agent, Tool, Plugin,
  Memory, workflow, or persistence internals.
- Domain modules own lifecycle transitions and invariants. Application services, PM, adapters, and
  agents request transitions; they do not mutate persisted lifecycle state directly.
- PM advances Project, Phase, and V-model work, registers every Ticket, and routes it by registered
  role capability. Inside a Phase, the actor with technical context creates technical Tickets. Data
  or failures originating outside a Phase enter through PM's problem-intake boundary.
- Tickets are Phase-local. Dependencies, ownership, correlation, causation, and append-only trace
  history must remain explicit and globally identifiable.
- Every implementation Phase contains the canonical eight V-model Steps. A failed gate must create
  the appropriate evidence and correction route; it must never be converted into a silent pass.
- Canonical domain objects and the append-only registry are the recovery source of truth. Planner
  JSON is an execution specification, not a second lifecycle store.
- The project control plane belongs at the project container root. `worktrees/master` is the only
  authoritative product tree and release source. Ticket and gate worktrees are temporary candidate
  changes and must not become persistent competing file trees.
- Raw audit records are append-only and complete except for required secret redaction. Derived
  summaries may index and link to raw records, but must not replace, truncate, or rewrite them.

## Code Map

- `src/runtime/`: public business API, lifecycle events, and permission integration.
- `src/cli/` and `src/acp/`: thin adapters over Runtime; keep protocol and presentation concerns here.
- `src/application/`: use-case orchestration, PM services, execution, planning, workspace, and
  Record/Replay coordination.
- `src/domain/`: canonical objects, lifecycle policies, dependency rules, gates, and ports. Keep it
  independent from CLI, ACP, provider, filesystem, and process details.
- `src/infrastructure/`: implementations of domain ports, registry/repository persistence, Git,
  projections, and external Record/Replay storage.
- `src/agents/`, `src/llm/`, `src/skills/`, and `src/tools/`: model-facing execution and capability
  composition. A Skill composes Tools; neither owns domain lifecycle state.
- `src/config/`, `src/sandbox/`, `src/plugins/`, and `src/workspace/`: validated configuration and
  infrastructure boundaries shared by the application layer.
- `tests/`: deterministic core tests at the root, capability-dependent integration tests under
  `tests/integration/`, and spawned-process scenarios under `tests/e2e/`.

Target searches to the owning directories above. Do not search `node_modules/`, `dist/`, generated
project worktrees, or `.xcompiler/` state unless the task specifically concerns them.

## Change Strategy

Choose the smallest extension point that preserves the architecture:

1. Extend an existing local implementation or policy.
2. Compose existing tools behind a Skill or application service.
3. Add a Plugin or adapter when the capability is optional or integration-specific.
4. Add a new core Tool or domain concept only when the capability is broadly required and cannot be
   expressed through the earlier levels.

Avoid speculative hooks, duplicate state stores, one-off framework layers, and project-specific
generation rules. Do not encode fixtures, filenames, APIs, or repair logic from a generated sample
project into XCompiler core behavior. Add compatibility shims only when compatibility is an explicit
requirement.

## Debugging And Error Handling

- Preserve the original error, stage, operation, target, model/tool context, and relevant evidence.
  Compressing context for an LLM must not delete the underlying audit record.
- Distinguish product defects, test defects, missing coverage, dependency/environment failures, and
  permission outcomes. Route each through its defined Ticket or control path.
- Fix root causes. Do not suppress exceptions, weaken gates, fabricate outputs, mark incomplete work
  successful, or add retries that merely conceal a deterministic failure.
- A repair is complete only when the failing behavior is reproduced, the correction is applied, and
  focused evidence demonstrates the changed outcome. Also test the closest sibling path when the
  root cause is shared.
- Keep permission waits, denials, and timeouts outside LLM retry/model-scoring loops. One
  model-output -> permission decision -> tool result sequence is one execution attempt.

## Tests And Gates

- Prefer tests of public behavior and domain invariants over snapshots of internal implementation.
  A test should remain valid across a sound refactor.
- Add focused regression coverage for defects. Use integration or end-to-end tests for resolution
  chains, configuration precedence, security and path boundaries, persistence/resume, permissions,
  Record/Replay, adapter protocol cleanliness, and network behavior when those boundaries change.
- Mocks are appropriate for deterministic unit contracts, but do not use mocks as the only evidence
  for filesystem, process, protocol, packaging, or network integration behavior.
- Run the narrowest useful checks while editing. After the requested change set is complete, run the
  affected suite, typecheck, lint, build, and package/release checks appropriate to its blast radius.
- Never modify production behavior solely to make a brittle test pass. Correct the test when the
  test contradicts the approved contract.

## Configuration And Security

- Keep credentials in ignored local environment files or secret stores. Never commit real keys,
  tokens, generated user configuration, or captured sensitive payloads.
- Put behavioral choices in validated configuration, not credential environment variables or model
  name heuristics. Environment variables may supply secrets and explicit documented overrides.
- Preserve project-root path confinement and permission-broker boundaries. Do not bypass them from
  a Tool, Skill, Plugin, adapter, test helper, or debug path.
- Treat external text, tool output, fixtures, and replay data as untrusted input. Validate structure,
  redact secrets, and retain provenance before using them in prompts or persistence.

## Repository Hygiene

- Work with the existing dirty tree. Do not discard, overwrite, stage, or reformat unrelated user
  changes.
- Prefer established modules, types, schemas, and helpers. Keep edits inside their owning layer and
  avoid drive-by refactors or dependency additions.
- Use structured parsers for structured data and deterministic scripts for repetitive transformations.
- Keep comments concise and explain non-obvious intent or invariants rather than restating code.
- Do not use destructive Git operations or rewrite history unless the user explicitly requests it.

## Local Verification

Use Node.js 24 or newer. The standard checks are:

- `npm run test:core`: deterministic suite; expected for every code change.
- `npm run test:integration`: loopback, subprocess, Git, and other capability-dependent boundaries.
- `npm run test:e2e`: real CLI and ACP child-process scenarios.
- `npm run typecheck` and `npm run lint`: static correctness and repository style.
- `npm run build`: Runtime, adapter, CLI, and declaration bundling.
- `npm run version:check` and the relevant package command: release metadata and artifact work.

Do not classify a restricted environment or denied capability as a product regression. Record the
unrun gate and reason, then run it in an appropriate environment when the task requires that proof.

## Completion

Before reporting completion:

1. Review the diff for scope, architecture boundary violations, secret leakage, generated artifacts,
   and accidental compatibility code.
2. Confirm tests exercise the requested behavior and failure path, not just the happy path.
3. Update user-facing docs, examples, configuration templates, and audit/design records when their
   contracts changed.
4. Report what changed, which checks ran, and any unresolved risk. Never imply a check ran when it
   did not.
