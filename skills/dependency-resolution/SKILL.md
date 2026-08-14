---
name: dependency-resolution
description: Diagnose and apply project dependency changes at the manifest-owning design Step. Use for missing modules, incompatible versions, install failures, or dependency Change Requests.
license: Apache-2.0
compatibility: XCompiler 0.3+ Python and TypeScript projects
metadata:
  xcompiler.category: dependencies
  xcompiler.version: "1"
allowed-tools: read_file analyze_error add_dependency install_deps run_program run_tests
---

# Dependency Resolution

## Procedure

1. Confirm the missing package or incompatibility from structured failure evidence.
2. Identify the language and authoritative manifest: Python project metadata/requirements or TypeScript `package.json` and lockfile policy.
3. Confirm the current Step owns dependency changes. Otherwise produce a Change Request to the manifest-owning design Step.
4. Prefer an existing dependency or standard library when it already satisfies the contract.
5. Add one justified dependency through `add_dependency`; let the sandbox own manifest and lockfile mechanics.
6. Install with progress-aware monitoring and then rerun the exact failed import/build/test.

## Constraints

- Do not infer package managers from model names or stale prompts.
- Do not hand-edit a lockfile.
- Do not retry a stalled install while its installation directory is still growing.
- Treat registry/network failure separately from an invalid package or version.

## Verification

The manifest records the dependency, a clean environment can install it, and the original import or build failure is resolved.
