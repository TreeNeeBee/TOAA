---
name: file-operations
description: Inspect, create, append, search, and safely edit files inside the current XCompiler workspace. Use when a task needs mixed file discovery and mutation operations.
license: Apache-2.0
compatibility: XCompiler 0.3+ project workspaces
metadata:
  xcompiler.category: file
  xcompiler.version: "1"
  xcompiler.related-skills: artifact-authoring focused-file-editing
allowed-tools: read_file list_dir code_search write_file append_file apply_patch replace_in_file
---

# File Operations

Use the narrowest workflow:

- Existing-file correction: follow `focused-file-editing`.
- New declared output: follow `artifact-authoring`.
- Discovery only: use targeted `list_dir`, `code_search`, and bounded `read_file` calls.

## Rules

1. Every file call uses a concrete workspace-relative path.
2. Read operations remain inside the project workspace; write operations also require the current Step allowlist.
3. Prefer targeted searches over recursive inspection of dependencies, generated output, control state, or audit data.
4. Do not encode sample-project filenames or infer paths from an unrelated prior project.
5. A large file is processed in context-sized windows; retain the exact offset and continuation target.
6. A correction patches accepted content. Whole-file rewrite is reserved for new files or exact Runtime-authorized rewrite targets.

## Verification

Read back changed boundaries, then run the parser, compiler, or test appropriate to the file type.
