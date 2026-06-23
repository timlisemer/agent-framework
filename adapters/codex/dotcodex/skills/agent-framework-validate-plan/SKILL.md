---
name: agent-framework-validate-plan
description: Validate a named planfile against the plan contract using the agent-framework validate-plan MCP. Use when the user invokes $agent-framework-validate-plan.
---

# Agent Framework Validate Plan

This validates the plan contract only. It is not implementation validation; use `agent-framework-validate` for validating completed code against a plan.

1. Immediately call `mcp__agent_framework__validate_plan` with `working_dir` set to the current repository path.
2. Pass `plan_file` with the named planfile path.
3. Do not run Bash check/build/test commands and do not gather file context first.
4. Report the tool result:
   - If status is PASS, say the plan validated.
   - If status is FAIL, report the specific reasons.
