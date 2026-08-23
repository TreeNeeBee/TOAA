---
id: agent.calibration.outcome-assertions
layer: agent
createdAt: "2026-08-16T00:00:00.000Z"
updatedAt: "2026-08-16T00:00:00.000Z"
status: active
category: test_failure
summary: "A suite that asserts shape passes on output that is wrong"
primaryError: "Acceptance suite passes while the delivered result is incorrect"
debugDemand: "Assert what the produced values are, not that fields exist and have the right type."
fingerprints:
  - "cat:test_failure"
  - "assert:shape-only"
  - "gate:scenario-outcome-mismatch"
symptoms:
  - "Every test passes but the delivered output is visibly wrong"
  - "Assertions are typeof / toHaveProperty / length > 0 / toBe('string')"
  - "Phase delivery gate reports the scenario result does not meet its expectation"
resolutionPlan: "Read the scenario expectation the Phase declared, then compare each field of the produced result against it: exact values, counts, ordering, ranges, and the absence of wrong content. Add the missing assertions to the acceptance suite rather than weakening the expectation."
solution: |
  Assertions that only describe shape are satisfied by output that is duplicated, empty, or
  nonsense for the field it fills. `expect(typeof item.title).toBe('string')` and
  `expect(item.url).toMatch(/^https?:/)` both pass on a record whose summary is pasted twice and
  whose timestamp is the moment of collection rather than the moment of publication.

  A delivered project shipped exactly that: 115 assertions green, 14 test files passing, and every
  one of its 100 output records carrying the same summary text twice.

  Write at least one assertion per field that could only pass on a correct value. Useful shapes:
  compare against a known-good example, assert a count that a duplicate would break, assert
  ordering, assert that a value falls in a range the wrong value would not, or assert the absence
  of a marker that only incorrect output contains.

  Note that `toBe('string')` is `typeof` in disguise and `toMatch(/^https?:/)` checks format, not
  content. Neither counts as an outcome assertion.
evidence:
  - "Live P1 delivery: 100/100 records had duplicated summaries; 115 assertions passed"
  - "publishedAt carried collection time, asserted only as typeof string"
language: any
stats:
  uses: 0
---

## When this applies

A verification level is writing or repairing an acceptance suite, or a Phase delivery gate has
reported that a scenario ran successfully but its result does not meet the declared expectation.

## Why the suite passed anyway

The V-model levels below acceptance verify structure: does the code run, are the paths covered, do
the modules agree. None of them look at the value the product emits. If the acceptance level also
only checks shape, nothing in the chain ever reads the output — the project can be wrong in a way
that is obvious to a human reader and invisible to every gate.

## What to do

1. Take the Phase scenario's `expected` as the specification. It states what the run must produce.
2. For each element it names, write an assertion that a wrong value would fail.
3. Keep the shape assertions — they are not harmful, they are just not sufficient.
