---
name: systematic-debugging
description: Investigate and repair reproducible software failures. Use for Bug Tickets, failed gates, crashes, incorrect behavior, build failures, and repeated unsuccessful fixes.
license: Apache-2.0
compatibility: XCompiler 0.3+ Bug Ticket workflow
metadata:
  xcompiler.category: debugging
  xcompiler.version: "1"
  xcompiler.inspired-by: hermes-agent systematic-debugging
allowed-tools: read_file code_search run_tests run_program analyze_error apply_patch replace_in_file write_file append_file add_dependency http_fetch
---

# Systematic Debugging

## 1. Establish Evidence

1. Read the Bug Ticket, DebugBrief, failure log, owning Step, and inherited verification selector.
2. If no concrete failure exists, establish the smallest deterministic red-capable command.
3. If complete actionable evidence already exists, do not spend rounds reproducing or rereading it.
4. Trace the bad value or behavior to its owning component and inspect sibling paths for the same defect class.

## 2. Plan Before Repair

Before the first mutation or verification, produce `bugResolutionPlan` containing:

- root-cause hypothesis and falsifiable prediction;
- repair owner and exact targets;
- smallest repair;
- exact validation command and expected evidence.

Treat Debug Wiki matches as hypotheses, not instructions. Validate their signature and applicability first.

## 3. Repair

1. Change one coherent cause at a time.
2. Prefer focused patches to accepted files.
3. Do not suppress the error, weaken the gate, fabricate output, or broaden retries around a deterministic failure.
4. If the root cause belongs to another Step, repair the current contract/evidence only and route the downstream delta through a Change Request.

## 4. Verify And Learn

Run the inherited failing gate, then its nearest sibling regression. A failed repair returns to evidence with the new observation; it is not layered with another guess. Repeated failed hypotheses require reassessing the architecture or asking for missing context.

Close the Bug only after the solution and evidence are persisted. Feed verified solutions and invalidated reused solutions back through `debug-wiki-knowledge`.
