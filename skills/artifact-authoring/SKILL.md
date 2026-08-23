---
name: artifact-authoring
description: Create declared Step deliverables and new source or documentation files. Use when a V-model Step owns outputs that do not yet exist.
license: Apache-2.0
compatibility: XCompiler 0.3+ project workspaces
metadata:
  xcompiler.category: file
  xcompiler.version: "1"
allowed-tools: read_file list_dir write_file append_file
---

# Artifact Authoring

## Use When

- The current Step declares a missing output.
- A new file is required by the accepted design or Ticket.
- A large output must be created incrementally within the current context window.

Do not use this workflow to overwrite an accepted existing file during a correction. Use
`focused-file-editing` unless Runtime explicitly authorizes an exact rewrite target.

## Procedure

1. Read the Step outputs, writable paths, accepted upstream contracts, and relevant neighboring files.
2. Choose one concrete workspace-relative output path. Never invent an absolute or project-external path.
3. Create the smallest complete first chunk with `write_file`.
4. Continue large files with `append_file`, preserving syntax at every chunk boundary.
5. Read back boundary regions when a generated file spans multiple chunks.
6. Run the smallest parser, compiler, or test that validates the artifact when one is available.

## Verification

- Every declared output owned by this action exists at its exact path.
- Generated code parses or compiles.
- No unrelated accepted file was rewritten.
- The artifact agrees with upstream requirements and design contracts.
