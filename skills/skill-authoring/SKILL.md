---
name: skill-authoring
description: Create or revise XCompiler Agent Skills that conform to the Agent Skills Specification and preserve Runtime security and lifecycle boundaries.
license: Apache-2.0
compatibility: XCompiler Plugin API 3 and Agent Skills Specification
metadata:
  xcompiler.category: skills
  xcompiler.version: "1"
  xcompiler.inspired-by: anthropics skills and hermes-agent skill authoring
allowed-tools: read_file list_dir code_search write_file append_file apply_patch replace_in_file run_tests
---

# Skill Authoring

1. Define the behavior change, trigger, non-trigger, expected evidence, required Tools, and Runtime boundary.
2. Write a failing recognition, application, edge, or pressure scenario before changing the Skill.
3. Create `skills/<name>/SKILL.md`; `name` must match the directory and use lowercase letters, numbers, and single hyphens.
4. Put what/when in `description`. Keep the body under 500 lines and move focused details into one-level `references/` files.
5. Declare only needed `allowed-tools`. A Skill may guide use of Runtime services but cannot replace lifecycle, permissions, path confinement, audit, or integrity enforcement.
6. Test metadata parsing, activation, expected behavior, counterexamples, missing resources, unknown Tools, and conflict handling.
7. Update package assets and Plugin API documentation when distribution or extension behavior changes.

Do not copy third-party Skill bodies without license review and attribution. Prefer an original XCompiler workflow adapted to its V-model and Ticket architecture.
