---
name: agent-framework-plan1
description: Spawn one Codex planning agent, consolidate its plan, then spawn one verification agent and write a named planfile. Use when the user invokes $agent-framework-plan1.
---

# Agent Framework Plan1

Use the user's invoking prompt as the task description. Subagents do not share this conversation, so expand references like "that bug" or "your theory" into a self-contained briefing before spawning agents.

1. Spawn exactly one `default` agent to create an implementation plan. Use `gpt-5.5` with `reasoning_effort: "medium"` unless the user explicitly requests a different model. Tell it to inspect relevant files, avoid code edits, avoid backwards-compatibility shims, fix root causes rather than symptoms, and include enough concrete file paths, anchors, and quoted snippets that implementation has no room for interpretation.
2. Wait for the planning agent to finish.
3. Consolidate its result into a draft plan in your own context.
4. Write the consolidated plan to a named planfile using lowercase kebab-case. The plan must begin with `Plan Name: <name>` and end with `Planfile Path: <path>` followed by `Plan Name: <same-name>`.
5. Call `mcp__agent_framework__validate_plan` with `plan_file` set to that path. If it returns FAIL, revise the planfile and call it again until it returns PASS.
6. Spawn exactly one `default` verification agent with the same model and reasoning effort. Tell it to inspect the current code and verify the validated planfile against the source files for incorrect assumptions, missing changes, edge cases, regressions, and insufficient implementation detail.
7. Wait for the verification agent to finish, apply valid corrections to the planfile, and re-run `mcp__agent_framework__validate_plan` with `plan_file` if corrections were made.
8. Report the final planfile path.
