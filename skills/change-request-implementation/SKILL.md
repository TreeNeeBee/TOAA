---
name: change-request-implementation
description: Apply an upstream contract delta as a scoped downstream change. Use when a change-request Ticket is routed to a V-model Step.
license: Apache-2.0
compatibility: XCompiler 0.3+ Change Request Ticket workflow
metadata:
  xcompiler.category: workflow
  xcompiler.version: "1"
allowed-tools: read_file list_dir code_search apply_patch replace_in_file write_file append_file run_tests run_program
---

# Change Request Implementation

## Procedure

1. Read the source Ticket, parent CR, contract delta, affected artifacts, accepted baseline, and target Step.
2. Confirm the delta belongs to this Step. Do not absorb work owned by another V-model stage.
3. Inspect every affected artifact before mutation.
4. Apply only the incremental delta, preserving unrelated accepted behavior.
5. Record changed artifacts and focused verification evidence.
6. If the delta affects the next downstream Step, create the child CR description and dependency evidence for PM routing.

## Completion

- This Step's delta is implemented and verified.
- The CR chain terminates when no downstream artifact or contract changes.
- Source Bug/Enhancement remains unresolved until all affected downstream CRs and gates close.
- A failed CR produces new evidence linked to its parent; it does not restart full development silently.
