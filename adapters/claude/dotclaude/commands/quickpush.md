---
disable-model-invocation: true
description: Quick commit and push - no questions asked (user)
allowed-tools: mcp__agent-framework__commit
---

You MUST use the MCP tools listed in allowed-tools above. Under NO circumstances use raw git commands (git commit, git push, git add, etc.) directly.

1. Call mcp__agent-framework__commit with:
   - working_dir: current working directory
   - model_tier: "haiku"
   - skip_elicitation: true
   - auto_push: true

2. Report the commit and push results to the user.
   - If the result is DECLINED or contains errors, you MUST spell out the specific errors returned by the MCP.
   - If multiple errors are returned, list the multiple errors; do not replace them with only a vague count or summary such as "check failed with N errors".
