---
name: agent-framework-push
description: Commit staged changes and push through the agent-framework commit MCP tool with auto_push enabled. Use when the user invokes $agent-framework-push.
---

# Agent Framework Push

Use only `mcp__agent_framework__commit`. Do not use raw git commands.

1. Call `mcp__agent_framework__commit` with:
   - `working_dir`: current working directory
   - `auto_push`: `true`
2. Report the result.
3. If the result contains `DECLINED`, an error, or a failure, report it and do not attempt any raw push command.
