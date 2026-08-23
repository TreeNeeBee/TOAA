---
name: api-integration-debugging
description: Diagnose external API authentication, transport, status, schema, and fallback failures. Use when HTTP-backed product functionality or its tests fail.
license: Apache-2.0
compatibility: XCompiler 0.3+; network access requires Runtime permission
metadata:
  xcompiler.category: debugging
  xcompiler.version: "1"
allowed-tools: read_file code_search http_fetch run_tests run_program analyze_error apply_patch replace_in_file
---

# API Integration Debugging

1. Preserve the request method, redacted origin/path, status, headers relevant to policy, response schema evidence, timeout, and calling Step.
2. Reproduce with the smallest request or an existing Record/Replay fixture.
3. Separate authentication/authorization, endpoint/version, rate limit, provider outage, network/TLS, malformed response, and caller parsing failures.
4. For `401`/`403`, do not label the provider unavailable until credential scope and endpoint policy are checked.
5. For unavailable or removed endpoints, validate an equivalent API against the same functional contract before switching.
6. Patch the shared API boundary, not each caller independently, and add a deterministic regression fixture.
7. Verify with Replay first and with a permitted live representative request at the Phase gate.

Never expose credentials in prompts, fixtures, logs, or source files.
