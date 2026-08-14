---
name: test-execution
description: Independently inspect, supplement when authorized, freeze, and execute V-model tests. Use in S5-S8 verification Steps and correction gates.
license: Apache-2.0
compatibility: XCompiler 0.3+ Python and TypeScript projects
metadata:
  xcompiler.category: testing
  xcompiler.version: "1"
allowed-tools: read_file list_dir code_search write_file append_file run_tests run_program analyze_error http_fetch
---

# Test Execution

## Procedure

1. Inspect the paired baseline, accepted contract, current implementation, and Runtime-owned test selector.
2. Check test completeness independently before execution.
3. When the Step permits supplements, add only risk-driven tests under the designated supplemental root.
4. Use `record-replay-fixtures` for external data and freeze the complete baseline plus supplement set.
5. Execute with `run_tests`; use `run_program` only for a declared executable scenario.
6. Classify each failure before routing it.

## Failure Classification

- Broken assertion, malformed fixture, or invalid harness: test defect; repair only the supplemental test this Step owns.
- Missing contract coverage or KPI/tolerance shortfall: Enhancement for the paired upstream Step.
- Correct test exposing product behavior: Bug for the paired upstream Step.
- Dependency, environment, permission, or replay failure: preserve its typed evidence and use its dedicated route.

Do not edit product code or accepted baseline tests from a verification Step.

## Verification

Report the exact command, exit status, selected tests, coverage/KPI evidence, fixture mode, and unresolved findings.
