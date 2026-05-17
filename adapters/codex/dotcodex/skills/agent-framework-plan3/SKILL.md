---
name: agent-framework-plan3
description: Spawn three Codex planning agents in parallel, consolidate, then spawn three verification agents and write a named planfile. Use when the user invokes $agent-framework-plan3.
---

# Agent Framework Plan3

Use the user's invoking prompt as the task description. Subagents do not share this conversation, so expand references like "that bug" or "your theory" into a self-contained briefing before spawning agents.

1. Spawn exactly three `default` planning agents in one parallel batch. Use `gpt-5.5` with `reasoning_effort: "medium"` unless the user explicitly requests a different model. Give all three the same self-contained prompt: inspect relevant files, avoid code edits, avoid backwards-compatibility shims, fix root causes rather than symptoms, and include enough concrete file paths, anchors, and quoted snippets that implementation has no room for interpretation.
2. Wait for all three planning agents.
3. Consolidate agreement, flag meaningful divergence, and choose the best concrete implementation. Summarize meaningful rejected planner divergence under `Approaches Decided Against` using plain bullets, not labels like `Option A:` or `Alternative 1:`.
4. Write the consolidated plan to a named planfile using lowercase kebab-case. The plan must begin with `Plan Name: <name>` and end with `Planfile Path: <path>` followed by `Plan Name: <same-name>`.
5. Call `mcp__agent_framework__validate_plan` with `plan_file` set to that path. If it returns FAIL, revise the planfile and call it again until it returns PASS.
6. Spawn exactly three `default` verification agents in one parallel batch with the same model and reasoning effort. Tell each to inspect the code and verify the validated planfile against the source files for incorrect assumptions, missing changes, edge cases, regressions, and insufficient implementation detail.
7. Wait for all three verifiers. Fix issues reported by multiple verifiers and apply single-verifier issues when correct on the merits. Re-run `mcp__agent_framework__validate_plan` with `plan_file` if corrections were made.
8. Report the final planfile path.
