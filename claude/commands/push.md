---
disable-model-invocation: true
description: Commit staged changes and push to remote (user)
allowed-tools: mcp__agent-framework__commit, mcp__agent-framework__push
---

1. Call mcp__agent-framework__commit with working_dir set to the current working directory.

2. Check the commit result:
   - If it starts with "SKIPPED:" - report that nothing was committed, but still proceed to push
   - If it contains "DECLINED" - report the reason and DO NOT push
   - If it contains an error or failure - report the error and DO NOT push
   - Otherwise - report the commit message and proceed

3. Call mcp__agent-framework__push with working_dir set to the current working directory.

4. Report the push result to the user.
