---
name: agent-framework-implement
description: Implement an approved plan by calling the agent-framework implement MCP. Use when the user invokes $agent-framework-implement.
---

<!-- Generated from adapters/shared/implementation-wrapper-template.ts. Edit that template and refresh this file. -->

# Agent Framework Implement

Immediately call `mcp__agent_framework__implement`.

Inputs:
- Pass `working_dir` with the current repository working directory.
- If the prompt, arguments, or active workflow context provides a concrete plan file path, pass it as `planfile`; otherwise omit `planfile` so the MCP resolves the current plan.
- Pass `model_tier` only when the user explicitly requested haiku, sonnet, or opus.
- Pass `extra_context` only as an array of exact quoted user text from the invoking prompt or recent user messages. Do not summarize, infer, or add assistant-created context.

Do not spawn agents yourself. Do not run checks yourself. Report the MCP result.
