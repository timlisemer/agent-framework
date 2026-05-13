---
disable-model-invocation: true
description: Validate an inline plan or plan file using the agent-framework validate-plan MCP
allowed-tools: mcp__agent-framework__validate_plan
---

1. IMMEDIATELY call mcp__agent-framework__validate_plan.

   - Pass `plan_file` when the user supplied a path.
   - Pass `plan` when the user supplied inline plan text.
   - Do NOT run any Bash commands.
   - Do NOT read files or gather context first.
   - Do NOT critique the plan yourself before calling the MCP.
   - Do NOT use any other tools.

2. Report the result:

   - If Status is PASS: report that the plan validated.
   - If Status is FAIL: report the specific reasons.
