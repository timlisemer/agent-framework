---
disable-model-invocation: true
description: Commit staged changes and push to remote (user)
allowed-tools: mcp__agent-framework__commit
---

You MUST use the MCP tools listed in allowed-tools above. Under NO circumstances use raw git commands (git commit, git push, git add, etc.) directly.

1. Call mcp__agent-framework__commit with:
   - working_dir: current working directory
   - auto_push: true

2. Check the commit result:
   - If it starts with "SKIPPED:" - report that nothing was committed, but still proceed to push
   - If it contains "DECLINED" - report the reason and DO NOT push
   - If it contains an error or failure - report the error and DO NOT push
   - Otherwise - report the commit and push results to the user
