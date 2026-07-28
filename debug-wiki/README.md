# XCompiler Debug Wiki

This directory is a bundled LLM-wiki style knowledge base for Debugger repair.

- `wiki/system/` contains system-level debug policies and safety rules.
- `wiki/agent/` contains agent-level calibration knowledge derived from recurring LLM failure patterns.
- `wiki/external/` is created in the runtime copy and stores resolved Bug Ticket knowledge and feedback.
- `index.md` is regenerated in the runtime copy as a human-readable catalog.
- `index.json` is regenerated in the runtime copy as a machine-readable retrieval index.
- `log.md` is an append-only runtime operation log for retrieval, failed reuse, and confirmed repairs.

At runtime XCompiler copies `system` and `agent` pages into the configured debug-wiki root, builds `index.md` and `index.json`, and appends only real project feedback to the `external` layer.
