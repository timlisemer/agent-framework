---
description: Commit staged changes and push to remote (user)
allowed-tools: mcp__agent-framework__commit, mcp__agent-framework__push
---

CRITICAL: Do NOT run any bash commands, git commands, or use any tools other than the two MCP tools listed above.
Do NOT run git status, git add, git diff, or any other preparatory git operations.

1. IMMEDIATELY call the mcp__agent-framework__commit tool without any preparation steps
2. Check the result:
   - If it starts with "SKIPPED:" - report that nothing was committed, but still proceed to push
   - If it contains an error or failure - report the error and DO NOT push
   - Otherwise - report the commit message and proceed
3. Call the mcp__agent-framework__push tool
4. Report the push result to the user
