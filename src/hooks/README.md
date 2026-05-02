# Hook Handlers

Hook handlers implement the core logic for each Claude Code hook event.
They consume canonical input shapes (today identical to
`@anthropic-ai/claude-agent-sdk` types) and produce output via an
`AdapterEncoder` passed in from the adapter entry point.

Adapters live under `adapters/<name>/` and are responsible for translating
the encoder output (exit code + optional stdout JSON) into the format the
specific tool expects.

This separation means the rule logic in `src/hooks/` is adapter-agnostic:
adding a new AI coding tool only requires a new adapter, not changes here.
