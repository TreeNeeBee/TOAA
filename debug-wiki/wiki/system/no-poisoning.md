---
id: system.debug.no-poisoning
layer: system
createdAt: "2026-07-18T00:00:00.000Z"
updatedAt: "2026-07-18T00:00:00.000Z"
status: active
category: tool_loop
summary: "Do not poison XCompiler with generated project-specific fixes"
primaryError: "Generated project failures must be fixed through process or agent behavior, not hardcoded into XCompiler."
debugDemand: "Fix Debugger/Coder workflow, tool contracts, or prompts; never add generated project fixtures or domain-specific hacks to XCompiler core."
fingerprints:
  - "cat:tool_loop"
  - "policy:no-poisoning"
symptoms:
  - "A real sample project fails repeatedly"
  - "Proposed fix adds project fixture or generated-project rule into XCompiler"
solution: "When a generated project exposes a recurring failure, fix the generic agent/tool/debug process. Do not add DBC/news/test-project-specific fixtures, hardcoded APIs, or one-off output rules to XCompiler core. External wiki entries may record the resolved Bug Ticket knowledge, but system/agent rules must remain general."
evidence:
  - "Project-specific hardcoding is treated as poisoning"
stats:
  uses: 0
  successes: 1
  failures: 0
feedback: []
---

# No poisoning

XCompiler can learn from generated projects, but the learning must be generalized. Specific project artifacts belong to the generated project or the external wiki layer.
