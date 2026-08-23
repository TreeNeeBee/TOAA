---
name: python-debugger
description: Debug Python runtime state with pdb or debugpy when a reproducible failure cannot be explained from tracebacks and focused probes.
license: Apache-2.0
compatibility: Requires Python; remote debugpy sessions require an isolated local listener and Runtime permission
metadata:
  xcompiler.category: debugging
  xcompiler.version: "1"
allowed-tools: read_file code_search run_program run_tests analyze_error
---

# Python Debugger

Use after `systematic-debugging` establishes the failing selector.

1. Prefer `python -m pdb` for a short local script or one pytest test.
2. Use `break`, `where`, `up`, `down`, `p`, `pp`, `next`, `step`, `continue`, and `until` to inspect the smallest relevant frame.
3. For pytest, disable output capture only for the narrow selector.
4. Use debugpy only when attach semantics are necessary and bind to loopback in an isolated environment.
5. Never expose a debugger port publicly or persist inspected secrets.
6. Confirm the paused file, line, process, and input match the Bug evidence.

If the available sandbox cannot maintain an interactive process session, report the capability blocker and fall back to a deterministic probe or targeted instrumentation.
