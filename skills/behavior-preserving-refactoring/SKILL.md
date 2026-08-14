---
name: behavior-preserving-refactoring
description: Improve internal structure without changing accepted behavior. Use for explicit refactor Tickets after baseline behavior is verified.
license: Apache-2.0
compatibility: XCompiler 0.3+ project workspaces
metadata:
  xcompiler.category: refactoring
  xcompiler.version: "1"
allowed-tools: read_file code_search apply_patch replace_in_file write_file append_file run_tests run_program
---

# Behavior-Preserving Refactoring

## Procedure

1. Define the structural objective and the public behavior that must remain invariant.
2. Run the smallest relevant baseline before editing.
3. Map ownership and dependencies; avoid moving lifecycle policy into adapters or infrastructure details into Domain.
4. Make one structural change at a time using focused edits.
5. Run the focused baseline after each coherent extraction, then the broader affected suite.
6. Remove obsolete code only after all callers and persisted references are proven absent.

## Constraints

- Do not mix feature changes or compatibility shims into a pure refactor unless the Ticket explicitly requires them.
- Do not duplicate state while extracting modules.
- Do not replace behavior tests with implementation snapshots.

## Verification

Public behavior, lifecycle transitions, persisted state, adapters, and package exports remain unchanged while the requested structure improves.
