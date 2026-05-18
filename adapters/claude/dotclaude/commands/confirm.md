---
disable-model-invocation: true
description: Analyze uncommitted changes and confirm code quality (user)
allowed-tools: mcp__agent-framework__confirm
---

You MUST use the MCP tools listed in allowed-tools above. Under NO circumstances use raw git commands (git commit, git push, git add, etc.) directly.

Call mcp__agent-framework__confirm with working_dir set to the current working directory.
Report the result to the user.

If the result is DECLINED or contains errors, you MUST spell out the specific errors returned by the MCP. If multiple errors are returned, list the multiple errors; do not replace them with only a vague count or summary such as "check failed with N errors".
