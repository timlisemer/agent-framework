---
disable-model-invocation: true
description: Quick confirm with repair loop - no questions asked (user)
allowed-tools: mcp__agent-framework__confirm, Edit, MultiEdit, Write
---

You MUST use mcp__agent-framework__confirm for confirm. Do not use raw check, test, lint, format, or git commands directly.

1. Call mcp__agent-framework__confirm with:
   - working_dir: current working directory
   - model_tier: "haiku"
   - skip_elicitation: true

Do not pass extra_context. Do not pass a placeholder string such as "no extra context".

2. If the confirm result is DECLINED or contains errors, you MUST spell out the specific errors returned by the MCP before making any repair edits.
   - If multiple errors are returned, list the multiple errors; do not replace them with only a vague count or summary such as "check failed with N errors".
   - Do not silently proceed to fixes after a DECLINED result; first show the returned error text clearly enough that the user can see exactly what quickconfirm is repairing.

3. Fix every returned error by editing files.

4. After these edits have been made, retry mcp__agent-framework__confirm with the same arguments from step 1.

5. Repeat steps 2 through 4 until confirm succeeds.

6. Report the final confirm result to the user.
