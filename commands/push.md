---
description: Commit staged changes and push to remote (user)
allowed-tools: mcp__agent-framework__commit, mcp__agent-framework__push
---

1. Use the mcp__agent-framework__commit tool to generate and execute a commit
2. Check the result:
   - If it starts with "SKIPPED:" - report that nothing was committed, but still proceed to push
   - If it contains an error or failure - report the error and DO NOT push
   - Otherwise - report the commit message and proceed
3. Use the mcp__agent-framework__push tool to push committed changes
4. Report the push result to the user
