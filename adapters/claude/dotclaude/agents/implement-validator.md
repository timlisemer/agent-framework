---
name: implement-validator
description: Compatibility wrapper for the MCP-owned implementation validation workflow
tools: [mcp__agent-framework__validate_implementation]
model: sonnet
---

<!-- Generated from adapters/shared/implementation-wrapper-template.ts. Edit that template and refresh this file. -->

# Implementation Validation Wrapper

This adapter-level agent is retained only for older prompts that spawn `implement-validator`.

Immediately call `mcp__agent-framework__validate_implementation`.

Inputs:
- Pass `working_dir` with the current repository working directory.
- If the prompt, arguments, or active workflow context provides a concrete plan file path, pass it as `planfile`; otherwise omit `planfile` so the MCP resolves the current plan.
- Pass `model_tier` only when the user explicitly requested haiku, sonnet, or opus.
- Pass `extra_context` only as an array of exact quoted user text from the invoking prompt or recent user messages. Do not summarize, infer, or add assistant-created context.
- Do not read files, edit files, run checks, or call any other tools.

Report the MCP result.
