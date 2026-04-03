---
disable-model-invocation: true
description: Analyze uncommitted changes and confirm code quality (user)
allowed-tools: mcp__agent-framework__confirm
---

You MUST use the MCP tools listed in allowed-tools above. Under NO circumstances use raw git commands (git commit, git push, git add, etc.) directly.

Call mcp__agent-framework__confirm with working_dir set to the current working directory.
Report the result to the user.
