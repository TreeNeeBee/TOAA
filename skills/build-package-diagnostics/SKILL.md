---
name: build-package-diagnostics
description: Diagnose compilation, dependency installation, packaging, module resolution, and release artifact failures. Use for failed build or package gates.
license: Apache-2.0
compatibility: XCompiler 0.3+ Python and TypeScript projects
metadata:
  xcompiler.category: debugging
  xcompiler.version: "1"
allowed-tools: read_file list_dir code_search analyze_error run_program run_tests add_dependency install_deps apply_patch replace_in_file
---

# Build And Package Diagnostics

1. Capture the exact command, runtime/toolchain versions, cwd, manifest/lockfile, target, exit code, and first causal error.
2. Reproduce the narrowest failing build stage; do not rerun an expensive package pipeline when typecheck or import resolution already fails.
3. Distinguish source errors, module-format/resolution errors, missing dependencies, incompatible runtime versions, stale generated output, and packaging-tool limitations.
4. For installs, use progress-aware waiting: refresh the inactivity timer while the install directory grows and fail only after the configured no-growth interval.
5. Repair the owning source, manifest, or package configuration without hand-editing generated lock data.
6. Verify the narrow stage, full build, package contents, and a clean-artifact smoke run.
