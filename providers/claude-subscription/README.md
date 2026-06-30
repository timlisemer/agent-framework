# Claude Subscription Provider

Provider id: `claude-subscription`

This provider uses the Claude Agent SDK / Claude Code runtime instead of Anthropic API billing. It supports both framework modes:

- `direct`: one Claude SDK turn, no tools.
- `sdk`: Claude SDK with the framework's default read-only `Read` and `Bash` tool policy for reviewer-style agents.
- Internal implementation workflows can opt into a disposable write-capable SDK profile that keeps the same configured adapter tool surface as managed Astral, including MCP tools and file editing tools, while removing only the Stop hook. Those runs still use per-run framework-owned fake homes and leave parent-owned check/validation available to the workflow.

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

- Agent-framework passes `persistSession: false` for one-shot Claude SDK calls. Internal direct/read-only/write runs use per-run homes under `~/.agent-framework/internal/{direct,read-only,write}/claude/<runId>` and clean disposable runtime state when the run ends. Opt-in continuable SDK sessions preserve the native Claude session ID across turns until the owning session is disposed.
- In managed Astral user-runtime sessions (`sdkRuntimeHome: "managedAstral"`), agent-framework sets `CLAUDE_CONFIG_DIR` and `CLAUDE_HOME` to `~/.agent-framework/astral-ai/claude`, refreshes framework-owned adapter config there, preserves `projects/` history plus top-level auth/local-secret files, and uses it for session history listing/resume.
- It scrubs OpenRouter and Anthropic API-key environment variables when this provider is selected so the runtime uses the signed-in Claude Code account path instead of accidentally falling back to API billing.
