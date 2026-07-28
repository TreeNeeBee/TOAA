---
id: system.debug.bug-ticket-flow
layer: system
createdAt: "2026-07-18T00:00:00.000Z"
updatedAt: "2026-07-18T00:00:00.000Z"
status: active
category: unknown
summary: "Bug-first repair with separate Enhance findings and upstream change requests"
primaryError: "Debug attempts must repair recorded Bug Tickets instead of hiding failures"
debugDemand: "Record Bug Ticket evidence, require an explicit bugResolutionPlan, apply a minimal repair, and verify before closure."
fingerprints:
  - "cat:unknown"
  - "debug:bug-ticket-resolution-plan"
symptoms:
  - "Debugger receives a routed Bug Ticket"
  - "Attempt claims done without a reusable repair plan"
solution: "Treat every Debugger retry with bugTicketId as Bug Ticket handling. Track the discovered defect, functional gap, or incomplete test as a separate Enhance Ticket. Create a change-request only when an accepted upstream contract delta must propagate downstream. The LLM must output bugResolutionPlan before or while fixing the bug. Close only after a successful repair or verification action and debug-wiki persistence."
evidence:
  - "bugResolutionPlan is persisted to the Bug Ticket and external wiki after success"
stats:
  uses: 0
  successes: 1
  failures: 0
feedback: []
---

# Bug-Ticket-first debug flow

Failures become Bug Tickets first. The discovered quality gap is classified as an Enhance Ticket; it is not itself a change request. Debugger repairs the bug, and only an accepted upstream contract delta opens a CR for downstream propagation. The repair plan is reusable knowledge and must survive in the external wiki before the Bug and Enhance Tickets close.
