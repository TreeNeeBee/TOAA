---
name: node-inspect-debugger
description: Debug TypeScript or Node.js state with the V8 inspector when tests and ordinary process output cannot expose the root cause.
license: Apache-2.0
compatibility: Requires Node.js inspector support; interactive stepping additionally requires a PTY process-session Tool
metadata:
  xcompiler.category: debugging
  xcompiler.version: "1"
  xcompiler.inspired-by: hermes-agent node-inspect-debugger
allowed-tools: read_file code_search run_program run_tests analyze_error skill_resource
---

# Node Inspector Debugging

Use only after `systematic-debugging` establishes a tight reproduction and ordinary output is insufficient.

## Non-Interactive Procedure

1. Confirm Node version, module format, source maps, entrypoint, and exact failing selector.
2. Start the narrow target with `--inspect-brk=127.0.0.1:0` where the sandbox supports it.
3. Never bind an inspector to `0.0.0.0`; inspector access permits arbitrary code execution.
4. For Vitest, isolate one file/test and avoid worker pools while debugging.
5. Verify that paused source maps to the intended TypeScript/JavaScript file and PID.

Current XCompiler `run_program` is one-shot. If interactive stepping, attaching, or follow-up input is
required and no PTY process-session Tool is available, return a capability blocker instead of pretending the session ran.

Load `references/cli-reference.md` only when an interactive process-session Tool is actually available.

## Common Failures

- `--inspect` does not pause before fast code; use `--inspect-brk`.
- Breakpoints in emitted JavaScript do not automatically match TypeScript without valid source maps.
- Parent inspector flags do not guarantee child-process inspection.
- A paused process must be resumed or terminated during cleanup.
