---
id: agent.calibration.self-authored-sample
layer: agent
createdAt: "2026-08-18T00:00:00.000Z"
updatedAt: "2026-08-18T00:00:00.000Z"
status: active
category: test_failure
summary: "A sample you wrote yourself cannot prove you understood the format"
primaryError: "Parser rejects the project's own fixture: Invalid syntax at line N"
debugDemand: "Get an authoritative sample. Your understanding of the format is the same understanding that produced the fixture, so the two can never disagree."
fingerprints:
  - "cat:test_failure"
  - "err:invalid-syntax-at-line"
  - "fixture:self-authored"
symptoms:
  - "The library chosen in design rejects a fixture the project wrote"
  - "Invalid syntax / ParseError on a file named VALID_* or sample.*"
  - "Several test levels carry the same malformed sample, copied between them"
  - "Tests are thorough — edge cases, error paths — yet the sample itself is not valid"
resolutionPlan: "Do not adjust the parser, the assertions, or the library choice. Fetch an authoritative sample (user-provided file, official docs, upstream test corpus), replace the fixture with it, and rerun."
solution: |
  This is not carelessness, and thorough test design does not prevent it. A project's understanding
  of a format *is* its implementation of that format: both come from the same source, so they never
  contradict each other. Every self-authored sample is therefore consistent with the code and proves
  nothing about the format.

  The give-away is a third-party parser rejecting the project's own "valid" sample. The parser is the
  authority; the fixture is the guess.

  Three repairs are wrong here, in increasing order of damage:

  1. Adjusting assertions until the suite passes — hides it.
  2. Replacing the library with a hand-written parser that accepts the invented shape — ships a tool
     that reads a dialect only this project speaks, passing every gate and failing on every real file.
  3. Declaring the real-world file malformed — inverts the authority relationship.

  Correct repair: obtain a sample the project did not author. A user-supplied file is best; an
  official example or an upstream project's test corpus is next. Only simple text formats
  (CSV/JSON/INI) may be constructed from scratch, and only with immediate verification.
evidence:
  - "Live dbc2excel: all three inline DBC samples across S001/S002/S003 failed cantools with the identical 'Invalid syntax at line 3, column 5' — the NS_ section header was malformed in every one"
  - "The same run's real sample, examples/dbc2excel/vehicle.dbc, parsed cleanly: 217 messages / 462 signals"
  - "The test design itself was sound: multiplexed signals, a malformed-input path, and an empty-filter case were all covered"
stats:
  uses: 0
  successes: 0
  failures: 0
feedback: []
---

# A self-authored sample cannot validate the format

## When this applies

A parser chosen during design rejects a sample the project wrote for its own tests.

## Why thorough tests do not help

The tests and the fixture share an author, so they agree with each other by construction. What they
agree on may still be wrong. An outside sample is the only fact in the loop that the project has no
say in.

## What to do

Replace the fixture with an authoritative sample; never reshape the parser or the assertions to
accept the invented one.
