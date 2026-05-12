# Hook Handlers

Hook handlers implement the core logic for each host-agent hook event.
They consume canonical input shapes (today identical to
the host agent's SDK (currently `@anthropic-ai/claude-agent-sdk` for Claude Code) types) and produce output via an
`AdapterEncoder` passed in from the adapter entry point.

Adapters live under `adapters/<name>/` and are responsible for translating
the encoder output (exit code + optional stdout JSON) into the format the
specific tool expects.

This separation means the rule logic in `src/hooks/` is adapter-agnostic:
adding a new AI coding tool only requires a new adapter, not changes here.

## Bash Authorization

The PreToolUse pipeline separates user authorization from command safety. A
fresh user message that implies Bash use satisfies the prediction-block
authorization check; prediction-block must not ask for another authorization
just because the command is outside its narrow read-only classifier. Bash safety
is still enforced by the surrounding rule pipeline: blacklist-style deterministic
blocks run before prediction-block, and final tool approval runs afterward.
