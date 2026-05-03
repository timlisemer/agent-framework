---
name: agent-framework-quickpush
description: Commit and push quickly through the agent-framework commit MCP tool without elicitation. Use when the user invokes the agent-framework quickpush workflow or asks for the old /quickpush command equivalent.
---

# Agent Framework Quickpush

Use only `mcp__agent-framework__commit`. Do not use raw git commands.

Call `mcp__agent-framework__commit` with:
- `working_dir`: current working directory
- `model_tier`: `haiku`
- `skip_elicitation`: `true`
- `auto_push`: `true`

Report the commit and push result to the user.

