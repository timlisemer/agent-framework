# Provider configuration template

```sh
# Provider selection (default: openrouter)
# AGENT_FRAMEWORK_PROVIDER=openrouter
# AGENT_FRAMEWORK_DIRECT_PROVIDER=openrouter
# AGENT_FRAMEWORK_SDK_PROVIDER=openrouter
# AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME=claude # claude | codex

# Optional - set by Claude Code automatically
CLAUDE_PROJECT_DIR=/path/to/project

# Required for hooks - path to agent-framework directory
AGENT_FRAMEWORK_ROOT=/path/to/agent-framework

# --- OpenRouter ---
# See: https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration
#
# OPENROUTER_API_KEY=<your-openrouter-api-key>
# ANTHROPIC_BASE_URL=https://openrouter.ai/api
# ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY
# ANTHROPIC_API_KEY= # Important: must be explicitly empty

# --- Claude subscription ---
# Sign in with Claude Code, then:
# AGENT_FRAMEWORK_PROVIDER=claude-subscription

# --- OpenAI subscription ---
# Sign in with Codex/ChatGPT, then:
# AGENT_FRAMEWORK_PROVIDER=openai-subscription

# --- Telemetry (Optional) ---
# All three required if telemetry is enabled
# TELEMETRY_HOST_ID=your-host-id
# TELEMETRY_ENDPOINT=https://your-telemetry-endpoint.com
# AGENT_FRAMEWORK_API_KEY=your-api-key
```
