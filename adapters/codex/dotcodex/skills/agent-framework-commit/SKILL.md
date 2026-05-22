---
name: agent-framework-commit
description: Generate and execute a git commit through the agent-framework commit MCP tool. Use when the user invokes $agent-framework-commit.
---

# Agent Framework Commit

Use only `mcp__agent_framework__commit`. Do not use raw git commands such as `git add`, `git commit`, or `git push`.

Call `mcp__agent_framework__commit` with `working_dir` set to the current working directory. If the invoking prompt names a planfile path or the current planfile path is already known, include it as `optional_planfile`. Then report the result to the user.

If the result is `DECLINED` or contains errors, you MUST spell out the specific errors returned by the MCP. If multiple errors are returned, list the multiple errors; do not replace them with only a vague count or summary such as "check failed with N errors".
