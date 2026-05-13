---
name: agent-framework-plan1
description: Spawn one Codex planning agent, consolidate its plan, then spawn one verification agent and present a final proposed plan. Use when the user invokes $agent-framework-plan1.
---

# Agent Framework Plan1

Use the user's invoking prompt as the task description. Subagents do not share this conversation, so expand references like "that bug" or "your theory" into a self-contained briefing before spawning agents.

1. Spawn exactly one `default` agent to create an implementation plan. Use `gpt-5.5` with `reasoning_effort: "medium"` unless the user explicitly requests a different model. Tell it to inspect relevant files, avoid code edits, avoid backwards-compatibility shims, fix root causes rather than symptoms, and include enough concrete file paths, anchors, and quoted snippets that implementation has no room for interpretation. Tell it to call `mcp__agent_framework__validate_plan` with its full inline plan before reporting the plan directly; if the tool returns FAIL, revise the plan and call it again until it returns PASS, then report the validated plan directly.
2. Wait for the planning agent to finish.
3. Consolidate its result into a draft plan in your own context. Do not write a plan file unless the user explicitly requested one.
4. Spawn exactly one `default` verification agent with the same model and reasoning effort. Tell it to inspect the current code and verify the draft plan against the source files for incorrect assumptions, missing changes, edge cases, regressions, and insufficient implementation detail.
5. Wait for the verification agent to finish and apply valid corrections.
6. Present the final plan in a single `<proposed_plan>` block.
