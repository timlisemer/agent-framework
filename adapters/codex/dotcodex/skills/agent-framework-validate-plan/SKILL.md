---
name: agent-framework-validate-plan
description: Validate an inline plan or plan file using the agent-framework validate-plan MCP. Use when the user invokes $agent-framework-validate-plan.
---

# Agent Framework Validate Plan

1. Immediately call `mcp__agent_framework__validate_plan` with `working_dir` set to the current repository path.
2. Pass exactly one of:
   - `plan_file` when the user supplied a path.
   - `plan` when the user supplied inline plan text.
3. Do not run Bash check/build/test commands and do not gather file context first.
4. Report the tool result:
   - If status is PASS, say the plan validated.
   - If status is FAIL, report the specific reasons.
