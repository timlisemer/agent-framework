---
name: agent-framework-commit
description: Generate and execute a git commit through the agent-framework commit MCP tool. Use when the user invokes $agent-framework-commit.
---

# Agent Framework Commit

Use only `mcp__agent_framework__commit`. Do not use raw git commands such as `git add`, `git commit`, or `git push`.

Call `mcp__agent_framework__commit` with `working_dir` set to the current working directory, then report the result to the user.
