---
name: record-replay-fixtures
description: Prepare, verify, freeze, replay, and refresh deterministic external-data fixtures. Use for HTTP, LLM, and tool-backed tests that require reproducible real data while current project code still executes.
license: Apache-2.0
compatibility: XCompiler 0.3+ Runtime Record/Replay controller
metadata:
  xcompiler.category: testing
  xcompiler.version: "1"
  xcompiler.runtime-service: record-replay
allowed-tools: read_file list_dir http_fetch run_tests run_program skill_resource
---

# Record And Replay Fixtures

This Skill guides fixture lifecycle. Runtime remains authoritative for mode selection, capture,
redaction, hash chains, storage, permissions, and delivery-gate live execution.

Record/Replay controls external data at the interaction boundary. It never substitutes a recorded
build, program, or test exit code for execution against the current source tree.

## Modes

- `record`: call the real dependency and append a new recording.
- `replay`: require one exact valid recording; never fall through to live access.
- `auto`: replay an exact match or record a live miss when Runtime permits it.
- `refresh`: call live and supersede prior matching recordings without deleting history.
- `off`: bypass fixtures; reserved for declared live scenarios and explicit operations.

For detailed failure disposition, load `references/failure-routing.md` with `skill_resource` only
when a fixture check fails.

## Procedure

1. Identify the external contract and stable request fields. Remove timestamps, random IDs, and secrets from test intent where possible.
2. Record a minimal representative success and the failure variants required by the contract.
3. Inspect fixture provenance, channel, operation, request identity, redaction, and integrity report.
4. Freeze the test selector and execute the current test code in `replay` mode, serving only its
   external interactions from fixtures.
5. Refresh only when the external contract intentionally changed; retain supersession history.

## Failure Routing

- Replay miss: fixture coverage gap or unstable request identity.
- Multiple active matches: ambiguous fixture history; repair the recording chain.
- Hash/integrity failure: corrupt fixture; never silently rerecord over it.
- Secret detection: remove or redact the sensitive field before recording.
- Replayed response exposes a product defect: create the normal Bug or Enhancement; do not rewrite the fixture to make the test pass.

## Verification

The frozen test passes without network access, fixture integrity validates, and the Phase delivery gate still executes its declared real-user scenarios with Replay disabled.
