---
id: agent.calibration.provider-vs-project-network
layer: agent
createdAt: "2026-08-18T00:00:00.000Z"
updatedAt: "2026-08-18T00:00:00.000Z"
status: active
category: llm_provider
summary: "XCompiler's own provider outage is not the generated project's API failure"
primaryError: "availability check failed / fetch failed / stream idle for a configured LLM provider"
debugDemand: "Change nothing in the project. A provider outage is infrastructure and resolves by retry or provider switch."
fingerprints:
  - "cat:llm_provider"
  - "err:availability-check-failed"
  - "err:fetch-failed"
  - "err:all-llm-providers-failed"
symptoms:
  - "<Role> availability check failed for <provider>: fetch failed"
  - "all LLM providers failed for role X"
  - "OpenAI-compatible provider request failed ... mode=stream|non-stream"
  - "stream sent reasoning chars but no content"
resolutionPlan: "Confirm the failing endpoint belongs to a configured llm.providers entry rather than to the generated project, then stop: no product file, test, or dependency changes this."
solution: |
  Two network failures look alike in a log and need opposite responses.

  - **Ours**: a configured `llm.providers` endpoint is unreachable, timing out, rate limited, or
    streaming nothing. The generated project is not involved. Nothing in it should change.
  - **The project's**: the delivered code calls an external API that fails. That is a real defect and
    becomes a Bug.

  The distinguishing evidence is the endpoint: a provider name from `config.yaml`, a role name, or
  the phrase "all LLM providers failed" means ours. A URL the project itself requests means the
  project's.

  Getting this backwards is expensive in one specific direction: treating our outage as the
  project's leads to rewriting a working integration — swapping to a different API, adding
  fallbacks, weakening assertions — to fix something that was never broken.
evidence:
  - "Live run: 'Architect availability check failed for openai:deepseek/deepseek-v4-flash: fetch failed' was classified network_api_failure, whose demand tells the project to switch to a public no-key API"
  - "Two dbc2excel runs lost ~30 minutes each to provider outages that produced no project defect"
stats:
  uses: 0
  successes: 0
  failures: 0
feedback: []
---

# Provider outage versus project API failure

## When this applies

A network error appears in the failure log and it is not obvious whose request failed.

## How to tell

Ours: a provider name from `llm.providers`, a role name, `all LLM providers failed`, or an
`OpenAI-compatible provider request failed` prefix.

The project's: a URL the delivered code fetches, with its own status code.

## What to do

If it is ours, change nothing in the project and let the retry or provider switch handle it. If it is
the project's, repair the integration and verify it.
