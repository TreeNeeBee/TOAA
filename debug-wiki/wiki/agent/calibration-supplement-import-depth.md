---
id: agent.calibration.supplement-import-depth
layer: agent
createdAt: "2026-08-16T00:00:00.000Z"
updatedAt: "2026-08-16T00:00:00.000Z"
status: active
category: test_failure
summary: "A verification supplement sits five directories down, not three"
primaryError: "Failed to load url ../../../src/... Does the file exist?"
debugDemand: "Use the prefix the gate names; do not count the directories by hand."
fingerprints:
  - "cat:test_failure"
  - "err:failed-to-load-url"
  - "path:tests-verification-supplement"
symptoms:
  - "Failed to load url ../../../src/<module> in tests/verification/..."
  - "One suite fails to collect while every baseline suite beside it passes"
  - "The same import path is rewritten across several attempts without converging"
resolutionPlan: "Read the supplement root the delivery-gate message names, count nothing, and use the prefix it gives verbatim. The root is tests/verification/<iteration>/<phase>/<step-id>/, which is five levels below the repository root, so the product is reached with ../../../../../src/…"
solution: |
  The verification supplement namespace nests an iteration, a phase, and a Step id:

      tests/verification/p1/unit-test/019ff69f-3feb-7f66-942b-fcf6188d6af5/supplement.test.ts

  That is five directories below the repository root, and one of the segments is a UUID, which
  makes the depth easy to misjudge. `../../../src/...` resolves inside `tests/` and the module
  loader reports the product file as missing.

  Two separate live Steps spent their entire attempt budget on this single off-by-one while every
  baseline case beside them passed — the failure looks like a missing module, so the repair loop
  goes hunting for the module instead of counting the path.

  The delivery-gate entry inspection prints the exact prefix for the current root. Use that string
  as given. If it is not in front of you, derive it from the root rather than from the file: the
  root has five segments, so the prefix has five `../`.
evidence:
  - "Live UNIT_TEST: 7/7 attempts consumed on ../../../../src/... against a five-deep root"
  - "Live MODULE_TEST: same signature, ../../../src/scrapers/baidu.ts"
language: any
stats:
  uses: 0
---

## When this applies

A verification level added a supplemental test under its own namespace and the suite fails to
collect with a module-resolution error naming a path under `src/`.

## Why the repair loop stalls on it

The error says the file does not exist, which points attention at the product rather than at the
importing test. The product file is present and correct; only the path from the supplement to it is
wrong. Every attempt that goes looking for the missing module finds nothing to fix.

## What to do

1. Look at the failing test's own path, not at the module it names.
2. Count the segments of the supplement root — not of the file.
3. Emit that many `../`, then the product path.
