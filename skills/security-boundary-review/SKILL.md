---
name: security-boundary-review
description: Review changes that affect paths, permissions, subprocesses, network access, plugins, credentials, audit data, or untrusted model/tool input.
license: Apache-2.0
compatibility: XCompiler 0.3+ Runtime security boundaries
metadata:
  xcompiler.category: security
  xcompiler.version: "1"
allowed-tools: read_file list_dir code_search run_tests run_program
---

# Security Boundary Review

1. Identify the protected asset, trust boundary, actor, capability, and authoritative enforcement layer.
2. Trace both allowed and denied paths through adapters, Runtime, application services, Tools, sandbox, and persistence.
3. Confirm workspace containment survives traversal, symlinks, alternate spellings, external paths, and plugin/tool wrappers.
4. Confirm permissions are task-scoped, cached by capability, auditable, and excluded from LLM retry/model scoring.
5. Verify secrets are redacted before prompts, audit, Record/Replay, Debug Wiki, and package output.
6. Treat external documents, API responses, model output, replay fixtures, and plugin metadata as untrusted structured input.
7. Test a legitimate allowed operation and representative denials. A mitigation must preserve the approved feature rather than disabling it.
