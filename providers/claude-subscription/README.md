# Claude Subscription Provider

Provider id: `claude-subscription`

This provider uses the Claude Agent SDK / Claude Code runtime instead of Anthropic API billing. It supports both framework modes:

- `direct`: one Claude SDK turn, no tools.
- `sdk`: Claude SDK with the framework's read-only `Read` and `Bash` tool policy.

Recommended config:

```bash
export AGENT_FRAMEWORK_PROVIDER=claude-subscription
```

Official references:

- Claude Code overview: https://docs.anthropic.com/en/docs/claude-code/overview
- Claude Code settings: https://docs.anthropic.com/en/docs/claude-code/settings
- Claude Code data usage: https://docs.anthropic.com/en/docs/claude-code/data-usage
- Claude Code costs: https://docs.anthropic.com/en/docs/claude-code/costs

Compliance stance:

- Anthropic documents Claude Code with a Claude.ai account and states `/cost` is not intended for Max and Pro subscribers.
- Agent-framework treats this as a subscription-backed host-agent runtime, not as an Anthropic API key.
- Commercial/team/API terms are separate from consumer Free/Pro/Max terms. Do not use a personal consumer subscription to bypass API or organization billing rules.

Silence/session behavior:

- Agent-framework passes `persistSession: false` for Claude SDK calls.
- It scrubs OpenRouter and Anthropic API-key environment variables when this provider is selected so the runtime uses the signed-in Claude Code account path instead of accidentally falling back to API billing.
