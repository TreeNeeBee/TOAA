---
name: test-design
description: Design baseline tests from requirements, architecture, detailed design, and code contracts. Use in S1-S4 when a Step owns paired V-model test cases.
license: Apache-2.0
compatibility: XCompiler 0.3+ Python and TypeScript projects
metadata:
  xcompiler.category: testing
  xcompiler.version: "1"
allowed-tools: read_file list_dir code_search write_file append_file
---

# Test Design

## Procedure

1. Identify the paired verification Step and the contract this baseline proves.
2. Derive cases from observable behavior, interfaces, dependencies, failure modes, and tolerance/KPI requirements.
3. Separate unit, integration, module/system, and functional concerns; do not duplicate a later Step's ownership.
4. Create deterministic tests and all required fixtures. Prefer workspace/user samples or authoritative public samples for complex formats.
5. Use controlled mocks where the contract permits them. For external interactions, use XCompiler Record/Replay rather than hiding a live dependency behind an incomplete mock.
6. Record the test selector and expected evidence in the owning Step artifact.

## Test Quality

- Assert behavior and invariants, not incidental implementation details.
- Include success, boundary, invalid-input, and relevant failure paths.
- Do not modify production behavior solely to simplify a test.
- Never reference a fixture that is not created or recorded.

## Verification

S1-S3 validate test artifacts structurally on the initial pass because product code does not exist yet. S4 and correction passes execute the paired baseline through the Runtime-owned gate.
