# Node Inspect CLI Reference

Start paused on the first line with `node inspect <script>` or launch the target using
`node --inspect-brk=127.0.0.1:0 <script>` and attach through a loopback inspector URL.

Common commands:

| Command | Action |
|---|---|
| `cont` | Continue execution. |
| `next` | Step over. |
| `step` | Step into. |
| `out` | Step out. |
| `pause` | Pause a running target. |
| `sb(file, line)` | Set a breakpoint. |
| `breakpoints` | List breakpoints. |
| `bt` | Show the call stack. |
| `repl` | Evaluate expressions in the current scope. |

Confirm the attached PID and source file before trusting inspected state. Resume or terminate a
paused target during cleanup.
