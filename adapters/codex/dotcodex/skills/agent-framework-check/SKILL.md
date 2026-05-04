---
name: agent-framework-check
description: Run the agent-framework check MCP tool and report summarized lint/type-check results. Use when the user invokes the agent-framework check workflow or asks for the old /check command equivalent.
---

# Agent Framework Check

1. Immediately call `mcp__agent_framework__check` with `working_dir` set to the current repository path.
2. Do not run Bash check/build/test commands and do not gather file context first.
3. Report the tool result:
   - If status is PASS, say all checks passed.
   - If status is FAIL, report the error count and specific errors.
