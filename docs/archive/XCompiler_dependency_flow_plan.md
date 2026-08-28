# Dependencies: one owning phase, and a Change Request to reach it

Status: implemented — HIGH_LEVEL_DESIGN owns the manifest, `add_dependency` refuses elsewhere, and a
need raised outside it travels there as a Change Request. See `corrective_workflow_service.ts` and
`tests/manifest_sandbox_sync.test.ts`.
Target release: v0.3.0

## 1. Why

A live run stalled because nothing installed the packages a generated project declared, and the
Steps that noticed could not fix it: the manifest was another Step's output, and the sandbox had no
way to be ready before the design that chose its contents existed.

Two things were conflated. **Creating** the sandbox is an environment concern and belongs before the
V-model starts. **Filling** it is a design decision and belongs to HIGH_LEVEL_DESIGN. Separating them
removes the ordering paradox without giving every Step a say in the dependency set.

## 2. The rule

HIGH_LEVEL_DESIGN owns the dependency manifest. No other Step edits it — `add_dependency` refuses
elsewhere and says so. A need discovered anywhere else travels to HIGH_LEVEL_DESIGN as a Change
Request and comes back as a dependency the design accepted.

```text
S1 REQUIREMENT_ANALYSIS  needs a package
      └── CR → HIGH_LEVEL_DESIGN, and S1 waits for the flow to reach it normally

S4 CODE (or any later Step)  needs a package
      └── CR → HIGH_LEVEL_DESIGN, and the flow rolls back to it

HIGH_LEVEL_DESIGN
      ├── compatibility check against the accepted set
      ├── update the manifest
      ├── sync the sandbox
      └── CR downstream: "the dependency environment changed, re-check"
```

The distinction between the two directions matters. A need raised *before* HIGH_LEVEL_DESIGN runs is
satisfied by the ordinary forward flow — there is nothing to roll back to. A need raised *after* it
has delivered is a change to an accepted artifact, so the flow returns there and comes forward again.

## 3. Compatibility is a design judgment, not a tool rule

An earlier attempt made `add_dependency` keep whatever version was already declared, on the reading
that existing choices win. That is wrong, and a test said so: a project holding `vitest@1.6.1` and
`@vitest/coverage-v8@1.5.0` needs the *update*, because the coverage provider must match the runner.
Compatibility is about the set staying consistent, which no per-package rule can decide.

So the check lives with HIGH_LEVEL_DESIGN, which sees the whole set, and the tool stays mechanical.

## 4. Work

| # | Change | State |
|---|---|---|
| 1 | Sandbox created before the V-model; a run stops if it cannot be | done — `324e11c` |
| 2 | `add_dependency` owned by HIGH_LEVEL_DESIGN | done — `30c1f03` |
| 3 | A Step that needs a package raises a dependency CR to HIGH_LEVEL_DESIGN | done — `6944331` |
| 4 | A CR arriving after HIGH_LEVEL_DESIGN delivered rolls the flow back to it | done — `6944331`, refused case `bc2d3d7` |
| 5 | HIGH_LEVEL_DESIGN syncs the sandbox after updating the manifest | done — `add_dependency` rebuilds, delivery syncs `fd9125b` |
| 6 | A manifest change propagates a re-check CR downstream | done — `ae72997` |
| 7 | An isolated worktree prepares its own environment | done — `ace2b52` |

## 5. The open question, answered

Item 4 needed a Step that had already delivered to reopen, and the doubt was whether a CR aimed
*upstream* converges when every chain built so far ran downstream. It does, but only because the two
directions were kept apart rather than merged into one mechanism:

- The **upstream** hop is not a chain. It is a single CR on HIGH_LEVEL_DESIGN plus a rollback, and the
  Step that raised it parks on `'dependency'` — it is waiting, not scheduled, so it cannot meet the
  forward flow and strand it.
- The **downstream** re-check is an ordinary chain, opened after the manifest is accepted.

What did not survive contact was the assumption that a re-check should propagate only where the
application recorded entries. A dependency change moves the ground under every later Step whether or
not the design edited anything for it, so `openDependencyRecheck` reaches all of them unconditionally
— the one place the CR-chain termination rule of the [chain plan](./XCompiler_cr_chain_plan.md) §2
deliberately does not apply.

## 6. What the live runs added

Three of the seven items above existed only because a real run failed on them, and each was reachable
only once the previous one was fixed:

1. Cold-cache `npm install` timed out on a weak link — not, as first asserted, because a private
   registry was unreachable. The registry is user-configurable and defaults to the public one; the
   actual fix was npm's own fetch-retry budget.
2. HIGH_LEVEL_DESIGN delivering `package.json` as a *file output* changed the manifest without going
   through `add_dependency`, so nothing rebuilt the sandbox. Delivery now syncs it.
3. A CODE Step forks into its own worktree, where Git restores the manifest but not the untracked
   `node_modules`. The one Step that develops in isolation was the one guaranteed to find no
   toolchain. Every scope now prepares its environment, as the run does.

The shape is the same each time: **one concept decided in several places, and fixing one of them is
not fixing it.** `manifest_missing` needed four guards for the same reason.
