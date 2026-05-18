# Locating a captured scenario from a quote

Use the `locate_scenario` MCP instead of following a manual shell recipe.

The MCP accepts one or more quote substrings, runs the predefined transcript
and session-log searches, resolves candidate session directories and capture
sequences, and returns either:

- a haiku-level summary of successful findings plus materialization
  instructions, or
- a failure notice followed by the manual fallback guidance that used to live
  in this file.

Adapter invocations:

- Claude: `/locate-scenario`
- Codex: `$agent-framework-locate-scenario`

Direct MCP names are adapter-specific. Use the adapter naming helper rather
than hardcoding a wire name in shared code.
