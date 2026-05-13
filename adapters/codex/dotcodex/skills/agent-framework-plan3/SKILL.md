---
name: agent-framework-plan3
description: Spawn three Codex planning agents in parallel, consolidate, then spawn three verification agents and present a final proposed plan. Use when the user invokes $agent-framework-plan3.
---

# Agent Framework Plan3

Use the user's invoking prompt as the task description. Subagents do not share this conversation, so expand references like "that bug" or "your theory" into a self-contained briefing before spawning agents.

1. Spawn exactly three `default` planning agents in one parallel batch. Use `gpt-5.5` with `reasoning_effort: "medium"` unless the user explicitly requests a different model. Give all three the same self-contained prompt: inspect relevant files, avoid code edits, avoid backwards-compatibility shims, fix root causes rather than symptoms, and include enough concrete file paths, anchors, and quoted snippets that implementation has no room for interpretation. Tell each to call `mcp__agent_framework__validate_plan` with its full inline plan before reporting the plan directly; if the tool returns FAIL, revise the plan and call it again until it returns PASS, then report the validated plan directly.
2. Wait for all three planning agents.
3. Consolidate agreement, flag meaningful divergence, and choose the best concrete implementation. Summarize meaningful rejected planner divergence under `Approaches Decided Against` using plain bullets, not labels like `Option A:` or `Alternative 1:`. Do not write a plan file unless the user explicitly requested one. Call `mcp__agent_framework__validate_plan` with the full inline consolidated plan; if it returns FAIL, revise the consolidated plan and call it again until it returns PASS.
4. Spawn exactly three `default` verification agents in one parallel batch with the same model and reasoning effort. Tell each to inspect the code and verify the consolidated plan against the source files for incorrect assumptions, missing changes, edge cases, regressions, and insufficient implementation detail.
5. Wait for all three verifiers. Fix issues reported by multiple verifiers and apply single-verifier issues when correct on the merits.
6. Present the final plan in a single `<proposed_plan>` block.
