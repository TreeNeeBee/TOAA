---
name: verification-before-delivery
description: Require fresh, attributable evidence before a Step, Phase, Ticket, or Project is reported delivered. Use at completion and delivery gates.
license: Apache-2.0
compatibility: XCompiler 0.3+ quality and delivery gates
metadata:
  xcompiler.category: verification
  xcompiler.version: "1"
  xcompiler.inspired-by: superpowers verification-before-completion
allowed-tools: read_file list_dir run_tests run_program
---

# Verification Before Delivery

## Evidence Rule

Do not claim an artifact, test, gate, Phase, or Project is complete from model confidence, an old log,
or another actor's summary. Use fresh evidence tied to the current revision and declared gate.

## Procedure

1. Resolve the exact owner, revision, deliverables, checkpoints, KPI/tolerance, and gate contract.
2. Confirm every required artifact exists and aligns with accepted upstream contracts.
3. Run the Runtime-owned baseline and supplemental selectors; do not widen or replace them with easier tests.
4. At Phase delivery, execute declared real-user scenarios in the real environment with Replay disabled.
5. Preserve command, environment, timestamp, exit status, timeout, output tail, and artifact hashes.
6. Submit every independent failure as separate evidence so PM can route multiple Tickets.

## Outcome

Deliver only when all required evidence is green. A skipped or unavailable gate is reported as unverified, never converted to pass.
