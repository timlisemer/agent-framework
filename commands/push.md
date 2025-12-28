---
description: Commit staged changes and push to remote
allowed-tools: mcp__agent-framework__commit, Bash(git push:*)
---

1. Use the mcp__agent-framework__commit tool to generate and execute a commit
2. Check the result:
   - If it starts with "SKIPPED:" - report that nothing was committed, but still proceed to push
   - If it contains an error or failure - report the error and DO NOT push
   - Otherwise - report the commit message and proceed
3. Run `git push` to push committed changes to remote
4. Report the push result to the user
