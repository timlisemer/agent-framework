# OpenRouter Provider

Provider id: `openrouter`

OpenRouter is the default provider. Direct mode uses OpenRouter's Anthropic API skin through `@anthropic-ai/sdk`. SDK mode can run either through Claude's Agent SDK or Codex SDK:

```bash
export AGENT_FRAMEWORK_PROVIDER=openrouter
export AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME=codex # claude | codex
```

For Claude-compatible routing, OpenRouter documents this setup:

```bash
export OPENROUTER_API_KEY="<your-openrouter-api-key>"
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
export ANTHROPIC_API_KEY="" # Important: Must be explicitly empty
```

Official reference: https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration

For Codex-compatible routing, Codex uses OpenRouter's OpenAI-compatible `/api/v1` endpoint. Agent-framework configures Codex with OpenRouter provider routing:

```toml
[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
```

Isolated Codex SDK sessions place that routing in a per-run internal Codex config under `~/.agent-framework/internal/.../codex/<runId>`. Native user-runtime Codex SDK sessions preserve the user's normal Codex home/config while still passing the OpenRouter provider routing needed for the session. Generic managed user-runtime sessions (`{ kind: "managed", configuration: { profile: "default" } }`) set `CODEX_HOME` to `~/.agent-framework/managed/default/codex`, refresh framework-owned adapter config without deleting `sessions/`, and still pass the OpenRouter provider routing needed for the session.

OpenRouter SDK mode is still billed by OpenRouter credits. Cost telemetry is only fetched for direct OpenRouter calls that return a generation id; SDK calls are logged with tokens/latency when available but excluded from OpenRouter generation-cost lookup.
