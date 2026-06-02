---
name: agent-framework-quickconfirm
description: Run confirm quickly through the agent-framework confirm MCP tool without elicitation, fixing errors by editing files and retrying until it works. Use when the user invokes $agent-framework-quickconfirm.
---

# Agent Framework Quickconfirm

Use only `mcp__agent_framework__confirm` for confirm. Do not use raw check, test, lint, format, or git commands directly.

Call `mcp__agent_framework__confirm` with:
- `working_dir`: current working directory
- `model_tier`: `haiku`
- `skip_elicitation`: `true`

Do not pass `extra_context`. Do not pass a placeholder string such as `no extra context`.

If the confirm result is `DECLINED` or contains errors, spell out the specific errors returned by the MCP before making any repair edits. If multiple errors are returned, list the multiple errors; do not replace them with only a vague count or summary such as `check failed with N errors`. Do not silently proceed to fixes after a `DECLINED` result; first show the returned error text clearly enough that the user can see exactly what quickconfirm is repairing.

Fix every returned error by editing files. After these edits have been made, retry `mcp__agent_framework__confirm` with the same arguments. Repeat until confirm succeeds, then report the final confirm result to the user.
