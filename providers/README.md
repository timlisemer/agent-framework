# Providers

Agent-framework has one provider abstraction for both execution modes:

- `direct`: one prompt in, one text result out.
- `sdk`: autonomous investigation through a host-agent runtime. Framework-owned
  agents default to per-run isolated runtime homes; explicit user-runtime UI
  sessions either use the user's native host-agent home or, with
  `sdkRuntimeHome: "managedAstral"`, a managed home under
  `~/.agent-framework/astral-ai/<provider>` for session history and resume.
  Managed refreshes replace framework-owned adapter config and preserve durable
  history directories such as Codex `sessions/` and Claude `projects/`.

Supported providers:

| Provider | Direct runtime | SDK runtime | Billing path |
| --- | --- | --- | --- |
| `openrouter` | OpenRouter Anthropic API skin | Claude Agent SDK or Codex SDK | OpenRouter credits |
| `claude-subscription` | Claude Agent SDK, one turn, no tools | Claude Agent SDK | Claude Code account/subscription |
| `openai-subscription` | Codex SDK, one turn, no tools | Codex SDK | Codex access included with ChatGPT plan |

Provider resolution is generic:

1. `AGENT_FRAMEWORK_DIRECT_PROVIDER` or `AGENT_FRAMEWORK_SDK_PROVIDER`
2. `.agent-framework.json` tier+mode override
3. `.agent-framework.json` mode override
4. `AGENT_FRAMEWORK_PROVIDER`
5. `.agent-framework.json` default
6. `openrouter`

Example:

```json
{
  "default": "openai-subscription",
  "modes": {
    "direct": "openai-subscription",
    "sdk": "openai-subscription"
  },
  "providers": {
    "openrouter": {
      "sdkRuntime": "codex"
    }
  }
}
```

Read the provider-specific notes before enabling a subscription-backed provider:

- [OpenRouter](openrouter/README.md)
- [Claude subscription](claude-subscription/README.md)
- [OpenAI subscription](openai-subscription/README.md)
