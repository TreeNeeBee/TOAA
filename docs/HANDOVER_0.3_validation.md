# Handover — XCompiler 0.3 live validation

Branch: `master`
Pre-review gates: `npm run lint`, `npx tsc --noEmit`, `npm test` → **92 files / 814 tests, all green**
Post-review gates: `npm run lint`, `npm run typecheck`, `npm test` → **92 files / 821 tests, all green**
Refactor-hardening gates: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test` →
**93 files / 826 tests, all green**
Release-artifact gates: full `npm audit` → **0 vulnerabilities**; `npm pack --dry-run` →
**41 files**; cached `npm run package:native` → **signed macOS arm64 v0.3.0 smoke passed**

This session ran `examples/news/news_ts.md` end to end against two OpenRouter models
(`qwen/qwen3.7-plus`, `deepseek/deepseek-v4-flash`) and fixed what the runs exposed:
**38 defects and one performance change**. The development commits were intentionally squashed into
the 0.3 architecture commit before merging to `master`; the historical hashes below are diagnostic
labels from the validation session, not stable repository references.

## 1. How to resume

```bash
npm run build
export OPENROUTER_API_KEY=<key>
node dist/cli/xcompiler.js build -w /tmp/xc-new --name news-ts -t examples/news/news_ts.md --yes
node dist/cli/xcompiler.js run   -w /tmp/xc-new
```

Use a **fresh workspace**. Workspaces built before `e8919a4` have no repository-ownership record;
the new logic will find the repo already present and record `pre-existing`, which permanently
withholds the merge for that workspace. 0.3 is intentionally breaking, so rebuilding is the
supported path.

Watching a run — the state reader used throughout is disposable but useful:

```bash
node -e 'const fs=require("fs");const b=process.argv[1]+"/.xcompiler/objects";const latest=t=>{try{return fs.readdirSync(b+"/"+t).map(id=>{const p=b+"/"+t+"/"+id;const r=fs.readdirSync(p).filter(f=>f.endsWith(".json")).sort((a,z)=>+a.slice(1,-5)-+z.slice(1,-5));return JSON.parse(fs.readFileSync(p+"/"+r.at(-1),"utf8"))})}catch(e){return[]}};console.log(latest("step").map(s=>s.name+"="+s.state).sort().join(" "),"| MR",latest("merge-request").map(m=>m.state),"| GATE",latest("merge-gate-run").map(g=>g.status),"| CS",latest("ticket-change-set").map(c=>c.state))' /tmp/xc-new
```

**The one number that matters:** files under `worktrees/master/src/`. While it is 0, the squash
merge has never landed and Steps S005–S008 cannot see the code CODE wrote.

## 2. What remains

- **DoD 15 is not met.** It is the only release blocker for tagging `v0.3.0`
  (`docs/XCompiler_refactor_plan.md` §15). Every other DoD item is done.
- **The last live-model link:** squash merge landing on the mainline. The gate itself has now run
  and passed against a real generated project (`GATE[passed] MR[approved]`), and every known
  blocker on the path to the merge has been fixed — but no single run has yet gone all the way
  through. Deterministic tests cover repository ownership, merge failure reporting, merge intent
  recovery, and downstream visibility; a fresh live run still has to confirm the complete path.
- **Typed-error hardening completed in the review follow-up:** `DebugBrief` now consumes the Ticket's
  structured failure category and status code before consulting bounded text fallbacks. Executor
  and quality gates use typed failure codes, `blockedBy`, and `unavailableMetrics`; prose remains
  presentation and legacy external-provider evidence, not the primary control channel.
- **Debug feedback was modularized:** verified Bug knowledge synchronization now lives in a dedicated
  application service, while prompt validation/retry policy, executor action policy, output
  verification, Ticket lookup, and blocker routing have independent modules and tests.
- **Resolved in the review follow-up:** the fallback that dropped quality gaps based on model prose
  was removed. Misowned prerequisites use `blockedBy`; failed metric probes use exact identifiers in
  `unavailableMetrics`; true `gaps` are never silently discarded.

## 3. The changes

### Sandbox and dependency environment

| Commit | Change |
|---|---|
| `fd9125b` | Sync the environment when a Step delivers the manifest as a file output |
| `ace2b52` | An isolated worktree prepares its own environment — Git restores the manifest but not the untracked `node_modules`, so CODE, the only Step that develops in isolation, was the only one guaranteed to find no toolchain |
| `8d23fdd` | Sync when **any** tool writes the manifest. `add_dependency` rebuilt and delivery rebuilt; writing the file directly did not, and that is the path a design Step actually takes |
| `a41f961` | An unchanged manifest still prepares the environment. "The manifest did not change" and "the environment needs nothing" are different facts, and the Step that called `add_dependency` had called it *because* its toolchain was missing |
| `da2be30` | Recover when `npm ci` refuses a manifest its lockfile has not caught up to. All three sync paths above were failing this way at once, silently |
| `ce9f529` | Share the package download cache per project (perf). Measured: a cold install timed out at 3 minutes; the retry took 22s, and an isolated worktree 13s |
| `eb5b317` | Test for `ace2b52`, which had been committed without one |

### Merge, gate, and repository

| Commit | Change |
|---|---|
| `88dc5c8` | A failing gate opens the Bug it discovered instead of halting the run — the worktree/MR plan §3.2 settled this and the code did something else |
| `ed896d1` | `integrateTicket` survives its own intervening writes. **Two defects that cancelled**: a ChangeSet copy one revision stale, *and* two mutators each advancing a revision. Being one behind and asking two forward lands on one, so every test passed |
| `f7ef854` | Keep XCompiler's own PM projection out of the generated project. It was tracked by Git and dirtied the working copy, so its own bookkeeping refused its own merge |
| `275cf4d` | Report a merge that cannot be applied instead of throwing, and name the files that blocked it |
| `e8919a4` | Repository ownership is a fact, recorded once — it was re-derived per invocation, so a resumed run refused to merge into a mainline XCompiler had created. Also makes `awaiting-authorization` visible |
| `6c3abb0` | Make the gate verdict read as one decision |
| `8fc61ce` | Test for the `awaiting-authorization` record |

### Dependency Change Request flow

| Commit | Change |
|---|---|
| `9b05c7b` | Hand the manifest owner the tool it owns. Every dependency CR routed correctly to a Step that had no `add_dependency`; `skill:dep_resolver` existed and was wired to nobody |
| `f78527d` | Free the requesting role when a Step parks on a dependency. A Bug held the single developer slot while its Step waited, and the answer arrived as a CR aimed at that same Step — the run aborted. Also lands the `blockedBy` channel |
| `a077065` | Test for `blockedBy`, committed without one |

### Planner and plan rules

| Commit | Change |
|---|---|
| `ab86b7e` | Name the field a module got wrong, not only the rule |
| `9ed5f81` | Run the plan's own lint inside the planner's existing repair loop. A build died with exit 3 after two model calls and the one party able to repair the plan was never told |
| `2d5a6e7` | The repair round fires when the router wraps the failure. The predicate read only the outer message, so **the loop never fired in a real run**; its test drives a bare client where the error propagates unwrapped |
| `c6efb37` | Sibling subtasks get distinct names — three Tickets in one Phase were all `P1-S004-T01S` |

### V-model policy and tooling

| Commit | Change |
|---|---|
| `4e06ea8` | An unownable condition stops counting as a Step's quality gap |
| `e732964` | `run_program` gets the toolchain diagnosis `run_tests` already had. A Debugger reached for the runner directly and was still going at round six |
| `7f19d8d` | Stop grading a design Step on a product CODE has not written. 43 × TS18003, and the repair the models converged on was editing `tsconfig.json` to point at a non-source file. Also consolidates three "is this the Step's to own" decisions into one predicate, `isUnownedStepFailure` |

### Documentation

`aba31a4`, `0d5f5e6`, `b4439e7`, `7408f04`, `38d19cf`, `5e1673c` — design records updated to match
what the runs proved. The durable content is `docs/XCompiler_refactor_plan.md` §15.1.

## 4. What generalises

Recorded in `docs/XCompiler_refactor_plan.md` §15.1. Worth carrying into whatever comes next:

1. **Defects are layered, and reasoning cannot converge on them.** Each sandbox defect was only
   reachable once the previous one was fixed. No amount of reading found the second before the
   first was repaired.
2. **Two defects can cancel.** The stale ChangeSet copy and the double revision increment hid each
   other from a fully green suite. Fixing either alone made the other visible. This is the
   strongest argument in the refactor for tests that exercise the real seam — the unit harness
   stubbed the repository as a static object answering the same record for every id.
3. **A mechanism can be dead in production while its test is green.** The planner's repair loop
   keyed on message text; the provider router wraps every failure. Branch on structure, and check
   what the production path actually hands the predicate.
4. **A rule stated in one place is decided in several.** The tool refused every phase but
   HIGH_LEVEL_DESIGN; the calibration handed HIGH_LEVEL_DESIGN a skill without that tool.
5. **Downgrading a failure to a note obliges someone to read the note.** Three sandbox syncs failed
   for a whole run, each recording a note and continuing. `awaiting-authorization` hid a passing
   merge gate the same way.

## 5. Working rules this branch follows

- **Every behavioural change is falsified before committing**: revert it, confirm the specific test
  fails for the stated reason, restore, confirm it passes. Three changes this session were
  committed without it and were corrected afterwards (`eb5b317`, `a077065`, `8fc61ce`).
- **Branch on typed codes, never on message prose.** `ToolFailureCode` exists for this.
- **Name the action, not only the fault.** A failure a caller cannot act on is a failure that
  repeats — the recipient is usually a model with a bounded round budget.
- Tests that encode a contract being changed are **rewritten, keeping their intent**, not deleted.
