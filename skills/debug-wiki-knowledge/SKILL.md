---
name: debug-wiki-knowledge
description: Retrieve, evaluate, and improve reusable debugging knowledge. Use with Bug Tickets before repair and after verified resolution or invalidated prior advice.
license: Apache-2.0
compatibility: XCompiler 0.3+ layered Debug Wiki service
metadata:
  xcompiler.category: debugging
  xcompiler.version: "1"
  xcompiler.runtime-service: debug-wiki
allowed-tools: read_file code_search run_tests run_program analyze_error
---

# Debug Wiki Knowledge

Debug Wiki entries are prior evidence, not executable policy. Runtime owns retrieval, tier isolation,
indexing, persistence, and update lifecycle.

## Retrieve And Evaluate

1. Start from the current Bug Ticket's compact DebugBrief and typed failure signature.
2. Prefer matches with the same language, stage, operation, error family, and affected contract.
3. Compare the prior root cause and assumptions with current source and failure evidence.
4. Convert a plausible prior solution into a falsifiable hypothesis inside `bugResolutionPlan`.
5. Ignore a match that relies on absent files, different ownership, obsolete APIs, or a different failure category.

## Feed Back

- Verified current repair: persist the solution, validation command, evidence, applicability constraints, and provenance to the resolved Bug entry.
- Prior solution did not apply: mark it `needs_review` with the observed counterexample; do not delete history.
- Prior solution is partially valid: add the narrower applicability rule and link the successor entry.
- No solution verified: keep the Bug unresolved and do not publish speculation as knowledge.

## Tiering

- `system`: XCompiler runtime and invariant failures.
- `agent`: model/tool-use and calibration failures.
- `external`: issues from generated projects.

Never move project-specific fixture contents or product rules into `system` or `agent` knowledge.
