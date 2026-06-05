---
name: agent-framework-fullconfirm
description: Analyze full git-visible code and confirm code quality through the agent-framework fullconfirm MCP tool. Use when the user invokes $agent-framework-fullconfirm.
---

# Agent Framework FullConfirm

Use only `mcp__agent_framework__fullconfirm`. Do not use raw git commands.

Call `mcp__agent_framework__fullconfirm` with `working_dir` set to the current working directory. If the invoking prompt names a planfile path or the current planfile path is already known, include it as `optional_planfile`. Then report the result to the user.

If the result is `DECLINED` or contains errors, you MUST spell out the specific errors returned by the MCP. If multiple errors are returned, list the multiple errors; do not replace them with only a vague count or summary such as "check failed with N errors".
