---
name: code-review
description: Review a candidate change for correctness, regression risk, architecture boundaries, security, and missing tests. Use before merge or when a review Ticket is assigned.
license: Apache-2.0
compatibility: XCompiler 0.3+ candidate worktrees and merge gates
metadata:
  xcompiler.category: review
  xcompiler.version: "1"
  xcompiler.inspired-by: openhands extensions code-review
allowed-tools: read_file list_dir code_search run_tests run_program
---

# Code Review

## Review Order

1. Read the Ticket/CR contract and candidate changelist.
2. Inspect the diff and trace affected call paths, state transitions, data ownership, and error propagation.
3. Check Runtime/adaptor, Domain/application/infrastructure, PM/Ticket, worktree, permission, audit, and secret boundaries where relevant.
4. Look for behavioral regressions, silent failure, stale state, unsafe defaults, race conditions, incomplete cleanup, and test gaps.
5. Run focused checks only when existing evidence cannot answer a concrete concern.

## Findings

Report actionable findings first, ordered by severity. Each finding names the affected file/location,
observable impact, trigger, and expected correction. Do not manufacture findings to fill a format.

## Verification

Approval requires contract compliance and adequate evidence. Review comments do not replace merge gates or independent delivery verification.
