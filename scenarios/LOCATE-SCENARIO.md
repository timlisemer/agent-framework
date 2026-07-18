# Locating a captured scenario from a quote

Use the `locate_scenario` MCP instead of following a manual shell recipe.

The MCP accepts one or more quote substrings, searches canonical run journals
and their linked digest-verified artifacts, and resolves each candidate to a
stable run ID, runtime root, and available record context. It returns either:

- a haiku-level summary of successful findings plus materialization
  instructions, or
- a failure notice followed by the manual fallback guidance that used to live
  in this file.

Adapter invocations:

- Claude: `/locate-scenario`
- Codex: `$agent-framework-locate-scenario`

Direct MCP names are adapter-specific. Use the adapter naming helper rather
than hardcoding a wire name in shared code.
