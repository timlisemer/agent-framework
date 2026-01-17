---
disable-model-invocation: true
description: Run linter and type checks, return summarized results (user)
allowed-tools: mcp__agent-framework__check
---

1. IMMEDIATELY call mcp__agent-framework__check with no parameters.

   - Do NOT run any Bash commands (make check, npm run build, cargo check, tsc, etc.)
   - Do NOT read files or gather context first
   - Do NOT use any other tools

2. Check the result:

   - If Status is PASS: report that all checks passed
   - If Status is FAIL: report the error count and list the specific errors

3. Report the results to the user
