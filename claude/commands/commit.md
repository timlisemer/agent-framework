---
disable-model-invocation: true
description: Generate and execute a git commit using the agent framework
allowed-tools: mcp__agent-framework__commit
---

You MUST use the MCP tools listed in allowed-tools above. Under NO circumstances use raw git commands (git commit, git push, git add, etc.) directly.

Call mcp__agent-framework__commit with working_dir set to the current working directory.
Report the result to the user.
