---
name: focused-file-editing
description: Apply small, evidence-backed edits to existing workspace files. Use for Bug fixes, Change Requests, targeted refactors, and review corrections.
license: Apache-2.0
compatibility: XCompiler 0.3+ project workspaces
metadata:
  xcompiler.category: file
  xcompiler.version: "1"
allowed-tools: read_file code_search apply_patch replace_in_file
---

# Focused File Editing

## Use When

- An existing accepted file needs a localized correction.
- Failure evidence identifies a symbol, import, assertion, or bounded region.
- A Change Request carries an explicit contract delta.

Do not replace an entire existing file to avoid understanding its current content.

## Procedure

1. Confirm the concrete workspace-relative target from evidence or the writable allowlist.
2. Read the current target bytes or a sufficient bounded region.
3. Search sibling call paths when the same defect class may occur elsewhere.
4. Prefer `replace_in_file` for one exact fragment and `apply_patch` for related hunks.
5. Make one coherent change that addresses the root cause and preserves unrelated behavior.
6. Run the narrowest verification that can falsify the repair.

## Failure Handling

- A missing or ambiguous match means the file changed: reread once and rebuild the patch.
- Two failed replacements on the same target require a fresh bounded read, not repeated guesses.
- A denied path is a scope or ownership problem; do not retry with alternate spellings.

## Verification

- The intended fragment changed exactly once unless evidence requires multiple sites.
- No surrounding content was truncated.
- The original failure is now green and the nearest sibling path remains green.
