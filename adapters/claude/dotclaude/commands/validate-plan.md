---
disable-model-invocation: true
description: Validate a named planfile against the plan contract using the agent-framework validate-plan MCP
allowed-tools: mcp__agent-framework__validate_plan
---

This validates the plan contract only. It is not implementation validation; use `/validate` for validating completed code against a plan.

1. IMMEDIATELY call mcp__agent-framework__validate_plan.

   - Pass `plan_file` with the named planfile path.
   - Pass `working_dir` with the current repository working directory.
   - Do NOT run any Bash commands.
   - Do NOT read files or gather context first.
   - Do NOT critique the plan yourself before calling the MCP.
   - Do NOT use any other tools.

2. Report the result:

   - If Status is PASS: report that the plan validated.
   - If Status is FAIL: report the specific reasons.
