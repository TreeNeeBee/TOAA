---
name: test-flake-investigation
description: Isolate nondeterministic tests and race-dependent failures. Use when identical revisions alternate between pass and fail or timing changes behavior.
license: Apache-2.0
compatibility: XCompiler 0.3+ test sandboxes
metadata:
  xcompiler.category: testing
  xcompiler.version: "1"
allowed-tools: read_file code_search run_tests run_program analyze_error apply_patch replace_in_file
---

# Test Flake Investigation

1. Prove nondeterminism by repeating the narrow selector on one unchanged revision and recording pass/fail signatures.
2. Fix seeds, time, timezone, locale, ports, filesystem order, network data, and concurrency one variable at a time.
3. Prefer condition-based waiting over arbitrary sleeps. Capture the state transition that should end the wait.
4. Use Record/Replay for external interactions and unique temporary resources for parallel tests.
5. Identify whether the test, product synchronization, shared state, or environment owns the race.
6. Add a high-reproduction regression, apply one root-cause fix, then repeat enough runs to demonstrate improvement.

Do not hide a flake with retries, larger timeouts, disabled parallelism, or quarantine unless the Ticket explicitly accepts that temporary containment.
