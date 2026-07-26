# OpenRouter Free Mode Guide

XCompiler defaults to OpenRouter Free mode through an OpenAI-compatible `/v1` endpoint.
The provider must declare `type: openai`; the provider name is only an identifier and is not used to infer the API protocol.

Official references:

- OpenRouter Quickstart: https://openrouter.ai/docs/quickstart
- API reference: https://openrouter.ai/docs/api_reference/overview
- Free model catalog: https://openrouter.ai/models?max_price=0
- API keys: https://openrouter.ai/settings/keys

## 1. Create Local Environment

From a source checkout:

```bash
cp .env.example .env
cp config.example.yaml config.yaml
```

From the published npm package:

```bash
npm install -g @xcompiler/cli
cp "$(npm root -g)/@xcompiler/cli/.env.example" .env
cp "$(npm root -g)/@xcompiler/cli/config.example.yaml" config.yaml
```

Edit `.env` locally:

```bash
OPENROUTER_API_KEY=<your-openrouter-api-key>
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openrouter/free
```

`.env` is ignored by git. Do not commit real API keys.
`config.yaml`, `llm_scores.yaml`, and `llm_scores_user.yaml` are local files; keep them outside commits. The package ships `config.example.yaml` and `.env.example` only as templates. `llm_scores.yaml` is maintained by XCompiler; do not edit it directly.

## 2. Configure XCompiler

`config.example.yaml` already uses OpenRouter Free mode by default:

```yaml
llm:
  providers:
    openrouter_free:
      type: openai
      api_key: ${OPENROUTER_API_KEY}
      base_url: https://openrouter.ai/api/v1
      model: openrouter/free
      context_window: 128K
      tags: [cluster]
      connect_timeout_ms: 60000
      request_timeout_ms: 900000
      stream_first_token_timeout_ms: 300000
      stream_idle_timeout_ms: 60000
  roles:
    Planner:   [openrouter_free]
    Architect: [openrouter_free]
    Coder:     [openrouter_free]
    Tester:    [openrouter_free]
    Debugger:  [openrouter_free]
  cluster_score_min: 0.2
  cluster_score_max: 0.5
```

`type: openai` means XCompiler will use the OpenAI-compatible chat completions client. This is also the correct type for local `/v1` endpoints such as vLLM or mlx-server.
`tags: [cluster]` marks the provider as an aggregated route. XCompiler scores those providers in a lower default band (`0.2..0.5`) so they behave as backups rather than replacing dedicated role models too early.
OpenRouter requires `OPENROUTER_API_KEY`. Local OpenAI-compatible endpoints may leave `api_key` empty when they run without authentication.

If an OpenAI-compatible request fails, XCompiler reports the provider, model, base URL, request mode, HTTP status/body when available, and a concrete hint such as setting `OPENROUTER_API_KEY`, changing `json_response_format`, checking quota/rate limits, or switching provider.

The three network timeouts cover different stages: `connect_timeout_ms` controls DNS/TCP/TLS establishment, `stream_first_token_timeout_ms` allows slow model startup, and `stream_idle_timeout_ms` detects a stalled stream after output has begun. Increase only the stage that actually timed out.

`context_window` is the model's combined input and output capacity in tokens. It
accepts values such as `131072` or `128K`; an empty or omitted value defaults to
128K. XCompiler recalculates response, `read_file`, write-content, and tool
feedback windows before the primary provider starts and whenever fallback
switches to another provider. For routed providers, configure a conservative
window supported by the possible route targets.

## 3. Choose A Free Model

OpenRouter free models normally use model ids ending with `:free`.
Browse https://openrouter.ai/models?max_price=0, copy the model slug, and set:

```yaml
providers:
  openrouter_coder:
    type: openai
    api_key: ${OPENROUTER_API_KEY}
    base_url: https://openrouter.ai/api/v1
    model: qwen/qwen3-coder:free
    context_window: 128K
  openrouter_free:
    type: openai
    api_key: ${OPENROUTER_API_KEY}
    base_url: https://openrouter.ai/api/v1
    model: openrouter/free
    context_window: 128K
    tags: [cluster]
```

If one free model returns quota, availability, or capability errors, pick another free model slug and rerun the task.

## 4. Engineering Recommendation

For real development runs, avoid relying on a single aggregated route as the only model. Use a role-specific primary model, then append `openrouter_free` as the last fallback for every role:

```yaml
roles:
  Planner:   [openrouter_planner, openrouter_free]
  Architect: [openrouter_architect, openrouter_free]
  Coder:     [openrouter_coder, openrouter_free]
  Tester:    [openrouter_tester, openrouter_free]
  Debugger:  [openrouter_debugger, openrouter_free]
```

Keep the default cluster score band (`cluster_score_min: 0.2`, `cluster_score_max: 0.5`) when `openrouter/free` is a safety net. Raise `cluster_score_max` toward `1.0` only when you intentionally want the aggregated route to compete with dedicated models.

For manual local priority overrides, create `llm_scores_user.yaml` beside `config.yaml`:

```yaml
openrouter_free: 0.3
local_openai: 0
```

User overrides take precedence over the dynamic `llm_scores.yaml` snapshot. Use `0` to disable a provider; use `0.1..1` to pin its effective priority. This file is local runtime policy and should not be committed.

## 5. Optional Local Backups

Local OpenAI-compatible endpoints:

```yaml
local_openai:
  type: openai
  api_key: ${LOCAL_OPENAI_API_KEY}
  base_url: ${LOCAL_OPENAI_BASE_URL}
  model: ${LOCAL_OPENAI_MODEL}
  context_window: 128K
```

For no-auth local servers, set `LOCAL_OPENAI_API_KEY=` or leave the provider `api_key` empty.

Ollama native endpoints:

```yaml
ollama_code:
  type: ollama
  base_url: ${OLLAMA_BASE_URL}
  model: ${OLLAMA_CODE_MODEL}
  context_window: 128K
  think: false
```

Add backups to `roles` or `fallbacks` only after the provider block is enabled.

## 6. Validate

```bash
npm run typecheck
npm test
xcompiler doctor
```

For a direct endpoint check:

```bash
curl https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $OPENROUTER_API_KEY"
```
