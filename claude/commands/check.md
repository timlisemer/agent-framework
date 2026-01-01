---
description: Run linter and type checks, return summarized results (user)
allowed-tools: mcp__agent-framework__check
---

CRITICAL: Do NOT run any bash commands or use any tools other than the MCP tool listed above.
Do NOT run make check, npm run build, tsc, or any other build/lint commands directly.

1. IMMEDIATELY call the mcp__agent-framework__check tool without any preparation steps
2. Report the results to the user:
   - If Status is PASS - confirm all checks passed
   - If Status is FAIL - report the error count and list the specific errors
