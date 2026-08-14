---
name: performance-profiling
description: Measure and diagnose CPU, memory, I/O, latency, and throughput regressions before optimizing. Use when a KPI or tolerance gate reports a performance shortfall.
license: Apache-2.0
compatibility: XCompiler 0.3+; profiler availability depends on sandbox runtime
metadata:
  xcompiler.category: performance
  xcompiler.version: "1"
allowed-tools: read_file code_search run_program run_tests apply_patch replace_in_file
---

# Performance Profiling

1. Define the user-visible metric, workload, baseline revision, environment, tolerance, and measurement method.
2. Reproduce with representative data and enough samples to separate signal from noise.
3. Profile before editing; identify the dominant CPU, allocation, I/O, network, or contention path.
4. Form one measurable hypothesis and change one cause.
5. Compare before/after distributions under the same workload and verify functional baselines.
6. Report tradeoffs and resource changes, not only the fastest observed run.

Do not optimize synthetic microbenchmarks that do not represent the declared KPI.
