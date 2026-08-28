# XCompiler Agent Development Guidelines

This file is the single source of behavior constraints for coding agents maintaining this
repository. It governs how an agent collaborates, investigates, edits, verifies, and reports work.

XCompiler-specific architecture, ownership, lifecycle, directory, and release constraints live in
[`docs/XCompiler_project_constraints.md`](docs/XCompiler_project_constraints.md). Read the relevant
parts of that document before changing product behavior. Do not copy either document into Runtime
prompts or use it to change generated-project behavior unless the user separately approves that
product change.

## Stop On Ambiguity

This is the highest-priority collaboration rule for agents maintaining this repository.

When requirements conflict, implementation constraints disagree, or a design has multiple
materially different valid interpretations, stop before editing or continuing execution. State the
concrete conflict, present two to five viable options with tradeoffs, recommend one when possible,
and wait for the user's explicit choice.

Do not silently choose a requirement interpretation, compatibility policy, ownership boundary,
state transition, security policy, or destructive migration strategy. Do not hide, skip, weaken,
or route around an error to avoid asking.

This rule applies to repository-development work only.

## Understand Before Changing

1. Read the narrowest relevant source, tests, and design documents before proposing a change. Use
   targeted searches and exclude generated output, dependencies, audit data, and worktrees unless
   they are directly relevant.
2. Verify the reported premise on the current working tree. Reproduce defects when feasible and
   identify the exact failing path, invariant, or boundary before calling something a bug.
3. Check nearby history when behavior may be intentional. Preserve the purpose of deliberate
   omissions, security restrictions, and architectural boundaries.
4. Read the relevant project constraints, then define the behavioral contract and affected ownership
   boundary before editing. If that contract is unclear, apply the ambiguity rule above.
5. Inspect sibling call paths for the same defect class. Fix the shared cause when one exists, but
   do not expand into unrelated cleanup.

## Development Discipline

- Choose the smallest established extension point that satisfies the approved contract. Prefer
  local patterns, schemas, helpers, and ownership boundaries over new abstractions.
- Keep edits scoped to the requested behavior. Do not add speculative hooks, duplicate state,
  unrelated cleanup, or compatibility shims unless compatibility is an explicit requirement.
- Use structured parsers for structured data and deterministic transformations for repetitive work.
- Do not encode a sample project's fixtures, filenames, APIs, or repair details into reusable
  product behavior.
- Before editing, state what will change and why. If new evidence invalidates the approved design,
  stop and return to the ambiguity rule instead of silently changing direction.

## Debugging And Error Handling

- Preserve the original error, stage, operation, target, model/tool context, and relevant evidence.
  Compressing context for an LLM must not delete the underlying audit record.
- Distinguish product defects, test defects, missing coverage, dependency/environment failures, and
  permission outcomes. Preserve the distinction through the repository's defined control path.
- Fix root causes. Do not suppress exceptions, weaken gates, fabricate outputs, mark incomplete work
  successful, or add retries that merely conceal a deterministic failure.
- Branch control flow on a channel the producer sets deliberately — a typed code, an enumerated
  kind, a structured field — never on message text. Prose is presentation: it is rewritten for
  clarity by people who cannot see who is matching it, and the match then fails silently while its
  own test keeps passing, because the test supplies the wording the pattern was written against.
  A test that repeats the matched wording does not make this safe.
- A repair is complete only when the failing behavior is reproduced, the correction is applied, and
  focused evidence demonstrates the changed outcome. Also test the closest sibling path when the
  root cause is shared.
- Keep permission waits, denials, and timeouts outside LLM retry/model-scoring loops. One
  model-output -> permission decision -> tool result sequence is one execution attempt.

## Tests And Gates

- Prefer tests of public behavior and domain invariants over snapshots of internal implementation.
  A test should remain valid across a sound refactor.
- Add focused regression coverage for defects. Use integration or end-to-end tests when a changed
  boundary cannot be demonstrated by a deterministic unit test.
- Mocks are appropriate for deterministic unit contracts, but do not use mocks as the only evidence
  for filesystem, process, protocol, packaging, or network integration behavior.
- Follow the user's requested verification order. Unless the user asks to defer checks, run the
  narrowest useful checks while editing and the complete affected gates after all edits finish.
- Never modify production behavior solely to make a brittle test pass. Correct the test when the
  test contradicts the approved contract.
- Cover the call site, not only the unit. A check that is never invoked passes every test written
  against the check itself; deleting its call from the production path must fail something. Verify
  this the same way you verify the fix — remove the call, watch a test fail, restore it.
- Falsify the wiring, not the logic. Most changes have two halves — a function, and the line that
  calls it — and the function is the half that was never in doubt. Reverting it proves only that the
  test runs. The rule above says to remove the call too, and knowing it is not enough: it was in this
  file, and five changes in a single session still shipped with a test that passed either way,
  because each time the natural revert was the interesting half. Two tells that you picked the wrong
  one: the test names the new function rather than the behaviour a caller would notice, and it was
  easy to write. Revert the call first; if nothing fails, the test is aimed at the wrong half,
  whatever else it proves.
- Verify a heuristic against the case that motivated it before keeping it. A rule inferred from a
  defect but never run against that defect is unevidenced; if it does not catch its own motivating
  example, delete it rather than shipping a check that only appears to help.

## Configuration And Security

- Keep credentials in ignored local environment files or secret stores. Never commit real keys,
  tokens, generated user configuration, or captured sensitive payloads.
- Put behavioral choices in validated configuration, not credential environment variables or model
  name heuristics. Environment variables may supply secrets and explicit documented overrides.
- Preserve path-confinement and permission boundaries. Do not bypass them from production code,
  tests, helpers, or debug paths.
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

## Completion

Before reporting completion:

1. Review the diff for scope, architecture boundary violations, secret leakage, generated artifacts,
   and accidental compatibility code.
2. Confirm tests exercise the requested behavior and failure path, not just the happy path.
3. Run the checks required by the project constraints and the change's blast radius. Do not classify
   a restricted environment or denied capability as a product regression; report the unrun gate and
   reason accurately.
4. Update user-facing docs, examples, configuration templates, and audit/design records when their
   contracts changed.
5. Report what changed, which checks ran, and any unresolved risk. Never imply a check ran when it
   did not.
