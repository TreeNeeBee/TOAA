---
id: agent.calibration.unwritten-test-file
layer: agent
createdAt: "2026-08-18T00:00:00.000Z"
updatedAt: "2026-08-18T00:00:00.000Z"
status: active
category: missing_output
summary: "A runner that cannot find the test file is reporting unwritten work"
primaryError: "pytest exit=4 file or directory not found / vitest No test files found"
debugDemand: "Write the declared test files; rerunning the same command cannot change a path that does not exist."
fingerprints:
  - "cat:missing_output"
  - "err:pytest-exit-4"
  - "err:no-test-files-found"
  - "err:file-or-directory-not-found"
symptoms:
  - "pytest exit=4 with ERROR: file or directory not found"
  - "vitest reports No test files found"
  - "collected 0 items while the suite is expected to exist"
  - "the same run_tests command repeats without any write between attempts"
resolutionPlan: "List the test directory, compare it against this Step's declared outputs, write every missing test file with real assertions against the product module, and only then run the suite."
solution: |
  The runner is not describing a broken environment and not describing a failing test. It is saying
  the path it was given is not on disk, which nearly always means the Step has not yet written a test
  file it declared as an output.

  Selectors come from the plan, not from the filesystem: Runtime derives them from the paired source
  Step's declared outputs, so a declared-but-unwritten test produces an invocation that cannot pass
  no matter how often it runs.

  Two traps make this loop:

  1. The message reads like an environment fault, so attention goes to the sandbox instead of to the
     unfinished work.
  2. A suite with no tests is not a passing suite. Under some vitest configurations "No test files
     found" is not even a failing exit, so an unwritten suite can be mistaken for nothing to do.

  Repair: `list_dir tests/`, diff against the declared outputs, `write_file` each missing test with
  assertions against the real product module, then rerun. Never change the selector to a path that
  happens to exist, and never delete the selector to make the failure go away.
evidence:
  - "Live dbc2excel CODE Step: 10 identical pytest exit=4 results across 6 attempts, 69 accurate 'outputs still missing' messages ignored, run stopped by the non-convergence guard at 11/8"
  - "The five unwritten outputs were the Step's own declared unit tests plus its unit-test plan"
stats:
  uses: 0
  successes: 0
  failures: 0
feedback: []
---

# Unwritten declared test file

## When this applies

The test runner exits with a usage error naming a path, or reports that it found no test files.

## Why the loop happens

The failure text describes the filesystem, while the actual instruction — which Runtime does send —
is that declared outputs are still missing. The runner's message is louder and sounds like
infrastructure, so the repair loop re-runs the command instead of writing the files.

## What to do

1. `list_dir tests/` and read what is actually there.
2. Compare against this Step's declared outputs.
3. Write each missing file, with assertions against the product module it verifies.
4. Rerun only after the files exist.
