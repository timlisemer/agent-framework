---
name: agent-framework-confirm
description: Analyze uncommitted changes and confirm code quality through the agent-framework confirm MCP tool. Use when the user invokes $agent-framework-confirm.
---

# Agent Framework Confirm

Use only `mcp__agent_framework__confirm`. Do not use raw git commands.

Call `mcp__agent_framework__confirm` with `working_dir` set to the current working directory, then report the result to the user.

If the result is `DECLINED` or contains errors, you MUST spell out the specific errors returned by the MCP. If multiple errors are returned, list the multiple errors; do not replace them with only a vague count or summary such as "check failed with N errors".
