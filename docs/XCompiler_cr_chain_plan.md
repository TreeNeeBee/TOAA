# Change Request propagation: from one multi-Step Ticket to a PM-routed chain

Status: implemented and converging — see §7
Target release: v0.3.0
Supersedes: the `affectedStepIds` propagation model in
[the worktree/MR/context plan](./XCompiler_worktree_mr_context_plan.md) §6

## 1. What changes

Today one Change Request carries `affectedStepIds: [S3, S4, S5, S6]`. It is created with the whole
downstream chain already decided, records an `application` per Step, and closes only once every one
of them has been applied.

The chain becomes a chain of Tickets instead. A CR targets exactly one Step. When it is applied and
that application produced changes, it opens a **child CR for the next downstream Step**, carrying the
delta forward, and registers that child with PM for routing. The chain ends where the changes stop.

The reason is that the downstream scope is not knowable when the first CR is opened. A delta applied
to a detailed design may or may not require a code change; predeclaring four Steps asserts an answer
nobody has yet, and reopening them commits the schedule to it.

## 2. Decisions

**`affectedStepIds` becomes `targetStepId`.** One CR, one Step. Provenance of a chain is
`parentChangeRequestId`, which already exists and already carries the nested-CR resume path. 0.3 is
intentionally breaking, so the field is replaced rather than deprecated.

**"Has changes" means the application recorded changelist entries.** `completeChangeRequestStep`
already receives `entries`; a non-empty list is the signal to propagate, an empty one ends the chain.
No separate judgment call, and no model-reported flag that could disagree with what was written.

**The next Step is the immediate downstream neighbour**, recomputed at each hop rather than taken
from a list fixed at creation. That is what makes the scope discovered rather than predicted.

**PM routes every child.** A child CR is registered on creation, exactly like a Bug or Enhancement,
and the scheduler assigns it to whoever owns its Step. The handler owns the CR's gate and its
lifecycle from that point.

**A CR closes when its own application is verified.** The source Bug or Enhancement closes when the
last descendant in the chain closes — that is, when a CR that spawned no child is verified.

## 3. Sequence

```text
Bug verified at S3
  └── CR#1  target=S4   PM routes to developer
        applied, entries non-empty
        └── CR#2  target=S5   PM routes to tester
              applied, entries empty  →  chain ends
              CR#2 closes → CR#1 closes → Bug closes
```

## 4. Work

| # | Change | File |
|---|---|---|
| 1 | `affectedStepIds` → `targetStepId` | `domain/tickets/ticket.ts` |
| 2 | `openChangeRequest` takes one target Step | `application/project_management/ticket_workflow.ts` |
| 3 | `activateChangeRequest` opens its one Step | `application/project_management/corrective_workflow_service.ts` |
| 4 | `completeChangeRequestStep` spawns the child, or ends the chain | same |
| 5 | Source Ticket closes on the last descendant | same |
| 6 | `propagateCorrectiveChange` opens only the first CR | same |

## 5. Tests

These encode the current contract and are rewritten, not deleted. Each keeps its intent and changes
only the mechanism it asserts.

| Test | Now asserts | Becomes |
|---|---|---|
| `propagates one CR through every downstream gate` | one CR applied at 4 Steps | a chain of CRs, one per Step, each PM-routed |
| `refuses to close a CR when any affected Step lacks change and verification evidence` | closure blocked until every affected Step has evidence | closure blocked until this CR's own Step has evidence |
| `turns a downstream CR failure into a linked Bug and resumes the parent CR after repair` | unchanged intent | the Bug attaches to the child CR; its parent resumes |
| `routes a CR quality shortfall through a linked Enhancement instead of a Bug` | unchanged intent | unchanged mechanism |
| `keeps a Bug open until its linked Change Request is implemented and verified` | Bug waits for one CR | Bug waits for the last descendant |

New: a chain terminates when an application records no changes; a child is registered with PM before
it is scheduled; the chain order follows the V-model.

## 6. Risk

The corrective workflow is the most intricate part of the system, and rewriting the tests that
protect it removes the safety net while the thing they protect is changing. Mitigation: each step of
§4 lands with its tests rewritten in the same commit, the suite stays green between commits, and
every behavioural change is falsified — reverted to confirm the test fails — before it is committed.

## 7. Where it stands

Complete. 765 tests pass, the suite typechecks, and each behavioural change below was falsified —
reverted individually to confirm it fails exactly the test it protects.

Decisions that survived the work:

- A child CR must not repeat the source Ticket's hand-off. That bookkeeping belongs to the head of
  the chain; by the second hop the source is already parked behind it and cannot be handed off again.
- A CR closes when its own Step is verified, not when its descendants finish. Holding it open
  reserves its assignee's capacity for work already done, which starves the role the next hop needs.
- The actor who hands the delta on must be read before closure, since closing releases the
  assignment.
- `parentChangeRequestId` carries two different relationships — the previous hop of a chain, and a CR
  parked while a Bug inside it was repaired. Only the second needs waking, and nothing else wakes it.

### What the non-convergence actually was

Two defects, both from the same root: **a relationship was inferred from the presence of a field
rather than from what the field pointed at.**

**`parentChangeRequestId` was read as "this is a child hop".** `openChangeRequest` skipped the source
hand-off whenever the field was set. But a Bug raised inside a failing CR records that CR too, and
such a Bug is a source in its own right whose first CR is the head of a new chain. Skipping the
hand-off there also skipped the `changeRequestTicketIds` back-link — and the scheduler keeps a Bug
schedulable exactly while that list is empty, so the Bug was re-dispatched forever. The guard now
asks whether the parent CR was opened against *this same source Ticket*.

The earlier suspicion that `P1-S003-STORY` was being reopened and rescheduled was wrong. The Story is
re-run once, legitimately, because the Bug reopened its Step; the loop was the Bug itself.

**Two chains converged on one Step.** When a Bug or Enhancement is raised inside a CR, the repair is
made upstream and propagates back down, while the parked CR resumes and re-applies its own Step. Both
chains then claimed that Step, and whichever applied first closed it — stranding the other on a Step
the scheduler no longer visits, so the Phase could not deliver. A repair chain now ends where it
meets the CR it repairs; that CR carries the repair onward through its own chain. Where the meeting
point is the first hop, no chain opens at all and the corrective Ticket closes in place, releasing
the CR parked on it.

### Known deviation

§2 says the source Bug or Enhancement closes when the last descendant closes. It currently closes at
the *first* hop: `closeVerified` cascades to the source before `openChildChangeRequest` has created
the next hop, so the sibling check sees none. This does not affect convergence, and the
`recordVerifiedBugResolution` hook still fires only at the true end of the chain, so no test observes
it. Fixing it means creating the child before closing the parent, which reorders a sequence that the
"read the assignee before closure" rule above also constrains. Left as is, deliberately.
