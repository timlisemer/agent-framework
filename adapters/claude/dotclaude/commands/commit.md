---
disable-model-invocation: true
description: Generate and execute a git commit using the agent framework
allowed-tools: mcp__agent-framework__commit
---

You MUST use the MCP tools listed in allowed-tools above. Under NO circumstances use raw git commands (git commit, git push, git add, etc.) directly.

Call mcp__agent-framework__commit with working_dir set to the current working directory. If the invoking prompt names a planfile path or the current planfile path is already known, include it as optional_planfile.
Report the result to the user.

If the result is DECLINED or contains errors, you MUST spell out the specific errors returned by the MCP. If multiple errors are returned, list the multiple errors; do not replace them with only a vague count or summary such as "check failed with N errors".
