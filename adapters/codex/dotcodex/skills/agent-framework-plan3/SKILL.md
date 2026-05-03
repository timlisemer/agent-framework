---
name: agent-framework-plan3
description: Spawn three Codex planning agents in parallel, consolidate, then spawn three validation agents and present a final proposed plan. Use when the user invokes the agent-framework plan3 workflow or asks for the old /plan3 command equivalent.
---

# Agent Framework Plan3

Use the user's invoking prompt as the task description. Subagents do not share this conversation, so expand references like "that bug" or "your theory" into a self-contained briefing before spawning agents.

1. Spawn exactly three `default` planning agents in one parallel batch. Use `gpt-5.5` with `reasoning_effort: "medium"` unless the user explicitly requests a different model. Give all three the same self-contained prompt: inspect relevant files, report the plan directly, avoid code edits, avoid backwards-compatibility shims, and fix root causes rather than symptoms.
2. Wait for all three planning agents.
3. Consolidate agreement, flag meaningful divergence, and choose the best concrete implementation. Do not write a plan file unless the user explicitly requested one.
4. Spawn exactly three `default` validation agents in one parallel batch with the same model and reasoning effort. Tell each to inspect the code and validate the consolidated plan for incorrect assumptions, missing changes, edge cases, regressions, and insufficient implementation detail.
5. Wait for all three validators. Fix issues reported by multiple validators and apply single-validator issues when correct on the merits.
6. Present the final plan in a single `<proposed_plan>` block. Include summary, key changes, tests, and assumptions.

