# Hook Handlers

Hook handlers implement the core logic for each host-agent hook event.
They consume adapter-normalized tool calls through `AdapterSpec`: raw host
tool names and inputs are canonicalized before shared rules run, while the
adapter still owns host-specific LLM summaries, false-denial classification,
appeal aliases, and output encoding.

Adapters live under `adapters/<name>/` and are responsible for translating
raw host hook payloads and encoder output (exit code + optional stdout JSON)
into the format the specific tool expects.

This separation means the rule logic in `src/hooks/` is adapter-agnostic:
adding a new AI coding tool only requires a new adapter, not changes here.

## Bash Authorization

The PreToolUse pipeline separates user authorization from command safety. A
fresh user message that implies Bash use satisfies the prediction-block
authorization check; prediction-block must not ask for another authorization
just because the command is outside its narrow read-only classifier. Bash safety
is still enforced by the surrounding rule pipeline: blacklist-style deterministic
blocks run before prediction-block, and final tool approval runs afterward.

Command safety is centralized in `src/utils/bash-policy/`. The analyzer handles
shell segments, wrappers, shell payloads, `eval`, and `xargs`; topic modules own
git, check-routed commands, read-only Bash, file writes, scripting-language
execution, run/install/remote commands, and destructive find/sed cases. The
registry keeps one terminal owner for each Bash tool call while compatibility
APIs still render established `blacklist` and check-MCP messages.
