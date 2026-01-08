---
disable-model-invocation: true
description: Analyze uncommitted changes and confirm code quality (user)
allowed-tools: mcp__agent-framework__confirm
---

CRITICAL: Do NOT run any bash commands, git commands, or use any tools other than the MCP tool listed above.
Do NOT run git status, git diff, or any other preparatory git operations.

1. IMMEDIATELY call the mcp__agent-framework__confirm tool without any preparation steps
2. Report the results to the user:
   - If it contains "CONFIRMED" - report the summary and confirmation
   - If it contains "DECLINED" - report the summary and reason for decline
